/**
 * The realtime stack end to end (SPEC §10, F1r acceptance): a real collab server
 * (Hocuspocus 4 + extension-redis + Postgres persistence + relay) on a random port,
 * the app's real Better Auth options (sessions in Postgres + Redis), a throwaway
 * migrated database and an isolated REDIS_PREFIX. Clients are the browser
 * `CollabClient` running on Node's WebSocket.
 */
import { createHmac, randomBytes } from "node:crypto";
import { QueryClient } from "@tanstack/react-query";
import { eq, sql } from "drizzle-orm";
import type { Redis } from "ioredis";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import type { Db } from "@/db/db.server";
import { tripKeys } from "@/lib/query/keys";
import type { CollabClient, DocLease } from "@/lib/realtime/collab-client";
import type { ChannelMessage } from "@/lib/realtime/protocol";
import type { TripLiveController } from "@/lib/realtime/trip-live";
import type { CollabServer } from "../app";
import type { JobWorkers } from "../jobs";

vi.setConfig({ testTimeout: 30_000, hookTimeout: 60_000 });

// .env is loaded by vitest.config.ts (variables already set win).
const hex = randomBytes(4).toString("hex");
const baseUrl = process.env.DATABASE_URL_TEST ?? process.env.DATABASE_URL;
if (!baseUrl) throw new Error("DATABASE_URL(_TEST) must be set");
const scratch = new URL(baseUrl);
scratch.pathname = `/yonder_rt_${hex}`;
const scratchUrl = scratch.toString();
// Everything below reads these lazily (dynamic imports in beforeAll).
process.env.DATABASE_URL = scratchUrl;
process.env.REDIS_PREFIX = `yonder-rttest-${hex}`;
process.env.BETTER_AUTH_URL = "http://localhost:3000";
process.env.APP_URL = "http://localhost:3000";
process.env.BETTER_AUTH_SECRET ||= "test-secret-test-secret-test-secret-00";
const APP_ORIGIN = "http://localhost:3000";

// ---------------------------------------------------------------------------

const until = async (pred: () => boolean, ms = 5_000, what = "condition") => {
	const t0 = Date.now();
	while (!pred()) {
		if (Date.now() - t0 > ms) throw new Error(`timeout waiting for ${what}`);
		await new Promise((r) => setTimeout(r, 10));
	}
	return Date.now() - t0;
};

const paragraph = (doc: Y.Doc, text: string) =>
	doc.transact(() => {
		const p = new Y.XmlElement("paragraph");
		p.insert(0, [new Y.XmlText(text)]);
		const f = doc.getXmlFragment("default");
		f.insert(f.length, [p]);
	});
const textOf = (doc: Y.Doc) => doc.getXmlFragment("default").toString();

type U = { id: string; token: string; name: string };

let mod: {
	CollabClient: typeof CollabClient;
	TripLiveController: typeof TripLiveController;
	publishTripChange: typeof import("@/server/live/realtime.server").publishTripChange;
	enqueue: typeof import("@/server/live/jobs.server").enqueue;
	channelDocName: typeof import("@/lib/realtime/protocol").channelDocName;
	noteDocName: typeof import("@/lib/realtime/protocol").noteDocName;
	schema: typeof import("@/db/schema");
};
let db: Db;
let pool: import("pg").Pool;
let collab: CollabServer;
let workers: JobWorkers;
let redisCmd: Redis;
let deleteSession: (token: string) => Promise<void>;
let createSession: (userId: string) => Promise<string>;
let secret: string;
const clients: CollabClient[] = [];

const ids = {
	t1: "",
	t2: "",
	slug: `rt-${hex}`,
	n1: "",
	n2: "",
	link: { viewer: "", editor: "" },
};
const users: Record<string, U> = {};

function connect(
	who: U | null,
	opts: { cookie?: boolean; origin?: string } = {},
): CollabClient {
	const headers: Record<string, string> = {};
	if (who && opts.cookie) {
		const sig = createHmac("sha256", secret).update(who.token).digest("base64");
		headers.cookie = `better-auth.session_token=${encodeURIComponent(`${who.token}.${sig}`)}`;
	}
	if (opts.origin) headers.origin = opts.origin;
	class HeaderWebSocket extends WebSocket {
		constructor(url: string | URL, protocols?: string | string[]) {
			super(url, { headers, protocols } as unknown as string[]);
		}
	}
	const c = new mod.CollabClient({
		url: collab.url,
		token: who && !opts.cookie ? who.token : undefined,
		WebSocketPolyfill: HeaderWebSocket,
		lingerMs: 0,
	});
	clients.push(c);
	return c;
}

function live(
	client: CollabClient,
	tripId = ids.t1,
	tabId = `tab-${randomBytes(3).toString("hex")}`,
) {
	const queryClient = new QueryClient();
	const invalidated: unknown[][] = [];
	vi.spyOn(queryClient, "invalidateQueries").mockImplementation(async (f) => {
		invalidated.push([...(f?.queryKey ?? [])]);
	});
	const messages: ChannelMessage[] = [];
	const lost: string[] = [];
	const c = new mod.TripLiveController(client, tripId, {
		queryClient,
		tabId,
		coalesceMs: 0,
		onMessage: (m) => messages.push(m),
		onAccessLost: (r) => lost.push(r),
	});
	c.start();
	return { c, invalidated, messages, lost, tabId };
}

const status = (l: DocLease) => l.getSnapshot();

async function authed(l: DocLease, what = l.name) {
	await until(
		() => status(l).status === "authenticated",
		5_000,
		`${what} authenticated`,
	);
}
async function denied(l: DocLease, what = l.name) {
	await until(() => status(l).status === "denied", 5_000, `${what} denied`);
	return status(l).reason;
}

async function tripVersion(tripId = ids.t1): Promise<number> {
	const r = await db.execute(
		sql`select version from trips where id = ${tripId}`,
	);
	return Number((r.rows[0] as { version: string }).version);
}

// ---------------------------------------------------------------------------

beforeAll(async () => {
	const migrate = await import("@/db/migrate.server");
	await migrate.ensureDatabase(scratchUrl);
	await migrate.migrateDatabase(scratchUrl);

	const { createDb } = await import("@/db/db.server");
	const handles = createDb({
		connectionString: scratchUrl,
		max: 5,
		applicationName: "yonder-rttest",
	});
	db = handles.db;
	pool = handles.pool;

	const [
		{ betterAuth },
		{ authOptions },
		protocol,
		realtime,
		jobs,
		redisMod,
		handlers,
		collabMod,
	] = await Promise.all([
		import("better-auth"),
		import("@/server/auth-options"),
		import("@/lib/realtime/protocol"),
		import("@/server/live/realtime.server"),
		import("@/server/live/jobs.server"),
		import("@/server/live/redis.server"),
		import("@/server/live/job-handlers.server"),
		Promise.all([
			import("../app"),
			import("../auth"),
			import("../db"),
			import("../jobs"),
			import("@/lib/realtime/collab-client"),
			import("@/lib/realtime/trip-live"),
			import("@/db/schema"),
		]),
	]);
	const [app, auth, collabDbMod, jobsMod, clientMod, tripLive, schema] =
		collabMod;
	mod = {
		CollabClient: clientMod.CollabClient,
		TripLiveController: tripLive.TripLiveController,
		publishTripChange: realtime.publishTripChange,
		enqueue: jobs.enqueue,
		channelDocName: protocol.channelDocName,
		noteDocName: protocol.noteDocName,
		schema,
	};
	secret = authOptions.secret ?? "";

	const ba = betterAuth({
		...authOptions,
		session: { ...authOptions.session, disableSessionRefresh: true },
	});
	const ctx = await ba.$context;
	deleteSession = (token) => ctx.internalAdapter.deleteSession(token);
	createSession = async (userId) =>
		(await ctx.internalAdapter.createSession(userId)).token;

	// ---- seed -------------------------------------------------------------
	const mkUser = async (
		key: string,
		first: string,
		last: string,
		anon = false,
	) => {
		const id = `u-${key}-${hex}`;
		const name = anon ? `Guest ${first}` : `${first} ${last}`.trim();
		await db.insert(schema.user).values({
			id,
			email: `${key}-${hex}@example.com`,
			emailVerified: true,
			name,
			firstName: anon ? "" : first,
			lastName: anon ? "" : last,
			isAnonymous: anon,
		});
		const session = await ctx.internalAdapter.createSession(id);
		users[key] = { id, token: session.token, name };
	};
	await mkUser("ada", "Ada", "Owner");
	await mkUser("bob", "Bob", "Editor");
	await mkUser("cy", "Cy", "Viewer");
	await mkUser("dee", "Dee", "Stranger");
	await mkUser("eve", "", "");
	await mkUser("fay", "Fay", "Removed");
	await mkUser("gus", "Gus", "Downgraded");
	await mkUser("hal", "Hal", "SignedOut");
	await mkUser("gv", "Owl", "", true);
	await mkUser("ge", "Wren", "", true);
	await mkUser("sue", "Sue", "Suggester");
	await mkUser("gs", "Lark", "", true);
	await mkUser("ivy", "Ivy", "Revoked", true);

	const [t1] = await db
		.insert(schema.trips)
		.values({ slug: ids.slug, name: "RT", createdBy: users.ada?.id })
		.returning({ id: schema.trips.id });
	const [t2] = await db
		.insert(schema.trips)
		.values({ slug: `rt2-${hex}`, name: "RT2" })
		.returning({ id: schema.trips.id });
	if (!t1 || !t2) throw new Error("seed trips");
	ids.t1 = t1.id;
	ids.t2 = t2.id;
	const member = (
		key: string,
		role: "owner" | "editor" | "viewer" | "suggester",
		color: number,
	) => ({
		tripId: ids.t1,
		userId: users[key]?.id ?? "",
		status: "active" as const,
		role,
		color,
	});
	await db
		.insert(schema.tripMembers)
		.values([
			member("ada", "owner", 0),
			member("bob", "editor", 1),
			member("cy", "viewer", 2),
			member("fay", "editor", 3),
			member("gus", "editor", 4),
			member("hal", "editor", 5),
			member("eve", "editor", 6),
			member("sue", "suggester", 7),
		]);
	const [lv, le, ls] = await db
		.insert(schema.shareLinks)
		.values([
			// One live row per role, as test fixtures may hold (`pinTestLink`).
			{ tripId: ids.t1, role: "viewer" },
			{ tripId: ids.t1, role: "editor" },
			{ tripId: ids.t1, role: "suggester" },
		])
		.returning({ id: schema.shareLinks.id });
	if (!lv || !le || !ls) throw new Error("seed links");
	ids.link = { viewer: lv.id, editor: le.id };
	await db.insert(schema.shareGrants).values([
		{
			tripId: ids.t1,
			shareLinkId: lv.id,
			userId: users.gv?.id ?? "",
			color: 5,
		},
		{
			tripId: ids.t1,
			shareLinkId: le.id,
			userId: users.ge?.id ?? "",
			color: 6,
		},
		{
			tripId: ids.t1,
			shareLinkId: ls.id,
			userId: users.gs?.id ?? "",
			color: 7,
		},
		{
			tripId: ids.t1,
			shareLinkId: le.id,
			userId: users.ivy?.id ?? "",
			color: 3,
		},
	]);
	const [n1] = await db
		.insert(schema.nodes)
		.values({
			tripId: ids.t1,
			type: "city",
			name: "Tokyo",
			slug: "tokyo",
			position: "a0",
		})
		.returning({ id: schema.nodes.id });
	const [n2] = await db
		.insert(schema.nodes)
		.values({
			tripId: ids.t2,
			type: "city",
			name: "Seoul",
			slug: "seoul",
			position: "a0",
		})
		.returning({ id: schema.nodes.id });
	if (!n1 || !n2) throw new Error("seed nodes");
	ids.n1 = n1.id;
	ids.n2 = n2.id;

	// ---- servers ----------------------------------------------------------
	collab = await app.startCollabServer({
		port: 0,
		db: collabDbMod.collabDb(handles),
		lookupSession: auth.betterAuthSessionLookup(
			ba as unknown as import("../auth").SessionApi,
		),
		originAllowed: auth.createOriginCheck({
			allowedOrigins: [APP_ORIGIN],
			allowAnyLocalhost: false,
		}),
		redis: {
			url: process.env.REDIS_URL ?? "redis://localhost:6379",
			tripPattern: realtime.tripChannelPattern(),
			hocuspocusPrefix: redisMod.key("hp"),
			name: `t${hex}`,
		},
		debounce: 100,
		maxDebounce: 300,
		recheckMs: 300,
		log: () => {},
	});
	redisCmd = redisMod.redis();
	workers = jobsMod.startJobWorkers({
		connection: redisMod.redisForBull(),
		prefix: jobs.bullPrefix(),
		commands: redisCmd,
		key: redisMod.key,
		pool: handles.pool,
		handlers: handlers.jobHandlers,
		publish: realtime.publishTripChange,
		gateMs: 1_000,
		log: () => {},
	});
	await workers.ready;
});

afterAll(async () => {
	for (const c of clients) c.destroy();
	await workers?.close();
	await collab?.stop();
	const jobs = await import("@/server/live/jobs.server");
	await jobs.closeQueues();
	const redisMod = await import("@/server/live/redis.server");
	if (redisCmd) {
		// Only this run's keys (never FLUSHALL: other agents share this Redis).
		let cursor = "0";
		do {
			const [next, keys] = await redisCmd.scan(
				cursor,
				"MATCH",
				`${process.env.REDIS_PREFIX}:*`,
				"COUNT",
				500,
			);
			cursor = next;
			if (keys.length) await redisCmd.unlink(...keys);
		} while (cursor !== "0");
	}
	await redisMod.closeRedis();
	const { closeDb } = await import("@/db/db.server");
	await closeDb();
	await pool?.end();
	const migrate = await import("@/db/migrate.server");
	await migrate.dropDatabase(scratchUrl);
});

// ---------------------------------------------------------------------------

describe("collab server", () => {
	it("multiplexes channel + note on one socket; hello carries the version and role", async () => {
		const a = connect(users.ada as U);
		const l = live(a);
		const note = a.acquire(
			mod.noteDocName(ids.t1, { kind: "node", nodeId: ids.n1 }),
		);
		await authed(note);
		await until(
			() => l.messages.some((m) => m.type === "hello"),
			5_000,
			"hello",
		);
		const hello = l.messages.find((m) => m.type === "hello");
		expect(hello).toMatchObject({
			type: "hello",
			version: await tripVersion(),
			you: {
				userId: users.ada?.id,
				role: "owner",
				guest: false,
				color: 0,
				name: "Ada Owner",
			},
		});
		expect(l.c.getSnapshot().status).toBe("authenticated");
		// channel is read-only for everyone; the owner writes notes
		expect(l.c.channel?.getSnapshot().readOnly).toBe(true);
		expect(status(note).readOnly).toBe(false);
		expect(l.c.channel?.provider.configuration.websocketProvider).toBe(
			note.provider.configuration.websocketProvider,
		);
		expect(a.openDocuments().sort()).toEqual(
			[mod.channelDocName(ids.t1), note.name].sort(),
		);
		l.c.stop();
		note.release();
	});

	it("syncs two editors, persists bytea + derived text, keeps the trip version and invalidates notes", async () => {
		const name = mod.noteDocName(ids.t1, { kind: "trip" });
		const a = connect(users.ada as U).acquire(name);
		const b = connect(users.bob as U, {
			cookie: true,
			origin: APP_ORIGIN,
		}).acquire(name);
		const watcher = live(connect(users.cy as U));
		await Promise.all([
			authed(a),
			authed(b),
			authed(watcher.c.channel as DocLease),
		]);
		await until(() => status(a).synced && status(b).synced, 5_000, "synced");
		await until(
			() => watcher.messages.some((m) => m.type === "hello"),
			5_000,
			"watcher hello",
		);
		await new Promise((r) => setTimeout(r, 50));
		// Without a baseVersion the first hello refetches everything; start clean.
		watcher.invalidated.length = 0;
		const before = await tripVersion();

		paragraph(a.doc, "Hello from Ada");
		const ms = await until(
			() => textOf(b.doc).includes("Hello from Ada"),
			3_000,
			"b sees a",
		);
		expect(ms).toBeLessThan(1_000);
		paragraph(b.doc, "and Bob");
		await until(() => textOf(a.doc).includes("and Bob"), 3_000, "a sees b");

		await until(
			() =>
				watcher.invalidated.some(
					(k) => k.join("/") === tripKeys.notes(ids.t1).join("/"),
				),
			5_000,
			"notes invalidation",
		);
		const rows = await db.execute(
			sql`select state, plain_text, json, updated_by, trip_id from yjs_documents where name = ${name}`,
		);
		const row = rows.rows[0] as {
			state: Buffer;
			plain_text: string;
			json: { type: string };
			trip_id: string;
		};
		expect(Buffer.isBuffer(row.state) && row.state.byteLength > 20).toBe(true);
		expect(row.plain_text).toContain("Hello from Ada");
		expect(row.json.type).toBe("doc");
		expect(row.trip_id).toBe(ids.t1);
		// QA NOTE-VERSION-CONFLICT: a note body isn't structured data. Typing
		// never moves trips.version (a reviewed date change stays valid), and
		// the invalidate carries the current version (no gap for anyone).
		expect(await tripVersion()).toBe(before);
		const notesEvents = watcher.messages.filter(
			(m) => m.type === "invalidate" && m.keys.includes("notes"),
		);
		expect(notesEvents.length).toBeGreaterThan(0);
		for (const m of notesEvents) expect(m).toMatchObject({ version: before });
		expect(
			watcher.invalidated.some(
				(k) => k.join("/") === tripKeys.trip(ids.t1).join("/"),
			),
		).toBe(false);

		// persisted state round-trips into a fresh Y.Doc
		const restored = new Y.Doc();
		Y.applyUpdate(restored, new Uint8Array(row.state));
		expect(textOf(restored)).toContain("and Bob");
		watcher.c.stop();
		a.release();
		b.release();
	});

	it("keeps viewers read-only: their writes never reach others or the database", async () => {
		const name = mod.noteDocName(ids.t1, { kind: "node", nodeId: ids.n1 });
		const owner = connect(users.ada as U).acquire(name);
		const viewer = connect(users.cy as U).acquire(name);
		await Promise.all([authed(owner), authed(viewer)]);
		expect(status(viewer).readOnly).toBe(true);
		await until(() => status(viewer).synced, 3_000, "viewer synced");
		paragraph(viewer.doc, "VIEWER WRITE");
		paragraph(owner.doc, "owner line");
		await until(
			() => textOf(viewer.doc).includes("owner line"),
			3_000,
			"viewer gets live edits",
		);
		await new Promise((r) => setTimeout(r, 700)); // > debounce: a store has run
		expect(textOf(owner.doc)).not.toContain("VIEWER WRITE");
		const rows = await db.execute(
			sql`select plain_text from yjs_documents where name = ${name}`,
		);
		expect((rows.rows[0] as { plain_text: string }).plain_text).toContain(
			"owner line",
		);
		expect((rows.rows[0] as { plain_text: string }).plain_text).not.toContain(
			"VIEWER WRITE",
		);
		owner.release();
		viewer.release();
	});

	it("refuses strangers, unnamed accounts, missing sessions, bad names, foreign targets and bad origins", async () => {
		const channel = mod.channelDocName(ids.t1);
		expect(await denied(connect(users.dee as U).acquire(channel))).toBe(
			"forbidden",
		);
		expect(await denied(connect(users.eve as U).acquire(channel))).toBe(
			"name-required",
		);
		expect(await denied(connect(null).acquire(channel))).toBe("unauthorized");
		expect(
			await denied(
				connect({ id: "x", name: "x", token: "forged-token" }).acquire(channel),
			),
		).toBe("unauthorized");
		expect(
			await denied(
				connect(users.ada as U).acquire(`trip/${ids.t1}/node/NOT-A-UUID`),
			),
		).toBe("bad-doc");
		// a node of ANOTHER trip addressed through this trip's name: not in
		// this trip ("gone", like a removed day; it reveals nothing)
		expect(
			await denied(
				connect(users.ada as U).acquire(`trip/${ids.t1}/node/${ids.n2}`),
			),
		).toBe("gone");
		// cookie auth works from the app origin …
		await authed(
			connect(users.ada as U, { cookie: true, origin: APP_ORIGIN }).acquire(
				channel,
			),
		);
		// … but the upgrade is refused from any other origin (cross-site WebSocket hijacking)
		const evil = connect(users.ada as U, {
			cookie: true,
			origin: "https://evil.test",
		});
		const lease = evil.acquire(channel);
		await new Promise((r) => setTimeout(r, 800));
		expect(evil.getSocketSnapshot().everConnected).toBe(false);
		expect(status(lease).status).toBe("connecting");
	});

	it("admits share-link guests with the link's role, and refuses a disabled link", async () => {
		const name = mod.noteDocName(ids.t1, { kind: "trip" });
		const gv = connect(users.gv as U).acquire(name);
		const ge = connect(users.ge as U).acquire(name);
		await Promise.all([authed(gv), authed(ge)]);
		expect(status(gv).readOnly).toBe(true);
		expect(status(ge).readOnly).toBe(false);
		const gvLive = live(connect(users.gv as U));
		await until(
			() => gvLive.messages.some((m) => m.type === "hello"),
			5_000,
			"guest hello",
		);
		expect(gvLive.c.getSnapshot().you).toMatchObject({
			guest: true,
			memberId: null,
			role: "viewer",
			color: 5,
		});

		await db
			.update(mod.schema.shareLinks)
			.set({ enabled: false })
			.where(eq(mod.schema.shareLinks.id, ids.link.viewer));
		expect(await denied(connect(users.gv as U).acquire(name))).toBe(
			"forbidden",
		);
		gvLive.c.stop();
	});

	it("relays publishTripChange to channel clients in < 1 s and skips the originating tab", async () => {
		const bob = live(connect(users.bob as U));
		const ada = live(connect(users.ada as U));
		await until(
			() =>
				bob.messages.some((m) => m.type === "hello") &&
				ada.messages.some((m) => m.type === "hello"),
		);
		await new Promise((r) => setTimeout(r, 50));
		// Without a baseVersion the first hello refetches everything; start clean.
		bob.invalidated.length = 0;
		ada.invalidated.length = 0;
		const version = await tripVersion();
		const t0 = Date.now();
		const delivered = await mod.publishTripChange({
			type: "invalidate",
			tripId: ids.t1,
			version: version + 1,
			keys: ["graph"],
			by: ada.tabId,
			hints: [{ kind: "node", id: ids.n1 }],
		});
		expect(delivered).toBeGreaterThanOrEqual(1);
		await until(
			() => bob.messages.some((m) => m.type === "invalidate"),
			1_000,
			"bob gets the event",
		);
		expect(Date.now() - t0).toBeLessThan(1_000);
		await until(() => bob.invalidated.length > 0, 1_000);
		expect(bob.invalidated).toContainEqual([...tripKeys.graph(ids.t1)]);
		await until(
			() => ada.messages.some((m) => m.type === "invalidate"),
			1_000,
			"ada gets it too",
		);
		await new Promise((r) => setTimeout(r, 50));
		expect(ada.invalidated).toEqual([]); // her own tab caused it
		bob.c.stop();
		ada.c.stop();
	});

	it("treats a skipped version as missed events: full refetch", async () => {
		const bob = live(connect(users.bob as U));
		await until(() => bob.messages.some((m) => m.type === "hello"));
		const known = bob.c.getSnapshot().version ?? 0;
		await mod.publishTripChange({
			type: "invalidate",
			tripId: ids.t1,
			version: known + 2,
			keys: ["media"],
		});
		await until(() => bob.invalidated.length > 0, 2_000, "refetch");
		expect(bob.invalidated).toContainEqual([...tripKeys.trip(ids.t1)]);
		bob.c.stop();
	});

	it("access events cut a removed member within 2 s, downgrade an editor, keep everyone else", async () => {
		const note = mod.noteDocName(ids.t1, { kind: "trip" });
		const fayClient = connect(users.fay as U);
		const fay = live(fayClient);
		const fayNote = fayClient.acquire(note);
		const gusNote = connect(users.gus as U).acquire(note);
		const ada = live(connect(users.ada as U));
		await Promise.all([
			authed(fayNote),
			authed(gusNote),
			authed(fay.c.channel as DocLease),
			authed(ada.c.channel as DocLease),
		]);
		expect(status(gusNote).readOnly).toBe(false);

		const { collabDb } = await import("../db");
		const cdb = collabDb({ db, pool });
		const t0 = Date.now();
		await cdb.withTripTx(ids.t1, async (tx, out) => {
			await tx
				.delete(mod.schema.tripMembers)
				.where(eq(mod.schema.tripMembers.userId, users.fay?.id ?? ""));
			await tx
				.update(mod.schema.tripMembers)
				.set({ role: "viewer" })
				.where(eq(mod.schema.tripMembers.userId, users.gus?.id ?? ""));
			out.access([users.fay?.id ?? "", users.gus?.id ?? ""]);
		});
		expect(await denied(fayNote, "fay note")).toBe("forbidden");
		expect(await denied(fay.c.channel as DocLease, "fay channel")).toBe(
			"forbidden",
		);
		expect(Date.now() - t0).toBeLessThan(2_000);
		expect(fay.lost).toEqual(["forbidden"]);
		await until(
			() =>
				status(gusNote).status === "authenticated" && status(gusNote).readOnly,
			3_000,
			"gus read-only",
		);
		expect(status(ada.c.channel as DocLease).status).toBe("authenticated");
		// everyone else refetches sharing + graph
		await until(
			() =>
				ada.invalidated.some(
					(k) => k.join("/") === tripKeys.sharing(ids.t1).join("/"),
				),
			2_000,
		);
		fay.c.stop();
		ada.c.stop();
	});

	it("suggesters (members and guests) are read-only on notes (EXTENSIONS §3.1)", async () => {
		const name = mod.noteDocName(ids.t1, { kind: "node", nodeId: ids.n1 });
		const sue = connect(users.sue as U).acquire(name);
		const gs = connect(users.gs as U).acquire(name);
		await Promise.all([authed(sue, "sue"), authed(gs, "guest suggester")]);
		expect(status(sue).readOnly).toBe(true);
		expect(status(gs).readOnly).toBe(true);
		sue.release();
		gs.release();
	});

	it("private notes open for their owner only, never for another member or a guest (ADDENDUM §7.2)", async () => {
		const target = { kind: "node" as const, nodeId: ids.n1 };
		const own = mod.noteDocName(ids.t1, target, users.bob?.id);
		const bobClient = connect(users.bob as U);
		const mine = bobClient.acquire(own);
		await authed(mine, "bob private note");
		expect(status(mine).readOnly).toBe(false);
		expect(
			await denied(
				connect(users.ada as U).acquire(own),
				"ada on bob's private note",
			),
		).toBe("forbidden");
		// A viewer may keep a private note too (it is theirs alone)…
		const cyOwn = connect(users.cy as U).acquire(
			mod.noteDocName(ids.t1, target, users.cy?.id),
		);
		await authed(cyOwn, "cy private note");
		expect(status(cyOwn).readOnly).toBe(false);
		// …but a guest never.
		const geOwn = connect(users.ge as U).acquire(
			mod.noteDocName(ids.t1, target, users.ge?.id),
		);
		expect(await denied(geOwn, "guest private note")).toBe("forbidden");
		// QA NOTE-VERSION-CONFLICT: storing it neither moves trips.version nor
		// tells anyone but Bob (his own tabs refresh their notes and counts).
		const bobLive = live(bobClient);
		const adaLive = live(connect(users.ada as U));
		await Promise.all([
			authed(bobLive.c.channel as DocLease, "bob channel"),
			authed(adaLive.c.channel as DocLease, "ada channel"),
		]);
		const before = await tripVersion();
		const notesEvents = (l: ReturnType<typeof live>) =>
			l.messages.filter(
				(m) => m.type === "invalidate" && m.keys.includes("notes"),
			);
		paragraph(mine.doc, "private line");
		await new Promise((r) => setTimeout(r, 600)); // > debounce: stored
		const rows = await db.execute(
			sql`select owner_user_id as owner from yjs_documents where name = ${own}`,
		);
		expect((rows.rows[0] as { owner: string }).owner).toBe(users.bob?.id);
		await until(
			() => notesEvents(bobLive).length > 0,
			3_000,
			"bob's notes invalidation",
		);
		await new Promise((r) => setTimeout(r, 100));
		expect(notesEvents(adaLive)).toEqual([]);
		expect(notesEvents(bobLive)[0]).toMatchObject({ version: before });
		expect(await tripVersion()).toBe(before);
		bobLive.c.stop();
		adaLive.c.stop();
		mine.release();
		cyOwn.release();
	});

	it("re-checks an open writable connection: a revocation whose access event was lost still cuts it (SECURITY §4)", async () => {
		const name = mod.noteDocName(ids.t1, { kind: "node", nodeId: ids.n1 });
		const owner = connect(users.ada as U).acquire(name);
		const ivy = connect(users.ivy as U).acquire(name);
		await Promise.all([authed(owner), authed(ivy, "ivy")]);
		expect(status(ivy).readOnly).toBe(false);
		await until(() => status(ivy).synced, 3_000, "ivy synced");
		// Revoke WITHOUT publishing an access event (a Redis blip, a lost message).
		await db.execute(
			sql`delete from share_grants where user_id = ${users.ivy?.id ?? ""}`,
		);
		await new Promise((r) => setTimeout(r, 400)); // > recheckMs
		paragraph(ivy.doc, "WRITE AFTER REVOKE");
		expect(await denied(ivy, "ivy after revoke")).toBe("forbidden");
		await new Promise((r) => setTimeout(r, 500));
		expect(textOf(owner.doc)).not.toContain("WRITE AFTER REVOKE");
		owner.release();
	});

	it("sweeps read-only connections too: an expired viewer link stops streaming notes (SEC-R1-06)", async () => {
		await db
			.update(mod.schema.shareLinks)
			.set({ enabled: true, expiresAt: null })
			.where(eq(mod.schema.shareLinks.id, ids.link.viewer));
		const name = mod.noteDocName(ids.t1, { kind: "node", nodeId: ids.n1 });
		const owner = connect(users.ada as U).acquire(name);
		const gv = connect(users.gv as U).acquire(name);
		await Promise.all([authed(owner), authed(gv, "guest viewer")]);
		expect(status(gv).readOnly).toBe(true);
		await until(() => status(gv).synced, 3_000, "guest viewer synced");
		paragraph(owner.doc, "BEFORE EXPIRY");
		await until(() => textOf(gv.doc).includes("BEFORE EXPIRY"), 3_000);
		// The link expires: no event, and the viewer never writes.
		await db.execute(
			sql`update share_links set expires_at = now() - interval '1 second' where id = ${ids.link.viewer}`,
		);
		expect(await denied(gv, "guest viewer after expiry")).toBe("forbidden");
		paragraph(owner.doc, "AFTER EXPIRY");
		await new Promise((r) => setTimeout(r, 500));
		expect(textOf(gv.doc)).not.toContain("AFTER EXPIRY");
		owner.release();
	});

	it("a revoked session is cut from an open channel; signing in again + reconnect() brings it back (ERR-07)", async () => {
		let token = await createSession(users.bob?.id ?? "");
		const client = new mod.CollabClient({
			url: collab.url,
			token: () => token,
			WebSocketPolyfill: WebSocket,
			lingerMs: 0,
		});
		clients.push(client);
		const lease = client.acquire(mod.channelDocName(ids.t1));
		await authed(lease, "bob channel");
		// Revoked server-side: no event; the periodic re-check cuts it.
		await deleteSession(token);
		expect(await denied(lease, "bob channel after revoke")).toBe(
			"unauthorized",
		);
		token = await createSession(users.bob?.id ?? "");
		client.reconnect();
		await authed(lease, "bob channel after sign-in");
		lease.release();
	});

	it("a signed-out session loses collab access on the next connect", async () => {
		const client = connect(users.hal as U);
		const lease = client.acquire(mod.channelDocName(ids.t1));
		await authed(lease);
		await deleteSession(users.hal?.token ?? "");
		client.socket.disconnect();
		await until(() => client.getSocketSnapshot().status !== "connected");
		void client.socket.connect();
		expect(await denied(lease)).toBe("unauthorized");
	});

	it("sanitizes awareness: forged names and foreign view paths never reach peers", async () => {
		const ada = connect(users.ada as U);
		const bob = connect(users.bob as U);
		const aCh = ada.acquire(mod.channelDocName(ids.t1));
		const bCh = bob.acquire(mod.channelDocName(ids.t1));
		await Promise.all([authed(aCh), authed(bCh)]);
		const view = (path: string) => ({
			scopeId: null,
			scopeName: "Japan",
			lens: "city",
			tab: "plan",
			days: null,
			sel: null,
			path,
		});
		aCh.awareness?.setLocalState({
			user: {
				id: "u-mallory",
				name: "Mallory",
				color: 7,
				email: "m@evil.test",
			},
			view: view("/t/someone-elses-trip/x"),
			secret: "leak",
		});
		const adaState = () =>
			bCh.awareness?.getStates().get(aCh.doc.clientID) as
				| Record<string, unknown>
				| undefined;
		await until(() => !!adaState(), 3_000, "bob sees ada");
		expect(adaState()).toEqual({
			user: {
				id: users.ada?.id,
				memberId: expect.any(String),
				name: "Ada Owner",
				color: 0,
				guest: false,
			},
		});
		aCh.awareness?.setLocalStateField("view", view(`/t/${ids.slug}/japan`));
		await until(
			() => !!(adaState()?.view as { path?: string } | undefined)?.path,
			3_000,
			"valid view",
		);
		expect((adaState()?.view as { path?: string } | undefined)?.path).toBe(
			`/t/${ids.slug}/japan`,
		);
	});

	it("tells channel clients to resync after the relay's Redis subscriber is killed, and re-checks every connection", async () => {
		const bob = live(connect(users.bob as U));
		await until(() => bob.messages.some((m) => m.type === "hello"));
		// A guest whose grant disappears while the subscriber is down (its access
		// event would be lost): the re-subscribe re-check closes the socket.
		const gs = live(connect(users.gs as U));
		await authed(gs.c.channel as DocLease, "gs channel");
		await db.execute(
			sql`delete from share_grants where user_id = ${users.gs?.id ?? ""}`,
		);
		const list = (await redisCmd.client("LIST")) as string;
		const line = list
			.split("\n")
			.find((l) => l.includes(`name=yonder-relay-t${hex} `));
		const id = line?.match(/\bid=(\d+)/)?.[1];
		expect(id).toBeTruthy();
		await redisCmd.client("KILL", "ID", id as string);
		await until(
			() => bob.messages.some((m) => m.type === "resync"),
			5_000,
			"resync",
		);
		await until(
			() =>
				bob.invalidated.some(
					(k) => k.join("/") === tripKeys.trip(ids.t1).join("/"),
				),
			1_000,
		);
		// and live events flow again afterwards
		const v = bob.c.getSnapshot().version ?? 0;
		await mod.publishTripChange({
			type: "invalidate",
			tripId: ids.t1,
			version: v + 1,
			keys: ["lists"],
		});
		await until(
			() => bob.messages.some((m) => m.type === "invalidate"),
			3_000,
			"events after reconnect",
		);
		expect(
			await denied(gs.c.channel as DocLease, "gs after re-subscribe"),
		).toBe("forbidden");
		expect(status(bob.c.channel as DocLease).status).toBe("authenticated");
		gs.c.stop();
		bob.c.stop();
	});
});

describe("job worker", () => {
	it("runs sample jobs end to end: job progress events and one gated invalidation", async () => {
		const bob = live(connect(users.bob as U));
		await until(() => bob.messages.some((m) => m.type === "hello"));
		for (let i = 0; i < 3; i++) {
			// A short delay so all three are queued (total = 3) before the first runs.
			const r = await mod.enqueue(
				"autofill",
				"test.ping",
				{ tripId: ids.t1, keys: ["graph"] },
				{ delay: 300 },
			);
			expect(r?.added).toBe(true);
		}
		// deduplicated adds don't count towards progress
		const d1 = await mod.enqueue(
			"links",
			"test.ping",
			{ tripId: ids.t2 },
			{ dedupeId: `d-${hex}`, delay: 60_000 },
		);
		const d2 = await mod.enqueue(
			"links",
			"test.ping",
			{ tripId: ids.t2 },
			{ dedupeId: `d-${hex}`, delay: 60_000 },
		);
		expect(d1?.added).toBe(true);
		expect(d2).toMatchObject({ added: false, id: d1?.id });

		await until(
			() => bob.messages.some((m) => m.type === "job" && m.remaining === 0),
			10_000,
			"all jobs done",
		);
		const jobsSeen = bob.messages.filter((m) => m.type === "job");
		expect(
			jobsSeen.map((m) =>
				m.type === "job" ? [m.kind, m.remaining, m.total] : [],
			),
		).toEqual([
			["autofill", 2, 3],
			["autofill", 1, 3],
			["autofill", 0, 3],
		]);
		// gate = 1 s: the first job publishes at once, the rest trail into ONE more
		await new Promise((r) => setTimeout(r, 1_500));
		const invalidations = bob.messages.filter((m) => m.type === "invalidate");
		expect(invalidations.length).toBeGreaterThanOrEqual(1);
		expect(invalidations.length).toBeLessThanOrEqual(2);
		for (const e of invalidations)
			expect(e).toMatchObject({
				keys: ["graph"],
				version: await tripVersion(),
			});
		bob.c.stop();
	});
});
