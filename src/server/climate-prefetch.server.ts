/**
 * E3 climate job wiring (EXTENSIONS §6, §1.2 F-ext1 "job wiring"): when a
 * city or area node gets coordinates, its 0.25° cell's normals are fetched in
 * the background (queue `climate`, job `climate.cell`, one job per cell while
 * one is waiting), so the ClimateCard usually answers from `climate_normals`.
 * WP-Insights' `climateForCell` does the fetch (DB first: one request per
 * cell, ever). Off when `CLIMATE_ENABLED` is false. Runs inside cores:
 * `out.job` is discarded on rollback and by a proposal's dry run.
 */
import { climateCell } from "@/features/insights/server/climate.server";
import type { TxOutbox } from "@/server/live/outbox.server";

function climateEnabled(): boolean {
	const v = process.env.CLIMATE_ENABLED?.trim().toLowerCase();
	return !(v === "0" || v === "false");
}

export function enqueueClimateCell(
	out: Pick<TxOutbox, "job" | "tripId">,
	node: { type: string; lat?: number | null; lng?: number | null },
): void {
	if (node.type !== "city" && node.type !== "area") return;
	if (typeof node.lat !== "number" || typeof node.lng !== "number") return;
	if (!climateEnabled()) return;
	const cell = climateCell(node.lat, node.lng);
	out.job(
		"climate",
		"climate.cell",
		{ cell, tripId: out.tripId },
		{ dedupeId: `climate:${cell}` },
	);
}
