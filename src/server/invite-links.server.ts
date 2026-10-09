import { randomBytes } from "node:crypto";
import { sql } from "drizzle-orm";
import type { Tx } from "@/db/db.server";
import { db } from "@/db/db.server";
import type { ShareRole } from "@/lib/auth/roles";
import { newId } from "@/lib/ids";
import { leastUsedColor } from "./authz/resolve";
import { dropMemberGrants } from "./authz/share-links.server";
import { getEnv } from "./env.server";
import type { TxOutbox } from "./live/outbox.server";

/**
 * Invite links (owner, 2026-10-09): the trip's address only lets people look;
 * an invite link (`/join/<token>`) makes whoever opens it, signed in, a member
 * at its role. The owner makes as many as they like (one per group chat) and
 * deletes any with its ✕. Pure SQL over a transaction; the server functions
 * check the caller (`manageShareLinks`).
 */

export interface InviteLinkRow {
	id: string;
	token: string;
	role: ShareRole;
	useCount: number;
	lastUsedAt: Date | string | null;
	createdAt: Date | string;
}

/** 128 random bits, URL-safe: the link's secret. */
export function newInviteToken(): string {
	return randomBytes(16).toString("base64url");
}

/** An invite link's address, `https://yonder.sh/join/<token>`. */
export function inviteUrl(token: string, appUrl = getEnv().APP_URL): string {
	return new URL(`/join/${token}`, appUrl).toString();
}

export const isInviteToken = (t: string) => /^[A-Za-z0-9_-]{22}$/.test(t);

export async function listInviteLinks(
	exec: Pick<Tx, "execute">,
	tripId: string,
): Promise<InviteLinkRow[]> {
	const res = await exec.execute(sql`
		select id::text as id, token, role::text as role, use_count as "useCount",
		       last_used_at as "lastUsedAt", created_at as "createdAt"
		  from invite_links where trip_id = ${tripId}
		 order by created_at, id`);
	return res.rows as unknown as InviteLinkRow[];
}

export async function createInviteLink(
	tx: Tx,
	out: TxOutbox,
	tripId: string,
	role: ShareRole,
	userId: string,
): Promise<InviteLinkRow> {
	const res = await tx.execute(sql`
		insert into invite_links (id, trip_id, token, role, created_by)
		values (${newId()}, ${tripId}, ${newInviteToken()}, ${role}, ${userId})
		returning id::text as id, token, role::text as role, use_count as "useCount",
		          last_used_at as "lastUsedAt", created_at as "createdAt"`);
	out.emit({ keys: ["sharing"] });
	return res.rows[0] as unknown as InviteLinkRow;
}

/** Deletes one of the trip's invite links (it stops working at once). False if it isn't there. */
export async function deleteInviteLink(
	tx: Tx,
	out: TxOutbox,
	tripId: string,
	id: string,
): Promise<boolean> {
	const res = await tx.execute(sql`
		delete from invite_links where id = ${id} and trip_id = ${tripId} returning 1`);
	if (res.rows.length) out.emit({ keys: ["sharing"] });
	return res.rows.length > 0;
}

/**
 * Opening an invite link signed in: a member at its role, the link's use
 * counted. An email invite waiting for them sets their role instead
 * (`claimInvites` activates it: SHARE-04), and a member stays as they are.
 * Null for an unknown token, a deleted trip or a signed-out user, so nothing
 * says which.
 */
export async function redeemInviteLink(
	token: string,
	userId: string,
): Promise<{ tripId: string; slug: string; joined: boolean } | null> {
	if (!isInviteToken(token)) return null;
	return db.transaction(async (tx) => {
		// Accounts only: a signed-out guest signs in first (the route sends them).
		const account = await tx.execute(sql`
			select 1 from "user" where id = ${userId} and not coalesce(is_anonymous, false)`);
		if (!account.rows.length) return null;
		const link = (
			await tx.execute(sql`
				update invite_links l
				   set use_count = l.use_count + 1, last_used_at = now()
				  from trips t
				 where l.token = ${token} and t.id = l.trip_id and t.deleted_at is null
				returning l.trip_id::text as "tripId", l.role::text as role, t.slug`)
		).rows[0] as { tripId: string; role: ShareRole; slug: string } | undefined;
		if (!link) return null;
		// Serialize colour assignment per trip (the same lock key as lockTrip).
		await tx.execute(
			sql`select pg_advisory_xact_lock(hashtextextended(${link.tripId}, 0))`,
		);
		const blocked = await tx.execute(sql`
			select 1 from trip_members m
			  left join "user" u on u.id = ${userId}
			 where m.trip_id = ${link.tripId}
			   and (m.user_id = ${userId}
			        or (m.status = 'invited' and m.email = lower(trim(u.email))))
			 limit 1`);
		if (blocked.rows.length)
			return { tripId: link.tripId, slug: link.slug, joined: false };
		const taken = (
			await tx.execute(sql`
				select color from trip_members where trip_id = ${link.tripId}
				union all
				select color from share_grants where trip_id = ${link.tripId} and user_id <> ${userId}`)
		).rows as { color: number | string }[];
		const own = (
			await tx.execute(sql`
				select color from share_grants where trip_id = ${link.tripId} and user_id = ${userId} limit 1`)
		).rows[0] as { color: number | string } | undefined;
		const color = own
			? Number(own.color)
			: leastUsedColor(taken.map((r) => Number(r.color)));
		await tx.execute(sql`
			insert into trip_members (id, trip_id, user_id, status, role, color, joined_at, joined_by_link)
			values (${newId()}, ${link.tripId}, ${userId}, 'active', ${link.role}, ${color}, now(), true)`);
		await dropMemberGrants(tx, userId);
		return { tripId: link.tripId, slug: link.slug, joined: true };
	});
}
