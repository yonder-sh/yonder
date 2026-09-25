// biome-ignore-all lint/style/noNonNullAssertion: ported verbatim from spikes/japan-transit/estimate (typed arrays, bounds checked by construction).
// Public API: free Japan rail estimate over N02, returning 2–3 alternatives fastest first.
import { haversineM, type LatLng } from "./geo.server";
import { type Graph, stationNodes } from "./graph.server";
import { walkMinutes } from "./profiles.server";
import {
	alternatives,
	type EstimateRoute,
	finishRoute,
	type Place,
	rank,
} from "./router.server";
import { type Endpoint, type SnapOptions, snap } from "./snap.server";

export interface EstimateOptions {
	/** number of alternatives (default 3) */
	k?: number;
	walkKmh?: number;
	snap?: SnapOptions;
	/** include LineString geometry on ride segments */
	geometry?: boolean;
	/** offer a walk-only route when it takes at most this long (default 30 min) */
	maxWalkOnlyMin?: number;
}

export type EstimateNote =
	| "no-station-near-origin"
	| "no-station-near-destination"
	| "no-rail-path"
	/** rail-only path is > 1.8× the straight line over 15 km: a (highway) bus or car is probably faster */
	| "rail-detour-bus-likely"
	/** the best route starts or ends with > 15 min on foot: a local bus/taxi may beat it (N02 has no buses) */
	| "long-access-walk";

export interface EstimateResult {
	routes: EstimateRoute[];
	/** SPEC §14.2.1: always offered next to estimates */
	googleMapsUrl: string;
	notes: EstimateNote[];
	origin: { snapped: Endpoint[] };
	destination: { snapped: Endpoint[] };
	attribution: string;
}

/** Shinkansen rides shorter than this are city hops (Tokyo–Ueno is 3.6 km). */
export const MIN_SHINKANSEN_KM = 20;

/** The route rides a Shinkansen for less than MIN_SHINKANSEN_KM. */
export function shortShinkansenHop(r: EstimateRoute): boolean {
	return r.segments.some(
		(s) =>
			s.kind === "ride" &&
			s.cls === "shinkansen" &&
			s.distanceKm < MIN_SHINKANSEN_KM,
	);
}

export function googleMapsTransitUrl(from: LatLng, to: LatLng): string {
	return `https://www.google.com/maps/dir/?api=1&origin=${from.lat},${from.lng}&destination=${to.lat},${to.lng}&travelmode=transit`;
}

export function estimateRoutes(
	g: Graph,
	from: LatLng & { name?: string },
	to: LatLng & { name?: string },
	o: EstimateOptions = {},
): EstimateResult {
	const snapOpts = { ...o.snap, walkKmh: o.walkKmh ?? o.snap?.walkKmh };
	const src = snap(g, from, snapOpts);
	const dst = snap(g, to, snapOpts);
	return run(g, from, to, src, dst, o);
}

/** Station-to-station (names as in N02, e.g. "東京", "京都"); optional line/operator substring filters. */
export function estimateStations(
	g: Graph,
	fromName: string,
	toName: string,
	o: EstimateOptions & { fromLine?: string; toLine?: string } = {},
): EstimateResult {
	const a = stationNodes(g, fromName, o.fromLine);
	const b = stationNodes(g, toName, o.toLine);
	const ep = (ids: number[]): Endpoint[] =>
		ids.map((node) => ({ node, walkM: 0, walkMin: 0 }));
	const centroid = (ids: number[]): LatLng & { name: string } => ({
		lat: ids.reduce((t, i) => t + g.lat[i]!, 0) / Math.max(1, ids.length),
		lng: ids.reduce((t, i) => t + g.lng[i]!, 0) / Math.max(1, ids.length),
		name: "",
	});
	return run(
		g,
		{ ...centroid(a), name: fromName },
		{ ...centroid(b), name: toName },
		ep(a),
		ep(b),
		{ ...o, maxWalkOnlyMin: 0 },
	);
}

function run(
	g: Graph,
	from: LatLng & { name?: string },
	to: LatLng & { name?: string },
	src: Endpoint[],
	dst: Endpoint[],
	o: EstimateOptions,
): EstimateResult {
	const notes: EstimateNote[] = [];
	const origin: Place = {
		name: from.name ?? "Origin",
		lat: from.lat,
		lng: from.lng,
	};
	const destination: Place = {
		name: to.name ?? "Destination",
		lat: to.lat,
		lng: to.lng,
	};
	if (!src.length) notes.push("no-station-near-origin");
	if (!dst.length) notes.push("no-station-near-destination");
	const k = o.k ?? 3;
	let routes: EstimateRoute[] =
		src.length && dst.length
			? alternatives(g, src, dst, {
					k: k + 1,
					origin,
					destination,
					geometry: o.geometry,
				})
			: [];
	if (src.length && dst.length && !routes.length) notes.push("no-rail-path");
	// A Shinkansen hop inside a city (Ueno → Tokyo, 1 min of a 28 min trip)
	// isn't a sensible alternative (QA MT-06): kept only when it's the fastest
	// (Tokyo → Shinagawa). `alternatives` returns fastest first.
	routes = routes.filter((r, i) => i === 0 || !shortShinkansenHop(r));

	const straightM = haversineM(from.lat, from.lng, to.lat, to.lng);
	const walkOnly = walkMinutes(straightM, o.walkKmh);
	if (walkOnly <= (o.maxWalkOnlyMin ?? 30)) {
		routes.push(
			finishRoute(
				[
					{
						kind: "walk",
						from: origin,
						to: destination,
						distanceM: Math.round(straightM),
						durationMin: walkOnly,
					},
				],
				0,
			),
		);
	}
	routes = rank(routes, k, 1.6, 15);
	const best = routes[0];
	if (
		best &&
		best.rideKm > 0 &&
		straightM > 15_000 &&
		best.rideKm / (straightM / 1000) > 1.8
	)
		notes.push("rail-detour-bus-likely");
	const ends = best
		? [best.segments[0], best.segments[best.segments.length - 1]]
		: [];
	if (
		best &&
		best.rideKm > 0 &&
		ends.some((s) => s?.kind === "walk" && s.durationMin > 15)
	)
		notes.push("long-access-walk");
	return {
		routes,
		googleMapsUrl: googleMapsTransitUrl(from, to),
		notes,
		origin: { snapped: src },
		destination: { snapped: dst },
		attribution: g.data.source.attribution,
	};
}
