/**
 * `pnpm cleanup:test-data` against a throwaway database: it deletes every
 * trip the keeper doesn't own (money and all) and every test account through
 * the app's delete paths, leaves the keeper's trips exactly as they were
 * (placeholders and money included), and refuses to delete anything while an
 * account isn't a test account or appears in a kept trip.
 */
import { randomBytes, randomUUID } from "node:crypto";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const testEnv = vi.hoisted(() => {
	const hex = Math.random().toString(16).slice(2, 10);
	const base = process.env.DATABASE_URL_TEST ?? process.env.DATABASE_URL;
	if (!base) throw new Error("DATABASE_URL(_TEST) must be set");
	const scratch = new URL(base);
	scratch.pathname = `/yonder_cleanup_${hex}`;
	process.env.DATABASE_URL = scratch.toString();
	process.env.REDIS_PREFIX = `yonder-cleanuptest-${hex}`;
	return { scratchUrl: scratch.toString() };
});

import { createDb, type Db } from "../src/db/db.server";
import {
	dropDatabase,
	ensureDatabase,
	migrateDatabase,
} from "../src/db/migrate.server";
import { newId } from "../src/lib/ids";
import {
	fingerprintTrips,
	isTestEmail,
	planCleanup,
	runCleanup,
	sweepOrphans,
} from "./lib/cleanup-test-data";

let db: Db;
let pool: pg.Pool;

beforeAll(async () => {
	await ensureDatabase(testEnv.scratchUrl);
	await migrateDatabase(testEnv.scratchUrl);
	({ db, pool } = createDb({ connectionString: testEnv.scratchUrl, max: 2 }));
}, 60_000);

afterAll(async () => {
	await pool?.end();
	await dropDatabase(testEnv.scratchUrl);
});

const q = async <T>(text: string, values: unknown[] = []) =>
	(await pool.query(text, values)).rows as T[];

async function user(email: string, anonymous = false): Promise<string> {
	const id = randomUUID();
	await q(
		`insert into "user" (id, email, email_verified, first_name, last_name, name, is_anonymous)
		 values ($1, $2, true, 'T', 'User', 'T User', $3)`,
		[id, email, anonymous],
	);
	return id;
}

async function trip(
	ownerId: string,
	slug: string,
): Promise<{ id: string; owner: string }> {
	const id = newId();
	await q(
		"insert into trips (id, slug, name, created_by) values ($1, $2, $2, $3)",
		[id, slug, ownerId],
	);
	const owner = await member(id, ownerId, "owner");
	return { id, owner };
}

async function member(
	tripId: string,
	userId: string | null,
	role = "editor",
	name: string | null = null,
): Promise<string> {
	const id = newId();
	await q(
		`insert into trip_members (id, trip_id, user_id, status, role, display_name, color, joined_at)
		 values ($1, $2, $3, $4, $5, $6, 1, now())`,
		[
			id,
			tripId,
			userId,
			userId ? "active" : "placeholder",
			userId ? role : "viewer",
			name,
		],
	);
	return id;
}

async function expense(tripId: string, members: string[]): Promise<void> {
	const id = newId();
	await q(
		`insert into expenses (id, trip_id, title, amount_minor, currency, home_currency, home_amount_minor, fx_rate, fx_source)
		 values ($1, $2, 'Ramen', 3000, 'USD', 'USD', 3000, 1, 'same')`,
		[id, tripId],
	);
	for (const m of members)
		await q(
			"insert into expense_shares (trip_id, expense_id, member_id) values ($1, $2, $3)",
			[tripId, id, m],
		);
	if (members.length >= 2)
		await q(
			`insert into settlements (id, trip_id, from_member_id, to_member_id, amount_minor, currency, settled_at, settled_tz)
			 values ($1, $2, $3, $4, 500, 'USD', now(), 'UTC')`,
			[newId(), tripId, members[1], members[0]],
		);
}

const noS3 = {
	deletePrefix: async () => 0,
	listSubPrefixes: async () => [] as string[],
};

describe("isTestEmail", () => {
	it("knows test domains from real ones", () => {
		for (const e of [
			"dev@example.com",
			"x@example.test",
			"dennis@asia2027.test",
			"g-1@guest.yonder.invalid",
			"a@b.localhost",
		])
			expect(isTestEmail(e), e).toBe(true);
		for (const e of [
			"dennis@dennispham.me",
			"someone@company.io",
			"a@gmail.com",
			"x@example.co",
		])
			expect(isTestEmail(e), e).toBe(false);
	});
});

describe("cleanup:test-data", () => {
	it("deletes every other trip and test account, and leaves the keeper's trips as they were", async () => {
		const tag = randomBytes(3).toString("hex");
		const keeperEmail = `keeper-${tag}@dennispham.me`;
		const keeper = await user(keeperEmail);
		// The keeper's real trip: a placeholder (Audrey) and money between them.
		const real = await trip(keeper, `asia-${tag}`);
		const audrey = await member(real.id, null, "viewer", "Audrey");
		await expense(real.id, [real.owner, audrey]);
		// Test data: a test user's trip with money and the keeper as a member,
		// another test user in it, a link guest.
		const qa = await user(`qa-${tag}@asia2027.test`);
		const kai = await user(`kai-${tag}@example.com`);
		const guest = await user(`g-${tag}@guest.yonder.invalid`, true);
		const qaTrip = await trip(qa, `qa-${tag}`);
		const kaiInQa = await member(qaTrip.id, kai);
		await member(qaTrip.id, keeper, "viewer");
		await expense(qaTrip.id, [qaTrip.owner, kaiInQa]);
		await q(
			"update trip_members set status = 'removed', merged_into_id = $2 where id = $1",
			[await member(qaTrip.id, null, "viewer", "Kai typed"), kaiInQa],
		);

		const plan = await planCleanup(db, { keepOwner: keeperEmail });
		expect(plan.blockers).toEqual([]);
		expect(plan.keepTrips.map((t) => t.slug)).toEqual([`asia-${tag}`]);
		expect(plan.deleteTrips.map((t) => t.id)).toContain(qaTrip.id);
		expect(plan.deleteUsers.map((u) => u.id)).toEqual(
			expect.arrayContaining([qa, kai, guest]),
		);
		const before = await fingerprintTrips(db, [real.id]);
		const r = await runCleanup(db, plan, noS3);
		expect(r.trips).toBe(plan.deleteTrips.length);
		expect(r.users).toBe(plan.deleteUsers.length);

		expect(await fingerprintTrips(db, [real.id])).toEqual(before);
		expect(before[real.id]).toContain("placeholders=1");
		const [left] = await q<{ trips: number; users: number }>(
			`select (select count(*)::int from trips) as trips, (select count(*)::int from "user") as users`,
		);
		expect(left).toEqual({ trips: 1, users: 1 });
		// The plan now has nothing left to do.
		const again = await planCleanup(db, { keepOwner: keeperEmail });
		expect(again.deleteTrips).toEqual([]);
		expect(again.deleteUsers).toEqual([]);
	});

	it("refuses while an account isn't a test account, or appears in a kept trip", async () => {
		const tag = randomBytes(3).toString("hex");
		const keeperEmail = `keeper2-${tag}@dennispham.me`;
		const keeper = await user(keeperEmail);
		const real = await trip(keeper, `real-${tag}`);
		const friend = await user(`friend-${tag}@gmail.com`);
		const tester = await user(`tester-${tag}@example.com`);
		await member(real.id, tester, "editor");
		const plan = await planCleanup(db, { keepOwner: keeperEmail });
		expect(plan.blockers.join("\n")).toContain(`friend-${tag}@gmail.com`);
		expect(plan.blockers.join("\n")).toMatch(
			/trip_members row\(s\) in a kept trip/,
		);
		await expect(runCleanup(db, plan, noS3)).rejects.toThrow(
			/refusing to delete/,
		);
		// Nothing went.
		const [still] = await q<{ n: number }>(
			`select count(*)::int as n from "user" where id = any($1::text[])`,
			[[friend, tester]],
		);
		expect(still?.n).toBe(2);
		// Clean up this test's rows by hand (the next plan must not see them).
		await q("delete from trips where id = $1", [real.id]);
		await q(`delete from "user" where id = any($1::text[])`, [
			[keeper, friend, tester],
		]);
	});

	it("refuses when the keeper has no account or no trip", async () => {
		const none = await planCleanup(db, { keepOwner: "nobody@dennispham.me" });
		expect(none.blockers[0]).toMatch(/has no account/);
		const tag = randomBytes(3).toString("hex");
		const lonely = `lonely-${tag}@dennispham.me`;
		const id = await user(lonely);
		const plan = await planCleanup(db, { keepOwner: lonely });
		expect(plan.blockers.join()).toMatch(/owns no trip/);
		await q(`delete from "user" where id = $1`, [id]);
	});

	it("sweeps S3 prefixes nothing points at, and keeps what another trip re-references", async () => {
		const tag = randomBytes(3).toString("hex");
		const owner = await user(`sweep-${tag}@dennispham.me`);
		const live = await trip(owner, `live-${tag}`);
		const goneTrip = "01000000-0000-7000-8000-00000000dead";
		const sharedTrip = "01000000-0000-7000-8000-00000000beef";
		// A duplicate's attachment still points into the gone trip's objects.
		await q(
			`insert into attachments (id, trip_id, kind, status, storage_key, position, created_by)
			 values ($1, $2, 'photo', 'ready', $3, 'a0', $4)`,
			[newId(), live.id, `trips/${sharedTrip}/${newId()}/`, owner],
		);
		const listed: Record<string, string[]> = {
			"trips/": [
				`trips/${live.id}/`,
				`trips/${goneTrip}/`,
				`trips/${sharedTrip}/`,
			],
			"avatars/": [`avatars/${owner}/`, "avatars/deleted-user/"],
		};
		const dropped: string[] = [];
		const r = await sweepOrphans(db, {
			listSubPrefixes: async (p) => listed[p] ?? [],
			deleteAnyPrefix: async (p) => {
				dropped.push(p);
				return 2;
			},
		});
		expect(dropped).toContain(`trips/${goneTrip}/`);
		expect(dropped).toContain("avatars/deleted-user/");
		expect(dropped).not.toContain(`trips/${live.id}/`);
		expect(dropped).not.toContain(`trips/${sharedTrip}/`);
		expect(dropped).not.toContain(`avatars/${owner}/`);
		expect(r.avatarPrefixes).toBe(1);
		await q("delete from trips where id = $1", [live.id]);
		await q(`delete from "user" where id = $1`, [owner]);
	});
});
