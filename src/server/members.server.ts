/**
 * Retiring a member (EXTENSIONS §8.1 `retireMember`; QA TAG-04, A-26). A
 * member is never deleted once they may be referenced: tags (item, leg and
 * list assignees), priorities, mentions, splits and payments all point at
 * `trip_members.id`, and the money FKs are NO ACTION. Instead the row becomes
 * `status = 'removed'`: no user, no email, the last known name kept in
 * `display_name`. The graph still returns it (flagged), so `MemberName`
 * renders "Kai Viewer (former member)"; pickers, `assignableMembers`, the
 * `who` filter and `tripMemberIds` skip it.
 *
 * Callers: `removeMember` and `leaveTrip` (WP-Home), `claimInvites`' duplicate
 * invites. The caller runs it inside its `withTripTx` (or its own transaction).
 */
import { sql } from "drizzle-orm";
import { generateKeyBetween } from "fractional-indexing";
import type { Tx } from "@/db/db.server";
import { can, type TripRole } from "@/lib/auth/roles";
import { payerOrder, splitEqual } from "@/lib/engine/money";
import { newId } from "@/lib/ids";
import {
	normalizePersonName,
	PLACEHOLDER_NAME_MAX,
} from "@/lib/schemas/people";
import { AppError } from "./authz/errors";
import { leastUsedColor } from "./authz/resolve";
import type { TxOutbox } from "./live/outbox.server";
import { withdrawAuthorProposals } from "./proposals/withdraw.server";

export type RetiredMember = { memberId: string; userId: string | null };

export async function retireMember(
	tx: Tx,
	out: TxOutbox | null,
	tripId: string,
	memberId: string,
): Promise<RetiredMember> {
	const res = await tx.execute(sql`
		select m.user_id as "userId", m.role::text as role, m.status::text as status,
		       coalesce(nullif(u.name, ''), m.display_name, split_part(m.email, '@', 1), 'Someone') as name
		  from trip_members m left join "user" u on u.id = m.user_id
		 where m.id = ${memberId} and m.trip_id = ${tripId}
		 for update of m`);
	const row = res.rows[0] as
		| { userId: string | null; role: string; status: string; name: string }
		| undefined;
	// AppError (not `fail`): this module also runs inside Better Auth hooks, where
	// there is no server-function response to set a status on.
	if (!row || row.status === "removed")
		throw new AppError("NOT_FOUND", "member");
	if (row.role === "owner")
		throw new AppError("CONFLICT", "the owner can't leave or be removed");
	await tx.execute(sql`
		update trip_members
		   set status = 'removed', user_id = null, email = null,
		       display_name = ${row.name.slice(0, 120)}, updated_at = now()
		 where id = ${memberId} and trip_id = ${tripId}`);
	if (out) {
		if (row.userId) {
			out.access([row.userId]);
			await withdrawAuthorProposals(tx, out, tripId, [row.userId]);
			// Web Push: "You were removed from …" (never to whoever left on their own).
			out.notify({ kind: "membership", change: "removed", userId: row.userId });
		}
		out.emit({ entity: "member", keys: ["graph", "sharing", "money"] });
	}
	return { memberId, userId: row.userId };
}

/**
 * `updateMemberRole`'s core (EXTENSIONS §3.1 "access re-evaluation", §3.5
 * "access loss"): WP-Home calls it inside its `withTripTx` after the
 * `manageMembers` check. Any role change sends `out.access([userId])`, so
 * collab re-authenticates the member's open sockets at once (an editor →
 * suggester downgrade makes their note sockets read-only, QA SUG-17); a
 * downgrade to viewer or rater also withdraws their open proposals (and
 * dependants).
 * The owner's role never changes here (no ownership transfer in v1), and
 * nobody becomes owner.
 */
export async function changeMemberRole(
	tx: Tx,
	out: TxOutbox,
	tripId: string,
	memberId: string,
	role: Exclude<TripRole, "owner">,
): Promise<{ from: TripRole; to: TripRole; userId: string | null }> {
	const res = await tx.execute(sql`
		select user_id as "userId", role::text as role, status::text as status
		  from trip_members where id = ${memberId} and trip_id = ${tripId}
		 for update`);
	const row = res.rows[0] as
		| { userId: string | null; role: TripRole; status: string }
		| undefined;
	if (!row || row.status === "removed")
		throw new AppError("NOT_FOUND", "member");
	if (row.role === "owner" || (role as string) === "owner")
		throw new AppError("CONFLICT", "the owner's role can't change");
	if (row.role === role)
		return { from: row.role, to: role, userId: row.userId };
	await tx.execute(sql`
		update trip_members set role = ${role}, updated_at = now()
		 where id = ${memberId} and trip_id = ${tripId}`);
	if (row.userId) {
		out.access([row.userId]);
		out.notify({
			kind: "membership",
			change: "role",
			userId: row.userId,
			role,
		});
		// Viewers and raters can't propose (PLACES §1c).
		if (!can({ role, isGuest: false }, "propose"))
			await withdrawAuthorProposals(tx, out, tripId, [row.userId]);
	}
	out.emit({ keys: ["sharing", "graph", "proposals"] });
	return { from: row.role, to: role, userId: row.userId };
}

// ---------------------------------------------------------------------------
// ADDENDUM §8 + §10: free-text people (placeholders) and merging them into a
// real member. Both helpers are DB-only and run inside the caller's
// `withTripTx`; the caller authorizes (`addPeople`, `linkPeople`, a claim
// token, the caller's own access) and logs activity (`person.add`,
// `person.merge`).
// ---------------------------------------------------------------------------

/**
 * A lightweight person from a typed name (no account; claimable later). Reuses
 * a live placeholder or invite with the same name (case- and space-
 * insensitive), so a double submit or two pickers never make two "Audrey"s.
 * Role `rater` (PLACES §1c): a placeholder holds no access, and a claim
 * decides its own role (`claimPlaceholderRow`); linking the placeholder to an
 * email invites them with this role (capped by the linker's), so a friend
 * added by name who signs up can rate straight away, and nothing more.
 */
export async function createPlaceholder(
	tx: Tx,
	out: TxOutbox | null,
	tripId: string,
	displayName: string,
): Promise<{ memberId: string; created: boolean }> {
	const name = normalizePersonName(displayName);
	if (!name || name.length > PLACEHOLDER_NAME_MAX)
		throw new AppError("VALIDATION", "name");
	const found = await tx.execute(sql`
		select id::text as id from trip_members
		 where trip_id = ${tripId} and status in ('placeholder', 'invited')
		   and lower(display_name) = lower(${name})
		 order by created_at limit 1`);
	const existing = (found.rows[0] as { id: string } | undefined)?.id;
	if (existing) return { memberId: existing, created: false };
	const colors = await tx.execute(sql`
		select color from trip_members where trip_id = ${tripId} and status <> 'removed'
		union all
		select color from share_grants where trip_id = ${tripId}`);
	const color = leastUsedColor(
		(colors.rows as { color: number }[]).map((r) => Number(r.color)),
	);
	const memberId = newId();
	await tx.execute(sql`
		insert into trip_members (id, trip_id, status, role, display_name, color)
		values (${memberId}, ${tripId}, 'placeholder', 'rater', ${name}, ${color})`);
	out?.emit({ entity: "member", keys: ["graph", "sharing"] });
	return { memberId, created: true };
}

/**
 * Before a merge, where `f` and `i` share an equal split, pins the slices so
 * the merged member owes both (QA MONEY-QA-04): an `equal` expense with both
 * in it becomes `exact` with each person's equal amount (the merge then adds
 * `f`'s to `i`'s), and an itemized line both had gives `f`'s part its own
 * line for `i` (same label). Totals stay exact; the leftover-unit order is
 * the money engine's (payer first, then member order).
 */
async function keepBothSlices(
	tx: Tx,
	tripId: string,
	f: string,
	i: string,
): Promise<void> {
	const shared = await tx.execute(sql`
		select e.id::text as id, e.amount_minor::bigint as amount,
		       array_agg(s.member_id::text order by s.member_id) as members
		  from expenses e join expense_shares s on s.expense_id = e.id
		 where e.trip_id = ${tripId} and e.split_mode = 'equal' and e.amount_minor is not null
		   and exists (select 1 from expense_shares a where a.expense_id = e.id and a.member_id = ${f})
		   and exists (select 1 from expense_shares b where b.expense_id = e.id and b.member_id = ${i})
		 group by e.id`);
	const lines = await tx.execute(sql`
		select l.id::text as id, l.expense_id::text as "expenseId", l.label,
		       l.amount_minor::bigint as amount, l.position,
		       (select min(n.position) from expense_lines n
		         where n.expense_id = l.expense_id and n.position > l.position) as "nextPosition",
		       array_agg(m.member_id::text order by m.member_id) as members
		  from expense_lines l join expense_line_members m on m.line_id = l.id
		 where l.trip_id = ${tripId}
		   and exists (select 1 from expense_line_members a where a.line_id = l.id and a.member_id = ${f})
		   and exists (select 1 from expense_line_members b where b.line_id = l.id and b.member_id = ${i})
		 group by l.id`);
	const expenseRows = shared.rows as {
		id: string;
		amount: string | number;
		members: string[];
	}[];
	const lineRows = lines.rows as {
		id: string;
		expenseId: string;
		label: string;
		amount: string | number;
		position: string;
		nextPosition: string | null;
		members: string[];
	}[];
	if (!expenseRows.length && !lineRows.length) return;
	const order = (
		(
			await tx.execute(sql`
		select id::text as id from trip_members
		 where trip_id = ${tripId} and status <> 'removed' order by created_at, id`)
		).rows as { id: string }[]
	).map((r) => r.id);
	const expenseIds = [
		...new Set([
			...expenseRows.map((r) => r.id),
			...lineRows.map((r) => r.expenseId),
		]),
	];
	const payerRows = (
		await tx.execute(sql`
		select p.expense_id::text as "expenseId", pp.member_id::text as "memberId",
		       pp.amount_minor::bigint as amount
		  from expense_payments p join expense_payment_payers pp on pp.payment_id = p.id
		 where p.trip_id = ${tripId} and p.expense_id = any(${sql.param(expenseIds)}::uuid[])
		 order by p.paid_at, p.id`)
	).rows as { expenseId: string; memberId: string; amount: string | number }[];
	const payersOf = (expenseId: string) =>
		payerOrder([
			{
				currency: "",
				amountMinor: 0,
				homeAmountMinor: null,
				payers: payerRows
					.filter((r) => r.expenseId === expenseId)
					.map((r) => ({
						memberId: r.memberId,
						amountMinor: Number(r.amount),
					})),
			},
		]);

	for (const e of expenseRows) {
		const split = splitEqual(
			Number(e.amount),
			e.members,
			payersOf(e.id),
			order,
		);
		for (const m of e.members)
			await tx.execute(sql`
				update expense_shares set amount_minor = ${split[m] ?? 0}
				 where expense_id = ${e.id} and member_id = ${m}`);
		await tx.execute(sql`
			update expenses set split_mode = 'exact', updated_at = now() where id = ${e.id}`);
	}
	for (const l of lineRows) {
		const part =
			splitEqual(Number(l.amount), l.members, payersOf(l.expenseId), order)[
				f
			] ?? 0;
		let position = l.position;
		try {
			position = generateKeyBetween(l.position, l.nextPosition);
		} catch {
			// Not a fractional key: the same key sorts next to it by id.
		}
		const lineId = newId();
		await tx.execute(sql`
			update expense_lines set amount_minor = amount_minor - ${part} where id = ${l.id}`);
		await tx.execute(sql`
			delete from expense_line_members where line_id = ${l.id} and member_id = ${f}`);
		await tx.execute(sql`
			insert into expense_lines (id, trip_id, expense_id, label, amount_minor, position)
			values (${lineId}, ${tripId}, ${l.expenseId}, ${l.label}, ${part}, ${position})`);
		await tx.execute(sql`
			insert into expense_line_members (trip_id, line_id, member_id)
			values (${tripId}, ${lineId}, ${i})`);
	}
}

/**
 * Moves every reference of `fromMemberId` to `intoMemberId` (same trip) and
 * retires the from-row as `removed` with `merged_into_id`, so old ids (mention
 * tokens inside Yjs notes, proposal payloads) still resolve. Covers item, leg
 * and list assignees, priorities (+ rating comments), mentions, payers
 * (amounts summed), shares (exact amounts summed), itemized lines, budget
 * lines, settlements, seat member ids in leg details and mention tokens in
 * item notes and list items. Where both rows exist the INTO row wins
 * (its rating, its budget line); a settlement between the two is soft-deleted.
 *
 * Only placeholders and invites can be merged away (an active member is a
 * person with an account). The into-row keeps its role, colour and user.
 */
export async function mergeMember(
	tx: Tx,
	out: TxOutbox | null,
	tripId: string,
	fromMemberId: string,
	intoMemberId: string,
): Promise<void> {
	if (fromMemberId === intoMemberId)
		throw new AppError("VALIDATION", "same member");
	const res = await tx.execute(sql`
		select id::text as id, status::text as status,
		       coalesce(display_name, split_part(email, '@', 1), 'Someone') as name
		  from trip_members
		 where trip_id = ${tripId} and id in (${fromMemberId}, ${intoMemberId})
		 for update`);
	const rows = res.rows as { id: string; status: string; name: string }[];
	const from = rows.find((r) => r.id === fromMemberId);
	const into = rows.find((r) => r.id === intoMemberId);
	if (!from || !into || into.status === "removed")
		throw new AppError("NOT_FOUND", "member");
	if (from.status !== "placeholder" && from.status !== "invited")
		throw new AppError(
			"CONFLICT",
			"only a placeholder or invite can be merged",
		);

	const f = fromMemberId;
	const i = intoMemberId;
	// Both in the same equal split: the into-member takes on BOTH slices
	// (ADDENDUM §8/§10 "balances carry over when they claim").
	await keepBothSlices(tx, tripId, f, i);
	// Plain (key, member) link tables: drop the duplicates, then re-point.
	const links: [string, string][] = [
		["item_assignees", "item_id"],
		["leg_assignees", "leg_id"],
		["list_item_assignees", "list_item_id"],
		["node_priorities", "node_id"],
		["expense_line_members", "line_id"],
	];
	for (const [table, keyCol] of links) {
		const t = sql.identifier(table);
		const k = sql.identifier(keyCol);
		await tx.execute(sql`
			delete from ${t} a where a.trip_id = ${tripId} and a.member_id = ${f}
			   and exists (select 1 from ${t} b where b.member_id = ${i} and b.${k} = a.${k})`);
		await tx.execute(
			sql`update ${t} set member_id = ${i} where trip_id = ${tripId} and member_id = ${f}`,
		);
	}
	// Mentions: one row per (source, member).
	await tx.execute(sql`
		delete from mentions a where a.trip_id = ${tripId} and a.member_id = ${f}
		   and exists (select 1 from mentions b where b.member_id = ${i}
		     and b.doc_name is not distinct from a.doc_name
		     and b.list_item_id is not distinct from a.list_item_id
		     and b.note_item_id is not distinct from a.note_item_id
		     and b.node_id is not distinct from a.node_id
		     and b.rater_member_id is not distinct from a.rater_member_id)`);
	await tx.execute(
		sql`update mentions set member_id = ${i} where trip_id = ${tripId} and member_id = ${f}`,
	);
	// Rating-comment mentions follow their comment (its rating moved above).
	await tx.execute(sql`
		delete from mentions a where a.trip_id = ${tripId} and a.rater_member_id = ${f}
		   and exists (select 1 from mentions b where b.rater_member_id = ${i}
		     and b.node_id = a.node_id and b.member_id = a.member_id)`);
	await tx.execute(
		sql`update mentions set rater_member_id = ${i} where trip_id = ${tripId} and rater_member_id = ${f}`,
	);
	// Payers and shares: amounts add up when both paid / both owe.
	await tx.execute(sql`
		update expense_payment_payers b set amount_minor = b.amount_minor + a.amount_minor
		  from expense_payment_payers a
		 where a.trip_id = ${tripId} and a.member_id = ${f} and b.member_id = ${i}
		   and b.payment_id = a.payment_id`);
	await tx.execute(sql`
		delete from expense_payment_payers a where a.trip_id = ${tripId} and a.member_id = ${f}
		   and exists (select 1 from expense_payment_payers b where b.member_id = ${i} and b.payment_id = a.payment_id)`);
	await tx.execute(
		sql`update expense_payment_payers set member_id = ${i} where trip_id = ${tripId} and member_id = ${f}`,
	);
	await tx.execute(sql`
		update expense_shares b
		   set amount_minor = case when a.amount_minor is null and b.amount_minor is null then null
		                           else coalesce(b.amount_minor, 0) + coalesce(a.amount_minor, 0) end
		  from expense_shares a
		 where a.trip_id = ${tripId} and a.member_id = ${f} and b.member_id = ${i}
		   and b.expense_id = a.expense_id`);
	await tx.execute(sql`
		delete from expense_shares a where a.trip_id = ${tripId} and a.member_id = ${f}
		   and exists (select 1 from expense_shares b where b.member_id = ${i} and b.expense_id = a.expense_id)`);
	await tx.execute(
		sql`update expense_shares set member_id = ${i} where trip_id = ${tripId} and member_id = ${f}`,
	);
	// Budget lines: the into-member's own line wins for the same (scope, category).
	await tx.execute(sql`
		delete from budget_lines a where a.trip_id = ${tripId} and a.member_id = ${f}
		   and exists (select 1 from budget_lines b where b.trip_id = a.trip_id and b.member_id = ${i}
		     and b.node_id is not distinct from a.node_id and b.category is not distinct from a.category)`);
	await tx.execute(
		sql`update budget_lines set member_id = ${i} where trip_id = ${tripId} and member_id = ${f}`,
	);
	// Settlements between the two become meaningless: soft-deleted, ids kept
	// (the from-row survives as `removed`, so the FK still holds).
	await tx.execute(sql`
		update settlements set deleted_at = coalesce(deleted_at, date_trunc('milliseconds', now()))
		 where trip_id = ${tripId}
		   and ((from_member_id = ${f} and to_member_id = ${i}) or (from_member_id = ${i} and to_member_id = ${f}))`);
	await tx.execute(sql`
		update settlements set from_member_id = ${i}
		 where trip_id = ${tripId} and from_member_id = ${f} and to_member_id <> ${i}`);
	await tx.execute(sql`
		update settlements set to_member_id = ${i}
		 where trip_id = ${tripId} and to_member_id = ${f} and from_member_id <> ${i}`);
	// Ids inside JSON and Markdown (uuids are unique, so a text replace is exact).
	await tx.execute(sql`
		update legs set details = replace(details::text, ${f}, ${i})::jsonb
		 where trip_id = ${tripId} and details::text like ${`%${f}%`}`);
	const token = (id: string) => `mention:${id}`;
	await tx.execute(sql`
		update items set note = replace(note, ${token(f)}, ${token(i)})
		 where trip_id = ${tripId} and note like ${`%${token(f)}%`}`);
	await tx.execute(sql`
		update list_items set text = replace(text, ${token(f)}, ${token(i)}),
		                      note = replace(note, ${token(f)}, ${token(i)})
		 where trip_id = ${tripId} and (text like ${`%${token(f)}%`} or note like ${`%${token(f)}%`})`);
	// Retire the from-row with a pointer to what it became.
	await tx.execute(sql`
		update trip_members
		   set status = 'removed', user_id = null, email = null,
		       display_name = ${from.name.slice(0, 120)}, merged_into_id = ${i},
		       updated_at = now()
		 where id = ${f} and trip_id = ${tripId}`);
	out?.emit({
		entity: "member",
		keys: ["graph", "sharing", "money", "lists", "counts"],
	});
}

/**
 * The claim core (ADDENDUM §10): `userId` becomes the placeholder. When the
 * user already has an active membership on the trip, the placeholder is
 * merged into it (their role stays); otherwise the placeholder row itself
 * becomes their membership with `role`. The CALLER picks `role` and must
 * never exceed what the user already had (their guest link's role, or the
 * role the person linking them could grant): a placeholder's stored role is
 * not a grant. Returns the membership id.
 */
export async function claimPlaceholderRow(
	tx: Tx,
	out: TxOutbox | null,
	args: { tripId: string; memberId: string; userId: string; role: TripRole },
): Promise<{ memberId: string; merged: boolean }> {
	const { tripId, memberId, userId, role } = args;
	if (role === "owner") throw new AppError("VALIDATION", "role");
	const ph = await tx.execute(sql`
		select status::text as status from trip_members
		 where id = ${memberId} and trip_id = ${tripId} for update`);
	const status = (ph.rows[0] as { status: string } | undefined)?.status;
	if (status !== "placeholder") throw new AppError("NOT_FOUND", "member");
	const mine = await tx.execute(sql`
		select id::text as id from trip_members
		 where trip_id = ${tripId} and user_id = ${userId}`);
	const existing = (mine.rows[0] as { id: string } | undefined)?.id;
	if (existing) {
		await mergeMember(tx, out, tripId, memberId, existing);
		return { memberId: existing, merged: true };
	}
	await tx.execute(sql`
		update trip_members
		   set status = 'active', user_id = ${userId}, role = ${role}, joined_at = now(),
		       updated_at = now()
		 where id = ${memberId} and trip_id = ${tripId}`);
	if (out) {
		out.access([userId]);
		out.notify({ kind: "membership", change: "added", userId, role });
		out.emit({ entity: "member", keys: ["graph", "sharing", "money"] });
	}
	return { memberId, merged: false };
}
