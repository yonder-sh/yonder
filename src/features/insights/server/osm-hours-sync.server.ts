/**
 * OSM opening hours in the background (E1, WP-Insights): which places need a
 * fetch, and writing what Overpass said (queue `hours`, run by the worker;
 * the backfill script uses the same functions).
 *
 * - `hours.osm` (a trip): places never fetched for their current `osm_ref`
 *   (just added, or the ref changed). Queued by the node cores
 *   (`enqueueOsmHours`), a moment after the write so a burst of new places
 *   is one batched request.
 * - `hours.osmRefresh` (hourly, all trips): the same, plus places whose last
 *   fetch is older than 30 days + a spread of up to 3 days (by the node id,
 *   so a backfilled trip doesn't come due in one hour), at most
 *   OSM_REFRESH_LIMIT per run, oldest first.
 *
 * Only live places of live trips with an OSM ref and hours that are OSM's or
 * none (never manual or Google: `mergeOsmHours`), skipping categories whose
 * hours never matter (lodging, stations, airports, ports).
 *
 * Writes go through `withTripTx` without bumping `trips.version` unless the
 * hours themselves changed (a bare fetch stamp must not stale anyone's
 * reviewed date change); then the trip's clients are told (`graph`).
 */
import { and, eq, sql } from "drizzle-orm";
import { db } from "@/db/db.server";
import { nodes } from "@/db/schema";
import { NodeDetails } from "@/lib/schemas/nodes";
import { bumpTripVersion, rowsOf } from "@/server/live/outbox.server";
import { withTripTx } from "@/server/tx.server";
import { parseOsmRef } from "../osm-link";
import { hoursChanged, mergeOsmHours } from "./osm-hours.server";
import {
	fetchOsmOpeningHours,
	type OverpassDeps,
	overpassDeps,
} from "./overpass.server";

export const OSM_HOURS_REFRESH_DAYS = 30;
const SPREAD_S = 3 * 24 * 3600;
/** Places per hourly refresh run (one or two Overpass requests). */
export const OSM_REFRESH_LIMIT = 200;
/** Places per trip job (a sheet import can add many at once). */
export const OSM_TRIP_LIMIT = 500;

export type DueNode = { id: string; tripId: string; osmRef: string };

/**
 * Places that need an OSM hours fetch: never fetched for their current ref,
 * or (`stale`) last fetched more than 30 days (+ spread) ago.
 */
export async function dueOsmNodes(opts: {
	tripId?: string;
	stale: boolean;
	limit: number;
	/** Walk by node id after this one (the backfill's cursor), not oldest first. */
	afterId?: string;
}): Promise<DueNode[]> {
	const fetchedAt = sql`(n.details->>'openingHoursFetchedAt')::timestamptz`;
	const res = await db.execute(sql`
		select n.id::text as id, n.trip_id::text as "tripId", n.osm_ref as "osmRef"
		  from nodes n
		  join trips t on t.id = n.trip_id and t.deleted_at is null
		 where n.deleted_at is null
		   and n.type = 'place'
		   and (n.category is null or n.category not in ('lodging', 'station', 'airport', 'port'))
		   and n.osm_ref ~* '^(osm:)?[NWR][0-9]{1,15}$'
		   and coalesce(n.details->'openingHours'->>'source', 'osm') = 'osm'
		   ${opts.tripId ? sql`and n.trip_id = ${opts.tripId}` : sql``}
		   ${opts.afterId !== undefined ? sql`and n.id > ${opts.afterId}::uuid` : sql``}
		   and (
		     n.details->>'openingHoursFetchedAt' is null
		     or n.details->>'openingHoursRef' is distinct from regexp_replace(upper(n.osm_ref), '^OSM:', '')
		     ${
						opts.stale
							? sql`or ${fetchedAt} < now() - make_interval(days => ${OSM_HOURS_REFRESH_DAYS}, secs => abs(hashtext(n.id::text)::bigint) % ${SPREAD_S})`
							: sql``
					}
		   )
		 order by ${opts.afterId !== undefined ? sql`n.id` : sql`${fetchedAt} asc nulls first, n.id`}
		 limit ${opts.limit}`);
	return rowsOf(res) as DueNode[];
}

export type OsmSyncResult = {
	/** OSM objects looked up (cached or not). */
	looked: number;
	/** Nodes whose fetch stamp was written. */
	stamped: number;
	/** Nodes whose hours changed (added, replaced or removed). */
	changed: string[];
};

/**
 * Fetches the tags of `due` (batched, paced, cached) and writes each place's
 * result, trip by trip. Rows that changed meanwhile (hours made manual, the
 * ref changed again) are re-checked under the row lock and left alone.
 */
type SyncOpts = {
	deps?: OverpassDeps;
	now?: Date;
	/** The job's log (Overpass back-offs). */
	log?: (msg: string) => void;
};

export async function syncOsmHours(
	due: readonly DueNode[],
	opts: SyncOpts = {},
): Promise<OsmSyncResult> {
	const result: OsmSyncResult = { looked: 0, stamped: 0, changed: [] };
	if (!due.length) return result;
	const now = opts.now ?? new Date();
	const tags = await fetchOsmOpeningHours(
		due.map((d) => d.osmRef),
		opts.deps ?? overpassDeps(opts.log),
	);
	result.looked = tags.size;
	const fetchedAt = now.toISOString();
	const today = fetchedAt.slice(0, 10);
	const byTrip = new Map<string, string[]>();
	for (const d of due)
		byTrip.set(d.tripId, [...(byTrip.get(d.tripId) ?? []), d.id]);

	for (const [tripId, ids] of byTrip) {
		try {
			await withTripTx(
				tripId,
				async (tx, out) => {
					const rows = rowsOf(
						await tx.execute(sql`
							select id::text as id, osm_ref as "osmRef", details
							  from nodes
							 where trip_id = ${tripId} and deleted_at is null
							   and id = any(${sql.param(ids)}::uuid[])
							   for update`),
					) as { id: string; osmRef: string | null; details: NodeDetails }[];
					const changed: string[] = [];
					for (const row of rows) {
						const ref = parseOsmRef(row.osmRef);
						if (!ref || !tags.has(ref)) continue;
						const before = (row.details ?? {}) as NodeDetails;
						const next = mergeOsmHours(
							before,
							{ ref, tag: tags.get(ref) ?? null, fetchedAt },
							{ today },
						);
						if (!next) continue;
						const checked = NodeDetails.safeParse(next);
						if (!checked.success) continue;
						const hoursMoved = hoursChanged(before, checked.data);
						await tx
							.update(nodes)
							.set({
								details: checked.data,
								// Only a real change moves `updated_at` (an open editor's CONFLICT).
								...(hoursMoved ? { updatedAt: now } : {}),
							})
							.where(and(eq(nodes.id, row.id), eq(nodes.tripId, tripId)));
						result.stamped++;
						if (hoursMoved) changed.push(row.id);
					}
					if (changed.length) {
						// Real data changed: a new version, and the trip's clients refetch.
						out.version = await bumpTripVersion(tx, tripId);
						out.emit({ keys: ["graph"] });
						result.changed.push(...changed);
					}
				},
				{ bumpVersion: false },
			);
		} catch (e) {
			// The trip was deleted meanwhile, or a write failed: the others go on.
			console.error(
				`[hours] OSM hours for trip ${tripId} failed:`,
				e instanceof Error ? e.message : e,
			);
		}
	}
	return result;
}

/** `hours.osm`: the trip's places that were never fetched for their ref. */
export async function osmHoursForTrip(
	tripId: string,
	opts: SyncOpts = {},
): Promise<OsmSyncResult> {
	const due = await dueOsmNodes({
		tripId,
		stale: false,
		limit: OSM_TRIP_LIMIT,
	});
	return syncOsmHours(due, opts);
}

/** `hours.osmRefresh`: the next places due, all trips. */
export async function osmHoursRefresh(
	opts: SyncOpts & { limit?: number } = {},
): Promise<OsmSyncResult> {
	const due = await dueOsmNodes({
		stale: true,
		limit: opts.limit ?? OSM_REFRESH_LIMIT,
	});
	return syncOsmHours(due, opts);
}
