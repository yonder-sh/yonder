/**
 * The hourly autofill sweep (SPEC §10.9): when an editor loads a trip, enqueue
 * autofill for every unset pair whose suggestion is a walk or transit, at most
 * once per hour per trip (`SET key('sweep', tripId) 1 NX EX 3600`). It heals
 * jobs lost between a commit and its enqueue. Best effort: never throws.
 */

import type { AirportRecord } from "@/features/transit/server/airports.server";
import { autoFlightFor } from "@/features/transit/server/auto-flight.server";
import { indexGraph } from "@/lib/engine/graph-index";
import { suggestPair } from "@/lib/engine/suggest";
import type { TripGraph } from "@/lib/engine/types";
import { enqueue } from "./live/jobs.server";
import { autofillDedupeId } from "./live/outbox.server";
import { key, redis } from "./live/redis.server";

const SWEEP_TTL_S = 3600;

/** Returns how many jobs were enqueued (0 when the sweep ran within the hour). */
export async function autofillSweep(graph: TripGraph): Promise<number> {
	try {
		if (graph.trip.settings.autofillLegs === false) return 0;
		const ok = await redis().set(
			key("sweep", graph.trip.id),
			"1",
			"EX",
			SWEEP_TTL_S,
			"NX",
		);
		if (ok !== "OK") return 0;
		const ix = indexGraph(graph);
		let n = 0;
		const airports = new Map<string, AirportRecord | null>();
		for (const p of ix.pairs) {
			const row = ix.legByPair.get(p.key);
			if (row?.mode || row?.isEdited) continue;
			// FB-19: two adjacent airports get their default flight, even across a night.
			const flight = !!autoFlightFor(ix, p.fromItemId, p.toItemId, airports);
			// Overnight connectors and nights at a stay have no pair travel.
			const kind = ix.boundaryKind(p.fromItemId, p.toItemId);
			if (!flight && (kind === "stay" || kind === "overnight")) continue;
			const s = suggestPair(ix, p.fromItemId, p.toItemId);
			if (!flight && s.mode !== "walk" && s.mode !== "transit") continue;
			const target = {
				kind: "pair" as const,
				fromItemId: p.fromItemId,
				toItemId: p.toItemId,
			};
			await enqueue(
				"autofill",
				"autofill",
				{ tripId: graph.trip.id, target },
				{ dedupeId: autofillDedupeId(target) },
			);
			n++;
		}
		return n;
	} catch (e) {
		console.error(
			"[autofill] sweep failed:",
			e instanceof Error ? e.message : e,
		);
		return 0;
	}
}
