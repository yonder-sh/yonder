/**
 * The Asia 2027 import against real Postgres (SPEC §17.3; QA SEED-01, 10, 13):
 * one transaction, the row counts the plan promises, refusing a second run
 * without `--replace`, replacing with it, a bad input leaving no partial trip,
 * the dumped graph, and the QA seed's fixtures passing every DB constraint.
 * Uses its own throwaway database (created, migrated and dropped here).
 */
import { randomBytes } from "node:crypto";
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
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeDb, getDb } from "@/db/db.server";
import {
	dropDatabase,
	ensureDatabase,
	migrateDatabase,
} from "@/db/migrate.server";
import {
	expensePaymentPayers,
	expensePayments,
	expenseShares,
	expenses,
	tripMembers,
} from "@/db/schema";
import { closeQueues } from "@/server/live/jobs.server";
import { closeRedis } from "@/server/live/redis.server";
import { DEFAULTS, type ImportArgs } from "./lib/args";
import {
	applyQaFixtures,
	loadAirports,
	QA_DATES,
	QA_USERS,
	qaMoney,
	qaProposals,
} from "./lib/qa";
import { proposeAs } from "./lib/qa-propose";
import { type ImportHooks, removeImport, runImport } from "./lib/run";
import { findOrCreateUser, ImportRefused } from "./lib/write";

const baseUrl = process.env.DATABASE_URL_TEST ?? process.env.DATABASE_URL;
if (!baseUrl) throw new Error("DATABASE_URL_TEST or DATABASE_URL must be set");
const scratchUrl = (() => {
	const url = new URL(baseUrl);
	url.pathname = `/yonder_import_${randomBytes(4).toString("hex")}`;
	return url.toString();
})();

beforeAll(async () => {
	await ensureDatabase(scratchUrl);
	await migrateDatabase(scratchUrl);
	process.env.DATABASE_URL = scratchUrl;
}, 60_000);

afterAll(async () => {
	await closeQueues().catch(() => {});
	await closeRedis();
	await closeDb();
	await dropDatabase(scratchUrl);
});

const graphFile = path.join(
	tmpdir(),
	`asia-2027-${randomBytes(3).toString("hex")}.graph.json`,
);
const args = (o: Partial<ImportArgs> = {}): ImportArgs => ({
	...DEFAULTS,
	media: false,
	autofill: false,
	geocodeFallback: false,
	report: null,
	...o,
});
const quiet = { log: () => {} };
const q = async <T>(query: ReturnType<typeof sql>) =>
	(await getDb().execute(query)).rows as T[];
const count = async (table: string, tripId: string) =>
	Number(
		(
			await q<{ n: string }>(
				sql`select count(*)::int as n from ${sql.identifier(table)} where trip_id = ${tripId}`,
			)
		)[0]?.n,
	);

describe("sheet:import", () => {
	let tripId = "";

	it("writes the whole trip in one go", async () => {
		const r = await runImport(args({ dumpGraph: graphFile }), quiet, getDb());
		tripId = r.tripId;
		expect(await count("nodes", tripId)).toBe(191);
		expect(await count("items", tripId)).toBe(62);
		expect(await count("legs", tripId)).toBe(3);
		expect(await count("list_items", tripId)).toBe(59);
		expect(await count("list_item_targets", tripId)).toBe(3);
		expect(await count("list_item_assignees", tripId)).toBe(19 + 3 + 2 * 5);
		expect(await count("attachments", tripId)).toBe(32);
		expect(await count("node_priorities", tripId)).toBe(125);
		expect(await count("yjs_documents", tripId)).toBe(101);
		expect(await count("trip_days", tripId)).toBe(37);
		const [trip] = await q<{
			slug: string;
			start_date: string;
			end_date: string;
			default_tz: string;
		}>(
			sql`select slug, start_date::text, end_date::text, default_tz from trips where id = ${tripId}`,
		);
		expect(trip).toEqual({
			slug: "asia-2027",
			start_date: "2027-10-02",
			end_date: "2027-11-07",
			default_tz: "Asia/Tokyo",
		});
		const members = await q<{
			status: string;
			role: string;
			display_name: string | null;
			email: string;
		}>(
			sql`select m.status::text, m.role::text, m.display_name, u.email from trip_members m left join "user" u on u.id = m.user_id where m.trip_id = ${tripId} order by m.color`,
		);
		expect(members).toEqual([
			{
				status: "active",
				role: "owner",
				display_name: null,
				email: "dennis@dennispham.me",
			},
			{
				status: "placeholder",
				role: "editor",
				display_name: "Audrey",
				email: null,
			},
		]);
		const [owner] = await q<{
			first_name: string;
			last_name: string;
			email_verified: boolean;
		}>(
			sql`select first_name, last_name, email_verified from "user" where email = 'dennis@dennispham.me'`,
		);
		// A blank last name: /welcome asks for it at the first sign-in (ADDENDUM §8).
		expect(owner).toEqual({
			first_name: "Dennis",
			last_name: "",
			email_verified: true,
		});
		// Relative booking windows (ADDENDUM §10) are stored as rules.
		const rules = await q<{ text: string; due_rule: { kind: string } }>(
			sql`select text, due_rule from list_items where trip_id = ${tripId} and due_rule is not null order by text`,
		);
		expect(rules.map((r) => r.text)).toEqual([
			"Fuji Excursion train (Shinjuku → Kawaguchiko)",
			"Ghibli Museum tickets",
			"JAL Sky Museum tour",
		]);
		// Notes are real Yjs documents with Markdown and plain text.
		const [note] = await q<{ markdown: string; plain_text: string }>(
			sql`select d.markdown, d.plain_text from yjs_documents d join nodes n on d.node_id = n.id where n.trip_id = ${tripId} and n.name = 'Tokyo'`,
		);
		expect(note?.markdown).toContain(
			"[Kappabashi Street](https://www.japan-guide.com/e/e3020.html)",
		);
		expect(note?.plain_text).toContain("Kappabashi Street");
	});

	it("dumps the graph for the engine's perf test", () => {
		const g = JSON.parse(readFileSync(graphFile, "utf8"));
		expect(g.trip.id).toBe(tripId);
		expect(g.nodes).toHaveLength(191);
		expect(g.items).toHaveLength(62);
		expect(g.members.map((m: { name: string }) => m.name)).toEqual([
			"Dennis",
			"Audrey",
		]);
		rmSync(graphFile, { force: true });
	});

	it("refuses a second run without --replace (SEED-10 per SPEC §17.3)", async () => {
		await expect(runImport(args(), quiet, getDb())).rejects.toBeInstanceOf(
			ImportRefused,
		);
		expect(await count("nodes", tripId)).toBe(191);
	});

	it("replaces the trip with --replace, with the same counts", async () => {
		const r = await runImport(args({ replace: true }), quiet, getDb());
		expect(r.replacedTripId).toBe(tripId);
		expect(await count("nodes", tripId)).toBe(0);
		expect(await count("nodes", r.tripId)).toBe(191);
		expect(await count("list_items", r.tripId)).toBe(59);
		const owners = await q<{ n: number }>(
			sql`select count(*)::int as n from "user" where email = 'dennis@dennispham.me'`,
		);
		expect(owners[0]?.n).toBe(1);
		tripId = r.tripId;
	});

	it("leaves nothing behind when an input file is bad (SEED-13)", async () => {
		const dir = mkdtempSync(path.join(tmpdir(), "sheet-"));
		cpSync("seed/data", dir, { recursive: true });
		const f = path.join(dir, "shopping-list.json");
		writeFileSync(f, readFileSync(f, "utf8").slice(0, 300));
		try {
			await expect(
				runImport(args({ slug: "asia-bad", dataDir: dir }), quiet, getDb()),
			).rejects.toThrow(/shopping-list\.json: not valid JSON/);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
		expect(await q(sql`select id from trips where slug = 'asia-bad'`)).toEqual(
			[],
		);
	});

	it("rolls back a failure inside the transaction", async () => {
		await expect(
			runImport(
				args({ slug: "asia-rollback" }),
				{
					...quiet,
					extend: async () => {
						throw new Error("boom");
					},
				},
				getDb(),
			),
		).rejects.toThrow("boom");
		expect(
			await q(sql`select id from trips where slug = 'asia-rollback'`),
		).toEqual([]);
	});

	const airports = loadAirports("seed/airports/airports.json");
	const qaArgs = (o: Partial<ImportArgs> = {}) =>
		args({
			slug: "asia-qa",
			owner: "dennis@asia2027.test",
			ownerLast: "Tester",
			...QA_DATES,
			...o,
		});
	/** The QA seed's in-transaction additions that matter to a replace: money. */
	const qaHooks: ImportHooks = {
		...quiet,
		patchPlan: (plan) => applyQaFixtures(plan, airports),
		extend: async (tx, ctx) => {
			const m = qaMoney(ctx.plan, { createdBy: ctx.ownerUserId });
			await tx.insert(expenses).values(m.expenses);
			await tx.insert(expensePayments).values(m.payments);
			await tx.insert(expensePaymentPayers).values(m.payers);
			await tx.insert(expenseShares).values(m.shares);
		},
	};

	it("writes the QA fixtures within every DB constraint (flights, fixed trains, seats, money)", async () => {
		const r = await runImport(qaArgs(), qaHooks, getDb());
		const flights = await q<{ n: number }>(
			sql`select count(*)::int as n from legs where trip_id = ${r.tripId} and mode = 'flight' and dep_at is not null and arr_at is not null`,
		);
		expect(flights[0]?.n).toBe(6);
		const [fuji] = await q<{ dep: string; arr: string }>(
			sql`select to_char(dep_at at time zone 'Asia/Tokyo', 'HH24:MI') as dep, to_char(arr_at at time zone 'Asia/Tokyo', 'HH24:MI') as arr
			      from legs where trip_id = ${r.tripId} and details->'booking'->>'ref' = 'E7K2Q9'`,
		);
		expect(fuji).toEqual({ dep: "08:30", arr: "10:26" });
		expect(await count("leg_assignees", r.tripId)).toBeGreaterThanOrEqual(18);
		expect(await count("trip_days", r.tripId)).toBe(35);
		expect(await count("expenses", r.tripId)).toBe(3);
		expect(await count("expense_shares", r.tripId)).toBe(4);
		// QA DUE-09: the ANA window is relative to NH 9's day.
		const [ana] = await q<{ due_date: string; due_rule: { days: number } }>(
			sql`select due_date::text, due_rule from list_items where trip_id = ${r.tripId} and text = 'ANA JFK→HND award (depart Oct 2)'`,
		);
		expect(ana).toMatchObject({
			due_date: "2026-10-12",
			due_rule: { kind: "days", days: 355, time: "09:00" },
		});
	});

	it("replaces a trip that has money rows and a merged placeholder", async () => {
		// Money → members and merged → member are NO ACTION keys: a plain
		// cascade from trips can reach trip_members first and fail.
		const [before] = await q<{ id: string; owner: string }>(
			sql`select t.id, m.id as owner from trips t join trip_members m on m.trip_id = t.id and m.role = 'owner' where t.slug = 'asia-qa' and t.deleted_at is null`,
		);
		const tripIdQa = before?.id as string;
		await getDb().insert(tripMembers).values({
			tripId: tripIdQa,
			status: "removed",
			role: "editor",
			displayName: "Sam",
			color: 5,
			mergedIntoId: before?.owner,
		});
		const r = await runImport(qaArgs({ replace: true }), qaHooks, getDb());
		expect(r.replacedTripId).toBe(tripIdQa);
		expect(await count("expenses", tripIdQa)).toBe(0);
		expect(await count("trip_members", tripIdQa)).toBe(0);
		expect(await count("expenses", r.tripId)).toBe(3);
	});

	it("proposes Maya's two suggestions through the real gate (EXTENSIONS §2.1)", async () => {
		let mayaId = "";
		const r = await runImport(
			qaArgs({ replace: true }),
			{
				...qaHooks,
				extend: async (tx, ctx) => {
					await qaHooks.extend?.(tx, ctx);
					mayaId = (await findOrCreateUser(tx, QA_USERS.maya)).id;
					await tx.insert(tripMembers).values({
						tripId: ctx.plan.trip.id,
						userId: mayaId,
						status: "active",
						role: "suggester",
						color: 3,
					});
				},
			},
			getDb(),
		);
		const ids = await proposeAs(r.tripId, mayaId, qaProposals(r.plan));
		expect(ids).toHaveLength(2);
		const rows = await q<{ op: string; status: string; summary: string }>(
			sql`select op, status, summary from proposals where trip_id = ${r.tripId} order by op`,
		);
		expect(rows).toEqual([
			{ op: "item.update", status: "open", summary: "changed Akihabara" },
			{ op: "node.create", status: "open", summary: "added Tōfuku-ji" },
		]);
		// Nothing applied: the idea doesn't exist yet and Akihabara keeps 4 h.
		expect(
			await q(
				sql`select id from nodes where trip_id = ${r.tripId} and name = 'Tōfuku-ji'`,
			),
		).toEqual([]);
		const [aki] = await q<{ duration_min: number }>(
			sql`select i.duration_min from items i join nodes n on n.id = i.node_id where i.trip_id = ${r.tripId} and n.name = 'Akihabara' and i.day_id is null`,
		);
		expect(aki?.duration_min).toBe(240);
		// Someone who isn't a member (Eve) can't suggest.
		const eve = await getDb().transaction((tx) =>
			findOrCreateUser(tx, QA_USERS.eve),
		);
		await expect(
			proposeAs(r.tripId, eve.id, qaProposals(r.plan)),
		).rejects.toThrow(/can't suggest/);
	});

	it("removes an imported trip with --remove", async () => {
		const id = await removeImport("asia-qa", getDb());
		expect(id).toMatch(/^[0-9a-f-]{36}$/);
		expect(await q(sql`select id from trips where slug = 'asia-qa'`)).toEqual(
			[],
		);
		expect(await removeImport("asia-qa", getDb())).toBeNull();
	});
});
