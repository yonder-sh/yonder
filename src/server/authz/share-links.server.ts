import { sql } from "drizzle-orm";
import { db } from "@/db/db.server";
import { hashShareToken } from "@/db/share-token.server";
import type { ShareRole } from "@/lib/auth/roles";
import { isShareToken } from "@/lib/auth/share-link";
import { newId } from "@/lib/ids";
import type { SqlExec } from "@/server/graph.server";
import { leastUsedColor } from "./resolve";

/**
 * Redeeming share links (SECURITY §2; `share_links` / `share_grants`).
 *
 * Tokens are 32 random bytes; the database keeps only SHA-256(token)
 * (`token_hash`), so lookups hash the presented token (token creation and the
 * sealed copy for the owner live in `src/db/share-token.server.ts`).
 * Redeeming gives the signed-in user (usually a Better Auth anonymous guest)
 * a `share_grants` row; access is then resolved from the grant on every
 * request, so disabling, expiring or resetting the link cuts the guest off
 * immediately. A grant never makes anyone a member, with one exception: a
 * signed-in account on a "Can rate" link (`joinRateLinks`, PLACES §1c).
 */

export interface RedeemedLink {
	tripId: string;
	slug: string;
	role: ShareRole;
	shareLinkId: string;
	/** The grant's presence colour 0..7. */
	color: number;
}

type LinkRow = { id: string; trip_id: string; role: ShareRole; slug: string };
type ColorRow = { color: number | string };

/**
 * Upserts the user's grant for a live link. Returns null for an unknown,
 * disabled, expired or revoked token, or a deleted trip: callers answer all of
 * them with one generic "no longer works", so nothing reveals which.
 *
 * The grant's colour is stable per user and trip (QA LINK-10): the user's
 * member colour if they are also a member, else their colour on another grant
 * of this trip, else the least-used colour among the trip's members and guests.
 */
export async function redeemShareToken(
	token: string,
	userId: string,
): Promise<RedeemedLink | null> {
	if (!isShareToken(token)) return null;
	const tokenHash = hashShareToken(token);
	return db.transaction(async (tx) => {
		const link = (
			await tx.execute(sql`
				update share_links l
				   set last_used_at = now(), use_count = l.use_count + 1
				  from trips t
				 where l.token_hash = ${tokenHash}
				   and l.enabled and l.revoked_at is null
				   and (l.expires_at is null or l.expires_at > now())
				   and t.id = l.trip_id and t.deleted_at is null
				returning l.id::text as id, l.trip_id::text as trip_id, l.role::text as role, t.slug`)
		).rows[0] as LinkRow | undefined;
		if (!link) return null;

		// Serialize colour assignment per trip (the same lock key as lockTrip).
		await tx.execute(
			sql`select pg_advisory_xact_lock(hashtextextended(${link.trip_id}, 0))`,
		);

		const own = (
			await tx.execute(sql`
				select color from trip_members where trip_id = ${link.trip_id} and user_id = ${userId}
				union all
				select color from share_grants where trip_id = ${link.trip_id} and user_id = ${userId}
				limit 1`)
		).rows[0] as ColorRow | undefined;

		let color = own ? Number(own.color) : undefined;
		if (color === undefined) {
			const taken = (
				await tx.execute(sql`
					select color from trip_members where trip_id = ${link.trip_id}
					union all
					select color from share_grants where trip_id = ${link.trip_id}`)
			).rows as ColorRow[];
			color = leastUsedColor(taken.map((r) => Number(r.color)));
		}

		const grant = (
			await tx.execute(sql`
				insert into share_grants (trip_id, share_link_id, user_id, color)
				values (${link.trip_id}, ${link.id}, ${userId}, ${color})
				on conflict (share_link_id, user_id) do update set last_seen_at = now()
				returning color`)
		).rows[0] as ColorRow;

		if (link.role === "rater") await joinRateLinks(tx, userId, link.trip_id);

		return {
			tripId: link.trip_id,
			slug: link.slug,
			role: link.role,
			shareLinkId: link.id,
			color: Number(grant.color),
		};
	});
}

/**
 * PLACES §1c "Can rate": a rating belongs to a member row, so a signed-in
 * ACCOUNT holding a grant on a live rate link becomes a `rater` member (the
 * one exception to "a grant never makes anyone a member"; the owner asked
 * for rating through the one trip link, and the joiner must sign in). The
 * grant is then dropped: the membership is the one source of their role, and
 * the owner manages them under People like anyone invited. Anonymous guests
 * stay guests (view only: nothing to rate as), and a user who already has a
 * row on the trip (a member, or a removed former member) is left as they
 * are. No placeholder is merged: "Are you Audrey?" stays the member's own
 * claim. Called on redemption and when a guest signs in
 * (`migrateGuestToUser`). Returns the trips that gained a member.
 */
export async function joinRateLinks(
	tx: SqlExec,
	userId: string,
	tripId?: string,
): Promise<string[]> {
	const res = await tx.execute(sql`
		select distinct on (g.trip_id) g.trip_id::text as "tripId", g.color
		  from share_grants g
		  join share_links l on l.id = g.share_link_id
		  join trips t on t.id = g.trip_id and t.deleted_at is null
		  join "user" u on u.id = g.user_id and not coalesce(u.is_anonymous, false)
		 where g.user_id = ${userId}
		   and l.role::text = 'rater' and l.enabled and l.revoked_at is null
		   and (l.expires_at is null or l.expires_at > now())
		   ${tripId ? sql`and g.trip_id = ${tripId}` : sql``}
		   and not exists (select 1 from trip_members m
		                    where m.trip_id = g.trip_id and m.user_id = g.user_id)
		 order by g.trip_id, g.created_at`);
	const joined: string[] = [];
	for (const r of res.rows as { tripId: string; color: number | string }[]) {
		const ins = await tx.execute(sql`
			insert into trip_members (id, trip_id, user_id, status, role, color, joined_at)
			values (${newId()}, ${r.tripId}, ${userId}, 'active', 'rater', ${Number(r.color)}, now())
			on conflict do nothing
			returning trip_id`);
		if (!ins.rows.length) continue;
		await tx.execute(sql`
			delete from share_grants where trip_id = ${r.tripId} and user_id = ${userId}`);
		joined.push(r.tripId);
	}
	return joined;
}

/**
 * SECURITY §2 "a guest can't pose as Dennis": whether `name` (cleaned) is the
 * full or first name of a current member (or placeholder) of any trip this
 * guest holds a grant on. Case-insensitive.
 */
export async function guestNameClashes(
	guestUserId: string,
	name: string,
): Promise<boolean> {
	const res = await db.execute(sql`
		select 1 from share_grants g
		  join trip_members m on m.trip_id = g.trip_id and m.status <> 'removed'
		  left join "user" u on u.id = m.user_id
		 where g.user_id = ${guestUserId}
		   and lower(${name}) in (
		         lower(coalesce(nullif(u.name, ''), m.display_name, '')),
		         lower(coalesce(nullif(u.first_name, ''), split_part(coalesce(m.display_name, ''), ' ', 1))))
		 limit 1`);
	return res.rows.length > 0;
}
