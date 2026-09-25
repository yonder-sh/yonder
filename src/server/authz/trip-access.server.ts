import { sql } from "drizzle-orm";
import { db } from "@/db/db.server";
import type { TripAccess } from "@/lib/auth/roles";
import { type AccessRow, resolveAccess, UUID_RE } from "./resolve";

/**
 * Trip access straight from Postgres, with no request or session code, so any
 * process can use it (server functions via `access.server.ts`, the collab
 * server, scripts). Always read live: never cache it, and never trust a
 * cookie for it (SECURITY §1), so removing a member, changing a role, or
 * disabling/expiring/resetting a link takes effect on the very next call.
 */

/** Raw access rows for one user on one trip (live trips and live links only). */
export async function loadAccessRows(
	tripId: string,
	userId: string,
): Promise<AccessRow[]> {
	const res = await db.execute(sql`
		select 'member' as via, m.role::text as role, m.id::text as "memberId", m.color, t.slug
		  from trip_members m
		  join trips t on t.id = m.trip_id and t.deleted_at is null
		 where m.trip_id = ${tripId} and m.user_id = ${userId} and m.status = 'active'
		union all
		select 'grant', l.role::text, null, g.color, t.slug
		  from share_grants g
		  join share_links l on l.id = g.share_link_id and l.trip_id = g.trip_id
		  join trips t on t.id = l.trip_id and t.deleted_at is null
		 where g.trip_id = ${tripId} and g.user_id = ${userId}
		   and l.enabled and l.revoked_at is null
		   and (l.expires_at is null or l.expires_at > now())`);
	return res.rows as unknown as AccessRow[];
}

/** The user's access to the trip, or null (malformed id, deleted trip, no membership or live grant). */
export async function loadTripAccess(
	tripId: string,
	userId: string,
): Promise<TripAccess | null> {
	if (!UUID_RE.test(tripId)) return null;
	return resolveAccess(tripId, await loadAccessRows(tripId, userId));
}
