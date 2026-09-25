/** "Taken near Shibuya Sky" (SPEC §15.2): the closest located place to a photo's EXIF GPS. */
import type { GraphIndex } from "@/lib/engine/graph-index";
import type { GraphNode } from "@/lib/engine/types";

const R = 6_371_000;

export function metersBetween(
	a: { lat: number; lng: number },
	b: { lat: number; lng: number },
): number {
	const toRad = (d: number) => (d * Math.PI) / 180;
	const dLat = toRad(b.lat - a.lat);
	const dLng = toRad(b.lng - a.lng);
	const h =
		Math.sin(dLat / 2) ** 2 +
		Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
	return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** The nearest `place` node within `maxMeters` (default 300 m), or null. */
export function nearestPlace(
	ix: GraphIndex,
	gps: { lat: number; lng: number },
	maxMeters = 300,
): GraphNode | null {
	let best: GraphNode | null = null;
	let bestD = maxMeters;
	for (const n of ix.outline) {
		if (n.type !== "place" || n.lat === null || n.lng === null) continue;
		if (n.status === "dropped") continue;
		const d = metersBetween(gps, { lat: n.lat, lng: n.lng });
		if (d <= bestD) {
			best = n;
			bestD = d;
		}
	}
	return best;
}
