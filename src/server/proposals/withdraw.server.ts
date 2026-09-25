/**
 * Closing proposals without applying them (EXTENSIONS §3.5):
 *
 * - `withdrawAuthorProposals`: access loss withdraws the author's open
 *   proposals — `removeMember`/`leaveTrip` (via `retireMember`),
 *   `removeGuest`, `resetShareLink`, a link turned off, and a downgrade to
 *   viewer (`changeMemberRole`) call it in their transaction.
 * - `closeDependants`: reject, withdraw and access loss close EVERY open
 *   dependant (a proposal whose `requires` names a closed one, transitively),
 *   whatever its author, with a readable `review_note`.
 *
 * Dependency free on purpose (no request/session imports): the auth hooks use
 * it too.
 */
import { sql } from "drizzle-orm";
import type { SqlExecutor, TxOutbox } from "@/server/live/outbox.server";
import { rowsOf } from "@/server/live/outbox.server";

/** Why a dependant was closed, by the status it gets. */
export const DEPENDANT_NOTE = {
	withdrawn: "depends on a withdrawn suggestion",
	rejected: "depends on a rejected suggestion",
} as const;

/**
 * Closes every open proposal that (transitively) requires one of `ids`, with
 * `status` and the matching note. Returns the closed ids.
 */
export async function closeDependants(
	tx: SqlExecutor,
	tripId: string,
	ids: readonly string[],
	status: "withdrawn" | "rejected",
): Promise<string[]> {
	if (!ids.length) return [];
	const res = await tx.execute(sql`
		with recursive dep(id) as (
			select p.id from proposals p
			 where p.trip_id = ${tripId} and p.status = 'open'
			   and p.requires && ${sql.param([...ids])}::uuid[]
			union
			select p.id from proposals p
			  join dep d on d.id = any(p.requires)
			 where p.trip_id = ${tripId} and p.status = 'open'
		)
		update proposals set status = ${status}, review_note = ${DEPENDANT_NOTE[status]}, updated_at = now()
		 where id in (select id from dep) and status = 'open'
		returning id::text as id`);
	return rowsOf(res).map((r) => String(r.id));
}

export async function withdrawAuthorProposals(
	tx: SqlExecutor,
	out: Pick<TxOutbox, "emit">,
	tripId: string,
	userIds: readonly string[],
	reason = "author lost access",
): Promise<number> {
	if (!userIds.length) return 0;
	const res = await tx.execute(sql`
		update proposals set status = 'withdrawn', review_note = ${reason.slice(0, 200)}, updated_at = now()
		 where trip_id = ${tripId} and status = 'open'
		   and author_user_id = any(${sql.param([...userIds])}::text[])
		returning id::text as id`);
	const ids = rowsOf(res).map((r) => String(r.id));
	const dependants = await closeDependants(tx, tripId, ids, "withdrawn");
	const n = ids.length + dependants.length;
	if (n) out.emit({ keys: ["proposals"] });
	return n;
}
