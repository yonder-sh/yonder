/**
 * Web Push against real Postgres and Redis (isolated scratch database and
 * prefix): the subscription store and settings, delivery (404/410 removes a
 * device), and the pipeline from a committed transaction to a sent payload
 * (outbox hook → `push.events` → coalescing → flush), with the recipient
 * rules: never the actor, per-type switches, per-trip mute, and nothing the
 * person already read in the in-app inbox. `web-push` itself is replaced by
 * a recording sender.
 */
import { createECDH, randomBytes, randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import {
	afterAll,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from "vitest";

const testEnv = vi.hoisted(() => {
	const hex = Math.random().toString(16).slice(2, 10);
	const base = process.env.DATABASE_URL_TEST ?? process.env.DATABASE_URL;
	if (!base) throw new Error("DATABASE_URL(_TEST) must be set");
	const scratch = new URL(base);
	scratch.pathname = `/yonder_push_${hex}`;
	process.env.DATABASE_URL = scratch.toString();
	process.env.REDIS_PREFIX = `yonder-pushtest-${hex}`;
	process.env.BETTER_AUTH_SECRET ||= "test-secret-test-secret-test-secret-00";
	process.env.VAPID_PUBLIC_KEY =
		"BL8nGtlMWTWHbho97EdCXL2AUtdNmErDGu9ACAvCLk-j_0Y0h4tqYtTUMutMo3NshvDRpjKskvzt5CYPLLiuASs";
	process.env.VAPID_PRIVATE_KEY = "LHJAuFimLROyMAsa1zxQwx6JwE0UR1HSrRs5luubL-8";
	process.env.VAPID_SUBJECT = "mailto:support@yonder.sh";
	return { hex, scratchUrl: scratch.toString() };
});

vi.mock("@tanstack/react-start", () => import("@/test/start-mock"));
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
import type { PushEventsJob } from "@/lib/push/jobs";
import type { PushPayload } from "@/lib/push/types";
import { cloneDemoTrip } from "@/server/fixture.server";
import { closeQueues, getQueue } from "@/server/live/jobs.server";
import { closeRedis, redis, redisPrefix } from "@/server/live/redis.server";
import { syncMentions } from "@/server/mentions.server";
import { withTripTx } from "@/server/tx.server";
import { handlePushEvents, handlePushFlush } from "./handlers.server";
import { deliver, type PushSender, setPushSenderForTests } from "./send.server";
import {
	deleteSubscription,
	getSettings,
	isPushEndpoint,
	listSubscriptions,
	MAX_DEVICES,
	mutedTrips,
	saveSubscription,
	setTripMuted,
	setTypeEnabled,
	settingsFor,
	subscribedUsers,
	tripHasSubscribers,
} from "./store.server";

vi.setConfig({ testTimeout: 30_000, hookTimeout: 60_000 });

const db = () => getDb();
/** A real browser-style key pair (the store refuses points off the curve). */
const P256 = (() => {
	const ecdh = createECDH("prime256v1");
	ecdh.generateKeys();
	return ecdh.getPublicKey().toString("base64url");
})();
const AUTH = randomBytes(16).toString("base64url");
const AUTH2 = randomBytes(16).toString("base64url");
const endpoint = (tag: string = randomUUID()) =>
	`https://fcm.googleapis.com/fcm/send/${tag}`;

type U = { id: string; name: string };
async function newUser(first: string): Promise<U> {
	const id = randomUUID();
	await db()
		.insert(user)
		.values({
			id,
			email: `u-${id}@example.test`,
			emailVerified: true,
			name: `${first} Tester`,
			firstName: first,
			lastName: "Tester",
			isAnonymous: false,
		});
	return { id, name: `${first} Tester` };
}

type Trip = {
	tripId: string;
	name: string;
	ownerMember: string;
	mayaMember: string;
	items: string[];
};

async function freshTrip(owner: U, maya: U): Promise<Trip> {
	const c = await cloneDemoTrip(db(), owner.id);
	const mayaMember = randomUUID();
	await db().insert(tripMembers).values({
		id: mayaMember,
		tripId: c.tripId,
		userId: maya.id,
		status: "active",
		role: "suggester",
		color: 2,
	});
	const t = (
		await db().execute(sql`select name from trips where id = ${c.tripId}`)
	).rows[0] as { name: string };
	return {
		tripId: c.tripId,
		name: t.name,
		ownerMember: c.members.owner,
		mayaMember,
		items: Object.values(c.ids.items),
	};
}

/** What the recording sender got, per endpoint. */
let sent: { endpoint: string; payload: PushPayload }[] = [];
let answer: (endpoint: string) => number = () => 201;
const recorder: PushSender = async (sub, body) => {
	const statusCode = answer(sub.endpoint);
	if (statusCode >= 400)
		throw Object.assign(new Error(`status ${statusCode}`), { statusCode });
	sent.push({ endpoint: sub.endpoint, payload: JSON.parse(body) });
	return { statusCode };
};

beforeAll(async () => {
	await ensureDatabase(testEnv.scratchUrl);
	await migrateDatabase(testEnv.scratchUrl);
	setPushSenderForTests(recorder);
});

beforeEach(() => {
	sent = [];
	answer = () => 201;
});

afterAll(async () => {
	setPushSenderForTests(null);
	await closeQueues().catch(() => {});
	const r = redis();
	let cursor = "0";
	do {
		const [next, keys] = await r.scan(
			cursor,
			"MATCH",
			`${redisPrefix()}:*`,
			"COUNT",
			500,
		);
		cursor = next;
		if (keys.length) await r.unlink(...keys);
	} while (cursor !== "0");
	await closeRedis();
	await closeDb();
	await dropDatabase(testEnv.scratchUrl);
});

describe("subscription store", () => {
	it("only https endpoints of known push services", () => {
		expect(isPushEndpoint(endpoint())).toBe(true);
		expect(isPushEndpoint("https://web.push.apple.com/QGx")).toBe(true);
		expect(
			isPushEndpoint("https://updates.push.services.mozilla.com/wpush/v2/x"),
		).toBe(true);
		expect(isPushEndpoint("http://fcm.googleapis.com/fcm/send/x")).toBe(false);
		expect(isPushEndpoint("https://evil.example/fcm.googleapis.com")).toBe(
			false,
		);
		expect(isPushEndpoint("https://fcm.googleapis.com:8443/x")).toBe(false);
		expect(isPushEndpoint("https://10.0.0.1/x")).toBe(false);
	});

	it("saves per device, moves a device to whoever signs in on it, deletes only your own", async () => {
		const a = await newUser("Ana");
		const b = await newUser("Ben");
		const e1 = endpoint();
		const e2 = endpoint();
		await saveSubscription(db(), a.id, {
			endpoint: e1,
			p256dh: P256,
			auth: AUTH,
		});
		await saveSubscription(db(), a.id, {
			endpoint: e2,
			p256dh: P256,
			auth: AUTH,
			userAgent: "Firefox",
		});
		// Saving again is an upsert (new keys win).
		await saveSubscription(db(), a.id, {
			endpoint: e1,
			p256dh: P256,
			auth: AUTH2,
		});
		expect(
			(await listSubscriptions(db(), [a.id])).map((s) => [s.endpoint, s.auth]),
		).toEqual([
			[e1, AUTH2],
			[e2, AUTH],
		]);
		// Ben signs in on the device behind e1: it is his now.
		await saveSubscription(db(), b.id, {
			endpoint: e1,
			p256dh: P256,
			auth: AUTH,
		});
		expect(
			(await listSubscriptions(db(), [a.id])).map((s) => s.endpoint),
		).toEqual([e2]);
		expect(await subscribedUsers(db(), [a.id, b.id])).toEqual(
			new Set([a.id, b.id]),
		);
		// Ana can't remove Ben's device.
		expect(await deleteSubscription(db(), a.id, e1)).toBe(false);
		expect(await deleteSubscription(db(), b.id, e1)).toBe(true);
		expect(await subscribedUsers(db(), [b.id])).toEqual(new Set());
		await expect(
			saveSubscription(db(), a.id, {
				endpoint: "https://evil.example/x",
				p256dh: P256,
				auth: AUTH,
			}),
		).rejects.toThrow(/push endpoint/);
		// Keys no browser could have made (not on the curve, wrong length).
		await expect(
			saveSubscription(db(), a.id, {
				endpoint: endpoint(),
				p256dh: `B${"A".repeat(86)}`,
				auth: AUTH,
			}),
		).rejects.toThrow(/unusable/);
		await expect(
			saveSubscription(db(), a.id, {
				endpoint: endpoint(),
				p256dh: P256,
				auth: "short",
			}),
		).rejects.toThrow(/unusable/);
	});

	it(`keeps at most ${MAX_DEVICES} devices per person (the least recently used go)`, async () => {
		const a = await newUser("Many");
		const first = endpoint("first");
		await saveSubscription(db(), a.id, {
			endpoint: first,
			p256dh: P256,
			auth: AUTH,
		});
		await db().execute(
			sql`update push_subscriptions set created_at = now() - interval '1 day' where endpoint = ${first}`,
		);
		for (let i = 0; i < MAX_DEVICES; i++)
			await saveSubscription(db(), a.id, {
				endpoint: endpoint(),
				p256dh: P256,
				auth: AUTH,
			});
		const left = await listSubscriptions(db(), [a.id]);
		expect(left).toHaveLength(MAX_DEVICES);
		expect(left.map((s) => s.endpoint)).not.toContain(first);
	});

	it("per-type switches (opt-out) and per-trip mutes", async () => {
		const a = await newUser("Pref");
		const maya = await newUser("Maya");
		const t = await freshTrip(a, maya);
		expect(await getSettings(db(), a.id)).toEqual({
			offTypes: [],
			mutedTripIds: [],
		});
		expect(await setTypeEnabled(db(), a.id, "today", false)).toEqual(["today"]);
		expect(await setTypeEnabled(db(), a.id, "today", false)).toEqual(["today"]);
		expect(await setTypeEnabled(db(), a.id, "review", false)).toEqual([
			"today",
			"review",
		]);
		expect(await setTypeEnabled(db(), a.id, "today", true)).toEqual(["review"]);
		await setTripMuted(db(), a.id, t.tripId, true);
		await setTripMuted(db(), a.id, t.tripId, true);
		expect(await getSettings(db(), a.id)).toEqual({
			offTypes: ["review"],
			mutedTripIds: [t.tripId],
		});
		expect((await mutedTrips(db(), a.id)).map((m) => m.name)).toEqual([t.name]);
		const map = await settingsFor(db(), [a.id, maya.id]);
		expect(map.has(maya.id)).toBe(false);
		await setTripMuted(db(), a.id, t.tripId, false);
		expect((await getSettings(db(), a.id)).mutedTripIds).toEqual([]);
	});

	it("tripHasSubscribers: members (and live link guests) with a device", async () => {
		const a = await newUser("Own");
		const maya = await newUser("Maya");
		const t = await freshTrip(a, maya);
		expect(await tripHasSubscribers(db(), t.tripId)).toBe(false);
		await saveSubscription(db(), maya.id, {
			endpoint: endpoint(),
			p256dh: P256,
			auth: AUTH,
		});
		expect(await tripHasSubscribers(db(), t.tripId)).toBe(true);
	});

	it("an account's devices and settings go with it", async () => {
		const a = await newUser("Gone");
		const maya = await newUser("Maya");
		const t = await freshTrip(maya, a);
		await saveSubscription(db(), a.id, {
			endpoint: endpoint(),
			p256dh: P256,
			auth: AUTH,
		});
		await setTypeEnabled(db(), a.id, "mention", false);
		await setTripMuted(db(), a.id, t.tripId, true);
		await db().execute(sql`delete from trip_members where user_id = ${a.id}`);
		await db().execute(sql`delete from "user" where id = ${a.id}`);
		const left = await db().execute(sql`
			select (select count(*) from push_subscriptions where user_id = ${a.id})::int
			     + (select count(*) from notification_prefs where user_id = ${a.id})::int
			     + (select count(*) from notification_mutes where user_id = ${a.id})::int as n`);
		expect((left.rows[0] as { n: number }).n).toBe(0);
	});
});

describe("delivery", () => {
	it("marks a device used; a 404/410 removes it; other failures keep it", async () => {
		const a = await newUser("Dev");
		const ok = endpoint("ok");
		const gone = endpoint("gone");
		const flaky = endpoint("flaky");
		for (const e of [ok, gone, flaky])
			await saveSubscription(db(), a.id, {
				endpoint: e,
				p256dh: P256,
				auth: AUTH,
			});
		answer = (e) => (e === gone ? 410 : e === flaky ? 500 : 201);
		const payload: PushPayload = {
			title: "T · hi",
			body: "b",
			url: "/",
			tag: "x",
			ts: 1,
		};
		const r = await deliver(
			db(),
			await listSubscriptions(db(), [a.id]),
			payload,
			"mention",
		);
		expect(r).toEqual({ sent: 1, removed: 1, failed: 1 });
		const rows = (
			await db().execute(sql`
				select endpoint, last_used_at is not null as used from push_subscriptions
				 where user_id = ${a.id} order by endpoint`)
		).rows as { endpoint: string; used: boolean }[];
		expect(rows).toEqual([
			{ endpoint: flaky, used: false },
			{ endpoint: ok, used: true },
		]);
		answer = () => 404;
		await deliver(
			db(),
			await listSubscriptions(db(), [a.id]),
			payload,
			"mention",
		);
		expect(await listSubscriptions(db(), [a.id])).toEqual([]);
	});

	it("push off (no config): nothing is sent", async () => {
		const a = await newUser("Off");
		await saveSubscription(db(), a.id, {
			endpoint: endpoint(),
			p256dh: P256,
			auth: AUTH,
		});
		const r = await deliver(
			db(),
			await listSubscriptions(db(), [a.id]),
			{ title: "t", body: "", url: "/", tag: "x", ts: 1 },
			"mention",
			{ config: null },
		);
		expect(r).toEqual({ sent: 0, removed: 0, failed: 0 });
		expect(sent).toEqual([]);
	});
});

describe("pipeline", () => {
	let dennis: U;
	let maya: U;
	let t: Trip;
	let mayaDevice: string;
	let dennisDevice: string;

	beforeAll(async () => {
		dennis = await newUser("Dennis");
		maya = await newUser("Maya");
		t = await freshTrip(dennis, maya);
		mayaDevice = endpoint("maya");
		dennisDevice = endpoint("dennis");
		await saveSubscription(db(), maya.id, {
			endpoint: mayaDevice,
			p256dh: P256,
			auth: AUTH,
		});
		await saveSubscription(db(), dennis.id, {
			endpoint: dennisDevice,
			p256dh: P256,
			auth: AUTH,
		});
	});

	/** The `push.events` jobs the outbox queued (then removed from the queue). */
	async function takeEventJobs(): Promise<PushEventsJob[]> {
		const jobs = await getQueue("push").getJobs([
			"waiting",
			"delayed",
			"prioritized",
		]);
		const out: PushEventsJob[] = [];
		for (const j of jobs)
			if (j.name === "push.events") {
				out.push(j.data as PushEventsJob);
				await j.remove();
			}
		return out;
	}

	/** Mentions Maya in an item note, as Dennis, through the real outbox. */
	async function mentionMaya(
		itemId: string,
		text: string,
	): Promise<PushEventsJob[]> {
		await withTripTx(
			t.tripId,
			async (tx, out) => {
				await syncMentions(
					tx,
					out,
					t.tripId,
					{ noteItemId: itemId },
					[`${text} [@Maya](mention:${t.mayaMember})`],
					{ createdBy: dennis.id, target: { itemId } },
				);
			},
			{ actor: { userId: dennis.id, name: dennis.name, color: 0 } },
		);
		return takeEventJobs();
	}

	const flush = (
		userId: string,
		group: "mention" | "review" | "membership" | "remind",
	) => handlePushFlush({ tripId: t.tripId, userId, group });

	it("a mention: the outbox queues it with its actor; the mentioned person gets one push", async () => {
		const jobs = await mentionMaya(t.items[0] as string, "can you book this?");
		expect(jobs).toHaveLength(1);
		expect(jobs[0]).toMatchObject({
			tripId: t.tripId,
			actor: { userId: dennis.id },
			events: [{ kind: "mention", memberIds: [t.mayaMember] }],
		});
		await handlePushEvents(jobs[0] as PushEventsJob);
		await flush(dennis.id, "mention");
		await flush(maya.id, "mention");
		expect(sent).toHaveLength(1);
		expect(sent[0]?.endpoint).toBe(mayaDevice);
		expect(sent[0]?.payload.title).toMatch(
			new RegExp(`^${t.name} · Dennis mentioned you`),
		);
		expect(sent[0]?.payload.body).toBe("can you book this? @Maya");
		expect(sent[0]?.payload.url).toMatch(/^\/t\/[a-z0-9-]+\?sel=i\./);
		// Flushing again sends nothing (the window was taken).
		await flush(maya.id, "mention");
		expect(sent).toHaveLength(1);
	});

	it("already read in the in-app inbox: no push", async () => {
		const [job] = await mentionMaya(t.items[1] as string, "seen it?");
		await handlePushEvents(job as PushEventsJob);
		await db().execute(sql`
			update mentions set read_at = now() where member_id = ${t.mayaMember} and read_at is null`);
		await flush(maya.id, "mention");
		expect(sent).toEqual([]);
	});

	it("respects the per-trip mute and the per-type switch", async () => {
		await setTripMuted(db(), maya.id, t.tripId, true);
		let [job] = await mentionMaya(t.items[2] as string, "muted");
		await handlePushEvents(job as PushEventsJob);
		await flush(maya.id, "mention");
		expect(sent).toEqual([]);
		await setTripMuted(db(), maya.id, t.tripId, false);

		await setTypeEnabled(db(), maya.id, "mention", false);
		[job] = await mentionMaya(t.items[3] as string, "switched off");
		await handlePushEvents(job as PushEventsJob);
		await flush(maya.id, "mention");
		expect(sent).toEqual([]);
		await setTypeEnabled(db(), maya.id, "mention", true);
	});

	it("suggestions go to reviewers, never the suggester; a burst is one notification", async () => {
		const ids = [randomUUID(), randomUUID(), randomUUID()];
		for (const [i, id] of ids.entries())
			await db().execute(sql`
				insert into proposals (id, trip_id, op, payload, base, entity_kind, summary, status,
				                       author_user_id, author_name, author_color, author_is_guest, created_at)
				values (${id}, ${t.tripId}, 'item.move', '{}', '{"tripVersion":0,"refs":[]}', 'item',
				        ${`moved stop ${i + 1}`}, 'open', ${maya.id}, ${maya.name}, 2, false, now() + ${`${i} seconds`}::interval)`);
		for (const id of ids)
			await handlePushEvents({
				tripId: t.tripId,
				actor: { userId: maya.id, name: maya.name },
				at: Date.now(),
				events: [{ kind: "review", proposalId: id }],
			});
		await flush(maya.id, "review");
		await flush(dennis.id, "review");
		expect(sent).toHaveLength(1);
		expect(sent[0]).toMatchObject({
			endpoint: dennisDevice,
			payload: {
				title: `${t.name} · Maya made 3 suggestions`,
				body: "moved stop 3, moved stop 2 and moved stop 1",
			},
		});
	});

	it("Remind: one push to that person, opening the Rate step", async () => {
		for (const places of [12, 11])
			await handlePushEvents({
				tripId: t.tripId,
				actor: { userId: dennis.id, name: dennis.name },
				at: Date.now(),
				events: [{ kind: "remind", memberId: t.mayaMember, places }],
			});
		await flush(dennis.id, "remind");
		await flush(maya.id, "remind");
		expect(sent).toHaveLength(1);
		expect(sent[0]?.endpoint).toBe(mayaDevice);
		expect(sent[0]?.payload.title).toBe(
			`Dennis reminded you to rate 11 places in ${t.name}`,
		);
		expect(sent[0]?.payload.url).toMatch(
			/^\/t\/[a-z0-9-]+\?tab=places&pv=rate$/,
		);
		// Its own switch.
		sent = [];
		await setTypeEnabled(db(), maya.id, "remind", false);
		await handlePushEvents({
			tripId: t.tripId,
			actor: { userId: dennis.id, name: dennis.name },
			at: Date.now(),
			events: [{ kind: "remind", memberId: t.mayaMember, places: 3 }],
		});
		await flush(maya.id, "remind");
		expect(sent).toEqual([]);
		await setTypeEnabled(db(), maya.id, "remind", true);
	});

	it("never tells the actor about their own change", async () => {
		await handlePushEvents({
			tripId: t.tripId,
			actor: { userId: maya.id, name: maya.name },
			at: Date.now(),
			events: [{ kind: "membership", change: "removed", userId: maya.id }],
		});
		await flush(maya.id, "membership");
		expect(sent).toEqual([]);
		// Someone else changing Maya's role does.
		await handlePushEvents({
			tripId: t.tripId,
			actor: { userId: dennis.id, name: dennis.name },
			at: Date.now(),
			events: [
				{ kind: "membership", change: "role", userId: maya.id, role: "editor" },
			],
		});
		await flush(maya.id, "membership");
		expect(sent.map((s) => s.payload.title)).toEqual([
			`${t.name} · Your role is now Can edit`,
		]);
	});
});
