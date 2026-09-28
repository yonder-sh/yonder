/**
 * Today's Done against real Postgres (a throwaway database): owners, editors
 * and suggesters mark a stop Done directly (never a proposal); raters,
 * viewers and link guests are refused and nothing changes. The stamp is the
 * database's clock, by the marker, with no activity line; the trip's version
 * moves (the live event). Undo clears it; the Undo of an Undo puts the earlier
 * stamp back (never a later one). A stop in Ideas can't be Done, and a stop
 * moved to another day stops being Done.
 */
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import {
	afterAll,
	afterEach,
	beforeAll,
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
	scratch.pathname = `/yonder_done_${hex}`;
	process.env.DATABASE_URL = scratch.toString();
	process.env.REDIS_PREFIX = `yonder-donetest-${hex}`;
	process.env.BETTER_AUTH_SECRET ||= "test-secret-test-secret-test-secret-00";
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
import { user } from "@/db/schema";
import { moveItem, setItemDone } from "@/functions/items.functions";
import type { AuthUser } from "@/server/auth.server";
import { errorCode } from "@/server/authz/errors";
import { openTripLink } from "@/server/authz/share-links.server";
import { cloneDemoTrip, type FixtureClone } from "@/server/fixture.server";
import { loadGraphForServer } from "@/server/graph.server";
import { closeQueues } from "@/server/live/jobs.server";
import { TxOutbox } from "@/server/live/outbox.server";
import { closeRedis, redis, redisPrefix } from "@/server/live/redis.server";
import { resetLink } from "@/server/sharing.server";

vi.setConfig({ testTimeout: 30_000, hookTimeout: 60_000 });

type Fn = (opts: { data?: unknown; context?: unknown }) => Promise<unknown>;
const call = <T = Record<string, unknown>>(
	fn: unknown,
	u: AuthUser,
	data: unknown,
) => (fn as Fn)({ data, context: { user: u } }) as Promise<T>;

async function codeOf(p: Promise<unknown>): Promise<string> {
	try {
		await p;
		return "ok";
	} catch (e) {
		return (
			errorCode(e) ??
			`unexpected: ${e instanceof Error ? e.message : String(e)}`
		);
	}
}

const db = () => getDb();
const q = async <T>(query: ReturnType<typeof sql>) =>
	(await db().execute(query)).rows as T[];
const tick = () => new Promise((r) => setTimeout(r, 5));

async function newUser(first: string, anonymous = false): Promise<AuthUser> {
	const id = randomUUID();
	await db()
		.insert(user)
		.values({
			id,
			email: `${first.toLowerCase()}-${id}@example.test`,
			emailVerified: !anonymous,
			name: anonymous ? `Guest ${first}` : `${first} Test`,
			firstName: anonymous ? "" : first,
			lastName: anonymous ? "" : "Test",
			isAnonymous: anonymous,
		});
	const [row] = await db().select().from(user).where(sql`${user.id} = ${id}`);
	return row as unknown as AuthUser;
}

async function addMember(
	tripId: string,
	u: AuthUser,
	role: "viewer" | "rater" | "editor" | "suggester",
): Promise<void> {
	await db().execute(sql`
		insert into trip_members (id, trip_id, user_id, status, role, color, joined_at)
		values (${randomUUID()}, ${tripId}, ${u.id}, 'active', ${role}, 3, now())`);
}

let owner: AuthUser;
let maya: AuthUser;
let sam: AuthUser;
let rae: AuthUser;
let vic: AuthUser;
let c: FixtureClone;
let sky: string;

type Marked = { doneAt: string | null };
const mark = (
	u: AuthUser,
	itemId: string,
	done: boolean,
	at?: string,
	by?: string,
) =>
	call<Marked>(setItemDone, u, {
		tripId: c.tripId,
		itemId,
		done,
		...(at ? { at } : {}),
		...(by ? { by } : {}),
	});

async function doneMark(itemId: string) {
	const [row] = await q<{ at: Date | null; by: string | null }>(sql`
		select done_at as at, done_by as by from items where id = ${itemId}`);
	return row;
}

async function dbNow(): Promise<number> {
	const [r] = await q<{ t: string | Date }>(sql`select clock_timestamp() as t`);
	return new Date(r?.t as string).getTime();
}

const version = async () =>
	(
		await q<{ v: number }>(
			sql`select version::int as v from trips where id = ${c.tripId}`,
		)
	)[0]?.v ?? 0;
const activity = async () =>
	(
		await q<{ n: number }>(
			sql`select count(*)::int as n from activity_log where trip_id = ${c.tripId}`,
		)
	)[0]?.n ?? 0;
const proposals = async () =>
	(
		await q<{ n: number }>(
			sql`select count(*)::int as n from proposals where trip_id = ${c.tripId}`,
		)
	)[0]?.n ?? 0;

beforeAll(async () => {
	await ensureDatabase(testEnv.scratchUrl);
	await migrateDatabase(testEnv.scratchUrl);
	owner = await newUser("Olga");
	maya = await newUser("Maya");
	sam = await newUser("Sam");
	rae = await newUser("Rae");
	vic = await newUser("Vic");
	c = await cloneDemoTrip(db(), owner.id);
	await addMember(c.tripId, maya, "editor");
	await addMember(c.tripId, sam, "suggester");
	await addMember(c.tripId, rae, "rater");
	await addMember(c.tripId, vic, "viewer");
	sky = c.ids.items.sky as string;
});

afterEach(async () => {
	await db().execute(sql`
		update items set done_at = null, done_by = null where trip_id = ${c.tripId}`);
});

afterAll(async () => {
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

describe("setItemDone", () => {
	it("owners, editors and suggesters mark it directly: the database's clock, by them, no activity line, no proposal", async () => {
		for (const u of [owner, maya, sam]) {
			const before = await dbNow();
			const [v0, a0, p0] = [
				await version(),
				await activity(),
				await proposals(),
			];
			const r = await mark(u, sky, true);
			const row = await doneMark(sky);
			expect(row?.by).toBe(u.id);
			expect(row?.at?.getTime()).toBeGreaterThanOrEqual(before);
			expect(r.doneAt).toBe(row?.at?.toISOString());
			// The live event (the version moves); nothing in the activity log or the proposals.
			expect(await version()).toBe(v0 + 1);
			expect(await activity()).toBe(a0);
			expect(await proposals()).toBe(p0);
			await mark(u, sky, false);
		}
	});

	it("the graph carries it to everyone on the trip", async () => {
		await mark(maya, sky, true);
		const g = await loadGraphForServer(db(), c.tripId);
		const item = g?.items.find((i) => i.id === sky);
		expect(item?.doneBy).toBe(maya.id);
		expect(item?.doneAt).toBe((await doneMark(sky))?.at?.toISOString());
	});

	it("raters and viewers are refused, and the mark stays as it was; strangers don't see the trip", async () => {
		await mark(owner, sky, true);
		const was = await doneMark(sky);
		for (const u of [rae, vic]) {
			expect(await codeOf(mark(u, sky, false))).toBe("FORBIDDEN");
			expect(await codeOf(mark(u, sky, true))).toBe("FORBIDDEN");
		}
		expect(await codeOf(mark(await newUser("Stan"), sky, false))).toBe(
			"NOT_FOUND",
		);
		expect(await doneMark(sky)).toEqual(was);
	});

	it("link guests are refused, even on a Can edit link", async () => {
		const out = new TxOutbox(c.tripId);
		const slug = await db().transaction((tx) =>
			resetLink(tx, out, c.tripId, "editor", owner.id),
		);
		const guest = await newUser("Heron", true);
		expect((await openTripLink(slug, guest.id))?.role).toBe("editor");
		expect(await codeOf(mark(guest, sky, true))).toBe("FORBIDDEN");
		expect(await doneMark(sky)).toEqual({ at: null, by: null });
	});

	it("Undo clears it", async () => {
		await mark(sam, sky, true);
		const r = await mark(sam, sky, false);
		expect(r.doneAt).toBeNull();
		expect(await doneMark(sky)).toEqual({ at: null, by: null });
	});

	it("the Undo of an Undo puts the earlier stamp and marker back, never a later stamp", async () => {
		const first = await mark(maya, sky, true);
		await mark(owner, sky, false);
		await tick();
		const back = await mark(owner, sky, true, first.doneAt as string, maya.id);
		expect(back.doneAt).toBe(first.doneAt);
		expect(await doneMark(sky)).toEqual({
			at: new Date(first.doneAt as string),
			by: maya.id,
		});
		// Someone who isn't on the trip never gets it: the marker is the caller.
		const stranger = await newUser("Stan");
		await mark(owner, sky, true, first.doneAt as string, stranger.id);
		expect((await doneMark(sky))?.by).toBe(owner.id);
		// A stamp from the future is held to now.
		const future = await mark(owner, sky, true, "2999-01-01T00:00:00.000Z");
		expect(Date.parse(future.doneAt as string)).toBeLessThanOrEqual(
			await dbNow(),
		);
	});

	it("a stop in Ideas, or from another trip, is not found", async () => {
		expect(await codeOf(mark(owner, c.ids.items.backup as string, true))).toBe(
			"NOT_FOUND",
		);
		expect(await codeOf(mark(owner, randomUUID(), true))).toBe("NOT_FOUND");
	});

	it("a stop moved to another day, or to Ideas, is no longer Done; a move within its day keeps it", async () => {
		const hands = c.ids.items.hands as string;
		await mark(owner, hands, true);
		await call(moveItem, owner, {
			itemId: hands,
			dayId: c.ids.days.d1,
			afterItemId: c.ids.items.loft,
		});
		expect((await doneMark(hands))?.at).not.toBeNull();
		await call(moveItem, owner, { itemId: hands, dayId: c.ids.days.d2 });
		expect(await doneMark(hands)).toEqual({ at: null, by: null });
		await mark(owner, hands, true);
		await call(moveItem, owner, { itemId: hands, dayId: null });
		expect(await doneMark(hands)).toEqual({ at: null, by: null });
	});
});
