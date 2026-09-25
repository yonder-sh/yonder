/**
 * The one-inbox feed (ADDENDUM §10), server side: derives the caller's items
 * and their read state. `listInbox` / `markInboxRead` (src/functions/
 * inbox.functions.ts) wrap it; see there for the rules.
 *
 * Kinds (all derived, never stored; members of a trip only — link guests
 * have no inbox):
 * - `mention`: my mention rows, minus private notes and other people's
 *   private list items;
 * - `review`: one per trip with open suggestions by others (owners/editors);
 * - `proposal_result`: my suggestions accepted or rejected by someone else
 *   in the last 30 days (with the reviewer's note);
 * - `due`: open todos/shopping rows assigned to me or to nobody (never
 *   someone else's private row) whose effective due (`effectiveDue`, relative
 *   rules resolved against the trip's schedule) is overdue, open now, today
 *   or within 7 days; the key carries the due instant, so a moved window
 *   notifies again;
 * - `balance_changed`: my net moved since my latest settlement's `net_after`
 *   and someone else edited an expense since (`expense.*` activity, the
 *   latest one names the cause); the key carries that activity's version;
 * - `budget_notice`: my own budget line was set against a trip default that
 *   has changed since (`default_seen_minor`).
 */
import { sql } from "drizzle-orm";
import { db } from "@/db/db.server";
import { balanceEdits } from "@/features/money/server/money.server";
import { dueState, effectiveDue } from "@/lib/engine/due";
import { indexGraph } from "@/lib/engine/graph-index";
import { formatMoney } from "@/lib/engine/money";
import { computeSchedule } from "@/lib/engine/schedule";
import type { DueKind, ExpenseCategory, ListKind } from "@/lib/schemas/enums";
import {
	INBOX_MAX,
	type InboxDto,
	type InboxItem,
	inboxKey,
} from "@/lib/schemas/inbox";
import type { DueRule } from "@/lib/schemas/lists";
import type { BundleTarget } from "@/lib/schemas/targets";
import { loadTripAccess } from "@/server/authz/trip-access.server";
import { loadTripGraph } from "@/server/graph.server";
import { mentionExcerpt } from "@/server/mentions.server";
import { memberNets } from "@/server/money-nets.server";

type MentionRow = {
	id: string;
	tripId: string;
	tripSlug: string;
	tripName: string;
	memberId: string;
	byName: string | null;
	byMemberId: string | null;
	excerpt: string | null;
	nodeId: string | null;
	itemId: string | null;
	dayId: string | null;
	listItemId: string | null;
	noteItemId: string | null;
	docName: string | null;
	/** The place, item or day the mention sits on ("Shibuya Sky", "Day 3"). */
	where: string | null;
	at: string | Date;
	read: boolean;
};

type ReviewRow = {
	tripId: string;
	tripSlug: string;
	tripName: string;
	count: number;
	newestId: string;
	at: string | Date;
	read: boolean;
};

const iso = (v: string | Date) => new Date(v).toISOString();

/** The caller's feed, newest first. Exported for `markInboxRead` and tests. */
export async function loadInbox(
	userId: string,
	opts: { tripId?: string; limit?: number } = {},
): Promise<InboxDto> {
	const limit = Math.min(opts.limit ?? INBOX_MAX, INBOX_MAX);
	const tripFilter = opts.tripId ? sql`and m.trip_id = ${opts.tripId}` : sql``;

	const mentions = await db.execute(sql`
		select mn.id::text as id, mn.trip_id::text as "tripId", t.slug as "tripSlug", t.name as "tripName",
		       mn.member_id::text as "memberId", u.name as "byName",
		       (select bm.id::text from trip_members bm where bm.trip_id = mn.trip_id and bm.user_id = mn.created_by limit 1) as "byMemberId",
		       mn.excerpt, mn.node_id::text as "nodeId", mn.item_id::text as "itemId", mn.day_id::text as "dayId",
		       mn.list_item_id::text as "listItemId", mn.note_item_id::text as "noteItemId", mn.doc_name as "docName",
		       coalesce(
		         (select coalesce(i.title, inode.name) from items i left join nodes inode on inode.id = i.node_id
		           where i.id = coalesce(mn.item_id, mn.note_item_id) and i.trip_id = mn.trip_id),
		         (select n.name from nodes n where n.id = mn.node_id and n.trip_id = mn.trip_id),
		         (select 'Day ' || (select count(*) from trip_days d2 where d2.trip_id = d.trip_id and d2.date <= d.date)::text
		            from trip_days d where d.id = mn.day_id and d.trip_id = mn.trip_id)
		       ) as "where",
		       mn.created_at as at,
		       (mn.read_at is not null or exists (
		          select 1 from inbox_reads r where r.user_id = ${userId} and r.item_key = 'mention:' || mn.id::text)) as read
		  from mentions mn
		  join trip_members m on m.id = mn.member_id and m.user_id = ${userId} and m.status = 'active'
		  join trips t on t.id = mn.trip_id and t.deleted_at is null
		  left join "user" u on u.id = mn.created_by
		  left join list_items li on li.id = mn.list_item_id
		 where (mn.doc_name is null or mn.doc_name not like '%/u/%')
		   -- Never notify people of their own mentions (a self-mention keeps its row).
		   and mn.created_by is distinct from ${userId}
		   and (li.id is null or (li.deleted_at is null and (not li.is_private or li.created_by = ${userId})))
		   ${tripFilter}
		 order by mn.created_at desc
		 limit ${limit}`);

	// Reviewers (owner/editor members): one item per trip with open suggestions by others.
	const reviews = await db.execute(sql`
		with open_by_trip as (
			select p.trip_id, count(*)::int as count,
			       (array_agg(p.id::text order by p.created_at desc))[1] as newest_id,
			       max(p.created_at) as at
			  from proposals p
			  join trip_members m on m.trip_id = p.trip_id and m.user_id = ${userId}
			   and m.status = 'active' and m.role in ('owner', 'editor')
			 where p.status = 'open' and p.author_user_id is distinct from ${userId}
			   ${tripFilter}
			 group by p.trip_id
		)
		select o.trip_id::text as "tripId", t.slug as "tripSlug", t.name as "tripName",
		       o.count, o.newest_id as "newestId", o.at,
		       exists (select 1 from inbox_reads r where r.user_id = ${userId}
		         and r.item_key = 'review:' || o.trip_id::text || ':' || o.newest_id) as read
		  from open_by_trip o
		  join trips t on t.id = o.trip_id and t.deleted_at is null`);

	const items: InboxItem[] = [];
	for (const r of mentions.rows as MentionRow[]) {
		const sel = r.itemId
			? `i.${r.itemId}`
			: r.nodeId
				? `n.${r.nodeId}`
				: r.dayId
					? `d.${r.dayId}`
					: undefined;
		const tab = r.docName ? "notes" : r.listItemId ? "lists" : "plan";
		items.push({
			kind: "mention",
			key: inboxKey.mention(r.id),
			mentionId: r.id,
			tripId: r.tripId,
			tripName: r.tripName,
			at: iso(r.at),
			read: Boolean(r.read),
			actor: r.byName ? { name: r.byName, memberId: r.byMemberId } : null,
			title: `${r.byName ?? "Someone"} mentioned you`,
			excerpt: r.excerpt,
			where: r.where,
			link: { tripSlug: r.tripSlug, ...(sel ? { sel } : {}), tab },
		});
	}
	for (const r of reviews.rows as ReviewRow[]) {
		const n = Number(r.count);
		items.push({
			kind: "review",
			key: inboxKey.review(r.tripId, r.newestId),
			count: n,
			tripId: r.tripId,
			tripName: r.tripName,
			at: iso(r.at),
			read: Boolean(r.read),
			actor: null,
			title: `${n} suggestion${n === 1 ? "" : "s"} to review`,
			link: { tripSlug: r.tripSlug, review: true },
		});
	}
	items.push(
		...(await proposalResults(userId, opts.tripId, limit)),
		...(await dueItems(userId, opts.tripId)),
		...(await balanceItems(userId, opts.tripId)),
		...(await budgetItems(userId, opts.tripId)),
	);

	items.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
	const page = items.slice(0, limit);
	return { items: page, unread: page.filter((i) => !i.read).length };
}

// ---------------------------------------------------------------------------
// F-ext1 kinds
// ---------------------------------------------------------------------------

const firstWord = (name: string | null | undefined) =>
	(name ?? "").trim().split(/\s+/)[0] || "Someone";

/** `and <col> = tripId` when the feed is for one trip. */
const oneTrip = (col: ReturnType<typeof sql>, tripId?: string) =>
	tripId ? sql`and ${col} = ${tripId}` : sql``;

/** My suggestions accepted or rejected by someone else (last 30 days). */
async function proposalResults(
	userId: string,
	tripId: string | undefined,
	limit: number,
): Promise<InboxItem[]> {
	const res = await db.execute(sql`
		select p.id::text as id, p.trip_id::text as "tripId", t.slug as "tripSlug", t.name as "tripName",
		       p.status::text as status, p.summary, p.review_note as note, p.reviewed_at as at,
		       u.name as "reviewerName",
		       (select rm.id::text from trip_members rm where rm.trip_id = p.trip_id and rm.user_id = p.reviewed_by limit 1) as "reviewerMemberId",
		       exists (select 1 from inbox_reads r where r.user_id = ${userId}
		                and r.item_key = 'result:' || p.id::text) as read
		  from proposals p
		  join trip_members m on m.trip_id = p.trip_id and m.user_id = ${userId} and m.status = 'active'
		  join trips t on t.id = p.trip_id and t.deleted_at is null
		  left join "user" u on u.id = p.reviewed_by
		 where p.author_user_id = ${userId} and p.status in ('accepted', 'rejected')
		   and p.reviewed_by is distinct from ${userId}
		   and p.reviewed_at > now() - interval '30 days'
		   ${oneTrip(sql`p.trip_id`, tripId)}
		 order by p.reviewed_at desc
		 limit ${limit}`);
	return (
		res.rows as {
			id: string;
			tripId: string;
			tripSlug: string;
			tripName: string;
			status: "accepted" | "rejected";
			summary: string;
			note: string | null;
			at: string | Date;
			reviewerName: string | null;
			reviewerMemberId: string | null;
			read: boolean;
		}[]
	).map((r) => {
		const who = firstWord(r.reviewerName);
		const title =
			r.status === "accepted"
				? `${who} accepted your suggestion: ${r.summary}`
				: r.note
					? `${who} rejected your suggestion: “${r.note}”`
					: `${who} rejected your suggestion: ${r.summary}`;
		return {
			kind: "proposal_result",
			key: inboxKey.proposalResult(r.id),
			proposalId: r.id,
			decision: r.status,
			note: r.note,
			tripId: r.tripId,
			tripName: r.tripName,
			at: iso(r.at),
			read: Boolean(r.read),
			actor: r.reviewerName
				? { name: r.reviewerName, memberId: r.reviewerMemberId }
				: null,
			title: title.slice(0, 300),
			link: { tripSlug: r.tripSlug, sel: `p.${r.id}` },
		} satisfies InboxItem;
	});
}

/** The states that ask for attention (EXTENSIONS §7: soon = within 7 days). */
const DUE_STATES = new Set(["overdue", "open_now", "today", "soon"]);

type DueRow = {
	id: string;
	tripId: string;
	tripSlug: string;
	tripName: string;
	nodeId: string | null;
	itemId: string | null;
	legId: string | null;
	dayId: string | null;
	list: ListKind;
	text: string;
	status: "open";
	dueDayId: string | null;
	dueDate: string | null;
	dueTime: string | null;
	dueTz: string | null;
	dueKind: DueKind;
	dueRule: DueRule | null;
	isPrivate: boolean;
	position: string;
	createdAt: string | Date;
	updatedAt: string | Date;
	assigneeIds: string[];
};

function targetOf(r: DueRow): BundleTarget {
	if (r.nodeId) return { kind: "node", nodeId: r.nodeId };
	if (r.itemId) return { kind: "item", itemId: r.itemId };
	if (r.legId) return { kind: "leg", legId: r.legId };
	if (r.dayId) return { kind: "day", dayId: r.dayId };
	return { kind: "trip" };
}

/** Open, dated rows assigned to me or to nobody; never someone else's private row. */
async function dueItems(
	userId: string,
	tripId: string | undefined,
	now = Date.now(),
): Promise<InboxItem[]> {
	const res = await db.execute(sql`
		select li.id::text as id, li.trip_id::text as "tripId", t.slug as "tripSlug", t.name as "tripName",
		       li.node_id::text as "nodeId", li.item_id::text as "itemId", li.leg_id::text as "legId",
		       li.day_id::text as "dayId", li.list::text as list, li.text, li.status::text as status,
		       li.due_day_id::text as "dueDayId", li.due_date::text as "dueDate", li.due_time as "dueTime",
		       li.due_tz as "dueTz", li.due_kind::text as "dueKind", li.due_rule as "dueRule",
		       li.is_private as "isPrivate", li.position, li.created_at as "createdAt", li.updated_at as "updatedAt",
		       coalesce((select array_agg(a.member_id::text) from list_item_assignees a
		                  where a.list_item_id = li.id), '{}') as "assigneeIds"
		  from list_items li
		  join trip_members m on m.trip_id = li.trip_id and m.user_id = ${userId} and m.status = 'active'
		  join trips t on t.id = li.trip_id and t.deleted_at is null
		 where li.deleted_at is null and li.status = 'open'
		   and (not li.is_private or li.created_by = ${userId})
		   and (li.due_rule is not null or li.due_date is not null or li.due_day_id is not null)
		   and (not exists (select 1 from list_item_assignees a where a.list_item_id = li.id)
		        or exists (select 1 from list_item_assignees a where a.list_item_id = li.id and a.member_id = m.id))
		   ${oneTrip(sql`li.trip_id`, tripId)}
		 order by li.trip_id, li.id
		 limit 500`);
	const rows = res.rows as DueRow[];
	if (!rows.length) return [];
	const byTrip = new Map<string, DueRow[]>();
	for (const r of rows)
		byTrip.set(r.tripId, [...(byTrip.get(r.tripId) ?? []), r]);
	const reads = await readKeys(
		userId,
		rows.map((r) => `due:${r.id}:`),
	);
	const items: InboxItem[] = [];
	for (const [tid, list] of byTrip) {
		const access = await loadTripAccess(tid, userId);
		if (!access || access.isGuest) continue;
		const graph = await loadTripGraph(tid, {
			...access,
			user: { id: userId, name: "" },
		});
		if (!graph) continue;
		const ix = indexGraph(graph);
		const schedule = computeSchedule(ix);
		const ctx = {
			daysById: new Map(graph.days.map((d) => [d.id, d])),
			dayTz: (dayId: string) =>
				schedule.days[dayId]?.tz ?? graph.trip.defaultTz,
			tripTz: graph.trip.defaultTz,
			itemDayId: (itemId: string) => ix.item(itemId)?.dayId ?? null,
		};
		for (const r of list) {
			// Everything `effectiveDue` reads (WP-Lists' `DueFields`), shaped like a
			// `ListItemDto`; unannotated so it fits the DTO before and after WP-Lists'
			// additions (`doneAt`, `mine`).
			const dto = {
				id: r.id,
				target: targetOf(r),
				list: r.list,
				text: r.text,
				note: null,
				url: null,
				status: r.status,
				dueDayId: r.dueDayId,
				dueDate: r.dueDate,
				dueTime: r.dueTime,
				dueTz: r.dueTz,
				dueKind: r.dueKind,
				dueRule: r.dueRule ?? null,
				quantity: null,
				priceAmount: null,
				priceCurrency: null,
				position: r.position,
				isPrivate: r.isPrivate,
				assigneeIds: r.assigneeIds ?? [],
				extraTargetNodeIds: [],
				createdAt: iso(r.createdAt),
				updatedAt: iso(r.updatedAt),
				doneAt: null,
				mine: false,
			};
			const due = effectiveDue(dto, ctx);
			if (!due) continue;
			const state = dueState(due, now);
			if (!DUE_STATES.has(state)) continue;
			const key = inboxKey.due(r.id, due.at);
			const text = mentionExcerpt([r.text]) || "A to-do";
			const sel = r.itemId
				? `i.${r.itemId}`
				: r.nodeId
					? `n.${r.nodeId}`
					: r.dayId
						? `d.${r.dayId}`
						: undefined;
			items.push({
				kind: "due",
				key,
				listItemId: r.id,
				dueKind: due.kind,
				dueAt: new Date(due.at).toISOString(),
				state: state as "overdue" | "open_now" | "today" | "soon",
				tripId: tid,
				tripName: r.tripName,
				at: new Date(Math.min(due.at, now)).toISOString(),
				read: reads.has(key),
				actor: null,
				title: `${text} · ${due.label}`.slice(0, 300),
				link: {
					tripSlug: r.tripSlug,
					tab: "lists",
					list: r.list === "shopping" ? "shopping" : "todo",
					...(sel ? { sel } : {}),
				},
			});
		}
	}
	return items;
}

/** The subset of `inbox_reads` keys that start with one of `prefixes`. */
async function readKeys(
	userId: string,
	prefixes: readonly string[],
): Promise<Set<string>> {
	if (!prefixes.length) return new Set();
	const res = await db.execute(sql`
		select item_key as key from inbox_reads
		 where user_id = ${userId}
		   and item_key like any(${sql.param(prefixes.map((p) => `${p.replace(/[%_\\]/g, "\\$&")}%`))}::text[])`);
	return new Set((res.rows as { key: string }[]).map((r) => r.key));
}

/** "Balance changed since your last settlement: +$6.20 (Maya edited Ramen Ichiran)". */
async function balanceItems(
	userId: string,
	tripId: string | undefined,
): Promise<InboxItem[]> {
	// My latest settlement per trip (as payer or payee) with its snapshot.
	const res = await db.execute(sql`
		select distinct on (s.trip_id)
		       s.trip_id::text as "tripId", t.slug as "tripSlug", t.name as "tripName",
		       m.id::text as "memberId", s.net_after as "netAfter", s.created_at as "settledAt"
		  from settlements s
		  join trip_members m on m.trip_id = s.trip_id and m.user_id = ${userId} and m.status = 'active'
		   and (s.from_member_id = m.id or s.to_member_id = m.id)
		  join trips t on t.id = s.trip_id and t.deleted_at is null
		 where s.deleted_at is null and s.net_after is not null
		   ${oneTrip(sql`s.trip_id`, tripId)}
		 order by s.trip_id, s.created_at desc, s.id desc`);
	const items: InboxItem[] = [];
	for (const r of res.rows as {
		tripId: string;
		tripSlug: string;
		tripName: string;
		memberId: string;
		netAfter: Record<string, number>;
		settledAt: string | Date;
	}[]) {
		const before = r.netAfter?.[r.memberId];
		if (typeof before !== "number") continue;
		// QA MONEY-21: the latest edit by someone else that moved MY balance
		// (I paid it, am in its split or one of its items, or it refunds one I
		// am in; never a private cost): WP-Money's rule, shared with the Money
		// tab's notice so both name the same cause.
		const [last] = await balanceEdits(db, {
			tripId: r.tripId,
			memberId: r.memberId,
			userId,
			since: r.settledAt,
			limit: 1,
		});
		if (!last) continue;
		const { currency, nets } = await memberNets(db, r.tripId);
		const delta = (nets[r.memberId] ?? 0) - before;
		if (delta === 0) continue;
		// Unread again only when my delta moves (not on every edit by anyone).
		const key = inboxKey.balance(
			r.tripId,
			r.memberId,
			`${new Date(r.settledAt).getTime()}:${delta}`,
		);
		const read = (await readKeys(userId, [key])).has(key);
		const cause = last.cause;
		const amount = `${delta > 0 ? "+" : "−"}${formatMoney(Math.abs(delta), currency)}`;
		items.push({
			kind: "balance_changed",
			key,
			deltaMinor: delta,
			currency,
			cause,
			tripId: r.tripId,
			tripName: r.tripName,
			at: iso(last.at),
			read,
			actor: { name: last.actorName, memberId: last.actorMemberId },
			title:
				`Balance changed since your last settlement: ${amount} (${cause})`.slice(
					0,
					300,
				),
			link: { tripSlug: r.tripSlug, tab: "money" },
		});
	}
	return items;
}

/** "Trip default is now $3,500; yours stays $3,000". */
async function budgetItems(
	userId: string,
	tripId: string | undefined,
): Promise<InboxItem[]> {
	const res = await db.execute(sql`
		select b.id::text as id, b.trip_id::text as "tripId", t.slug as "tripSlug", t.name as "tripName",
		       b.node_id::text as "nodeId", n.name as "nodeName", b.category::text as category,
		       b.amount_minor as "mineMinor", d.amount_minor as "defaultMinor", d.updated_at as at,
		       coalesce(t.settings->>'currency', 'USD') as currency,
		       exists (select 1 from inbox_reads r where r.user_id = ${userId}
		                and r.item_key = 'budget:' || b.id::text || ':' || d.amount_minor::text) as read
		  from budget_lines b
		  join trip_members m on m.id = b.member_id and m.user_id = ${userId} and m.status = 'active'
		  join trips t on t.id = b.trip_id and t.deleted_at is null
		  join budget_lines d on d.trip_id = b.trip_id and d.member_id is null
		   and d.node_id is not distinct from b.node_id and d.category is not distinct from b.category
		  left join nodes n on n.id = b.node_id
		 where b.default_seen_minor is not null and d.amount_minor <> b.default_seen_minor
		   ${oneTrip(sql`b.trip_id`, tripId)}`);
	return (
		res.rows as {
			id: string;
			tripId: string;
			tripSlug: string;
			tripName: string;
			nodeId: string | null;
			nodeName: string | null;
			category: ExpenseCategory | null;
			mineMinor: number | string;
			defaultMinor: number | string;
			at: string | Date;
			currency: string;
			read: boolean;
		}[]
	).map((r) => {
		const def = Number(r.defaultMinor);
		const mine = Number(r.mineMinor);
		const scope = r.nodeName ? `${r.nodeName}: ` : "";
		return {
			kind: "budget_notice",
			key: inboxKey.budget(r.id, def),
			budgetLineId: r.id,
			nodeId: r.nodeId,
			category: r.category,
			defaultMinor: def,
			mineMinor: mine,
			currency: r.currency,
			tripId: r.tripId,
			tripName: r.tripName,
			at: iso(r.at),
			read: Boolean(r.read),
			actor: null,
			title:
				`${scope}Trip default is now ${formatMoney(def, r.currency)}; yours stays ${formatMoney(mine, r.currency)}`.slice(
					0,
					300,
				),
			link: {
				tripSlug: r.tripSlug,
				tab: "money",
				...(r.nodeId ? { sel: `n.${r.nodeId}` } : {}),
			},
		} satisfies InboxItem;
	});
}
