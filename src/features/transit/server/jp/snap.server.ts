// Nearest-station snapping: arbitrary lat/lng → candidate platform nodes with walking time.
import type { LatLng } from "./geo.server";
import type { Graph } from "./graph.server";
import { walkMinutes } from "./profiles.server";

export interface Endpoint {
	node: number;
	walkM: number;
	walkMin: number;
}

export interface SnapOptions {
	/** Collect every station within this radius … */
	radiusM?: number;
	/** … but at most this many distinct stations (N02 group codes) … */
	maxStations?: number;
	/** … and at least this many, searching up to maxRadiusM if needed. */
	minStations?: number;
	maxRadiusM?: number;
	walkKmh?: number;
}

export function snap(g: Graph, p: LatLng, o: SnapOptions = {}): Endpoint[] {
	const radiusM = o.radiusM ?? 1200;
	const maxStations = o.maxStations ?? 8;
	const minStations = o.minStations ?? 2;
	const maxRadiusM = o.maxRadiusM ?? 6000;
	let hits = g.stationGrid.within(p.lat, p.lng, radiusM);
	const groupsIn = (h: typeof hits) =>
		new Set(h.map((x) => g.group[x.id])).size;
	if (groupsIn(hits) < minStations)
		hits = g.stationGrid.within(p.lat, p.lng, maxRadiusM);
	const out: Endpoint[] = [];
	const groups = new Set<string | undefined>();
	for (const { id, m } of hits) {
		const grp = g.group[id];
		if (!groups.has(grp)) {
			if (groups.size >= maxStations) continue;
			// beyond the base radius, only take as many as needed to reach minStations
			if (m > radiusM && groups.size >= minStations) continue;
			groups.add(grp);
		}
		out.push({ node: id, walkM: m, walkMin: walkMinutes(m, o.walkKmh) });
	}
	return out;
}
