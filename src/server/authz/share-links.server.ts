import { sql } from "drizzle-orm";
import { db } from "@/db/db.server";
import type { ShareRole } from "@/lib/auth/roles";
import { newId } from "@/lib/ids";
import { isTripSlug } from "@/lib/trip-slug";
import type { SqlExec } from "@/server/graph.server";
import { leastUsedColor } from "./resolve";

/**
 * Opening a trip through its link (SECURITY §2; `share_links` /
 * `share_grants`; the 2026-09-25 redesign): the trip's address `/t/<slug>`
 * is the link, like Google Drive. A non-member who opens it while
 * "Anyone with the link" is on gets a `share_grants` row on the live link;
 * access is then resolved from the grant on every request, so turning the
 * link off, expiring or resetting it (a new address tail) cuts the guest off
 * immediately. A grant never makes anyone a member, with one exception: a
 * signed-in account on a "Can rate" link (`joinRateLinks`, PLACES §1c).
 */

export interface OpenedLink {
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
 * The live link of the trip at `slug`: switched on, not revoked, not
 * expired, on a live trip. The newest when fixtures hold several.
 */
const liveLinkAt = (slug: string) => sql`
	select l.id from share_links l
	  join trips t on t.id = l.trip_id and t.deleted_at is null
	 where t.slug = ${slug}
	   and l.enabled and l.revoked_at is null
	   and (l.expires_at is null or l.expires_at > now())
	 order by l.created_at desc, l.id desc
	 limit 1`;

/**
 * Whether the trip at `slug` is open to anyone with the link (for a
 * signed-out visitor, before an anonymous guest session is made for them).
 * False for an unknown slug, a deleted trip and a link that is off, revoked
 * or expired alike, so it reveals nothing the address itself wouldn't.
 */
export async function tripLinkIsOpen(slug: string): Promise<boolean> {
	if (!isTripSlug(slug)) return false;
	const res = await db.execute(liveLinkAt(slug));
	return res.rows.length > 0;
}

/**
 * A non-member opens the trip's address: upserts the user's grant on its live
 * link. Returns null for an unknown slug, a deleted trip, a link that is
 * off, revoked or expired, and for an active member (they need no grant: a
 * link grant must never lift a member's own role, SHARE-04): callers answer
 * all of them with one generic NOT_FOUND, so nothing reveals which.
 *
 * The grant's colour is stable per user and trip (QA LINK-10): the user's
 * member colour if they have a (former) member row, else their colour on
 * another grant of this trip, else the least-used colour among the trip's
 * members and guests.
 */
export async function openTripLink(
	slug: string,
	userId: string,
): Promise<OpenedLink | null> {
	if (!isTripSlug(slug)) return null;
	return db.transaction(async (tx) => {
		const link = (
			await tx.execute(sql`
				update share_links l
				   set last_used_at = now(), use_count = l.use_count + 1
				  from trips t
				 where l.id = (${liveLinkAt(slug)})
				   and t.id = l.trip_id
				   and not exists (select 1 from trip_members m
				                    where m.trip_id = l.trip_id and m.user_id = ${userId} and m.status = 'active')
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
			insert into trip_members (id, trip_id, user_id, status, role, color, joined_at, joined_by_link)
			values (${newId()}, ${r.tripId}, ${userId}, 'active', 'rater', ${Number(r.color)}, now(), true)
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
