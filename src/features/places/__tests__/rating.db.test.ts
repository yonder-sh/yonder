/**
 * The people who rate, against real Postgres (a throwaway database):
 * - `setRatingsCounted`: owners and editors leave someone's ratings out and
 *   count them again, nothing is deleted, anyone else is refused;
 * - `remindToRate`: once per person and trip every 12 hours, never yourself,
 *   a placeholder or someone left out, only by people who rate; the row is
 *   the recipient's line until `dismissRateReminder`, and a `remind` push
 *   event is queued.
 */
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const testEnv = vi.hoisted(() => {
	const hex = Math.random().toString(16).slice(2, 10);
	const base = process.env.DATABASE_URL_TEST ?? process.env.DATABASE_URL;
	if (!base) throw new Error("DATABASE_URL(_TEST) must be set");
	const scratch = new URL(base);
	scratch.pathname = `/yonder_rating_${hex}`;
	process.env.DATABASE_URL = scratch.toString();
	process.env.REDIS_PREFIX = `yonder-ratingtest-${hex}`;
	process.env.BETTER_AUTH_SECRET ||= "test-secret-test-secret-test-secret-00";
	// Push on, so the outbox queues the reminder's push event.
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
import { user } from "@/db/schema";
import type { PushEventsJob } from "@/lib/push/jobs";
import type { AuthUser } from "@/server/auth.server";
import { errorCode } from "@/server/authz/errors";
import { cloneDemoTrip, type FixtureClone } from "@/server/fixture.server";
import { loadGraphForServer } from "@/server/graph.server";
import { closeQueues, getQueue } from "@/server/live/jobs.server";
import { closeRedis, redis, redisPrefix } from "@/server/live/redis.server";
import {
	dismissRateReminder,
	getRateReminders,
	type RateReminders,
	remindToRate,
	setRatingsCounted,
} from "../rating.functions";

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
	role: "rater" | "viewer" | "editor" | "suggester",
): Promise<string> {
	const id = randomUUID();
	await db().execute(sql`
		insert into trip_members (id, trip_id, user_id, status, role, color, joined_at)
		values (${id}, ${tripId}, ${u.id}, 'active', ${role}, 3, now())`);
	return id;
}

async function pushJobs(): Promise<PushEventsJob[]> {
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

let owner: AuthUser;
let maya: AuthUser;
let vic: AuthUser;
let rae: AuthUser;
let c: FixtureClone;
let mayaMember: string;
let vicMember: string;
let raeMember: string;

beforeAll(async () => {
	await ensureDatabase(testEnv.scratchUrl);
	await migrateDatabase(testEnv.scratchUrl);
	owner = await newUser("Olga");
	maya = await newUser("Maya");
	vic = await newUser("Vic");
	rae = await newUser("Rae");
	c = await cloneDemoTrip(db(), owner.id);
	mayaMember = await addMember(c.tripId, maya, "editor");
	vicMember = await addMember(c.tripId, vic, "viewer");
	raeMember = await addMember(c.tripId, rae, "rater");
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

describe("setRatingsCounted", () => {
	it("owners and editors leave someone out and count them again; ratings stay", async () => {
		const audrey = c.members.audrey;
		const rated = async () =>
			Number(
				(
					(
						await db().execute(
							sql`select count(*)::int as n from node_priorities where member_id = ${audrey}`,
						)
					).rows[0] as { n: number }
				).n,
			);
		await db().execute(sql`
			insert into node_priorities (trip_id, node_id, member_id, priority)
			select trip_id, id, ${audrey}, 'must' from nodes
			 where trip_id = ${c.tripId} and type = 'place' limit 3`);
		const before = await rated();
		expect(before).toBe(3);
		await call(setRatingsCounted, owner, {
			memberId: audrey,
			counted: false,
		});
		const g = await loadGraphForServer(db(), c.tripId);
		expect(g?.members.find((m) => m.id === audrey)?.ratingsCounted).toBe(false);
		expect(await rated()).toBe(before);
		const log = await db().execute(sql`
			select summary from activity_log where trip_id = ${c.tripId} and verb = 'person.ratings'`);
		expect(log.rows).toEqual([{ summary: "left out Audrey's ratings" }]);
		// Maya (an editor) counts her again.
		await call(setRatingsCounted, maya, { memberId: audrey, counted: true });
		const g2 = await loadGraphForServer(db(), c.tripId);
		expect(
			g2?.members.find((m) => m.id === audrey)?.ratingsCounted,
		).toBeUndefined();
		expect(await rated()).toBe(before);
	});

	it("raters and viewers can't", async () => {
		for (const u of [rae, vic])
			expect(
				await codeOf(
					call(setRatingsCounted, u, { memberId: mayaMember, counted: false }),
				),
			).toBe("FORBIDDEN");
	});
});

describe("remindToRate", () => {
	it("reminds once in 12 hours, queues a push and is the recipient's line", async () => {
		const r = await call<{ at: string }>(remindToRate, owner, {
			tripId: c.tripId,
			memberId: mayaMember,
		});
		expect(Date.parse(r.at)).toBeGreaterThan(Date.now() - 60_000);
		const jobs = await pushJobs();
		expect(jobs.flatMap((j) => j.events)).toEqual([
			{ kind: "remind", memberId: mayaMember, places: expect.any(Number) },
		]);
		expect(jobs[0]?.actor?.userId).toBe(owner.id);
		// Again, by anyone: refused for 12 hours.
		expect(
			await codeOf(
				call(remindToRate, rae, { tripId: c.tripId, memberId: mayaMember }),
			),
		).toBe("CONFLICT");
		const seen = await call<RateReminders>(getRateReminders, rae, {
			tripId: c.tripId,
		});
		expect(seen.recent.map((x) => x.memberId)).toEqual([mayaMember]);
		expect(seen.mine).toBeNull();
		const mine = await call<RateReminders>(getRateReminders, maya, {
			tripId: c.tripId,
		});
		expect(mine.mine).toMatchObject({ byName: "Olga" });
		expect(mine.mine?.places).toBeGreaterThan(0);
		await call(dismissRateReminder, maya, { tripId: c.tripId });
		expect(
			(await call<RateReminders>(getRateReminders, maya, { tripId: c.tripId }))
				.mine,
		).toBeNull();
		// 13 hours later it works again.
		await db().execute(sql`
			update rate_reminders set created_at = now() - interval '13 hours' where member_id = ${mayaMember}`);
		expect(
			await codeOf(
				call(remindToRate, rae, { tripId: c.tripId, memberId: mayaMember }),
			),
		).toBe("ok");
		await pushJobs();
	});

	it("never yourself, a placeholder, a viewer or someone left out", async () => {
		const tries: [AuthUser, string][] = [
			[owner, c.members.owner],
			[owner, c.members.audrey],
			[owner, vicMember],
		];
		for (const [u, memberId] of tries)
			expect(
				await codeOf(call(remindToRate, u, { tripId: c.tripId, memberId })),
			).toBe("VALIDATION");
		await call(setRatingsCounted, owner, {
			memberId: raeMember,
			counted: false,
		});
		expect(
			await codeOf(
				call(remindToRate, owner, { tripId: c.tripId, memberId: raeMember }),
			),
		).toBe("VALIDATION");
		await call(setRatingsCounted, owner, {
			memberId: raeMember,
			counted: true,
		});
		expect(await pushJobs()).toEqual([]);
	});

	it("only people who rate may remind", async () => {
		expect(
			await codeOf(
				call(remindToRate, vic, { tripId: c.tripId, memberId: raeMember }),
			),
		).toBe("FORBIDDEN");
	});
});
