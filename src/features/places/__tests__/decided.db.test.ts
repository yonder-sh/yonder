/**
 * "Mark decided" against real Postgres (a throwaway database): editors mark
 * a place, a city or the trip (a suggester or a viewer is refused and nothing
 * changes); the stamp is the database's clock, by the marker; Undo clears it;
 * each is an activity line; marking again moves the stamp, so the places
 * added since are covered, and undoing that puts the earlier stamp back
 * (never a later one).
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
	scratch.pathname = `/yonder_decided_${hex}`;
	process.env.DATABASE_URL = scratch.toString();
	process.env.REDIS_PREFIX = `yonder-decidedtest-${hex}`;
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
import { nodes, trips, user } from "@/db/schema";
import { setDecided } from "@/functions/nodes.functions";
import { indexGraph } from "@/lib/engine/graph-index";
import type { AuthUser } from "@/server/auth.server";
import { errorCode } from "@/server/authz/errors";
import { cloneDemoTrip, type FixtureClone } from "@/server/fixture.server";
import { loadGraphForServer } from "@/server/graph.server";
import { closeQueues } from "@/server/live/jobs.server";
import { closeRedis, redis, redisPrefix } from "@/server/live/redis.server";
import { isDecided } from "../lib/decided";

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
const tick = () => new Promise((r) => setTimeout(r, 5));

async function newUser(first: string): Promise<AuthUser> {
	const id = randomUUID();
	await db()
		.insert(user)
		.values({
			id,
			email: `${first.toLowerCase()}-${id}@example.test`,
			emailVerified: true,
			name: `${first} Test`,
			firstName: first,
			lastName: "Test",
			isAnonymous: false,
		});
	const [row] = await db().select().from(user).where(sql`${user.id} = ${id}`);
	return row as unknown as AuthUser;
}

async function addMember(
	tripId: string,
	u: AuthUser,
	role: "viewer" | "editor" | "suggester",
): Promise<void> {
	await db().execute(sql`
		insert into trip_members (id, trip_id, user_id, status, role, color, joined_at)
		values (${randomUUID()}, ${tripId}, ${u.id}, 'active', ${role}, 3, now())`);
}

let owner: AuthUser;
let maya: AuthUser;
let sam: AuthUser;
let vic: AuthUser;
let c: FixtureClone;
let kyoto: string;
let kiyomizu: string;

type Marked = { decidedAt: string | null };
const mark = (
	u: AuthUser,
	nodeId: string | null,
	decided: boolean,
	at?: string,
	by?: string,
) =>
	call<Marked>(setDecided, u, {
		tripId: c.tripId,
		nodeId,
		decided,
		...(at ? { at } : {}),
		...(by ? { by } : {}),
	});

async function nodeMark(id: string) {
	const [row] = await db()
		.select({ at: nodes.decidedAt, by: nodes.decidedBy })
		.from(nodes)
		.where(sql`${nodes.id} = ${id}`);
	return row;
}

async function tripMark() {
	const [row] = await db()
		.select({ at: trips.decidedAt, by: trips.decidedBy })
		.from(trips)
		.where(sql`${trips.id} = ${c.tripId}`);
	return row;
}

async function dbNow(): Promise<number> {
	const r = await db().execute(sql`select clock_timestamp() as t`);
	return new Date((r.rows[0] as { t: string | Date }).t).getTime();
}

/** The trip's "marked … decided / undecided" activity lines, oldest first. */
async function marks(): Promise<
	{ verb: string; summary: string; nodeId: string | null }[]
> {
	const r = await db().execute(sql`
		select verb, summary, node_id as "nodeId" from activity_log
		 where trip_id = ${c.tripId} and summary like 'marked %decided'
		 order by created_at, id`);
	return r.rows as { verb: string; summary: string; nodeId: string | null }[];
}

async function decidedNow(nodeId: string): Promise<boolean> {
	const g = await loadGraphForServer(db(), c.tripId);
	if (!g) throw new Error("no graph");
	const ix = indexGraph(g);
	const n = g.nodes.find((x) => x.id === nodeId);
	if (!n) throw new Error("no node");
	return isDecided(ix, n);
}

beforeAll(async () => {
	await ensureDatabase(testEnv.scratchUrl);
	await migrateDatabase(testEnv.scratchUrl);
	owner = await newUser("Olga");
	maya = await newUser("Maya");
	sam = await newUser("Sam");
	vic = await newUser("Vic");
	c = await cloneDemoTrip(db(), owner.id);
	await addMember(c.tripId, maya, "editor");
	await addMember(c.tripId, sam, "suggester");
	await addMember(c.tripId, vic, "viewer");
	kyoto = c.ids.nodes.kyoto as string;
	kiyomizu = c.ids.nodes.kiyomizu as string;
});

afterEach(async () => {
	await db().execute(sql`
		update nodes set decided_at = null, decided_by = null where trip_id = ${c.tripId}`);
	await db().execute(sql`
		update trips set decided_at = null, decided_by = null where id = ${c.tripId}`);
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

describe("setDecided", () => {
	it("an editor marks a city: the database's clock, by them, and an activity line", async () => {
		const before = await dbNow();
		const r = await mark(maya, kyoto, true);
		const row = await nodeMark(kyoto);
		expect(row?.by).toBe(maya.id);
		expect(row?.at).toBeInstanceOf(Date);
		expect(row?.at?.getTime()).toBeGreaterThanOrEqual(before);
		expect(r.decidedAt).toBe(row?.at?.toISOString());
		expect((await marks()).at(-1)).toEqual({
			verb: "node.update",
			summary: "marked Kyoto decided",
			nodeId: kyoto,
		});
		expect(await decidedNow(kiyomizu)).toBe(true);
	});

	it("a suggester or a viewer is refused, and the mark stays as it was", async () => {
		await mark(owner, kyoto, true);
		const was = await nodeMark(kyoto);
		const lines = (await marks()).length;
		expect(await codeOf(mark(sam, kyoto, false))).toBe("FORBIDDEN");
		expect(await codeOf(mark(sam, kyoto, true))).toBe("FORBIDDEN");
		expect(await codeOf(mark(vic, kyoto, false))).toBe("FORBIDDEN");
		expect(await codeOf(mark(sam, null, true))).toBe("FORBIDDEN");
		expect(await codeOf(mark(vic, null, true))).toBe("FORBIDDEN");
		expect(await nodeMark(kyoto)).toEqual(was);
		expect((await tripMark())?.at).toBeNull();
		expect(await marks()).toHaveLength(lines);
	});

	it("Undo clears the mark, and says so", async () => {
		await mark(owner, kyoto, true);
		const r = await mark(owner, kyoto, false);
		expect(r.decidedAt).toBeNull();
		expect(await nodeMark(kyoto)).toEqual({ at: null, by: null });
		expect((await marks()).at(-1)?.summary).toBe("marked Kyoto undecided");
		expect(await decidedNow(kiyomizu)).toBe(false);
	});

	it("marking again moves the stamp: the places added since are covered", async () => {
		const first = await mark(owner, kyoto, true);
		await tick();
		// Kiyomizu-dera comes in after the mark: it still asks.
		await db().execute(
			sql`update nodes set created_at = now() where id = ${kiyomizu}`,
		);
		expect(await decidedNow(kiyomizu)).toBe(false);
		await tick();
		const again = await mark(maya, kyoto, true);
		expect(Date.parse(again.decidedAt as string)).toBeGreaterThan(
			Date.parse(first.decidedAt as string),
		);
		expect((await nodeMark(kyoto))?.by).toBe(maya.id);
		expect(await decidedNow(kiyomizu)).toBe(true);
		expect((await marks()).slice(-2).map((l) => l.summary)).toEqual([
			"marked Kyoto decided",
			"marked Kyoto decided",
		]);
	});

	it("undoing a re-mark puts the earlier stamp and marker back, never a later stamp", async () => {
		const first = await mark(owner, kyoto, true);
		await tick();
		await mark(owner, kyoto, true);
		const back = await mark(owner, kyoto, true, first.decidedAt as string);
		expect(back.decidedAt).toBe(first.decidedAt);
		expect((await nodeMark(kyoto))?.at?.toISOString()).toBe(first.decidedAt);
		// Maya's re-mark, undone: Olga's mark again; a stranger never gets it.
		await mark(maya, kyoto, true);
		await mark(maya, kyoto, true, first.decidedAt as string, owner.id);
		expect((await nodeMark(kyoto))?.by).toBe(owner.id);
		const stranger = await newUser("Stan");
		await mark(maya, kyoto, true, first.decidedAt as string, stranger.id);
		expect((await nodeMark(kyoto))?.by).toBe(maya.id);
		// A stamp from the future is held to now.
		const future = await mark(owner, kyoto, true, "2999-01-01T00:00:00.000Z");
		expect(Date.parse(future.decidedAt as string)).toBeLessThanOrEqual(
			await dbNow(),
		);
	});

	it("the whole trip: marked, marked again, undone", async () => {
		const r = await mark(owner, null, true);
		const row = await tripMark();
		expect(row?.by).toBe(owner.id);
		expect(r.decidedAt).toBe(row?.at?.toISOString());
		expect((await marks()).at(-1)).toEqual({
			verb: "trip.update",
			summary: "marked the trip decided",
			nodeId: null,
		});
		await tick();
		const again = await mark(maya, null, true);
		expect(Date.parse(again.decidedAt as string)).toBeGreaterThan(
			Date.parse(r.decidedAt as string),
		);
		expect((await tripMark())?.by).toBe(maya.id);
		await mark(owner, null, false);
		expect(await tripMark()).toEqual({ at: null, by: null });
		expect((await marks()).at(-1)?.summary).toBe("marked the trip undecided");
	});

	it("a place from outside the trip is not found", async () => {
		expect(await codeOf(mark(owner, randomUUID(), true))).toBe("NOT_FOUND");
	});
});
