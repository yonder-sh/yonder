/**
 * WP-Home membership cores (SPEC §11.2–§11.5, §13.6; ADDENDUM §8–§10). DB-only:
 * each runs inside the caller's `withTripTx` (authorization is the caller's
 * job, via `requireDirect`). The merge/claim/retire cores
 * themselves are F's (`@/server/members.server`); these decide WHICH row
 * becomes WHAT, with which role, and never grant more than the caller could.
 */
import { sql } from "drizzle-orm";
import type { Tx } from "@/db/db.server";
import { roleAtLeast, type ShareRole, type TripRole } from "@/lib/auth/roles";
import { newId } from "@/lib/ids";
import { leastUsedColor } from "@/server/authz/resolve";
import { fail } from "@/server/authz/session.server";
import type { TxOutbox } from "@/server/live/outbox.server";
import { claimPlaceholderRow, mergeMember } from "@/server/members.server";
import { matchingPlaceholder } from "../claim-match";

export type MemberRow = {
	id: string;
	tripId: string;
	userId: string | null;
	status: "active" | "invited" | "placeholder" | "removed";
	role: TripRole;
	email: string | null;
	name: string;
	color: number;
};

/** One member row of the trip (locked), or NOT_FOUND. */
export async function lockMember(
	tx: Tx,
	tripId: string,
	memberId: string,
): Promise<MemberRow> {
	const res = await tx.execute(sql`
		select m.id::text as id, m.trip_id::text as "tripId", m.user_id as "userId",
		       m.status::text as status, m.role::text as role,
		       coalesce(u.email, m.email) as email,
		       coalesce(nullif(u.name, ''), m.display_name, split_part(m.email, '@', 1), 'Someone') as name,
		       m.color
		  from trip_members m left join "user" u on u.id = m.user_id
		 where m.id = ${memberId} and m.trip_id = ${tripId}
		 for update of m`);
	const row = res.rows[0] as MemberRow | undefined;
	if (!row || row.status === "removed") return fail("NOT_FOUND", "member");
	return { ...row, color: Number(row.color) };
}

/** The colours in use on a trip (members and guests), for `leastUsedColor`. */
export async function nextColor(tx: Tx, tripId: string): Promise<number> {
	const colors = await tx.execute(sql`
		select color from trip_members where trip_id = ${tripId} and status::text <> 'removed'
		union all
		select color from share_grants where trip_id = ${tripId}`);
	return leastUsedColor(
		(colors.rows as { color: number }[]).map((r) => Number(r.color)),
	);
}

/**
 * A member's link grants on this trip are dropped when the owner sets their
 * membership (promote, role change, invite of an existing account): the
 * effective role is the max of membership and grants (SPEC §11.3), so a kept
 * edit-link grant would silently override "Can view" (QA SHARE-04), like
 * `removeMember`'s "no side door". Their sockets re-check at once.
 */
export async function dropLinkGrants(
	tx: Tx,
	out: TxOutbox,
	tripId: string,
	userId: string,
): Promise<boolean> {
	const res = await tx.execute(sql`
		delete from share_grants where trip_id = ${tripId} and user_id = ${userId}
		returning user_id`);
	if (!res.rows.length) return false;
	out.access([userId]);
	out.emit({ keys: ["sharing", "graph"] });
	return true;
}

/** The weaker of two roles, never owner (a claim or link never grants more than the placeholder's role). */
export function capRole(role: TripRole, cap: TripRole): ShareRole {
	const r = roleAtLeast(cap, role) ? role : cap;
	return (r === "owner" ? "editor" : r) as ShareRole;
}

type Account = { id: string; name: string; email: string };

/** A non-anonymous account with that (lower-cased) email, if any. */
export async function accountByEmail(
	tx: Tx,
	email: string,
): Promise<Account | null> {
	const res = await tx.execute(sql`
		select id, name, email from "user"
		 where lower(email) = ${email} and not coalesce(is_anonymous, false)
		 limit 1`);
	return (res.rows[0] as Account | undefined) ?? null;
}

/** The live (non-removed) member row of a user or an email on a trip. */
async function liveRowFor(
	tx: Tx,
	tripId: string,
	by: { userId?: string; email?: string },
): Promise<{ id: string; status: string } | null> {
	const res = await tx.execute(sql`
		select m.id::text as id, m.status::text as status
		  from trip_members m left join "user" u on u.id = m.user_id
		 where m.trip_id = ${tripId} and m.status::text <> 'removed'
		   and (${by.userId ?? null}::text is not null and m.user_id = ${by.userId ?? null}
		        or ${by.email ?? null}::text is not null
		           and (m.email = ${by.email ?? null} or lower(u.email) = ${by.email ?? null}))
		 order by (m.status = 'active') desc
		 limit 1`);
	return (res.rows[0] as { id: string; status: string } | undefined) ?? null;
}

// ---------------------------------------------------------------------------
// inviteMember (owner)
// ---------------------------------------------------------------------------

export type InviteResult = {
	memberId: string;
	status: "active" | "invited";
	/** The address to email (the invitee), lower-cased. */
	email: string;
	/** An existing account got access at once. */
	userId: string | null;
	/** That account's name (null for a pending invite: never show the address). */
	name: string | null;
};

/**
 * An existing account becomes an active member at once; an unknown address a
 * pending invite (`claimInvites` activates it at sign-in). CONFLICT when the
 * person is already on the trip (active or pending), or it's the caller.
 */
export async function inviteCore(
	tx: Tx,
	out: TxOutbox,
	args: {
		tripId: string;
		email: string;
		role: ShareRole;
		inviter: { id: string; email: string };
	},
): Promise<InviteResult> {
	const email = args.email.trim().toLowerCase();
	if (email === args.inviter.email.trim().toLowerCase())
		return fail("CONFLICT", "That's you. You're already on this trip.");
	const account = await accountByEmail(tx, email);
	const existing = await liveRowFor(tx, args.tripId, {
		userId: account?.id,
		email,
	});
	if (existing?.status === "active")
		return fail("CONFLICT", "They're already on this trip.");
	if (existing?.status === "invited")
		return fail("CONFLICT", "They're already invited.");
	const color = await nextColor(tx, args.tripId);
	const memberId = newId();
	if (account)
		await tx.execute(sql`
			insert into trip_members (id, trip_id, user_id, status, role, color, invited_by, joined_at)
			values (${memberId}, ${args.tripId}, ${account.id}, 'active', ${args.role}, ${color}, ${args.inviter.id}, now())`);
	else
		await tx.execute(sql`
			insert into trip_members (id, trip_id, status, role, email, color, invited_by)
			values (${memberId}, ${args.tripId}, 'invited', ${args.role}, ${email}, ${color}, ${args.inviter.id})`);
	if (account) {
		// Invited as "Can view": an old edit-link grant doesn't outrank it.
		await dropLinkGrants(tx, out, args.tripId, account.id);
		out.access([account.id]);
		out.notify({
			kind: "membership",
			change: "added",
			userId: account.id,
			role: args.role,
		});
	}
	out.emit({ entity: "member", keys: ["graph", "sharing"] });
	return {
		memberId,
		status: account ? "active" : "invited",
		email,
		userId: account?.id ?? null,
		name: account?.name || null,
	};
}

// ---------------------------------------------------------------------------
// Placeholders ↔ accounts (ADDENDUM §10)
// ---------------------------------------------------------------------------

export type LinkResult =
	| { kind: "merged"; intoId: string }
	| { kind: "claimed"; memberId: string; userId: string }
	| { kind: "invited"; email: string };

/**
 * `linkPlaceholder` with an email: the placeholder merges into the trip row
 * of that person when there is one (a member or a pending invite), becomes
 * the membership of an existing account (role: the placeholder's, capped by
 * the linker's and at editor), or turns into a pending invite that
 * `claimInvites` activates on sign-up.
 */
export async function linkPlaceholderToEmail(
	tx: Tx,
	out: TxOutbox,
	args: {
		tripId: string;
		placeholder: MemberRow;
		email: string;
		linkerRole: TripRole;
	},
): Promise<LinkResult> {
	const { tripId, placeholder } = args;
	if (placeholder.status !== "placeholder")
		return fail("CONFLICT", "Only a person without an account can be linked.");
	const email = args.email.trim().toLowerCase();
	const account = await accountByEmail(tx, email);
	const row = await liveRowFor(tx, tripId, { userId: account?.id, email });
	if (row) {
		if (row.id === placeholder.id) return { kind: "invited", email };
		await mergeMember(tx, out, tripId, placeholder.id, row.id);
		return { kind: "merged", intoId: row.id };
	}
	const role = capRole(capRole(placeholder.role, args.linkerRole), "editor");
	if (account) {
		const r = await claimPlaceholderRow(tx, out, {
			tripId,
			memberId: placeholder.id,
			userId: account.id,
			role,
		});
		// The placeholder's role, not an old edit-link grant (QA SHARE-04).
		if (!r.merged) await dropLinkGrants(tx, out, tripId, account.id);
		return { kind: "claimed", memberId: r.memberId, userId: account.id };
	}
	await tx.execute(sql`
		update trip_members
		   set status = 'invited', email = ${email}, role = ${role}, updated_at = now()
		 where id = ${placeholder.id} and trip_id = ${tripId}`);
	out.emit({ entity: "member", keys: ["graph", "sharing"] });
	return { kind: "invited", email };
}

/**
 * `promoteGuest`: a signed-in guest becomes a member with EXACTLY the chosen
 * role (their link grants are dropped: EXTENSIONS §1.4 "Can suggest", QA
 * SHARE-04). Merges first (ADDENDUM §10 settles SPEC §11.2 flow 7 in favour
 * of merging): a pending invite of their email becomes theirs, and the
 * placeholder that looks like them ("Are you Audrey?": their full name, else
 * the only one with their first name) is merged into the new membership. This
 * is the owner's confirmation a guest's "I'm Audrey" needs (QA A-10).
 */
export async function promoteGuestCore(
	tx: Tx,
	out: TxOutbox,
	args: { tripId: string; userId: string; role: ShareRole },
): Promise<{ memberId: string; name: string }> {
	// SPEC §11.5: already a member → CONFLICT (checked first: promoting drops
	// the grant, so a repeat finds no guest).
	const active = await liveRowFor(tx, args.tripId, { userId: args.userId });
	if (active?.status === "active")
		return fail("CONFLICT", "They're already on this trip.");
	const guest = await tx.execute(sql`
		select u.id, u.name, u.first_name as "firstName", lower(u.email) as email,
		       coalesce(u.is_anonymous, false) as anon, max(g.color) as color
		  from share_grants g join "user" u on u.id = g.user_id
		 where g.trip_id = ${args.tripId} and g.user_id = ${args.userId}
		 group by u.id, u.name, u.first_name, u.email, u.is_anonymous`);
	const g = guest.rows[0] as
		| {
				id: string;
				name: string;
				firstName: string | null;
				email: string;
				anon: boolean;
				color: number;
		  }
		| undefined;
	if (!g) return fail("NOT_FOUND", "guest");
	if (g.anon)
		return fail(
			"CONFLICT",
			"Guests need to sign in with an email before they can be added.",
		);
	const invite = await liveRowFor(tx, args.tripId, { email: g.email });
	let memberId: string;
	if (invite?.status === "invited") {
		await tx.execute(sql`
			update trip_members
			   set status = 'active', user_id = ${g.id}, email = null, role = ${args.role},
			       joined_at = now(), updated_at = now()
			 where id = ${invite.id} and trip_id = ${args.tripId}`);
		memberId = invite.id;
	} else {
		memberId = newId();
		await tx.execute(sql`
			insert into trip_members (id, trip_id, user_id, status, role, color, joined_at)
			values (${memberId}, ${args.tripId}, ${g.id}, 'active', ${args.role}, ${Number(g.color ?? 0)}, now())`);
	}
	const placeholders = await tx.execute(sql`
		select id::text as id, display_name as name, status::text as status
		  from trip_members
		 where trip_id = ${args.tripId} and status = 'placeholder' and display_name is not null`);
	const twin = matchingPlaceholder(
		placeholders.rows as { id: string; name: string; status: string }[],
		{ name: g.name, firstName: g.firstName },
	);
	if (twin) await mergeMember(tx, out, args.tripId, twin.id, memberId);
	// The role the owner chose is the role they get: no link grant on top.
	await tx.execute(sql`
		delete from share_grants where trip_id = ${args.tripId} and user_id = ${g.id}`);
	out.access([g.id]);
	out.emit({ entity: "member", keys: ["graph", "sharing"] });
	return { memberId, name: g.name || "Someone" };
}
