/**
 * ADDENDUM §8/§10 people contracts against real Postgres: free-text
 * placeholders (`createPlaceholder`), merging a placeholder into a member
 * (`mergeMember`: tags, ratings, splits, payers, budgets, settlements, JSON
 * and Markdown ids), the claim core (`claimPlaceholderRow`), the one-inbox
 * feed (`loadInbox`: mentions, review counts, private items filtered) and the
 * private-list-item mention guard (`syncMentions`).
 * Uses its own throwaway database (created, migrated and dropped here).
 */
import { randomBytes, randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeDb, getDb } from "@/db/db.server";
import {
	dropDatabase,
	ensureDatabase,
	migrateDatabase,
} from "@/db/migrate.server";
import { user } from "@/db/schema";
import { seedDemoSkeleton } from "@/db/seed.server";
import { mentionToken } from "@/lib/notes/mentions";
import { loadInbox } from "./inbox.server";
import { TxOutbox } from "./live/outbox.server";
import {
	claimPlaceholderRow,
	createPlaceholder,
	mergeMember,
} from "./members.server";
import { syncMentions } from "./mentions.server";

const baseUrl = process.env.DATABASE_URL_TEST ?? process.env.DATABASE_URL;
if (!baseUrl) throw new Error("DATABASE_URL_TEST or DATABASE_URL must be set");
const scratchUrl = (() => {
	const url = new URL(baseUrl);
	url.pathname = `/yonder_people_${randomBytes(4).toString("hex")}`;
	return url.toString();
})();

beforeAll(async () => {
	await ensureDatabase(scratchUrl);
	await migrateDatabase(scratchUrl);
	process.env.DATABASE_URL = scratchUrl;
}, 60_000);

afterAll(async () => {
	await closeDb();
	await dropDatabase(scratchUrl);
});

const db = () => getDb();
const q = async <T>(query: ReturnType<typeof sql>) =>
	(await db().execute(query)).rows as T[];

async function newUser(name = "Audrey Nguyen") {
	const id = randomUUID();
	const [first = "A", last = "B"] = name.split(" ");
	await db()
		.insert(user)
		.values({
			id,
			name,
			email: `${id}@asia2027.test`,
			firstName: first,
			lastName: last,
			isAnonymous: false,
		});
	return id;
}

async function newTrip() {
	const slug = `p-${randomBytes(4).toString("hex")}`;
	return seedDemoSkeleton(db(), {
		email: `${slug}@asia2027.test`,
		tripSlug: slug,
		tripName: slug,
	});
}

const inTx = <T>(
	tripId: string,
	fn: (tx: never, out: TxOutbox) => Promise<T>,
) => db().transaction((tx) => fn(tx as never, new TxOutbox(tripId)));

describe("createPlaceholder", () => {
	it("creates a rater placeholder once per name (case and spaces ignored; PLACES §1c)", async () => {
		const t = await newTrip();
		const a = await inTx(t.tripId, (tx, out) =>
			createPlaceholder(tx, out, t.tripId, "  Audrey  "),
		);
		const b = await inTx(t.tripId, (tx, out) =>
			createPlaceholder(tx, out, t.tripId, "audrey"),
		);
		expect(a.created).toBe(true);
		expect(b).toEqual({ memberId: a.memberId, created: false });
		const [row] = await q<{ status: string; role: string; name: string }>(sql`
			select status::text as status, role::text as role, display_name as name
			  from trip_members where id = ${a.memberId}`);
		expect(row).toEqual({
			status: "placeholder",
			role: "rater",
			name: "Audrey",
		});
	});
});

describe("mergeMember", () => {
	it("moves tags, ratings, money and ids to the member and keeps a pointer", async () => {
		const t = await newTrip();
		const audreyUser = await newUser();
		const real = randomUUID();
		await db().execute(sql`
			insert into trip_members (id, trip_id, user_id, status, role, color)
			values (${real}, ${t.tripId}, ${audreyUser}, 'active', 'editor', 3)`);
		const { memberId: ph } = await inTx(t.tripId, (tx, out) =>
			createPlaceholder(tx, out, t.tripId, "Audrey"),
		);
		const [node] = await q<{ id: string }>(sql`
			insert into nodes (id, trip_id, type, name, slug, position)
			values (${randomUUID()}, ${t.tripId}, 'city', 'Kyoto', 'kyoto', 'a0') returning id::text as id`);
		const [node2] = await q<{ id: string }>(sql`
			insert into nodes (id, trip_id, type, name, slug, position)
			values (${randomUUID()}, ${t.tripId}, 'city', 'Osaka', 'osaka', 'a1') returning id::text as id`);
		// Both rated Kyoto (the member's rating wins); only the placeholder rated Osaka.
		await db().execute(sql`
			insert into node_priorities (trip_id, node_id, member_id, priority) values
			  (${t.tripId}, ${node?.id}, ${ph}, 'meh'),
			  (${t.tripId}, ${node?.id}, ${real}, 'must'),
			  (${t.tripId}, ${node2?.id}, ${ph}, 'want')`);
		// An expense both are in (exact), paid by both.
		const [exp] = await q<{ id: string }>(sql`
			insert into expenses (id, trip_id, title, amount_minor, currency, split_mode)
			values (${randomUUID()}, ${t.tripId}, 'Dinner', 9000, 'JPY', 'exact') returning id::text as id`);
		await db().execute(sql`
			insert into expense_shares (trip_id, expense_id, member_id, amount_minor) values
			  (${t.tripId}, ${exp?.id}, ${ph}, 3000), (${t.tripId}, ${exp?.id}, ${real}, 2000),
			  (${t.tripId}, ${exp?.id}, ${t.memberId}, 4000)`);
		const [pay] = await q<{ id: string }>(sql`
			insert into expense_payments (id, trip_id, expense_id, paid_at, paid_tz, currency, amount_minor)
			values (${randomUUID()}, ${t.tripId}, ${exp?.id}, now(), 'Asia/Tokyo', 'JPY', 9000) returning id::text as id`);
		await db().execute(sql`
			insert into expense_payment_payers (trip_id, payment_id, member_id, amount_minor) values
			  (${t.tripId}, ${pay?.id}, ${ph}, 5000), (${t.tripId}, ${pay?.id}, ${real}, 4000)`);
		// A settlement between the two (meaningless after the merge) and one with the owner.
		await db().execute(sql`
			insert into settlements (id, trip_id, from_member_id, to_member_id, amount_minor, currency, settled_at, settled_tz)
			values (${randomUUID()}, ${t.tripId}, ${ph}, ${real}, 100, 'JPY', now(), 'Asia/Tokyo'),
			       (${randomUUID()}, ${t.tripId}, ${ph}, ${t.memberId}, 200, 'JPY', now(), 'Asia/Tokyo')`);
		// Budget lines: both have one on the trip root (the member's wins).
		await db().execute(sql`
			insert into budget_lines (id, trip_id, member_id, amount_minor) values
			  (${randomUUID()}, ${t.tripId}, ${ph}, 100000), (${randomUUID()}, ${t.tripId}, ${real}, 300000)`);
		// A mention token in an item note.
		const [item] = await q<{ id: string }>(sql`
			insert into items (id, trip_id, title, note, position)
			values (${randomUUID()}, ${t.tripId}, 'Tea', ${`ask ${mentionToken("Audrey", ph)}`}, 'a0')
			returning id::text as id`);

		await inTx(t.tripId, (tx, out) => mergeMember(tx, out, t.tripId, ph, real));

		const ratings = await q<{ node: string; p: string }>(sql`
			select node_id::text as node, priority::text as p from node_priorities
			 where member_id = ${real} order by p`);
		expect(ratings).toEqual([
			{ node: node?.id, p: "must" },
			{ node: node2?.id, p: "want" },
		]);
		const shares = await q<{ m: string; a: number }>(sql`
			select member_id::text as m, amount_minor::int as a from expense_shares
			 where expense_id = ${exp?.id} order by a`);
		expect(shares).toEqual([
			{ m: t.memberId, a: 4000 },
			{ m: real, a: 5000 },
		]);
		const payers = await q<{ a: number }>(sql`
			select amount_minor::int as a from expense_payment_payers where payment_id = ${pay?.id}`);
		expect(payers).toEqual([{ a: 9000 }]);
		const settled = await q<{ from: string; live: boolean }>(sql`
			select from_member_id::text as from, deleted_at is null as live from settlements
			 where trip_id = ${t.tripId} order by amount_minor`);
		expect(settled).toEqual([
			{ from: ph, live: false },
			{ from: real, live: true },
		]);
		const budgets = await q<{ a: number }>(sql`
			select amount_minor::int as a from budget_lines where trip_id = ${t.tripId}`);
		expect(budgets).toEqual([{ a: 300000 }]);
		const [note] = await q<{ note: string }>(
			sql`select note from items where id = ${item?.id}`,
		);
		expect(note?.note).toContain(`mention:${real}`);
		const [gone] = await q<{ status: string; into: string; name: string }>(sql`
			select status::text as status, merged_into_id::text as into, display_name as name
			  from trip_members where id = ${ph}`);
		expect(gone).toEqual({ status: "removed", into: real, name: "Audrey" });
	});

	it("keeps both slices when both are in one equal split or one shared line (MONEY-QA-04)", async () => {
		const t = await newTrip();
		const mayaUser = await newUser("Maya Suggester");
		const maya = randomUUID();
		await db().execute(sql`
			insert into trip_members (id, trip_id, user_id, status, role, color)
			values (${maya}, ${t.tripId}, ${mayaUser}, 'active', 'editor', 3)`);
		const { memberId: audrey } = await inTx(t.tripId, (tx, out) =>
			createPlaceholder(tx, out, t.tripId, "Audrey"),
		);
		const dev = t.memberId;
		const three = [dev, maya, audrey];
		// Taxi $9.00, equal between all three, paid by Dev.
		const [taxi] = await q<{ id: string }>(sql`
			insert into expenses (id, trip_id, title, amount_minor, currency, split_mode)
			values (${randomUUID()}, ${t.tripId}, 'Taxi', 900, 'USD', 'equal') returning id::text as id`);
		for (const m of three)
			await db().execute(sql`
				insert into expense_shares (trip_id, expense_id, member_id) values (${t.tripId}, ${taxi?.id}, ${m})`);
		// Shared platter $6.00, itemized: one line all three had.
		const [platter] = await q<{ id: string }>(sql`
			insert into expenses (id, trip_id, title, amount_minor, currency, split_mode)
			values (${randomUUID()}, ${t.tripId}, 'Shared platter', 600, 'USD', 'equal') returning id::text as id`);
		const [line] = await q<{ id: string }>(sql`
			insert into expense_lines (id, trip_id, expense_id, label, amount_minor, position)
			values (${randomUUID()}, ${t.tripId}, ${platter?.id}, 'Platter', 600, 'a0') returning id::text as id`);
		for (const m of three)
			await db().execute(sql`
				insert into expense_line_members (trip_id, line_id, member_id) values (${t.tripId}, ${line?.id}, ${m})`);
		for (const e of [taxi, platter]) {
			const [pay] = await q<{ id: string }>(sql`
				insert into expense_payments (id, trip_id, expense_id, paid_at, paid_tz, currency, amount_minor)
				select ${randomUUID()}, ${t.tripId}, id, now(), 'UTC', 'USD', amount_minor from expenses where id = ${e?.id}
				returning id::text as id`);
			await db().execute(sql`
				insert into expense_payment_payers (trip_id, payment_id, member_id, amount_minor)
				select ${t.tripId}, ${pay?.id}, ${dev}, amount_minor from expense_payments where id = ${pay?.id}`);
		}

		await inTx(t.tripId, (tx, out) =>
			mergeMember(tx, out, t.tripId, audrey, maya),
		);

		// Taxi: exact, Maya owes both $3.00 slices.
		const [mode] = await q<{ mode: string }>(
			sql`select split_mode::text as mode from expenses where id = ${taxi?.id}`,
		);
		expect(mode?.mode).toBe("exact");
		const shares = await q<{ m: string; a: number }>(sql`
			select member_id::text as m, amount_minor::int as a from expense_shares
			 where expense_id = ${taxi?.id} order by a`);
		expect(shares).toEqual([
			{ m: dev, a: 300 },
			{ m: maya, a: 600 },
		]);
		// Platter: Maya has her line part and Audrey's; the lines still add up.
		const lines = await q<{ a: number; members: string[] }>(sql`
			select l.amount_minor::int as a,
			       array_agg(m.member_id::text order by m.member_id) as members
			  from expense_lines l join expense_line_members m on m.line_id = l.id
			 where l.expense_id = ${platter?.id} group by l.id order by a desc`);
		expect(lines.reduce((s, l) => s + l.a, 0)).toBe(600);
		const owed: Record<string, number> = {};
		for (const l of lines)
			for (const m of l.members)
				owed[m] = (owed[m] ?? 0) + l.a / l.members.length;
		expect(owed).toEqual({ [dev]: 200, [maya]: 400 });
	});

	it("refuses to merge away an active member", async () => {
		const t = await newTrip();
		const { memberId: ph } = await inTx(t.tripId, (tx, out) =>
			createPlaceholder(tx, out, t.tripId, "Sam"),
		);
		await expect(
			inTx(t.tripId, (tx, out) =>
				mergeMember(tx, out, t.tripId, t.memberId, ph),
			),
		).rejects.toThrow(/CONFLICT/);
	});
});

describe("claimPlaceholderRow", () => {
	it("turns the placeholder into the caller's membership with the given role", async () => {
		const t = await newTrip();
		const u = await newUser("Maya Chen");
		const { memberId: ph } = await inTx(t.tripId, (tx, out) =>
			createPlaceholder(tx, out, t.tripId, "Maya"),
		);
		const r = await inTx(t.tripId, (tx, out) =>
			claimPlaceholderRow(tx, out, {
				tripId: t.tripId,
				memberId: ph,
				userId: u,
				role: "suggester",
			}),
		);
		expect(r).toEqual({ memberId: ph, merged: false });
		const [row] = await q<{ status: string; role: string; userId: string }>(sql`
			select status::text as status, role::text as role, user_id as "userId"
			  from trip_members where id = ${ph}`);
		expect(row).toEqual({ status: "active", role: "suggester", userId: u });
		await expect(
			inTx(t.tripId, (tx, out) =>
				claimPlaceholderRow(tx, out, {
					tripId: t.tripId,
					memberId: ph,
					userId: u,
					role: "owner",
				}),
			),
		).rejects.toThrow(/VALIDATION/);
	});
});

describe("one inbox + private list items", () => {
	it("shows mentions and review counts, never a private item's mention", async () => {
		const t = await newTrip();
		const maya = await newUser("Maya Chen");
		const mayaMember = randomUUID();
		await db().execute(sql`
			insert into trip_members (id, trip_id, user_id, status, role, color)
			values (${mayaMember}, ${t.tripId}, ${maya}, 'active', 'editor', 2)`);
		const shared = randomUUID();
		const secret = randomUUID();
		const text = `buy ${mentionToken("Maya", mayaMember)}`;
		await db().execute(sql`
			insert into list_items (id, trip_id, list, text, position, created_by, is_private) values
			  (${shared}, ${t.tripId}, 'todo', ${text}, 'a0', ${t.userId}, false),
			  (${secret}, ${t.tripId}, 'shopping', ${text}, 'a1', ${t.userId}, true)`);
		for (const id of [shared, secret])
			await inTx(t.tripId, (tx, out) =>
				syncMentions(tx, out, t.tripId, { listItemId: id }, [text], {
					createdBy: t.userId,
					target: {},
				}),
			);
		const rows = await q<{ li: string }>(sql`
			select list_item_id::text as li from mentions where member_id = ${mayaMember}`);
		expect(rows).toEqual([{ li: shared }]);

		// A suggestion by Maya waits for the owner's review.
		await db().execute(sql`
			insert into proposals (id, trip_id, op, payload, base, entity_kind, summary, author_user_id, author_name, author_color, author_is_guest)
			values (${randomUUID()}, ${t.tripId}, 'node.update', '{}'::jsonb, '{}'::jsonb, 'node', 'renamed Kyoto', ${maya}, 'Maya Chen', 2, false)`);

		const mayaInbox = await loadInbox(maya, { tripId: t.tripId });
		expect(mayaInbox.items.map((i) => i.kind)).toEqual(["mention"]);
		expect(mayaInbox.unread).toBe(1);
		const ownerInbox = await loadInbox(t.userId);
		expect(ownerInbox.items).toMatchObject([
			{ kind: "review", count: 1, read: false },
		]);
	});
});
