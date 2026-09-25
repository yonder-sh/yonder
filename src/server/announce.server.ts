/**
 * Announcing a change that did not go through `withTripTx` (share-link
 * redemption, invite claims at sign-in): one `invalidate` per trip at the
 * trip's current version, published after the caller's own commit. Clients
 * refetch the named keys; the same version means "no gap", so nothing else
 * is refetched. Best effort, never throws.
 */
import { sql } from "drizzle-orm";
import { db } from "@/db/db.server";
import type { TripKey } from "@/lib/query/keys";
import { invalidateEvent, publishTripChange } from "./live/realtime.server";

export async function announceTripChange(
	tripIds: readonly string[],
	keys: readonly TripKey[],
): Promise<void> {
	for (const tripId of new Set(tripIds)) {
		try {
			const res = await db.execute(
				sql`select version from trips where id = ${tripId}`,
			);
			const version = Number(
				(res.rows[0] as { version?: number } | undefined)?.version ?? 0,
			);
			await publishTripChange(invalidateEvent({ tripId, version, keys }));
		} catch (e) {
			console.error(
				"[live] announce failed:",
				e instanceof Error ? e.message : e,
			);
		}
	}
}
