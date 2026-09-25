/**
 * The one inbox (ADDENDUM §10, EXTENSIONS §9) against real Postgres: every
 * kind (`proposal_result`, `due`, `balance_changed`, `budget_notice`, plus the
 * F-ext0 `mention`/`review`), one read state (`markInboxRead`), keys that
 * re-notify when the thing moves, and the private-item rules: a private gift
 * item never reaches another member's inbox, counts, activity or list reads.
 *
 * `effectiveDue`/`dueState` are WP-Lists' engine; this file pins a small
 * absolute-date version so the feed's plumbing is tested on its own.
 */
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const testEnv = vi.hoisted(() => {
	const hex = Math.random().toString(16).slice(2, 10);
	const base = process.env.DATABASE_URL_TEST ?? process.env.DATABASE_URL;
	if (!base) throw new Error("DATABASE_URL(_TEST) must be set");
	const scratch = new URL(base);
	scratch.pathname = `/yonder_inbox_${hex}`;
	process.env.DATABASE_URL = scratch.toString();
	process.env.REDIS_PREFIX = `yonder-inboxtest-${hex}`;
	process.env.BETTER_AUTH_SECRET ||= "test-secret-test-secret-test-secret-00";
	return { hex, scratchUrl: scratch.toString() };
});

vi.mock("@tanstack/react-start", () => import("@/test/start-mock"));
vi.mock(
	"@tanstack/react-start/server",
	() => import("@/test/start-server-mock"),
);
vi.mock("@/lib/engine/due", () => ({
	effectiveDue: (li: { dueDate: string | null; dueKind: string }) =>
		li.dueDate
			? {
					at: Date.parse(`${li.dueDate}T12:00:00Z`),
					kind: li.dueKind,
					label: `Due ${li.dueDate}`,
					allDay: true,
				}
			: null,
	dueState: (due: { at: number } | null, now: number) => {
		if (!due) return "none";
		if (due.at < now) return "overdue";
		return due.at - now <= 7 * 86_400_000 ? "soon" : "later";
	},
}));

import { closeDb, getDb } from "@/db/db.server";
import {
	dropDatabase,
	ensureDatabase,
	migrateDatabase,
} from "@/db/migrate.server";
import { tripMembers, user } from "@/db/schema";
import { listTripListItems } from "@/features/lists/lists.functions";
import { getTripCounts, listActivity } from "@/functions/graph.functions";
import { listInbox, markInboxRead } from "@/functions/inbox.functions";
import { setNodePriority } from "@/functions/nodes.functions";
import type { InboxDto, InboxItem } from "@/lib/schemas/inbox";
import { countChangesSince } from "@/server/activity.server";
import type { AuthUser } from "@/server/auth.server";
import { cloneDemoTrip, type FixtureClone } from "@/server/fixture.server";
import { closeQueues } from "@/server/live/jobs.server";
import { closeRedis, redis, redisPrefix } from "@/server/live/redis.server";
import { memberNets, splitByWeights } from "@/server/money-nets.server";

vi.setConfig({ testTimeout: 30_000, hookTimeout: 60_000 });

type Fn = (opts: { data?: unknown; context?: unknown }) => Promise<unknown>;
const call = <T>(fn: unknown, u: AuthUser, data: unknown) =>
	(fn as Fn)({ data, context: { user: u } }) as Promise<T>;
const inbox = (u: AuthUser, tripId?: string) =>
	call<InboxDto>(listInbox, u, tripId ? { tripId } : {});
const q = async <T>(query: ReturnType<typeof sql>) =>
	(await getDb().execute(query)).rows as T[];

async function newUser(first: string, last: string): Promise<AuthUser> {
	const id = randomUUID();
	await getDb()
		.insert(user)
		.values({
			id,
			email: `u-${id}@example.test`,
			emailVerified: true,
			name: `${first} ${last}`,
			firstName: first,
			lastName: last,
			isAnonymous: false,
		});
	const [row] = await getDb()
		.select()
		.from(user)
		.where(sql`${user.id} = ${id}`);
	return row as unknown as AuthUser;
}

const U = {} as Record<"dennis" | "maya" | "audrey", AuthUser>;
type Trip = FixtureClone & { maya: string; audrey: string };

async function freshTrip(): Promise<Trip> {
	const c = await cloneDemoTrip(getDb(), U.dennis.id);
	const maya = randomUUID();
	const audrey = randomUUID();
	await getDb()
		.insert(tripMembers)
		.values([
			{
				id: maya,
				tripId: c.tripId,
				userId: U.maya.id,
				status: "active",
				role: "suggester",
				color: 2,
			},
			{
				id: audrey,
				tripId: c.tripId,
				userId: U.audrey.id,
				status: "active",
				role: "editor",
				color: 3,
			},
		]);
	return { ...c, maya, audrey };
}

const dayOffset = (days: number) =>
	new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);

async function listItem(
	t: Trip,
	o: {
		text: string;
		due?: string;
		by?: AuthUser;
		private?: boolean;
		assignee?: string;
		status?: "open" | "done";
		target?: { nodeId?: string };
	},
): Promise<string> {
	const id = randomUUID();
	await getDb().execute(sql`
		insert into list_items (id, trip_id, node_id, list, text, position, is_private, created_by, due_date, status)
		values (${id}, ${t.tripId}, ${o.target?.nodeId ?? null}, 'todo', ${o.text}, ${`a${id.slice(0, 6)}`},
		        ${o.private ?? false}, ${(o.by ?? U.dennis).id}, ${o.due ?? null}, ${o.status ?? "open"})`);
	if (o.assignee)
		await getDb().execute(sql`
			insert into list_item_assignees (trip_id, list_item_id, member_id)
			values (${t.tripId}, ${id}, ${o.assignee})`);
	return id;
}

beforeAll(async () => {
	await ensureDatabase(testEnv.scratchUrl);
	await migrateDatabase(testEnv.scratchUrl);
	U.dennis = await newUser("Dennis", "Pham");
	U.maya = await newUser("Maya", "Chen");
	U.audrey = await newUser("Audrey", "Nguyen");
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

const ofKind = <K extends InboxItem["kind"]>(d: InboxDto, kind: K) =>
	d.items.filter((i): i is Extract<InboxItem, { kind: K }> => i.kind === kind);

describe("proposal_result", () => {
	it("tells the author, with the reviewer's note; never the reviewer themself", async () => {
		const t = await freshTrip();
		const rejected = randomUUID();
		const accepted = randomUUID();
		const own = randomUUID();
		await getDb().execute(sql`
			insert into proposals (id, trip_id, op, payload, base, entity_kind, summary, status,
			                       author_user_id, author_name, author_color, author_is_guest,
			                       reviewed_by, reviewed_at, review_note)
			values (${rejected}, ${t.tripId}, 'item.move', '{}', '{"tripVersion":0,"refs":[]}', 'item', 'moved Itoya to Day 5', 'rejected',
			        ${U.maya.id}, 'Maya Chen', 2, false, ${U.dennis.id}, now(), 'too far that day'),
			       (${accepted}, ${t.tripId}, 'node.create', '{}', '{"tripVersion":0,"refs":[]}', 'node', 'added Nishiki Market', 'accepted',
			        ${U.maya.id}, 'Maya Chen', 2, false, ${U.dennis.id}, now() - interval '1 minute', null),
			       (${own}, ${t.tripId}, 'item.move', '{}', '{"tripVersion":0,"refs":[]}', 'item', 'moved Loft', 'accepted',
			        ${U.dennis.id}, 'Dennis Pham', 0, false, ${U.dennis.id}, now(), null)`);
		const results = ofKind(await inbox(U.maya, t.tripId), "proposal_result");
		expect(results.map((r) => r.proposalId)).toEqual([rejected, accepted]);
		expect(results[0]).toMatchObject({
			decision: "rejected",
			note: "too far that day",
			title: "Dennis rejected your suggestion: “too far that day”",
			link: { sel: `p.${rejected}` },
			read: false,
		});
		expect(results[1]?.title).toBe(
			"Dennis accepted your suggestion: added Nishiki Market",
		);
		expect(ofKind(await inbox(U.dennis, t.tripId), "proposal_result")).toEqual(
			[],
		);
	});
});

describe("due", () => {
	it("dated todos for me or nobody, overdue or within 7 days; a moved date notifies again", async () => {
		const t = await freshTrip();
		const mine = await listItem(t, {
			text: "Book ANA",
			due: dayOffset(2),
			assignee: t.maya,
		});
		const everyone = await listItem(t, {
			text: "JR seats",
			due: dayOffset(-1),
		});
		await listItem(t, {
			text: "Audrey's",
			due: dayOffset(1),
			assignee: t.audrey,
		});
		await listItem(t, { text: "Later", due: dayOffset(30) });
		await listItem(t, { text: "Done", due: dayOffset(1), status: "done" });
		const due = ofKind(await inbox(U.maya, t.tripId), "due");
		expect(due.map((d) => d.listItemId).sort()).toEqual(
			[mine, everyone].sort(),
		);
		const overdue = due.find((d) => d.listItemId === everyone);
		expect(overdue).toMatchObject({
			state: "overdue",
			link: { tab: "lists", list: "todo" },
		});
		expect(overdue?.title).toContain("JR seats");
		// One read state; a moved window has a new key and is unread again.
		const key = due.find((d) => d.listItemId === mine)?.key ?? "";
		await call(markInboxRead, U.maya, { keys: [key] });
		expect(
			ofKind(await inbox(U.maya, t.tripId), "due").find(
				(d) => d.listItemId === mine,
			)?.read,
		).toBe(true);
		await getDb().execute(
			sql`update list_items set due_date = ${dayOffset(3)} where id = ${mine}`,
		);
		const moved = ofKind(await inbox(U.maya, t.tripId), "due").find(
			(d) => d.listItemId === mine,
		);
		expect(moved?.key).not.toBe(key);
		expect(moved?.read).toBe(false);
	});
});

describe("money notices", () => {
	it("splits exactly, leftover to the payer", () => {
		const parts = splitByWeights(
			1000,
			new Map([
				["a", 1],
				["b", 1],
				["c", 1],
			]),
			["b"],
		);
		expect([...parts.values()].reduce((s, v) => s + v, 0)).toBe(1000);
		expect(parts.get("b")).toBe(334);
		const neg = splitByWeights(
			-1000,
			new Map([
				["a", 1],
				["b", 1],
				["c", 1],
			]),
		);
		expect([...neg.values()].reduce((s, v) => s + v, 0)).toBe(-1000);
	});

	it("balance changed since my last settlement (someone else's edit, private expenses excluded)", async () => {
		const t = await freshTrip();
		const expense = async (o: {
			title: string;
			amount: number;
			payer: string;
			shares: string[];
			private?: boolean;
			by?: AuthUser;
		}) => {
			const id = randomUUID();
			const pay = randomUUID();
			await getDb().execute(sql`
				insert into expenses (id, trip_id, title, category, amount_minor, currency, home_currency,
				                      home_amount_minor, is_private, created_by)
				values (${id}, ${t.tripId}, ${o.title}, 'food_drink', ${o.amount}, 'USD', 'USD', ${o.amount},
				        ${o.private ?? false}, ${(o.by ?? U.dennis).id})`);
			await getDb().execute(sql`
				insert into expense_payments (id, trip_id, expense_id, paid_at, paid_tz, currency, amount_minor, home_amount_minor)
				values (${pay}, ${t.tripId}, ${id}, now(), 'Asia/Tokyo', 'USD', ${o.amount}, ${o.amount})`);
			await getDb().execute(sql`
				insert into expense_payment_payers (trip_id, payment_id, member_id, amount_minor)
				values (${t.tripId}, ${pay}, ${o.payer}, ${o.amount})`);
			for (const m of o.shares)
				await getDb().execute(sql`
					insert into expense_shares (trip_id, expense_id, member_id) values (${t.tripId}, ${id}, ${m})`);
			return id;
		};
		const dennis = t.members.owner;
		await getDb().execute(
			sql`update trips set settings = settings || '{"currency":"USD"}' where id = ${t.tripId}`,
		);
		await expense({
			title: "Ryokan",
			amount: 10_000,
			payer: dennis,
			shares: [dennis, t.maya],
		});
		expect((await memberNets(getDb(), t.tripId)).nets).toMatchObject({
			[dennis]: 5_000,
			[t.maya]: -5_000,
		});
		await getDb().execute(sql`
			insert into settlements (id, trip_id, from_member_id, to_member_id, amount_minor, currency, home_currency,
			                         home_amount_minor, settled_at, settled_tz, net_after, created_at)
			values (${randomUUID()}, ${t.tripId}, ${t.maya}, ${dennis}, 5000, 'USD', 'USD', 5000, now(), 'Asia/Tokyo',
			        ${JSON.stringify({ [dennis]: 0, [t.maya]: 0 })}::jsonb, now() - interval '1 hour')`);
		expect(ofKind(await inbox(U.maya, t.tripId), "balance_changed")).toEqual(
			[],
		);
		const ramen = await expense({
			title: "Ramen Ichiran",
			amount: 2_000,
			payer: dennis,
			shares: [dennis, t.maya],
		});
		await getDb().execute(sql`
			insert into activity_log (id, trip_id, actor_user_id, actor_name, verb, summary, version, meta)
			values (${randomUUID()}, ${t.tripId}, ${U.dennis.id}, 'Dennis Pham', 'expense.update', 'edited Ramen Ichiran',
			        1000, ${JSON.stringify({ expenseId: ramen })}::jsonb)`);
		// A private expense of Dennis's: never in balances, never the cause.
		const secret = await expense({
			title: "Gift",
			amount: 9_000,
			payer: dennis,
			shares: [dennis],
			private: true,
		});
		await getDb().execute(sql`
			insert into activity_log (id, trip_id, actor_user_id, actor_name, verb, summary, version, meta)
			values (${randomUUID()}, ${t.tripId}, ${U.dennis.id}, 'Dennis Pham', 'expense.add', 'added Gift',
			        1001, ${JSON.stringify({ expenseId: secret })}::jsonb)`);
		const [item] = ofKind(await inbox(U.maya, t.tripId), "balance_changed");
		expect(item).toMatchObject({
			deltaMinor: -1_000,
			currency: "USD",
			cause: "Dennis edited Ramen Ichiran",
			title:
				"Balance changed since your last settlement: −$10.00 (Dennis edited Ramen Ichiran)",
			link: { tab: "money" },
		});
		// Dennis made the change himself: no notice for him.
		expect(ofKind(await inbox(U.dennis, t.tripId), "balance_changed")).toEqual(
			[],
		);
		// QA MONEY-21: Maya reads it; then a later cost between Dennis and Audrey
		// only. It doesn't move Maya's balance: still the ramen, still read.
		await call(markInboxRead, U.maya, { keys: [item?.key as string] });
		const taxi = await expense({
			title: "Taxi",
			amount: 3_000,
			payer: dennis,
			shares: [dennis, t.audrey],
		});
		await getDb().execute(sql`
			insert into activity_log (id, trip_id, actor_user_id, actor_name, verb, summary, version, meta)
			values (${randomUUID()}, ${t.tripId}, ${U.dennis.id}, 'Dennis Pham', 'expense.add', 'added an expense: Taxi',
			        1002, ${JSON.stringify({ expenseId: taxi })}::jsonb)`);
		const [again] = ofKind(await inbox(U.maya, t.tripId), "balance_changed");
		expect(again).toMatchObject({
			key: item?.key,
			read: true,
			cause: "Dennis edited Ramen Ichiran",
		});
	});

	it("a changed trip default notifies members whose custom value stays", async () => {
		const t = await freshTrip();
		await getDb().execute(
			sql`update trips set settings = settings || '{"currency":"USD"}' where id = ${t.tripId}`,
		);
		await getDb().execute(sql`
			insert into budget_lines (id, trip_id, node_id, category, member_id, amount_minor, default_seen_minor)
			values (${randomUUID()}, ${t.tripId}, null, null, null, 350000, null),
			       (${randomUUID()}, ${t.tripId}, null, null, ${t.maya}, 300000, 320000),
			       (${randomUUID()}, ${t.tripId}, null, null, ${t.audrey}, 250000, 350000)`);
		const [notice] = ofKind(await inbox(U.maya, t.tripId), "budget_notice");
		expect(notice).toMatchObject({
			defaultMinor: 350000,
			mineMinor: 300000,
			title: "Trip default is now $3,500.00; yours stays $3,000.00",
		});
		// Audrey already saw this default.
		expect(ofKind(await inbox(U.audrey, t.tripId), "budget_notice")).toEqual(
			[],
		);
		// Mark all read; a new default makes a new key.
		await call(markInboxRead, U.maya, { all: true, tripId: t.tripId });
		expect((await inbox(U.maya, t.tripId)).unread).toBe(0);
		await getDb().execute(sql`
			update budget_lines set amount_minor = 400000 where trip_id = ${t.tripId} and member_id is null`);
		const again = ofKind(await inbox(U.maya, t.tripId), "budget_notice");
		expect(again[0]?.read).toBe(false);
	});
});

describe("private gift items (ADDENDUM §7.2)", () => {
	it("never reach another member's inbox, counts, activity or list reads", async () => {
		const t = await freshTrip();
		const itoya = t.ids.nodes.itoya ?? "";
		const token = `[@Maya](mention:${t.maya})`;
		const gift = await listItem(t, {
			text: `Gift for ${token}`,
			due: dayOffset(1),
			private: true,
			target: { nodeId: itoya },
		});
		// Even a stray mention row for it is filtered.
		await getDb().execute(sql`
			insert into mentions (id, trip_id, member_id, list_item_id, created_by, excerpt)
			values (${randomUUID()}, ${t.tripId}, ${t.maya}, ${gift}, ${U.dennis.id}, 'Gift for @Maya')`);
		const mayaFeed = await inbox(U.maya, t.tripId);
		expect(JSON.stringify(mayaFeed)).not.toContain(gift);
		expect(JSON.stringify(mayaFeed)).not.toContain("Gift");
		const dennisFeed = await inbox(U.dennis, t.tripId);
		expect(ofKind(dennisFeed, "due").map((d) => d.listItemId)).toContain(gift);

		type Counts = { byNode: Record<string, { todo: number }> };
		const mayaCounts = await call<Counts>(getTripCounts, U.maya, {
			tripId: t.tripId,
		});
		const dennisCounts = await call<Counts>(getTripCounts, U.dennis, {
			tripId: t.tripId,
		});
		expect(dennisCounts.byNode[itoya]?.todo ?? 0).toBe(
			(mayaCounts.byNode[itoya]?.todo ?? 0) + 1,
		);
		const mayaLists = await call<{ id: string }[]>(listTripListItems, U.maya, {
			tripId: t.tripId,
		});
		expect(mayaLists.map((l) => l.id)).not.toContain(gift);
		const activity = await call<{ summary: string }[]>(listActivity, U.maya, {
			tripId: t.tripId,
			limit: 100,
		});
		expect(JSON.stringify(activity)).not.toContain("Gift");
		// Marking a key that isn't in my feed records nothing.
		const dennisKey = ofKind(dennisFeed, "due").find(
			(d) => d.listItemId === gift,
		)?.key;
		expect(
			await call<{ updated: number }>(markInboxRead, U.maya, {
				keys: [dennisKey ?? "x"],
			}),
		).toEqual({ updated: 0 });
		expect(
			await q(
				sql`select 1 from inbox_reads where user_id = ${U.maya.id} and item_key = ${dennisKey ?? ""}`,
			),
		).toEqual([]);
	});
});

describe("digest backend", () => {
	it("countChangesSince: others' rows after my seen version, money only for members", async () => {
		const t = await freshTrip();
		const [trip] = await q<{ version: number }>(
			sql`select version from trips where id = ${t.tripId}`,
		);
		const version = Number(trip?.version);
		const stranger = await newUser("Gus", "Guest");
		// Never opened → 0.
		expect(await countChangesSince(getDb(), U.maya.id, [t.tripId])).toEqual({
			[t.tripId]: 0,
		});
		for (const u of [U.maya, stranger])
			await getDb().execute(sql`
				insert into trip_seen (trip_id, user_id, seen_version) values (${t.tripId}, ${u.id}, ${version})`);
		const row = (verb: string, by: AuthUser, v: number) => sql`
			insert into activity_log (id, trip_id, actor_user_id, actor_name, verb, summary, version)
			values (${randomUUID()}, ${t.tripId}, ${by.id}, ${by.name}, ${verb}, 'x', ${v})`;
		await getDb().execute(row("node.create", U.dennis, Number(version) + 1));
		await getDb().execute(row("expense.add", U.dennis, Number(version) + 2));
		await getDb().execute(row("item.move", U.maya, Number(version) + 3));
		await getDb().execute(row("item.move", U.dennis, Number(version)));
		expect(await countChangesSince(getDb(), U.maya.id, [t.tripId])).toEqual({
			[t.tripId]: 2,
		});
		expect(await countChangesSince(getDb(), stranger.id, [t.tripId])).toEqual({
			[t.tripId]: 2,
		});
		// …the stranger (no membership) doesn't see the expense row, but does see Maya's.
		await getDb().execute(sql`
			update trip_seen set seen_version = ${Number(version) + 1} where user_id = ${stranger.id}`);
		expect(await countChangesSince(getDb(), stranger.id, [t.tripId])).toEqual({
			[t.tripId]: 1,
		});
	});
});

describe("mentions (checkpoint)", () => {
	it("say where they sit, and never notify people of their own mentions", async () => {
		const t = await freshTrip();
		const sky = t.ids.items.sky as string;
		const itoya = t.ids.items.itoya as string;
		const tokyo = t.ids.nodes.tokyo as string;
		const byMaya = randomUUID();
		const self = randomUUID();
		const onNode = randomUUID();
		const li = await listItem(t, {
			text: "ask Audrey",
			target: { nodeId: tokyo },
		});
		await getDb().execute(sql`
			insert into mentions (id, trip_id, member_id, note_item_id, item_id, excerpt, created_by)
			values (${byMaya}, ${t.tripId}, ${t.audrey}, ${sky}, ${sky}, 'see @Audrey', ${U.maya.id}),
			       (${self}, ${t.tripId}, ${t.audrey}, ${itoya}, ${itoya}, 'note to @Audrey', ${U.audrey.id})`);
		await getDb().execute(sql`
			insert into mentions (id, trip_id, member_id, list_item_id, node_id, excerpt, created_by)
			values (${onNode}, ${t.tripId}, ${t.audrey}, ${li}, ${tokyo}, 'ask @Audrey', ${U.dennis.id})`);
		const mine = ofKind(await inbox(U.audrey, t.tripId), "mention");
		expect(mine.map((m) => m.mentionId).sort()).toEqual(
			[byMaya, onNode].sort(),
		);
		expect(mine.find((m) => m.mentionId === byMaya)).toMatchObject({
			title: "Maya Chen mentioned you",
			where: "Shibuya Sky",
		});
		expect(mine.find((m) => m.mentionId === onNode)?.where).toBe("Tokyo");
	});
});

describe("rating-comment mentions (ADDENDUM §10)", () => {
	it("a mention in a rating comment reaches the inbox, says where, and goes with the comment", async () => {
		const t = await freshTrip();
		const sensoji = t.ids.nodes.sensoji as string;
		const dennis = (
			await q<{ id: string }>(sql`
				select id::text as id from trip_members
				 where trip_id = ${t.tripId} and user_id = ${U.dennis.id}`)
		)[0]?.id as string;
		const comment = `Go early, [@Audrey Nguyen](mention:${t.audrey})`;
		await call(setNodePriority, U.dennis, {
			nodeId: sensoji,
			memberId: dennis,
			priority: "must",
			comment,
		});
		let rows = ofKind(await inbox(U.audrey, t.tripId), "mention");
		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatchObject({
			title: "Dennis Pham mentioned you",
			where: "Senso-ji",
			link: { sel: `n.${sensoji}` },
		});
		expect(rows[0]?.excerpt).toContain("@Audrey Nguyen");
		// The same comment again: no second row.
		await call(setNodePriority, U.dennis, {
			nodeId: sensoji,
			memberId: dennis,
			priority: "must",
			comment,
		});
		expect(ofKind(await inbox(U.audrey, t.tripId), "mention")).toHaveLength(1);
		// Clearing the rating clears the comment and its mention.
		await call(setNodePriority, U.dennis, {
			nodeId: sensoji,
			memberId: dennis,
			priority: null,
		});
		rows = ofKind(await inbox(U.audrey, t.tripId), "mention");
		expect(rows).toHaveLength(0);
	});
});
