/**
 * E1 OSM hours job wiring (WP-Insights): when a place gets an OSM ref (added
 * from a Photon result, or its ref changed), its trip's `hours.osm` job is
 * queued (queue `hours`, silent). Runs inside the node cores, so `out.job` is
 * discarded on rollback and by a proposal's dry run.
 *
 * One job per trip: it starts a moment later and fetches every place of the
 * trip still missing hours for its ref, so a burst of new places is one
 * batched Overpass request. An add while the trip's job is waiting is
 * dropped (that job will see the place); while it runs, one more job is kept
 * for afterwards (`keepLastIfActive`), so no place is missed.
 *
 * Deliberately light: no Overpass or opening_hours.js code here (the app
 * server imports this through the cores; the worker does the work).
 */
import type { TxOutbox } from "@/server/live/outbox.server";
import { parseOsmRef } from "../osm-link";

/** Enough for a burst of creates (an import, a multi-select) to land first. */
export const OSM_HOURS_JOB_DELAY_MS = 3_000;

export function enqueueOsmHours(
	out: Pick<TxOutbox, "job" | "tripId">,
	node: { type: string; osmRef?: string | null },
): void {
	if (node.type !== "place" || !parseOsmRef(node.osmRef)) return;
	out.job(
		"hours",
		"hours.osm",
		{ tripId: out.tripId },
		{
			delay: OSM_HOURS_JOB_DELAY_MS,
			dedupeId: `hours:osm:${out.tripId}`,
			dedupeKeepLast: true,
		},
	);
}
