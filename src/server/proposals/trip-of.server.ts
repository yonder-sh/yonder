/**
 * `tripIdOf` helpers for proposable defs: the trip of a live row, or
 * NOT_FOUND. They only locate the trip; the gate then checks the caller's
 * access on it (no access is NOT_FOUND too, so ids never reveal anything).
 */

import type { LegTarget } from "@/lib/schemas/targets";
import { fail } from "@/server/authz/session.server";
import type { SqlExec } from "@/server/graph.server";
import { tripOf } from "@/server/perms.server";

type Table = Parameters<typeof tripOf>[0];

export async function rowTrip(
	exec: SqlExec,
	table: Table,
	id: string,
): Promise<string> {
	const tripId = await tripOf(table, id, { exec });
	return tripId ?? fail("NOT_FOUND");
}

/** A pair's two items must be live items of one trip; a stay's day must exist. */
export async function legTargetTrip(
	exec: SqlExec,
	target: LegTarget,
): Promise<string> {
	if (target.kind === "stay") return rowTrip(exec, "trip_days", target.dayId);
	if (target.fromItemId === target.toItemId)
		return fail("VALIDATION", "a leg joins two different items");
	const a = await tripOf("items", target.fromItemId, { exec });
	const b = await tripOf("items", target.toItemId, { exec });
	if (!a || !b || a !== b) return fail("NOT_FOUND");
	return a;
}
