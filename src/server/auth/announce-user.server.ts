import { sql } from "drizzle-orm";
import { db } from "@/db/db.server";
import { publishTripChange } from "@/server/live/realtime.server";

/**
 * A user's name (or picture) changed: every trip they are an active member of
 * refetches its graph and sharing, so other members' open trips show the new
 * name without a reload (QA AUTH-15). The event carries the trip's current
 * `version` (nothing in the trip itself changed), so no client sees a gap.
 */
export async function announceUserChange(userId: string): Promise<void> {
	const rows = (
		await db.execute(sql`
			select t.id::text as "tripId", t.version
			  from trip_members m
			  join trips t on t.id = m.trip_id
			 where m.user_id = ${userId}
			   and m.status = 'active'
			   and t.deleted_at is null`)
	).rows as { tripId: string; version: number | string }[];
	await Promise.all(
		rows.map((r) =>
			publishTripChange({
				type: "invalidate",
				tripId: r.tripId,
				version: Number(r.version),
				keys: ["graph", "sharing"],
			}),
		),
	);
}
