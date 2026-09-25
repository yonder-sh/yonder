/**
 * WP-Lists: mentions across trips (SPEC §13.5). Signatures are final.
 *
 * The one-inbox bell (WP-Shell `InboxBell`, ADDENDUM §10) is the main way to
 * see mentions; these back an "All mentions" view. Same privacy rules as the
 * inbox feed: only the caller's own active memberships, never private notes,
 * never someone else's private list item, never deleted trips.
 */
import { createServerFn } from "@tanstack/react-start";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db/db.server";
import { withAccount } from "@/server/authz/middleware";

export type MentionDto = {
	id: string;
	tripId: string;
	tripSlug: string;
	tripName: string;
	byName: string;
	excerpt: string | null;
	/** Deep-link target in the trip (`sel` encoding) and the tab to open. */
	sel: string | null;
	tab: "notes" | "lists" | "plan";
	createdAt: string;
	readAt: string | null;
};

type Row = {
	id: string;
	tripId: string;
	tripSlug: string;
	tripName: string;
	byName: string | null;
	excerpt: string | null;
	nodeId: string | null;
	itemId: string | null;
	dayId: string | null;
	legKind: string | null;
	legFrom: string | null;
	legTo: string | null;
	legDay: string | null;
	listItemId: string | null;
	docName: string | null;
	createdAt: string | Date;
	readAt: string | Date | null;
};

/** The `sel` a mention's target deep-links to (legs by their pair or stay). */
export function selOfMention(r: {
	nodeId: string | null;
	itemId: string | null;
	dayId: string | null;
	legKind: string | null;
	legFrom: string | null;
	legTo: string | null;
	legDay: string | null;
}): string | null {
	if (r.itemId) return `i.${r.itemId}`;
	if (r.nodeId) return `n.${r.nodeId}`;
	if (r.dayId) return `d.${r.dayId}`;
	if (r.legKind === "pair" && r.legFrom && r.legTo)
		return `l.${r.legFrom}.${r.legTo}`;
	if (r.legKind === "stay_start" && r.legDay) return `s.${r.legDay}.start`;
	if (r.legKind === "stay_end" && r.legDay) return `s.${r.legDay}.end`;
	return null;
}

const iso = (v: string | Date) => new Date(v).toISOString();

export const listMyMentions = createServerFn({ method: "GET" })
	.middleware([withAccount])
	.handler(async ({ context }): Promise<MentionDto[]> => {
		const userId = context.user.id;
		const res = await db.execute(sql`
			select mn.id::text as id, mn.trip_id::text as "tripId", t.slug as "tripSlug", t.name as "tripName",
			       u.name as "byName", mn.excerpt,
			       mn.node_id::text as "nodeId", mn.item_id::text as "itemId", mn.day_id::text as "dayId",
			       l.kind::text as "legKind", l.from_item_id::text as "legFrom", l.to_item_id::text as "legTo",
			       l.stay_day_id::text as "legDay",
			       mn.list_item_id::text as "listItemId", mn.doc_name as "docName",
			       mn.created_at as "createdAt", mn.read_at as "readAt"
			  from mentions mn
			  join trip_members m on m.id = mn.member_id and m.user_id = ${userId} and m.status = 'active'
			  join trips t on t.id = mn.trip_id and t.deleted_at is null
			  left join "user" u on u.id = mn.created_by
			  left join legs l on l.id = mn.leg_id and l.trip_id = mn.trip_id
			  left join list_items li on li.id = mn.list_item_id
			 where (mn.doc_name is null or mn.doc_name not like '%/u/%')
			   and (li.id is null or (li.deleted_at is null and (not li.is_private or li.created_by = ${userId})))
			 order by (mn.read_at is null) desc, mn.created_at desc
			 limit 50`);
		return (res.rows as Row[]).map((r) => ({
			id: r.id,
			tripId: r.tripId,
			tripSlug: r.tripSlug,
			tripName: r.tripName,
			byName: r.byName ?? "Someone",
			excerpt: r.excerpt,
			sel: selOfMention(r),
			tab: r.docName ? "notes" : r.listItemId ? "lists" : "plan",
			createdAt: iso(r.createdAt),
			readAt: r.readAt ? iso(r.readAt) : null,
		}));
	});

export const markMentionsRead = createServerFn({ method: "POST" })
	.middleware([withAccount])
	.validator(
		z.union([
			z.object({ ids: z.array(z.uuid()).min(1).max(200) }).strict(),
			z.object({ all: z.literal(true) }).strict(),
		]),
	)
	.handler(async ({ data, context }): Promise<{ updated: number }> => {
		// Only the caller's own member rows (§11.3): the join on the membership
		// is the check, so ids of other people's mentions change nothing.
		const only =
			"ids" in data
				? sql`and mn.id = any(${sql.param(data.ids)}::uuid[])`
				: sql``;
		const res = await db.execute(sql`
			update mentions mn set read_at = now()
			  from trip_members m
			 where m.id = mn.member_id and m.user_id = ${context.user.id}
			   and mn.read_at is null ${only}
			returning mn.id`);
		return { updated: res.rows.length };
	});
