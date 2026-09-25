/**
 * The schema against real Postgres: every migration applies to a brand-new
 * database, and the constraints that guard trip isolation, the tree, days,
 * legs, bundles and share links actually fire. Uses its own throwaway database
 * (created, migrated and dropped here), so it never touches the dev or test data.
 */
import { randomBytes } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb, type Db } from "./db.server";
import {
	databaseName,
	dropDatabase,
	ensureDatabase,
	migrateDatabase,
} from "./migrate.server";
import {
	items,
	legs,
	listItems,
	mentions,
	nodes,
	shareLinks,
	tripDays,
	tripMembers,
	trips,
	yjsDocuments,
} from "./schema";
import { seedDemoSkeleton } from "./seed.server";
import { hashShareToken, shareTokenColumns } from "./share-token.server";

// .env is loaded by vitest.config.ts (variables already set win).

const baseUrl = process.env.DATABASE_URL_TEST ?? process.env.DATABASE_URL;
if (!baseUrl) throw new Error("DATABASE_URL_TEST or DATABASE_URL must be set");
const scratchUrl = (() => {
	const url = new URL(baseUrl);
	url.pathname = `/yonder_schema_${randomBytes(4).toString("hex")}`;
	return url.toString();
})();

let db: Db;
let pool: pg.Pool;

/** The SQLSTATE of a failed query (Drizzle wraps the pg error in `cause`). */
async function sqlState(run: () => Promise<unknown>): Promise<string> {
	try {
		await run();
	} catch (error) {
		const e = error as { code?: string; cause?: { code?: string } };
		return e.cause?.code ?? e.code ?? "no-code";
	}
	return "ok";
}

const FK_VIOLATION = "23503";
const UNIQUE_VIOLATION = "23505";
const CHECK_VIOLATION = "23514";

async function newTrip(slug: string) {
	const { tripId, userId, memberId } = await seedDemoSkeleton(db, {
		email: `${slug}@example.com`,
		tripSlug: slug,
		tripName: slug,
	});
	return { tripId, userId, memberId };
}

async function newNode(
	tripId: string,
	name: string,
	parentId: string | null = null,
) {
	const [row] = await db
		.insert(nodes)
		.values({
			tripId,
			parentId,
			type: "city",
			name,
			slug: name.toLowerCase(),
			position: "a0",
		})
		.returning();
	if (!row) throw new Error("no node");
	return row;
}

beforeAll(async () => {
	expect(databaseName(scratchUrl)).toMatch(/^yonder_schema_/);
	await ensureDatabase(scratchUrl);
	await migrateDatabase(scratchUrl);
	({ db, pool } = createDb({ connectionString: scratchUrl, max: 2 }));
}, 60_000);

afterAll(async () => {
	await pool?.end();
	await dropDatabase(scratchUrl);
});

describe("migrations", () => {
	it("create every table, the trigger and the hand-written constraints", async () => {
		const { rows } = await pool.query<{ n: number }>(
			"select count(*)::int as n from pg_tables where schemaname = 'public'",
		);
		// 22 foundation tables + 14 F-ext0 tables (EXTENSIONS §2.1, ADDENDUM §6–§7)
		// + inbox_reads (ADDENDUM §10, 0005).
		expect(rows[0]?.n).toBe(37);
		const { rows: cons } = await pool.query<{
			conname: string;
			condeferrable: boolean;
		}>(
			`select conname, condeferrable from pg_constraint
			 where conname in ('trip_days_trip_date_uq', 'list_items_due_day_fk', 'trip_days_night_node_fk')
			 order by conname`,
		);
		expect(cons).toEqual([
			{ conname: "list_items_due_day_fk", condeferrable: false },
			{ conname: "trip_days_night_node_fk", condeferrable: false },
			{ conname: "trip_days_trip_date_uq", condeferrable: true },
		]);
	});

	it("add the F-ext0 enum values, tables and hand-written money FKs (0002, 0003)", async () => {
		const { rows: enums } = await pool.query<{ v: string }>(
			`select t.typname || ':' || e.enumlabel as v from pg_enum e join pg_type t on t.oid = e.enumtypid
			  where (t.typname, e.enumlabel) in (('trip_role', 'suggester'), ('share_role', 'suggester'), ('member_status', 'removed'))
			  order by 1`,
		);
		expect(enums.map((r) => r.v)).toEqual([
			"member_status:removed",
			"share_role:suggester",
			"trip_role:suggester",
		]);
		const { rows: tables } = await pool.query<{ t: string }>(
			`select tablename as t from pg_tables where schemaname = 'public'
			  and tablename in ('proposals', 'trip_seen', 'climate_normals', 'user_prefs', 'expenses',
			    'expense_payments', 'expense_payment_payers', 'expense_shares', 'expense_lines',
			    'expense_line_members', 'expense_fees', 'settlements', 'fx_rates', 'budget_lines')
			  order by 1`,
		);
		expect(tables).toHaveLength(14);
		const { rows: fks } = await pool.query<{ conname: string; def: string }>(
			`select conname, pg_get_constraintdef(oid) as def from pg_constraint
			  where conname in ('expenses_leg_fk', 'attachments_expense_fk') order by conname`,
		);
		expect(fks.map((f) => f.conname)).toEqual([
			"attachments_expense_fk",
			"expenses_leg_fk",
		]);
		expect(fks.find((f) => f.conname === "expenses_leg_fk")?.def).toContain(
			"ON DELETE SET NULL (leg_id)",
		);
	});

	it("add the people, receipt and inbox contracts (0005, 0006)", async () => {
		const { rows: cols } = await pool.query<{ c: string }>(
			`select table_name || '.' || column_name as c from information_schema.columns
			  where table_schema = 'public' and (table_name, column_name) in (
			    ('trip_members', 'merged_into_id'),
			    ('attachments', 'payment_id'), ('settlements', 'net_after'),
			    ('budget_lines', 'default_seen_minor'), ('inbox_reads', 'item_key'))
			  order by 1`,
		);
		expect(cols.map((r) => r.c)).toEqual([
			"attachments.payment_id",
			"budget_lines.default_seen_minor",
			"inbox_reads.item_key",
			"settlements.net_after",
			"trip_members.merged_into_id",
		]);
		const { rows: fk } = await pool.query<{ def: string }>(
			`select pg_get_constraintdef(oid) as def from pg_constraint where conname = 'attachments_payment_fk'`,
		);
		expect(fk[0]?.def).toContain("ON DELETE SET NULL (payment_id)");
		expect(fk[0]?.def).toContain("(trip_id, expense_id, payment_id)");
	});
});

describe("seed skeleton", () => {
	it("is idempotent", async () => {
		const first = await newTrip("seed-twice");
		const second = await newTrip("seed-twice");
		expect(second.tripId).not.toBe(first.tripId);
		const rows = await db
			.select()
			.from(trips)
			.where(eq(trips.slug, "seed-twice"));
		expect(rows).toHaveLength(1);
		expect(rows[0]?.version).toBe(0);
	});
});

describe("trip isolation", () => {
	it("refuses a child row that points into another trip", async () => {
		const a = await newTrip("iso-a");
		const b = await newTrip("iso-b");
		const nodeA = await newNode(a.tripId, "Tokyo");
		expect(
			await sqlState(() =>
				db.insert(items).values({
					tripId: b.tripId,
					nodeId: nodeA.id,
					position: "a0",
				}),
			),
		).toBe(FK_VIOLATION);
		const [itemB] = await db
			.insert(items)
			.values({ tripId: b.tripId, title: "Lunch", position: "a0" })
			.returning();
		if (!itemB) throw new Error("no item");
		// Mentioning trip A's member from trip B's note.
		expect(
			await sqlState(() =>
				db.insert(mentions).values({
					tripId: b.tripId,
					memberId: a.memberId,
					noteItemId: itemB.id,
				}),
			),
		).toBe(FK_VIOLATION);
		// A Yjs doc name that belongs to another trip.
		expect(
			await sqlState(() =>
				db.insert(yjsDocuments).values({
					name: `trip/${a.tripId}/root`,
					tripId: b.tripId,
					state: new Uint8Array([0]),
				}),
			),
		).toBe(CHECK_VIOLATION);
	});
});

describe("nodes", () => {
	it("refuse cycles", async () => {
		const { tripId } = await newTrip("cycle");
		const japan = await newNode(tripId, "Japan");
		const tokyo = await newNode(tripId, "Tokyo", japan.id);
		const shibuya = await newNode(tripId, "Shibuya", tokyo.id);
		expect(
			await sqlState(() =>
				db
					.update(nodes)
					.set({ parentId: shibuya.id })
					.where(eq(nodes.id, japan.id)),
			),
		).toBe(CHECK_VIOLATION);
		expect(
			await sqlState(() =>
				db
					.update(nodes)
					.set({ parentId: japan.id })
					.where(eq(nodes.id, japan.id)),
			),
		).toBe(CHECK_VIOLATION);
	});

	it("keep live sibling slugs unique, including at the root", async () => {
		const { tripId } = await newTrip("slugs");
		const first = await newNode(tripId, "Kyoto");
		expect(await sqlState(() => newNode(tripId, "Kyoto"))).toBe(
			UNIQUE_VIOLATION,
		);
		await db
			.update(nodes)
			.set({ deletedAt: new Date() })
			.where(eq(nodes.id, first.id));
		expect(await sqlState(() => newNode(tripId, "Kyoto"))).toBe("ok");
	});

	it("allow a category only on places", async () => {
		const { tripId } = await newTrip("category");
		expect(
			await sqlState(() =>
				db.insert(nodes).values({
					tripId,
					type: "city",
					category: "museum",
					name: "X",
					slug: "x",
					position: "a0",
				}),
			),
		).toBe(CHECK_VIOLATION);
	});
});

describe("days", () => {
	it("swap dates inside one transaction (deferred uniqueness)", async () => {
		const { tripId } = await newTrip("days-swap");
		const [d1, d2] = await db
			.insert(tripDays)
			.values([
				{ tripId, date: "2027-10-03" },
				{ tripId, date: "2027-10-04" },
			])
			.returning();
		if (!d1 || !d2) throw new Error("no days");
		await db.transaction(async (tx) => {
			await tx
				.update(tripDays)
				.set({ date: "2027-10-04" })
				.where(eq(tripDays.id, d1.id));
			await tx
				.update(tripDays)
				.set({ date: "2027-10-03" })
				.where(eq(tripDays.id, d2.id));
		});
		const [row] = await db
			.select()
			.from(tripDays)
			.where(eq(tripDays.id, d1.id));
		expect(row?.date).toBe("2027-10-04");
	});

	it("can't be deleted while they hold items; stays and due days are nulled", async () => {
		const { tripId } = await newTrip("days-delete");
		const hotel = await newNode(tripId, "Hotel");
		const [day] = await db
			.insert(tripDays)
			.values({ tripId, date: "2027-10-05", nightNodeId: hotel.id })
			.returning();
		if (!day) throw new Error("no day");
		const [item] = await db
			.insert(items)
			.values({ tripId, dayId: day.id, title: "Lunch", position: "a0" })
			.returning();
		const [todo] = await db
			.insert(listItems)
			.values({
				tripId,
				list: "todo",
				text: "Book it",
				position: "a0",
				dueDayId: day.id,
			})
			.returning();
		if (!item || !todo) throw new Error("no rows");

		expect(
			await sqlState(() => db.delete(tripDays).where(eq(tripDays.id, day.id))),
		).toBe(FK_VIOLATION);

		await db.delete(nodes).where(eq(nodes.id, hotel.id));
		const [afterNode] = await db
			.select()
			.from(tripDays)
			.where(eq(tripDays.id, day.id));
		expect(afterNode?.nightNodeId).toBeNull();

		await db.update(items).set({ dayId: null }).where(eq(items.id, item.id));
		await db.delete(tripDays).where(eq(tripDays.id, day.id));
		const [afterDay] = await db
			.select()
			.from(listItems)
			.where(eq(listItems.id, todo.id));
		expect(afterDay?.dueDayId).toBeNull();
		expect(afterDay?.tripId).toBe(tripId);
	});

	it("reject a bad start time", async () => {
		const { tripId } = await newTrip("days-time");
		expect(
			await sqlState(() =>
				db
					.insert(tripDays)
					.values({ tripId, date: "2027-10-06", startTime: "25:00" }),
			),
		).toBe(CHECK_VIOLATION);
	});
});

describe("legs", () => {
	it("enforce the pair/stay shape, one leg per pair, and flight times", async () => {
		const { tripId } = await newTrip("legs");
		const [a, b] = await db
			.insert(items)
			.values([
				{ tripId, title: "A", position: "a0" },
				{ tripId, title: "B", position: "a1" },
			])
			.returning();
		if (!a || !b) throw new Error("no items");
		await db
			.insert(legs)
			.values({ tripId, fromItemId: a.id, toItemId: b.id, mode: "walk" });
		expect(
			await sqlState(() =>
				db.insert(legs).values({ tripId, fromItemId: a.id, toItemId: b.id }),
			),
		).toBe(UNIQUE_VIOLATION);
		expect(
			await sqlState(() =>
				db.insert(legs).values({ tripId, fromItemId: a.id, toItemId: a.id }),
			),
		).toBe(CHECK_VIOLATION);
		// FB-18: a flight's times are optional, but it has both instants or
		// neither.
		expect(
			await sqlState(() =>
				db.insert(legs).values({
					tripId,
					fromItemId: b.id,
					toItemId: a.id,
					mode: "flight",
					depAt: new Date("2026-12-12T07:00:00Z"),
				}),
			),
		).toBe(CHECK_VIOLATION);
		expect(
			await sqlState(() =>
				db.insert(legs).values({ tripId, kind: "stay_start" }),
			),
		).toBe(CHECK_VIOLATION);
		// A flight is a pair leg; with no times yet it is fine.
		expect(
			await sqlState(() =>
				db.insert(legs).values({
					tripId,
					fromItemId: b.id,
					toItemId: a.id,
					mode: "flight",
				}),
			),
		).toBe("ok");
	});
});

describe("bundles", () => {
	it("allow at most one target and name Yjs docs after it", async () => {
		const { tripId, memberId } = await newTrip("bundles");
		const tokyo = await newNode(tripId, "Tokyo");
		const [day] = await db
			.insert(tripDays)
			.values({ tripId, date: "2027-10-03" })
			.returning();
		if (!day) throw new Error("no day");
		const shop = {
			tripId,
			list: "shopping",
			text: "x",
			position: "a0",
		} as const;
		// Two targets at once.
		expect(
			await sqlState(() =>
				db
					.insert(listItems)
					.values({ ...shop, nodeId: tokyo.id, dayId: day.id }),
			),
		).toBe(CHECK_VIOLATION);
		// Only http(s) URLs.
		expect(
			await sqlState(() =>
				db
					.insert(listItems)
					.values({ ...shop, nodeId: tokyo.id, url: "javascript:alert(1)" }),
			),
		).toBe(CHECK_VIOLATION);
		expect(
			await sqlState(() =>
				db.insert(listItems).values({
					...shop,
					nodeId: tokyo.id,
					url: "https://www.muji.com/jp/",
				}),
			),
		).toBe("ok");

		const state = new Uint8Array([1, 2, 3]);
		await db
			.insert(yjsDocuments)
			.values({ name: `trip/${tripId}/root`, tripId, state });
		await db.insert(yjsDocuments).values({
			name: `trip/${tripId}/node/${tokyo.id}`,
			tripId,
			nodeId: tokyo.id,
			state,
		});
		expect(
			await sqlState(() =>
				db.insert(yjsDocuments).values({
					name: `trip/${tripId}/root-ish`,
					tripId,
					state,
				}),
			),
		).toBe(CHECK_VIOLATION);
		const [doc] = await db
			.select()
			.from(yjsDocuments)
			.where(eq(yjsDocuments.nodeId, tokyo.id));
		expect(doc?.state).toEqual(state);

		await db.insert(mentions).values({
			tripId,
			memberId,
			docName: `trip/${tripId}/root`,
		});
		expect(
			await sqlState(() => db.insert(mentions).values({ tripId, memberId })),
		).toBe(CHECK_VIOLATION);
	});
});

describe("share links", () => {
	it("look up by hash and allow one live link per role", async () => {
		const { tripId } = await newTrip("share");
		const token = "dev-share-token-editor";
		await db
			.insert(shareLinks)
			.values({ tripId, role: "editor", ...shareTokenColumns(token) });
		const [found] = await db
			.select({ id: shareLinks.id, role: shareLinks.role })
			.from(shareLinks)
			.where(eq(shareLinks.tokenHash, hashShareToken(token)));
		expect(found?.role).toBe("editor");
		expect(
			await sqlState(() =>
				db.insert(shareLinks).values({
					tripId,
					role: "editor",
					...shareTokenColumns("another-token-value"),
				}),
			),
		).toBe(UNIQUE_VIOLATION);
		await db
			.update(shareLinks)
			.set({ revokedAt: new Date() })
			.where(and(eq(shareLinks.tripId, tripId), eq(shareLinks.role, "editor")));
		expect(
			await sqlState(() =>
				db.insert(shareLinks).values({
					tripId,
					role: "editor",
					...shareTokenColumns("another-token-value"),
				}),
			),
		).toBe("ok");
	});
});

describe("trips", () => {
	it("bump version atomically and allow one owner", async () => {
		const { tripId, userId } = await newTrip("version");
		const [row] = await db
			.update(trips)
			.set({ version: sql`${trips.version} + 1` })
			.where(eq(trips.id, tripId))
			.returning({ version: trips.version });
		expect(row?.version).toBe(1);
		expect(
			await sqlState(() =>
				db.insert(tripMembers).values({
					tripId,
					status: "placeholder",
					role: "owner",
					displayName: "Sam",
					color: 1,
				}),
			),
		).toBe(UNIQUE_VIOLATION);
		expect(
			await sqlState(() =>
				db.insert(tripMembers).values({
					tripId,
					userId,
					status: "invited",
					role: "editor",
					email: "x@example.com",
					color: 1,
				}),
			),
		).toBe(CHECK_VIOLATION);
	});
});
