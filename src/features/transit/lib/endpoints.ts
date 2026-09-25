/**
 * Where a leg starts and ends (isomorphic: the inspector and the server use
 * the same rules). A pair leg joins its two items' places; a stay leg joins
 * the stay and the day's first/last located stop (SPEC §7.6).
 */
import type { GraphIndex } from "@/lib/engine/graph-index";
import { pairKey } from "@/lib/engine/graph-index";
import type { LegMode } from "@/lib/schemas/enums";
import { readLegDetails } from "@/lib/schemas/legs";
import type { LegTarget } from "@/lib/schemas/targets";

export type LegEnd = {
	nodeId: string;
	/** Item title or place name. */
	name: string;
	lat: number;
	lng: number;
	/** ISO 3166 alpha-2 of the nearest ancestor that has one, else null. */
	country: string | null;
	tz: string;
};

export type LegEnds = {
	/** Schedule key: `from>to` or `stay:<dayId>:<end>`. */
	key: string;
	from: LegEnd | null;
	to: LegEnd | null;
};

/** Country code of a node: its own, else the nearest ancestor's. */
export function countryOf(
	ix: GraphIndex,
	nodeId: string | null | undefined,
): string | null {
	if (!nodeId) return null;
	for (const n of ix.path(nodeId).slice().reverse())
		if (n.countryCode) return n.countryCode.toUpperCase();
	return null;
}

function end(
	ix: GraphIndex,
	nodeId: string | null | undefined,
	label?: string | null,
): LegEnd | null {
	if (!nodeId) return null;
	const c = ix.coordOf(nodeId);
	if (!c) return null;
	const node = ix.node(nodeId);
	return {
		nodeId,
		name: label || node?.name || "?",
		lng: c[0],
		lat: c[1],
		country: countryOf(ix, nodeId),
		tz: ix.tzOf(nodeId),
	};
}

export function legKeyOf(target: LegTarget): string {
	return target.kind === "pair"
		? pairKey(target.fromItemId, target.toItemId)
		: `stay:${target.dayId}:${target.end}`;
}

export function legEnds(ix: GraphIndex, target: LegTarget): LegEnds {
	const key = legKeyOf(target);
	if (target.kind === "pair") {
		const a = ix.item(target.fromItemId);
		const b = ix.item(target.toItemId);
		return {
			key,
			from: end(ix, ix.effectiveNodeId(target.fromItemId), a?.title),
			to: end(ix, ix.effectiveNodeId(target.toItemId), b?.title),
		};
	}
	const plan =
		target.end === "start"
			? ix.morningStay(target.dayId)
			: ix.eveningStay(target.dayId);
	if (!plan) return { key, from: null, to: null };
	const anchor = ix.item(plan.anchorItemId);
	const stayName = ix.node(plan.stayNodeId)?.name;
	return target.end === "start"
		? {
				key,
				from: end(ix, plan.fromNodeId, stayName),
				to: end(ix, plan.toNodeId, anchor?.title),
			}
		: {
				key,
				from: end(ix, plan.fromNodeId, anchor?.title),
				to: end(ix, plan.toNodeId, stayName),
			};
}

/** Both ends in Japan (Google has no transit there; ADDENDUM §5). */
export function isJapan(ends: Pick<LegEnds, "from" | "to">): boolean {
	return ends.from?.country === "JP" && ends.to?.country === "JP";
}

/** Either end in Japan: the leg gets the Japan copy and the Maps link. */
export function touchesJapan(ends: Pick<LegEnds, "from" | "to">): boolean {
	return ends.from?.country === "JP" || ends.to?.country === "JP";
}

/** Google Maps' `travelmode` values (Maps URLs, `api=1`). */
export type MapsTravelMode = "transit" | "walking" | "driving" | "bicycling";

/**
 * The directions mode for "Open in Google Maps" on a leg (FB-03: every
 * non-flight leg with two located ends, with the matching mode): walk →
 * walking, transit → transit, other → by its kind (taxi, car and other →
 * driving; bike → bicycling; bus and ferry → transit). An unset leg follows
 * its suggestion (transit when there is none). A flight has no link (null).
 */
export function mapsTravelMode(
	leg: { mode: LegMode | null; details?: unknown } | null | undefined,
	suggested?: LegMode | null,
): MapsTravelMode | null {
	const mode = leg?.mode ?? suggested ?? "transit";
	switch (mode) {
		case "flight":
			return null;
		case "walk":
			return "walking";
		case "transit":
			return "transit";
		case "other": {
			const d = leg?.mode === "other" ? readLegDetails(leg.details) : null;
			const kind = d?.kind === "other" ? d.otherKind : "taxi";
			if (kind === "bike") return "bicycling";
			if (kind === "bus" || kind === "ferry") return "transit";
			return "driving";
		}
	}
}

/**
 * SPEC §14.2.1: "Open in Google Maps" (ADDENDUM §5: on every Japan transit
 * row; FB-03: on every non-flight leg, `mode` matching the leg). Coordinates
 * at 5 decimals (~1 m).
 */
export function googleMapsDirectionsUrl(
	from: { lat: number; lng: number },
	to: { lat: number; lng: number },
	mode: MapsTravelMode = "transit",
): string {
	const ll = (p: { lat: number; lng: number }) =>
		`${Number(p.lat.toFixed(5))},${Number(p.lng.toFixed(5))}`;
	return `https://www.google.com/maps/dir/?api=1&origin=${ll(from)}&destination=${ll(to)}&travelmode=${mode}`;
}
