/**
 * `ProposalDto` from a proposal row (EXTENSIONS §3.5): the row minus the
 * server-only `base`, plus `fields` (the def's) and `before` (those fields'
 * values when it was proposed). Link guests never get any (`listProposals`).
 */
import { type SQL, sql } from "drizzle-orm";
import { mustRedact, type TripAccess } from "@/lib/auth/roles";
import type { Json, ProposalDto } from "@/lib/schemas/proposals";
import type { SqlExec } from "@/server/graph.server";
import { type AnyDef, fieldsOf, type ProposalRow } from "./propose.server";

/**
 * The proposals (alias `p`) this caller may know about (ADDENDUM §9,
 * EXTENSIONS §3.8). A link guest never learns anything about a hidden
 * (`members`) attachment or a receipt: not its file name, caption or a
 * suggested change, so those proposals are left out entirely, as is one that
 * would turn an attachment into a receipt. Members don't see suggestions about
 * the receipt of someone else's private expense.
 */
export function proposalVisibleSql(
	access: Pick<TripAccess, "role" | "isGuest">,
	userId: string,
	p: SQL = sql.raw("p"),
): SQL {
	// ADDENDUM §7.2: a suggestion about a list item that is private now quotes
	// its text; only the item's author may still see it.
	const privateItem = sql`not (${p}.entity_kind = 'list' and exists (
		select 1 from list_items li
		 where li.id = ${p}.entity_id and li.trip_id = ${p}.trip_id
		   and li.is_private and li.created_by is distinct from ${userId}))`;
	if (mustRedact(access))
		return sql`not (${p}.entity_kind = 'att' and exists (
			select 1 from attachments a
			 where a.id = ${p}.entity_id and a.trip_id = ${p}.trip_id
			   and (a.visibility <> 'everyone' or a.expense_id is not null)))
		  and coalesce(${p}.payload->'target'->>'kind', '') <> 'expense'
		  and ${privateItem}`;
	return sql`not (${p}.entity_kind = 'att' and exists (
		select 1 from attachments a
		  join expenses e on e.id = a.expense_id
		 where a.id = ${p}.entity_id and a.trip_id = ${p}.trip_id
		   and e.is_private and e.created_by is distinct from ${userId}))
		  and ${privateItem}`;
}

/** Whether this caller may see one proposal (resolve/withdraw answer NOT_FOUND otherwise). */
export async function proposalVisibleTo(
	exec: SqlExec,
	proposalId: string,
	access: Pick<TripAccess, "role" | "isGuest">,
	userId: string,
): Promise<boolean> {
	const res = await exec.execute(sql`
		select 1 from proposals p
		 where p.id = ${proposalId} and ${proposalVisibleSql(access, userId)}`);
	return res.rows.length > 0;
}

/** The DTO for one row (`before` from the server-only base). */
export function proposalDto(
	r: ProposalRow & { dependants: string[] },
	def: AnyDef | null,
): ProposalDto {
	const fields = def ? fieldsOf(def, r.payload) : [];
	const ref = r.base.refs.find(
		(x) =>
			x.kind === r.entityKind &&
			(r.entityKind === "trip" || x.id === r.entityId),
	);
	const before: Record<string, Json> = {};
	if (ref)
		for (const f of fields)
			if (f in ref.fields) before[f] = ref.fields[f] as Json;
	return {
		id: r.id,
		tripId: r.tripId,
		op: r.op,
		payload: r.payload,
		entityKind: r.entityKind,
		entityId: r.entityId,
		createdIds: r.createdIds,
		requires: r.requires,
		summary: r.summary,
		message: r.message,
		status: r.status,
		author: {
			userId: r.authorUserId,
			memberId: r.authorMemberId,
			name: r.authorName,
			color: r.authorColor,
			isGuest: r.authorIsGuest,
		},
		fields,
		before,
		reviewedBy: r.reviewedBy,
		reviewedAt: r.reviewedAt,
		reviewNote: r.reviewNote,
		lastError: (r.lastError as ProposalDto["lastError"]) ?? null,
		dependants: r.dependants,
		createdAt: r.createdAt,
		updatedAt: r.updatedAt,
	};
}
