/**
 * Deleting a trip that holds money (migration 0010): the money → member keys
 * were NO ACTION, checked after each cascaded delete, so `delete from trips`
 * failed with `expense_shares_member_fk` whenever the cascade reached
 * `trip_members` before `expenses`. Now they cascade (and the merge pointer
 * is set null), so every delete path works with expenses, payments, itemized
 * lines, settlements and a merged placeholder present: the plain row delete,
 * `hardDeleteTrip`, the purge (`purgeTrip`) and an account deletion
 * (`deleteUserAccount`), which retires the person's memberships in trips that
 * stay so nobody else's balances change. Its own throwaway database.
 */
import { randomBytes, randomUUID } from "node:crypto";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const testEnv = vi.hoisted(() => {
	const hex = Math.random().toString(16).slice(2, 10);
	const base = process.env.DATABASE_URL_TEST ?? process.env.DATABASE_URL;
	if (!base) throw new Error("DATABASE_URL(_TEST) must be set");
	const scratch = new URL(base);
	scratch.pathname = `/yonder_tripdel_${hex}`;
	process.env.DATABASE_URL = scratch.toString();
	process.env.REDIS_PREFIX = `yonder-tripdeltest-${hex}`;
	return { scratchUrl: scratch.toString() };
});

import { createDb, type Db } from "@/db/db.server";
import {
	databaseName,
	dropDatabase,
	ensureDatabase,
	migrateDatabase,
} from "@/db/migrate.server";
import { seedDemoSkeleton } from "@/db/seed.server";
import { purge, purgeTrip } from "@/features/media/server/purge.server";
import { newId } from "@/lib/ids";
import { deleteUserAccount } from "./account-delete.server";
import { errorCode } from "./authz/errors";
import { retireMember } from "./members.server";
import { hardDeleteTrip } from "./trip-delete.server";

let db: Db;
let pool: pg.Pool;

beforeAll(async () => {
	expect(databaseName(testEnv.scratchUrl)).toMatch(/^yonder_tripdel_/);
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

/** A user with a name (what sign-in makes). */
async function newUser(first: string): Promise<string> {
	const id = randomUUID();
	await q(
		`insert into "user" (id, email, email_verified, first_name, last_name, name, is_anonymous)
		 values ($1, $2, true, $3, 'Tester', $3 || ' Tester', false)`,
		[
			id,
			`${first.toLowerCase()}-${randomBytes(3).toString("hex")}@example.com`,
			first,
		],
	);
	return id;
}

async function addMember(
	tripId: string,
	opts: { userId?: string; status?: string; name?: string; color?: number },
): Promise<string> {
	const [row] = await q<{ id: string }>(
		`insert into trip_members (id, trip_id, user_id, status, role, display_name, color, joined_at)
		 values ($7, $1, $2, $3, $4, $5, $6, now()) returning id::text as id`,
		[
			tripId,
			opts.userId ?? null,
			opts.status ?? "active",
			opts.status === "placeholder" ? "viewer" : "editor",
			opts.name ?? null,
			opts.color ?? 1,
			newId(),
		],
	);
	return (row as { id: string }).id;
}

/**
 * A trip with everything that used to block its delete: an itemized expense
 * split between the owner and a member, paid by both (a pooled payment), a
 * settlement between them, and a placeholder merged into the member.
 */
async function tripWithMoney(slug: string) {
	const owner = await seedDemoSkeleton(db, {
		email: `${slug}-owner@example.com`,
		tripSlug: slug,
		tripName: slug,
	});
	const tripId = owner.tripId;
	const kaiUser = await newUser("Kai");
	const kai = await addMember(tripId, { userId: kaiUser, color: 2 });
	const merged = await addMember(tripId, {
		status: "removed",
		name: "Kai (typed)",
		color: 3,
	});
	await q(
		"update trip_members set merged_into_id = $2 where id = $1 and trip_id = $3",
		[merged, kai, tripId],
	);
	const [exp] = await q<{ id: string }>(
		`insert into expenses (id, trip_id, title, amount_minor, currency, home_currency, home_amount_minor, fx_rate, fx_source)
		 values ($2, $1, 'Ramen', 3000, 'USD', 'USD', 3000, 1, 'same') returning id::text as id`,
		[tripId, newId()],
	);
	const expenseId = (exp as { id: string }).id;
	for (const m of [owner.memberId, kai])
		await q(
			"insert into expense_shares (trip_id, expense_id, member_id) values ($1, $2, $3)",
			[tripId, expenseId, m],
		);
	const [pay] = await q<{ id: string }>(
		`insert into expense_payments (id, trip_id, expense_id, paid_at, paid_tz, currency, amount_minor)
		 values ($3, $1, $2, now(), 'Asia/Tokyo', 'USD', 3000) returning id::text as id`,
		[tripId, expenseId, newId()],
	);
	const paymentId = (pay as { id: string }).id;
	await q(
		`insert into expense_payment_payers (trip_id, payment_id, member_id, amount_minor)
		 values ($1, $2, $3, 2000), ($1, $2, $4, 1000)`,
		[tripId, paymentId, owner.memberId, kai],
	);
	const [line] = await q<{ id: string }>(
		`insert into expense_lines (id, trip_id, expense_id, label, amount_minor, position)
		 values ($3, $1, $2, 'Tonkotsu', 3000, 'a0') returning id::text as id`,
		[tripId, expenseId, newId()],
	);
	await q(
		`insert into expense_line_members (trip_id, line_id, member_id)
		 values ($1, $2, $3), ($1, $2, $4)`,
		[tripId, (line as { id: string }).id, owner.memberId, kai],
	);
	await q(
		`insert into settlements (id, trip_id, from_member_id, to_member_id, amount_minor, currency, settled_at, settled_tz)
		 values ($4, $1, $2, $3, 500, 'USD', now(), 'Asia/Tokyo')`,
		[tripId, kai, owner.memberId, newId()],
	);
	return {
		tripId,
		ownerUser: owner.userId,
		owner: owner.memberId,
		kai,
		kaiUser,
		merged,
		expenseId,
	};
}

const MONEY_TABLES = [
	"expenses",
	"expense_shares",
	"expense_payments",
	"expense_payment_payers",
	"expense_lines",
	"expense_line_members",
	"settlements",
	"trip_members",
] as const;

async function rowsLeft(tripId: string): Promise<Record<string, number>> {
	const out: Record<string, number> = {};
	for (const t of MONEY_TABLES) {
		const [r] = await q<{ n: number }>(
			`select count(*)::int as n from ${t} where trip_id = $1`,
			[tripId],
		);
		out[t] = (r as { n: number }).n;
	}
	return out;
}
const NONE = Object.fromEntries(MONEY_TABLES.map((t) => [t, 0]));

describe("0010: money → member keys", () => {
	it("cascade, and the merge pointer is set null", async () => {
		const rows = await q<{ conname: string; confdeltype: string }>(
			`select conname, confdeltype from pg_constraint
			  where conname in ('expense_shares_member_fk', 'expense_payment_payers_member_fk',
			                    'expense_line_members_member_fk', 'settlements_from_member_fk',
			                    'settlements_to_member_fk', 'trip_members_merged_into_fk')
			  order by conname`,
		);
		expect(rows).toEqual([
			{ conname: "expense_line_members_member_fk", confdeltype: "c" },
			{ conname: "expense_payment_payers_member_fk", confdeltype: "c" },
			{ conname: "expense_shares_member_fk", confdeltype: "c" },
			{ conname: "settlements_from_member_fk", confdeltype: "c" },
			{ conname: "settlements_to_member_fk", confdeltype: "c" },
			{ conname: "trip_members_merged_into_fk", confdeltype: "n" },
		]);
		// SET NULL ("merged_into_id") only: never the trip id.
		const [def] = await q<{ def: string }>(
			`select pg_get_constraintdef(oid) as def from pg_constraint where conname = 'trip_members_merged_into_fk'`,
		);
		expect(def?.def).toContain("ON DELETE SET NULL (merged_into_id)");
	});
});

describe("deleting a trip that has expenses", () => {
	it("a plain `delete from trips` works and leaves nothing behind", async () => {
		const t = await tripWithMoney(
			`del-plain-${randomBytes(3).toString("hex")}`,
		);
		const before = await rowsLeft(t.tripId);
		expect(before.expense_shares).toBe(2);
		expect(before.settlements).toBe(1);
		await q("delete from trips where id = $1", [t.tripId]);
		expect(await rowsLeft(t.tripId)).toEqual(NONE);
	});

	it("hardDeleteTrip works (the seeds', importer's and purge's path)", async () => {
		const t = await tripWithMoney(`del-hard-${randomBytes(3).toString("hex")}`);
		await db.transaction((tx) => hardDeleteTrip(tx, t.tripId));
		expect(await rowsLeft(t.tripId)).toEqual(NONE);
	});

	it("the purge removes a trip deleted long ago, money and all", async () => {
		const t = await tripWithMoney(
			`del-purge-${randomBytes(3).toString("hex")}`,
		);
		// The app's deleteTrip: a soft delete; the purge takes it after 30 days.
		await q(
			"update trips set deleted_at = now() - interval '40 days' where id = $1",
			[t.tripId],
		);
		const dropped: string[] = [];
		const r = await purge(db, {
			deletePrefix: async (p) => {
				dropped.push(p);
				return 1;
			},
			listSubPrefixes: async () => [],
		});
		expect(r.trips).toBeGreaterThanOrEqual(1);
		expect(dropped).toContain(`trips/${t.tripId}/`);
		expect(await rowsLeft(t.tripId)).toEqual(NONE);
		const [trip] = await q("select 1 from trips where id = $1", [t.tripId]);
		expect(trip).toBeUndefined();
	});

	it("purgeTrip removes one trip now, with its media prefix", async () => {
		const t = await tripWithMoney(`del-now-${randomBytes(3).toString("hex")}`);
		const dropped: string[] = [];
		const n = await purgeTrip(db, t.tripId, {
			deletePrefix: async (p) => {
				dropped.push(p);
				return 3;
			},
			listSubPrefixes: async () => [],
		});
		expect(n).toBe(3);
		expect(dropped).toEqual([`trips/${t.tripId}/`]);
		expect(await rowsLeft(t.tripId)).toEqual(NONE);
	});
});

describe("members with expenses", () => {
	it("removing one retires them: the row, splits, payments and settlements stay", async () => {
		const t = await tripWithMoney(`retire-${randomBytes(3).toString("hex")}`);
		await db.transaction((tx) => retireMember(tx, null, t.tripId, t.kai));
		const [kai] = await q<{ status: string; user_id: string | null }>(
			"select status::text as status, user_id from trip_members where id = $1",
			[t.kai],
		);
		expect(kai).toEqual({ status: "removed", user_id: null });
		const left = await rowsLeft(t.tripId);
		expect(left.expense_shares).toBe(2);
		expect(left.expense_payment_payers).toBe(2);
		expect(left.expense_line_members).toBe(2);
		expect(left.settlements).toBe(1);
		// …and the trip still deletes afterwards.
		await q("delete from trips where id = $1", [t.tripId]);
		expect(await rowsLeft(t.tripId)).toEqual(NONE);
	});

	it("a member row that does go takes its money rows with it, and the merge pointer is cleared", async () => {
		const t = await tripWithMoney(`rowgone-${randomBytes(3).toString("hex")}`);
		await q("delete from trip_members where id = $1", [t.kai]);
		const [shares] = await q<{ n: number }>(
			"select count(*)::int as n from expense_shares where trip_id = $1",
			[t.tripId],
		);
		expect(shares?.n).toBe(1);
		const [settle] = await q<{ n: number }>(
			"select count(*)::int as n from settlements where trip_id = $1",
			[t.tripId],
		);
		expect(settle?.n).toBe(0);
		const [merged] = await q<{ merged_into_id: string | null; status: string }>(
			"select merged_into_id, status::text as status from trip_members where id = $1",
			[t.merged],
		);
		expect(merged).toEqual({ merged_into_id: null, status: "removed" });
	});
});

describe("deleteUserAccount", () => {
	it("retires the person in trips that stay (their money stays), then deletes the account", async () => {
		const t = await tripWithMoney(`acct-${randomBytes(3).toString("hex")}`);
		const r = await db.transaction((tx) => deleteUserAccount(tx, t.kaiUser));
		expect(r.retired).toBe(1);
		const [u] = await q('select 1 from "user" where id = $1', [t.kaiUser]);
		expect(u).toBeUndefined();
		const [kai] = await q<{ status: string; display_name: string }>(
			"select status::text as status, display_name from trip_members where id = $1",
			[t.kai],
		);
		expect(kai).toEqual({ status: "removed", display_name: "Kai Tester" });
		const left = await rowsLeft(t.tripId);
		expect(left.expense_shares).toBe(2);
		expect(left.expense_payment_payers).toBe(2);
		expect(left.settlements).toBe(1);
	});

	it("refuses an account that still owns a trip, until that trip is gone", async () => {
		const t = await tripWithMoney(
			`acct-owner-${randomBytes(3).toString("hex")}`,
		);
		const code = await db
			.transaction((tx) => deleteUserAccount(tx, t.ownerUser))
			.then(
				() => "ok",
				(e: unknown) => errorCode(e),
			);
		expect(code).toBe("CONFLICT");
		const [still] = await q('select 1 as one from "user" where id = $1', [
			t.ownerUser,
		]);
		expect(still).toEqual({ one: 1 });
		await purgeTrip(db, t.tripId, {
			deletePrefix: async () => 0,
			listSubPrefixes: async () => [],
		});
		await db.transaction((tx) => deleteUserAccount(tx, t.ownerUser));
		const [gone] = await q('select 1 from "user" where id = $1', [t.ownerUser]);
		expect(gone).toBeUndefined();
	});
});
