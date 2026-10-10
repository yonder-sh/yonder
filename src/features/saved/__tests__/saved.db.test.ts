/**
 * Saved against real Postgres, Redis and S3 (s3proxy): saving (the Shortcut
 * and the app), the list (only mine, newest first, added and deleted ones
 * out), add-to-trip, delete, the preview job (stubbed fetches, the picture
 * re-hosted under the user, served to its owner only), and the move of the
 * Shortcut's waiting links in migration 0025.
 */
import { randomUUID } from "node:crypto";
import {
	cpSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { sql } from "drizzle-orm";
import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const testEnv = vi.hoisted(() => {
	const hex = Math.random().toString(16).slice(2, 10);
	const base = process.env.DATABASE_URL_TEST ?? process.env.DATABASE_URL;
	if (!base) throw new Error("DATABASE_URL(_TEST) must be set");
	const scratch = new URL(base);
	scratch.pathname = `/yonder_saved_${hex}`;
	const old = new URL(base);
	old.pathname = `/yonder_saved_mig_${hex}`;
	process.env.DATABASE_URL = scratch.toString();
	process.env.REDIS_PREFIX = `yonder-savedtest-${hex}`;
	process.env.BETTER_AUTH_URL = "http://localhost:3000";
	process.env.APP_URL = "http://localhost:3000";
	process.env.BETTER_AUTH_SECRET ||= "test-secret-test-secret-test-secret-00";
	return { scratchUrl: scratch.toString(), oldUrl: old.toString() };
});

/** `/api/saved/…` reads the session from the request: tests name the user. */
const sessions = vi.hoisted(() => ({ byId: new Map<string, unknown>() }));

vi.mock("@tanstack/react-start", () => import("@/test/start-mock"));
vi.mock("@/server/authz/session.server", async (orig) => ({
	...(await orig<typeof import("@/server/authz/session.server")>()),
	loadSession: async (h: Headers) => {
		const u = sessions.byId.get(h.get("x-test-user") ?? "");
		return u ? { user: u, session: {} } : null;
	},
}));
vi.mock(
	"@tanstack/react-start/server",
	() => import("@/test/start-server-mock"),
);

import { closeDb, getDb } from "@/db/db.server";
import {
	dropDatabase,
	ensureDatabase,
	migrateDatabase,
} from "@/db/migrate.server";
import { tripMembers, user } from "@/db/schema";
import { purge } from "@/features/media/server/purge.server";
import type { SafeFetcher } from "@/features/media/server/safe-fetch.server";
import { headObject } from "@/features/media/server/storage.server";
import type { AuthUser } from "@/server/auth.server";
import { errorCode } from "@/server/authz/errors";
import { cloneDemoTrip, type FixtureClone } from "@/server/fixture.server";
import { closeQueues } from "@/server/live/jobs.server";
import { closeRedis, redis, redisPrefix } from "@/server/live/redis.server";
import { usedBytes } from "@/server/quota.server";
import { ensureBucket } from "@/server/s3.server";
import {
	checkKey,
	newPairingCode,
	pair,
	saveShare,
	shareInput,
} from "@/server/shortcut.server";
import {
	attachSavedFiles,
	completeSavedUpload,
	deleteSavedLinks,
	listSavedLinks,
	markSavedAdded,
	restoreSavedLinks,
	saveSharedLink,
	signSavedUploadParts,
	startSavedUpload,
} from "../saved.functions";
import { savedFileVariants } from "../server/files.server";
import { savedPreview } from "../server/preview.server";
import { savedPrefix } from "../server/saved.server";
import { serveSaved, serveSavedFile } from "../server/serve.server";
import type { SavedLink } from "../types";

vi.setConfig({ testTimeout: 30_000, hookTimeout: 60_000 });

type Fn = (opts: { data?: unknown; context?: unknown }) => Promise<unknown>;
const call = <T = Record<string, unknown>>(
	fn: unknown,
	u: AuthUser,
	data?: unknown,
) => (fn as Fn)({ data, context: { user: u } }) as Promise<T>;

async function codeOf(p: Promise<unknown>): Promise<string> {
	try {
		await p;
		return "ok";
	} catch (e) {
		return errorCode(e) ?? `unexpected: ${(e as Error).message}`;
	}
}

async function newUser(first: string): Promise<AuthUser> {
	const id = randomUUID();
	await getDb()
		.insert(user)
		.values({
			id,
			email: `u-${id}@example.test`,
			emailVerified: true,
			name: `${first} Test`,
			firstName: first,
			lastName: "Test",
			isAnonymous: false,
		});
	const [row] = await getDb()
		.select()
		.from(user)
		.where(sql`${user.id} = ${id}`);
	sessions.byId.set(id, row);
	return row as unknown as AuthUser;
}

const list = (u: AuthUser) => call<SavedLink[]>(listSavedLinks, u);
const save = (u: AuthUser, data: Record<string, unknown>) =>
	call<{ id: string }>(saveSharedLink, u, data);

let trip: FixtureClone;
const U = {} as Record<"me" | "other" | "viewer", AuthUser>;

beforeAll(async () => {
	await ensureDatabase(testEnv.scratchUrl);
	await migrateDatabase(testEnv.scratchUrl);
	await ensureBucket();
	U.me = await newUser("Dennis");
	U.other = await newUser("Maya");
	U.viewer = await newUser("Vic");
	trip = await cloneDemoTrip(getDb(), U.me.id);
	await getDb().insert(tripMembers).values({
		tripId: trip.tripId,
		userId: U.viewer.id,
		status: "active",
		role: "viewer",
		color: 5,
	});
});

afterAll(async () => {
	await closeQueues().catch(() => {});
	const keys = await redis().keys(`${redisPrefix()}:*`);
	if (keys.length) await redis().del(...keys);
	await closeRedis();
	await closeDb();
	await dropDatabase(testEnv.scratchUrl);
	await dropDatabase(testEnv.oldUrl).catch(() => {});
});

describe("saving", () => {
	it("the app saves a link and the words around it; a retried upload saves once", async () => {
		const u = await newUser("Sol");
		const a = await save(u, {
			url: "https://www.tiktok.com/@kyoto.eats/video/7300000000000000301",
			text: "Matcha parfait at Tsujiri https://www.tiktok.com/@kyoto.eats/video/7300000000000000301",
			clientId: "share-abc",
		});
		const again = await save(u, {
			url: "https://www.tiktok.com/@kyoto.eats/video/7300000000000000301",
			clientId: "share-abc",
		});
		expect(again.id).toBe(a.id);
		const [l] = await list(u);
		expect(l).toMatchObject({
			id: a.id,
			url: "https://www.tiktok.com/@kyoto.eats/video/7300000000000000301",
			text: "Matcha parfait at Tsujiri",
			provider: "tiktok",
			embedId: "7300000000000000301",
			status: "pending",
			image: null,
		});
		expect(await codeOf(save(u, { text: "  " }))).toBe("VALIDATION");
	});

	it("the Shortcut saves into the phone owner's Saved", async () => {
		const u = await newUser("Ivy");
		const code = await newPairingCode(getDb(), u.id);
		const r = await pair(getDb(), code, "Ivy's iPhone");
		if (!r.ok) throw new Error("pair failed");
		const check = await checkKey(r.key);
		if (!check.ok) throw new Error("key should work");
		await saveShare(
			getDb(),
			check.device,
			shareInput("Ramen https://www.instagram.com/reel/C0SAVED01/?igsh=x"),
		);
		expect((await list(u)).map((l) => [l.provider, l.text])).toEqual([
			["instagram", "Ramen"],
		]);
	});
});

describe("the list", () => {
	it("only mine, newest first; added and deleted ones leave it", async () => {
		const u = await newUser("Lee");
		const first = await save(u, { url: "https://a.example/1" });
		const second = await save(u, { url: "https://b.example/2" });
		const third = await save(u, { text: "Onibus Coffee, Nakameguro" });
		await save(U.other, { url: "https://c.example/3" });
		expect((await list(u)).map((l) => l.id)).toEqual([
			third.id,
			second.id,
			first.id,
		]);
		await getDb().insert(tripMembers).values({
			tripId: trip.tripId,
			userId: u.id,
			status: "active",
			role: "editor",
			color: 7,
		});
		await call(markSavedAdded, u, {
			id: second.id,
			tripId: trip.tripId,
			nodeId: trip.ids.nodes.tokyo,
		});
		await call(deleteSavedLinks, u, { ids: [first.id] });
		expect((await list(u)).map((l) => l.id)).toEqual([third.id]);
		const rows = (
			await getDb().execute(sql`
				select id::text as id, added_trip_id::text as "tripId", added_node_id::text as "nodeId",
				       added_at is not null as added, deleted_at is not null as deleted
				  from saved_links where user_id = ${u.id} order by created_at`)
		).rows;
		expect(rows).toEqual([
			{ id: first.id, tripId: null, nodeId: null, added: false, deleted: true },
			{
				id: second.id,
				tripId: trip.tripId,
				nodeId: trip.ids.nodes.tokyo,
				added: true,
				deleted: false,
			},
			{
				id: third.id,
				tripId: null,
				nodeId: null,
				added: false,
				deleted: false,
			},
		]);
	});

	it("someone else's link can't be added, deleted or seen", async () => {
		const mine = await save(U.me, { url: "https://mine.example/x" });
		expect(
			await codeOf(
				call(markSavedAdded, U.other, {
					id: mine.id,
					tripId: trip.tripId,
					nodeId: null,
				}),
			),
		).toBe("NOT_FOUND");
		expect(await call(deleteSavedLinks, U.other, { ids: [mine.id] })).toEqual({
			ids: [],
		});
		expect((await list(U.other)).some((l) => l.id === mine.id)).toBe(false);
		expect((await list(U.me)).some((l) => l.id === mine.id)).toBe(true);
	});

	it("only a trip I can add to takes it (a viewer's trip doesn't)", async () => {
		const l = await save(U.viewer, { url: "https://viewer.example/x" });
		expect(
			await codeOf(
				call(markSavedAdded, U.viewer, {
					id: l.id,
					tripId: trip.tripId,
					nodeId: null,
				}),
			),
		).toBe("NOT_FOUND");
		expect((await list(U.viewer)).map((x) => x.id)).toContain(l.id);
	});
});

const png = (w: number, h: number) =>
	sharp({
		create: { width: w, height: h, channels: 3, background: "#2f7d5b" },
	})
		.png()
		.toBuffer();

describe("previews", () => {
	it("re-hosts a TikTok's picture under the user, served to its owner only", async () => {
		const poster = await png(90, 160);
		const stub: SafeFetcher = async (url) => {
			if (url.startsWith("https://www.tiktok.com/oembed"))
				return {
					status: 200,
					headers: {},
					finalUrl: url,
					contentType: "application/json",
					body: Buffer.from(
						JSON.stringify({
							title: "Golden Gai at night",
							author_name: "nightowl",
							thumbnail_url: "https://p16.tiktokcdn.com/stub.jpeg",
						}),
					),
				};
			if (url.includes("tiktokcdn"))
				return {
					status: 200,
					headers: {},
					finalUrl: url,
					contentType: "image/png",
					body: poster,
				};
			throw new Error(`unexpected fetch ${url}`);
		};
		const { id } = await save(U.me, {
			url: "https://www.tiktok.com/@nightowl/video/7300000000000000009",
		});
		await savedPreview({ userId: U.me.id, savedId: id }, stub);
		const l = (await list(U.me)).find((x) => x.id === id);
		expect(l).toMatchObject({
			status: "ready",
			previewTitle: "Golden Gai at night",
			author: "nightowl",
			siteName: "TikTok",
			imageW: 90,
			imageH: 160,
		});
		expect(l?.image).toMatch(new RegExp(`^/api/saved/${id}/image\\?v=`));
		expect(
			await headObject(`${savedPrefix(U.me.id, id)}image.webp`),
		).not.toBeNull();
		const get = (who: AuthUser | null) =>
			serveSaved(
				new Request(`http://localhost/api/saved/${id}/image`, {
					headers: who ? { "x-test-user": who.id } : {},
				}),
				id,
				"image",
			);
		const mine = await get(U.me);
		expect(mine.status).toBe(200);
		expect(mine.headers.get("content-type")).toBe("image/webp");
		expect((await get(U.other)).status).toBe(404);
		expect((await get(null)).status).toBe(404);
		// Deleted, it's gone from the grid and its picture too; the purge takes the objects.
		await call(deleteSavedLinks, U.me, { ids: [id] });
		expect((await get(U.me)).status).toBe(404);
		await getDb().execute(
			sql`update saved_links set deleted_at = now() - interval '31 days' where id = ${id}`,
		);
		await purge(getDb());
		expect(
			await headObject(`${savedPrefix(U.me.id, id)}image.webp`),
		).toBeNull();
	});

	it("a Maps link gets its place, and the trip that has it", async () => {
		const tokyo = (
			await getDb().execute(
				sql`select lat, lng from nodes where id = ${trip.ids.nodes.tokyo}`,
			)
		).rows[0] as { lat: number; lng: number };
		const url = `https://www.google.com/maps/place/Kissa+Saved/@${tokyo.lat + 0.01},${tokyo.lng},17z`;
		const { id } = await save(U.me, { url });
		const noFetch: SafeFetcher = async (u) => {
			throw new Error(`unexpected fetch ${u}`);
		};
		await savedPreview({ userId: U.me.id, savedId: id }, noFetch, async () => ({
			core: null,
			link: { lat: tokyo.lat + 0.01, lng: tokyo.lng, name: "Kissa Saved" },
		}));
		const l = (await list(U.me)).find((x) => x.id === id);
		expect(l).toMatchObject({
			status: "ready",
			previewTitle: "Kissa Saved",
			siteName: "Google Maps",
			place: { name: "Kissa Saved", lng: tokyo.lng },
			nearTrips: [trip.tripId],
		});
		// A viewer of that trip gets no pick (they can't add to it).
		const v = await save(U.viewer, { url });
		await savedPreview(
			{ userId: U.viewer.id, savedId: v.id },
			noFetch,
			async () => ({
				core: null,
				link: { lat: tokyo.lat + 0.01, lng: tokyo.lng },
			}),
		);
		expect(
			(await list(U.viewer)).find((x) => x.id === v.id)?.nearTrips,
		).toEqual([]);
	});
});

describe("one waiting row per link", () => {
	it("saving a link already in Saved answers that row, until it's deleted or added", async () => {
		const u = await newUser("Dee");
		const a = await save(u, {
			url: "https://www.instagram.com/reel/C0DEDUPE1/?igsh=abc",
		});
		// The same post, shared again (other tracking, from the Shortcut).
		const b = await save(u, {
			url: "https://www.instagram.com/reel/C0DEDUPE1/?igsh=xyz",
			text: "again",
		});
		const code = await newPairingCode(getDb(), u.id);
		const r = await pair(getDb(), code, "Dee's iPhone");
		if (!r.ok) throw new Error("pair failed");
		const check = await checkKey(r.key);
		if (!check.ok) throw new Error("key should work");
		const c = await saveShare(
			getDb(),
			check.device,
			shareInput("https://www.instagram.com/reel/C0DEDUPE1/"),
		);
		expect([b.id, c.id]).toEqual([a.id, a.id]);
		expect((await list(u)).map((l) => l.id)).toEqual([a.id]);
		// Deleted: a new one; Undo of the old one is then refused.
		await call(deleteSavedLinks, u, { ids: [a.id] });
		const d = await save(u, {
			url: "https://www.instagram.com/reel/C0DEDUPE1/",
		});
		expect(d.id).not.toBe(a.id);
		expect(await codeOf(call(restoreSavedLinks, u, { ids: [a.id] }))).toBe(
			"CONFLICT",
		);
	});

	it("Undo restores deleted ones, only mine", async () => {
		const u = await newUser("Uma");
		const a = await save(u, { url: "https://undo.example/a" });
		const b = await save(u, { url: "https://undo.example/b" });
		expect(await call(deleteSavedLinks, u, { ids: [a.id, b.id] })).toEqual({
			ids: [a.id, b.id],
		});
		expect(await list(u)).toEqual([]);
		expect(
			await call(restoreSavedLinks, U.other, { ids: [a.id, b.id] }),
		).toEqual({ ids: [] });
		await call(restoreSavedLinks, u, { ids: [a.id, b.id] });
		expect((await list(u)).map((l) => l.id).sort()).toEqual(
			[a.id, b.id].sort(),
		);
	});
});

const jpeg = (w = 64, h = 48) =>
	sharp({ create: { width: w, height: h, channels: 3, background: "#c84" } })
		.jpeg()
		.toBuffer();

/** A shared photo up to Saved as the share page does it: start, PUT, complete. */
async function upPhoto(
	u: AuthUser,
	clientId: string,
	position: number,
	body: Buffer,
) {
	const s = await call<{
		savedId: string;
		fileId: string;
		done: boolean;
		url?: string;
	}>(startSavedUpload, u, {
		clientId,
		position,
		type: "image/jpeg",
		size: body.length,
	});
	if (s.done) return s;
	const put = await fetch(s.url as string, {
		method: "PUT",
		body: new Uint8Array(body),
		headers: { "content-type": "image/jpeg" },
	});
	expect(put.status).toBe(200);
	const done = await call<{ savedId: string; done: boolean }>(
		completeSavedUpload,
		u,
		{ id: s.fileId },
	);
	return { ...s, ...done };
}

describe("photos and videos", () => {
	it("a share of two photos is one item once both are up, with thumbnails, counting against my quota", async () => {
		const u = await newUser("Pia");
		const [one, two] = [await jpeg(), await jpeg(80, 60)];
		const first = await upPhoto(u, "share-photos-1", 0, one);
		expect(first.done).toBe(true);
		// Only the first is up so far: a second file started, not finished.
		const started = await call<{ fileId: string; done: boolean }>(
			startSavedUpload,
			u,
			{
				clientId: "share-photos-1",
				position: 1,
				type: "image/jpeg",
				size: two.length,
			},
		);
		expect(started.done).toBe(false);
		expect(await list(u)).toEqual([]);
		// The page closed; next time it starts again, and finishes.
		const second = await upPhoto(u, "share-photos-1", 1, two);
		expect(second.done).toBe(true);
		expect(second.savedId).toBe(first.savedId);
		expect((await upPhoto(u, "share-photos-1", 0, one)).done).toBe(true);
		for (const f of [first.fileId, second.fileId])
			await savedFileVariants({ userId: u.id, fileId: f });
		const [item] = await list(u);
		expect(item?.id).toBe(first.savedId);
		expect(item?.files.map((f) => [f.kind, f.status, f.hasThumb])).toEqual([
			["photo", "ready", true],
			["photo", "ready", true],
		]);
		expect(await usedBytes(getDb(), u.id)).toBe(one.length + two.length);
		// Someone else can't touch them.
		expect(
			await codeOf(call(completeSavedUpload, U.other, { id: first.fileId })),
		).toBe("NOT_FOUND");
		expect(
			await codeOf(
				call(signSavedUploadParts, U.other, { id: first.fileId, parts: [1] }),
			),
		).toBe("NOT_FOUND");
		const thumb = await serveSavedFile(
			new Request("http://localhost/x", { headers: { "x-test-user": u.id } }),
			first.fileId,
			"thumb",
		);
		expect(thumb.status).toBe(200);
		expect(
			(
				await serveSavedFile(
					new Request("http://localhost/x", {
						headers: { "x-test-user": U.other.id },
					}),
					first.fileId,
					"thumb",
				)
			).status,
		).toBe(404);
	});

	it("over the quota: refused with the quota message", async () => {
		const u = await newUser("Qin");
		await getDb().execute(
			sql`update "user" set storage_quota_bytes = 100 where id = ${u.id}`,
		);
		expect(
			await codeOf(
				call(startSavedUpload, u, {
					clientId: "share-big",
					position: 0,
					type: "image/jpeg",
					size: 5000,
				}),
			),
		).toBe("STORAGE_QUOTA");
	});

	it("added to a trip, the photos are re-referenced and count once; deleting frees only what no trip uses", async () => {
		const u = await newUser("Ari");
		const c = await cloneDemoTrip(getDb(), u.id);
		// The demo trip's own uploads are mine too.
		const base = await usedBytes(getDb(), u.id);
		const kept = await jpeg(120, 90);
		const dropped = await jpeg(50, 50);
		const a = await upPhoto(u, "share-kept", 0, kept);
		const b = await upPhoto(u, "share-dropped", 0, dropped);
		await savedFileVariants({ userId: u.id, fileId: a.fileId });
		expect(await usedBytes(getDb(), u.id)).toBe(
			base + kept.length + dropped.length,
		);
		// A viewer of the trip can't put them there; the owner can.
		await getDb().insert(tripMembers).values({
			tripId: c.tripId,
			userId: U.viewer.id,
			status: "active",
			role: "viewer",
			color: 4,
		});
		expect(
			await codeOf(
				call(attachSavedFiles, U.viewer, {
					savedId: a.savedId,
					tripId: c.tripId,
					nodeId: c.ids.nodes.tokyo,
				}),
			),
		).not.toBe("ok");
		expect(
			await call(attachSavedFiles, u, {
				savedId: a.savedId,
				tripId: c.tripId,
				nodeId: c.ids.nodes.tokyo,
			}),
		).toEqual({ count: 1 });
		const att = (
			await getDb().execute(sql`
				select storage_key as key, status, kind from attachments
				 where trip_id = ${c.tripId} and starts_with(storage_key, 'saved/')`)
		).rows;
		expect(att).toEqual([
			{ key: `saved/${u.id}/${a.fileId}/`, status: "ready", kind: "photo" },
		]);
		await call(markSavedAdded, u, {
			id: a.savedId,
			tripId: c.tripId,
			nodeId: c.ids.nodes.tokyo,
		});
		// Counted once, in Saved and in the trip.
		expect(await usedBytes(getDb(), u.id)).toBe(
			base + kept.length + dropped.length,
		);
		// Deleting the other frees its space at once; Undo takes it back.
		await call(deleteSavedLinks, u, { ids: [b.savedId] });
		expect(await usedBytes(getDb(), u.id)).toBe(base + kept.length);
		await call(restoreSavedLinks, u, { ids: [b.savedId] });
		expect(await usedBytes(getDb(), u.id)).toBe(
			base + kept.length + dropped.length,
		);
		// The purge takes a deleted one's objects, but not ones a trip uses.
		await getDb().execute(sql`
			update saved_links set deleted_at = now() - interval '31 days'
			 where id in (${a.savedId}, ${b.savedId})`);
		await purge(getDb());
		expect(await headObject(`saved/${u.id}/${b.fileId}/original`)).toBeNull();
		expect(
			await headObject(`saved/${u.id}/${a.fileId}/original`),
		).not.toBeNull();
		expect(await usedBytes(getDb(), u.id)).toBe(base + kept.length);
	});
});

describe("migration 0025", () => {
	it("moves the Shortcut's waiting links into Saved", async () => {
		const src = path.resolve(__dirname, "../../../../drizzle");
		const dir = mkdtempSync(path.join(tmpdir(), "yonder-mig-"));
		try {
			cpSync(src, dir, { recursive: true });
			const journalPath = path.join(dir, "meta/_journal.json");
			const journal = JSON.parse(readFileSync(journalPath, "utf8")) as {
				entries: { idx: number }[];
			};
			journal.entries = journal.entries.filter((e) => e.idx <= 24);
			writeFileSync(journalPath, JSON.stringify(journal));
			await ensureDatabase(testEnv.oldUrl);
			await migrateDatabase(testEnv.oldUrl, { migrationsFolder: dir });
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
		const { createDb } = await import("@/db/db.server");
		const { db, pool } = createDb({ connectionString: testEnv.oldUrl, max: 1 });
		try {
			const uid = randomUUID();
			const id = randomUUID();
			await db.execute(sql`
				insert into "user" (id, email, email_verified, name, first_name, last_name, is_anonymous, created_at, updated_at)
				values (${uid}, ${`m-${uid}@example.test`}, true, 'Mo Test', 'Mo', 'Test', false, now(), now())`);
			await db.execute(sql`
				insert into shortcut_shares (id, user_id, url, text, created_at)
				values (${id}, ${uid}, 'https://www.tiktok.com/@a/video/7305', 'Hojicha', now() - interval '3 days')`);
			await migrateDatabase(testEnv.oldUrl);
			const rows = (
				await db.execute(sql`
					select id::text as id, user_id as "userId", url, text, preview_status as status,
					       created_at < now() - interval '2 days' as old
					  from saved_links`)
			).rows;
			expect(rows).toEqual([
				{
					id,
					userId: uid,
					url: "https://www.tiktok.com/@a/video/7305",
					text: "Hojicha",
					status: "pending",
					old: true,
				},
			]);
			const gone = await db.execute(
				sql`select to_regclass('public.shortcut_shares') as t`,
			);
			expect((gone.rows[0] as { t: string | null }).t).toBeNull();
		} finally {
			await pool.end();
		}
	});
});
