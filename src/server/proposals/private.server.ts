/**
 * ADDENDUM §7.2: private list items never become proposals (a proposal is
 * visible to every reviewer). The author's own private rows apply directly,
 * for suggesters and in suggest mode alike; nobody else can see them to
 * propose anything. Used as `directIf` by WP-Lists' defs.
 */
import { sql } from "drizzle-orm";
import type { Tx } from "@/db/db.server";
import type { TripAccess } from "@/lib/auth/roles";
import { rowsOf, type TxOutbox } from "@/server/live/outbox.server";
import { closeDependants } from "./withdraw.server";

/** A member (never a link guest) creating a private item writes it directly. */
export function privateCreateDirect(
	input: { isPrivate?: boolean },
	access: TripAccess,
): boolean {
	return input.isPrivate === true && !access.isGuest && !!access.memberId;
}

/** The row is a private list item created by the caller's membership. */
export async function ownPrivateListItem(
	listItemId: string,
	access: TripAccess,
	tx: Tx,
): Promise<boolean> {
	if (access.isGuest || !access.memberId) return false;
	const res = await tx.execute(sql`
		select 1 from list_items li
		  join trip_members m on m.id = ${access.memberId} and m.user_id = li.created_by
		 where li.id = ${listItemId} and li.trip_id = ${access.tripId} and li.is_private`);
	return res.rows.length > 0;
}

/** The review note of a suggestion closed because its to-do went private. */
export const PRIVATE_ITEM_NOTE = "the to-do is private now";

/**
 * ADDENDUM §7.2 "Make private": suggestions made earlier about the list item
 * quote its text (summary, payload), so every open one is withdrawn (with its
 * dependants) and every `proposal.*` activity line about any of them is
 * dropped. Closed ones stay, but `proposalVisibleSql` shows them to the
 * item's author only. Returns whether anything changed.
 */
export async function retractListItemProposals(
	tx: Tx,
	out: Pick<TxOutbox, "emit">,
	tripId: string,
	listItemId: string,
): Promise<boolean> {
	const res = await tx.execute(sql`
		update proposals set status = 'withdrawn', review_note = ${PRIVATE_ITEM_NOTE}, updated_at = now()
		 where trip_id = ${tripId} and status = 'open'
		   and entity_kind = 'list' and entity_id = ${listItemId}
		returning id::text as id`);
	const ids = rowsOf(res).map((r) => String(r.id));
	const dependants = await closeDependants(tx, tripId, ids, "withdrawn");
	const dropped = await tx.execute(sql`
		delete from activity_log a
		 where a.trip_id = ${tripId} and a.verb like 'proposal.%'
		   and exists (
		     select 1 from proposals p
		      where p.trip_id = ${tripId} and p.id::text = a.meta->>'proposalId'
		        and p.entity_kind = 'list' and p.entity_id = ${listItemId})
		returning a.id`);
	const withdrawn = ids.length + dependants.length > 0;
	const activity = rowsOf(dropped).length > 0;
	if (withdrawn) out.emit({ keys: ["proposals"] });
	if (activity) out.emit({ keys: ["activity"] });
	return withdrawn || activity;
}
