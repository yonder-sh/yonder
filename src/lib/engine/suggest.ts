/**
 * Leg suggestions and estimates (SPEC §9.3): what an unset leg counts in the
 * schedule, the label on its suggestion chip, and the conflict-fix buttons.
 *
 * Estimates are deliberately simple and deterministic: haversine distance ×
 * 1.3 for walks, a piecewise-linear rail table for transit, and for a flight
 * between two airport nodes the great-circle estimate (FB-18/19; no airport
 * time is invented). A flight between countries without airports counts 0.
 */
import type { TransitRoute } from "@/lib/schemas/legs";
import {
	AUTO_FLIGHT_MIN_KM,
	flightEstimateMin,
	looksLikeAirportNode,
} from "./flights";
import { haversineKm } from "./geo";
import type { GraphIndex } from "./graph-index";
import type { LegMode, ScheduleResult, Suggestion } from "./types";

/** Straight-line distance under which walking is suggested. */
export const WALK_THRESHOLD_KM = 1.5;
/** Straight line → street distance. */
export const WALK_DETOUR_FACTOR = 1.3;

/**
 * km → minutes, piecewise linear, tuned for Japanese and Korean rail; includes
 * the access walk and the wait. +0.25 min per km past the last anchor.
 */
export const RAIL_ESTIMATE_ANCHORS: readonly (readonly [
	km: number,
	min: number,
])[] = [
	[0, 8],
	[2, 12],
	[10, 25],
	[30, 50],
	[50, 70],
	[100, 115],
	[150, 130],
	[400, 185],
];
const RAIL_PER_KM_BEYOND = 0.25;

/** Rail door-to-door estimate in whole minutes for a straight-line distance. */
export function railEstimateMin(km: number): number {
	const d = Math.max(0, km);
	const anchors = RAIL_ESTIMATE_ANCHORS;
	for (let i = 1; i < anchors.length; i++) {
		const [x0, y0] = anchors[i - 1] as readonly [number, number];
		const [x1, y1] = anchors[i] as readonly [number, number];
		if (d <= x1) return Math.round(y0 + ((d - x0) / (x1 - x0)) * (y1 - y0));
	}
	const [xl, yl] = anchors[anchors.length - 1] as readonly [number, number];
	return Math.round(yl + (d - xl) * RAIL_PER_KM_BEYOND);
}

/** `round(d × 1.3 / walkSpeedKmh × 60)`. */
export function walkEstimateMin(km: number, walkSpeedKmh: number): number {
	return Math.round(((km * WALK_DETOUR_FACTOR) / walkSpeedKmh) * 60);
}

/** Compact duration: "12m", "1h43", "2h". */
export function formatShortDuration(minutes: number): string {
	const m = Math.max(0, Math.round(minutes));
	if (m < 60) return `${m}m`;
	const h = Math.floor(m / 60);
	const r = m % 60;
	return r === 0 ? `${h}h` : `${h}h${String(r).padStart(2, "0")}`;
}

/** "walk ~12m?", "transit ~1h43 est.?", "flight ~14h05 est.?", "flight?" (and "?" when nothing is known). */
export function suggestionLabel(
	mode: LegMode | null,
	estimateMin: number | null,
): string {
	if (!mode) return "?";
	if (estimateMin == null) return `${mode}?`;
	const est = mode === "transit" || mode === "flight" ? " est." : "";
	return `${mode} ~${formatShortDuration(estimateMin)}${est}?`;
}

/**
 * The suggestion for travelling between two nodes: walk under 1.5 km, a
 * flight with the great-circle estimate between two airports at least 150 km
 * apart (FB-19), a flight between countries (estimate null), else transit by
 * the rail table.
 */
export function suggestBetween(
	ix: GraphIndex,
	fromNodeId: string,
	toNodeId: string,
): Suggestion {
	const a = ix.coordOf(fromNodeId);
	const b = ix.coordOf(toNodeId);
	const km = a && b ? haversineKm(a, b) : null;
	const make = (
		mode: LegMode | null,
		estimateMin: number | null,
	): Suggestion => ({
		mode,
		estimateMin,
		distanceKm: km,
		label: suggestionLabel(mode, estimateMin),
	});
	if (km !== null && km < WALK_THRESHOLD_KM)
		return make("walk", walkEstimateMin(km, ix.settings.walkSpeedKmh));
	const na = ix.node(fromNodeId);
	const nb = ix.node(toNodeId);
	if (
		km !== null &&
		km >= AUTO_FLIGHT_MIN_KM &&
		na &&
		nb &&
		looksLikeAirportNode(na) &&
		looksLikeAirportNode(nb)
	)
		return make("flight", flightEstimateMin(km));
	const ca = ix.hierarchy.nearestOfType(fromNodeId, "country")?.id;
	const cb = ix.hierarchy.nearestOfType(toNodeId, "country")?.id;
	if (ca && cb && ca !== cb) return make("flight", null);
	if (km === null) return make(null, null);
	return make("transit", railEstimateMin(km));
}

/** The suggestion for the pair P→I (by the items' nodes). */
export function suggestPair(
	ix: GraphIndex,
	fromItemId: string,
	toItemId: string,
): Suggestion {
	const a = ix.item(fromItemId)?.nodeId;
	const b = ix.item(toItemId)?.nodeId;
	if (!a || !b)
		return { mode: null, estimateMin: null, distanceKm: null, label: "?" };
	return suggestBetween(ix, a, b);
}

export type ConflictFix =
	| { kind: "shorten"; itemId: string; durationMin: number }
	| {
			kind: "fastest-route";
			legId: string;
			routeId: string;
			durationMin: number;
	  }
	| { kind: "unpin"; itemId: string };

/** Shortened items keep at least this many minutes. */
export const MIN_SHORTENED_MIN = 15;

/**
 * The conflict-fix buttons for a late item or leg (§9.3): (1) shorten the
 * previous item by the lateness if it keeps ≥ 15 min; (2) switch to the fastest
 * alternative for untimed transit; (3) unpin a pinned item. A `departure` or
 * `flight` conflict gets only (1). `alternatives` are the leg's
 * `legs.alternatives` (not in the graph payload; pass them when loaded).
 */
export function conflictFixes(
	ix: GraphIndex,
	schedule: ScheduleResult,
	target: { kind: "item"; itemId: string } | { kind: "leg"; key: string },
	alternatives?: readonly TransitRoute[],
): ConflictFix[] {
	const fixes: ConflictFix[] = [];
	const shortenBefore = (itemId: string, minutes: number) => {
		const i = ix.orderOf(itemId);
		const prev = i > 0 ? ix.ordered[i - 1] : undefined;
		const cur = ix.item(itemId);
		if (!prev || !cur || prev.dayId !== cur.dayId) return;
		const next = prev.durationMin - minutes;
		if (next >= MIN_SHORTENED_MIN)
			fixes.push({ kind: "shorten", itemId: prev.id, durationMin: next });
	};
	if (target.kind === "leg") {
		const leg = schedule.legs[target.key];
		if (!leg?.late) return fixes;
		const toItemId = target.key.startsWith("stay:")
			? null
			: target.key.split(">")[1];
		if (toItemId) shortenBefore(toItemId, leg.late.minutes);
		return fixes;
	}
	const item = ix.item(target.itemId);
	const late = schedule.items[target.itemId]?.late;
	if (!item || !late) return fixes;
	shortenBefore(item.id, late.minutes);
	const p = ix.prevLocated(item.id);
	const leg =
		p && item.nodeId ? ix.legByPair.get(`${p.id}>${item.id}`) : undefined;
	if (
		leg &&
		leg.mode === "transit" &&
		!ix.isTimed(leg) &&
		alternatives?.length
	) {
		const current = leg.durationMin ?? Number.POSITIVE_INFINITY;
		const fastest = [...alternatives].sort(
			(a, b) => a.durationMin - b.durationMin,
		)[0];
		if (fastest && fastest.durationMin < current)
			fixes.push({
				kind: "fastest-route",
				legId: leg.id,
				routeId: fastest.id,
				durationMin: fastest.durationMin,
			});
	}
	if (item.pinnedStart) fixes.push({ kind: "unpin", itemId: item.id });
	return fixes;
}
