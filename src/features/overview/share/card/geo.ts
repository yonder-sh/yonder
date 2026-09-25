/**
 * The share card's map: an orthographic globe or a flat Equal Earth world map
 * (docs/OVERVIEW.md §Sharing, `TripRoute.view`), with Natural Earth 110m land,
 * a 20° graticule and the route's lines (flights lifted off the ground,
 * mockup `overview_shared.js`). Pure: numbers and SVG path strings.
 */
import {
	type GeoProjection,
	geoDistance,
	geoEqualEarth,
	geoInterpolate,
	geoOrthographic,
	geoPath,
} from "d3-geo";
import type { MultiLineString } from "geojson";
import { feature } from "topojson-client";
import type { GeometryCollection, Topology } from "topojson-specification";
import land50 from "world-atlas/land-50m.json";
import land110 from "world-atlas/land-110m.json";
import type { LngLat } from "@/lib/engine/geo";
import type { RouteView } from "../../lib/trip-route";

/** Equal Earth's half-width and half-height at scale 1. */
export const EE_HALF_W = 2.7066;
export const EE_HALF_H = 1.3173;
/** A regional globe zooms in until its farthest stay sits this far out (sin of the angle). */
const GLOBE_FILL = Math.sin((20 * Math.PI) / 180);
const MAX_ZOOM = 8;
/** Zoomed in further than this, the coast comes from the 50m set. */
const DETAIL_ZOOM = 1.8;

export interface MapFrame {
	kind: "globe" | "flat";
	/** Box (card units). */
	x: number;
	y: number;
	w: number;
	h: number;
	cx: number;
	cy: number;
	/** Globe: the visible disc's radius. Flat: Equal Earth scale. */
	r: number;
	/** Globe zoom (1: the whole sphere shows). */
	zoom: number;
	projection: GeoProjection;
}

export function mapFrame(
	view: RouteView,
	box: { x: number; y: number; w: number; h: number },
): MapFrame {
	const cx = box.x + box.w / 2;
	const cy = box.y + box.h / 2;
	if (view.kind === "flat") {
		const r = Math.min(
			(box.w - 8) / (2 * EE_HALF_W),
			(box.h - 8) / (2 * EE_HALF_H),
		);
		const projection = geoEqualEarth()
			.rotate([-view.centerLng, 0])
			.scale(r)
			.translate([cx, cy]);
		return { kind: "flat", ...box, cx, cy, r, zoom: 1, projection };
	}
	const r = Math.min(box.w, box.h) / 2 - 20;
	const spread = Math.max(1, view.spreadDeg) * (Math.PI / 180);
	const fill = GLOBE_FILL / Math.sin(Math.min(spread, Math.PI / 2));
	// Continental trips keep the whole sphere (the mockups); a country or a region zooms in.
	const zoom = fill < 1.15 ? 1 : Math.min(MAX_ZOOM, fill);
	const projection = geoOrthographic()
		.rotate([-view.center[0], -view.center[1]])
		.scale(r * zoom)
		.translate([cx, cy])
		.clipAngle(90);
	return { kind: "globe", ...box, cx, cy, r, zoom, projection };
}

const fmt = (n: number) => (Math.round(n * 10) / 10).toString();

/** Rounds a d3 path string to 0.1 units (smaller SVG, same picture). */
const tidy = (d: string | null) =>
	(d ?? "").replace(/-?\d+\.\d+(e-?\d+)?/g, (m) => fmt(Number(m)));

type LandTopo = Topology<{ land: GeometryCollection }>;
const landCache = new Map<
	string,
	GeoJSON.FeatureCollection | GeoJSON.Feature
>();
function land(detail: boolean) {
	const key = detail ? "50m" : "110m";
	let f = landCache.get(key);
	if (!f) {
		const topo = (detail ? land50 : land110) as unknown as LandTopo;
		f = feature(topo, topo.objects.land);
		landCache.set(key, f);
	}
	return f;
}

/** Natural Earth land: 110m, or 50m on a globe zoomed in on a country. */
export function landPath(f: MapFrame): string {
	return tidy(geoPath(f.projection)(land(f.zoom > DETAIL_ZOOM)));
}

export function spherePath(f: MapFrame): string {
	return tidy(geoPath(f.projection)({ type: "Sphere" }));
}

/** Meridians pole to pole and parallels from 60°S to 60°N, every 20° (10° or 5° zoomed in). */
export function graticulePath(f: MapFrame): string {
	const step = f.zoom > 4 ? 5 : f.zoom > 2 ? 10 : 20;
	const lines: LngLat[][] = [];
	for (let lng = -180; lng < 180; lng += step)
		lines.push(Array.from({ length: 181 }, (_, i) => [lng, -90 + i] as LngLat));
	for (let lat = -60; lat <= 60; lat += step)
		lines.push(
			Array.from({ length: 361 }, (_, i) => [-180 + i, lat] as LngLat),
		);
	const g: MultiLineString = { type: "MultiLineString", coordinates: lines };
	return tidy(geoPath(f.projection)(g));
}

/** Where a place lands, or null when it's on the far side of the globe. */
export function projectPoint(
	f: MapFrame,
	p: LngLat,
	lift = 0,
): { x: number; y: number } | null {
	if (f.kind === "globe") {
		const [lng, lat] = f.projection.rotate();
		// cos of the angle from the centre; the mockup hides points within ~1° of the rim.
		if (Math.cos(geoDistance(p, [-lng, -lat])) <= 0.02) return null;
	}
	const q = f.projection(p);
	if (!q) return null;
	if (!lift) return { x: q[0], y: q[1] };
	if (f.kind === "globe")
		return {
			x: f.cx + (q[0] - f.cx) * (1 + lift),
			y: f.cy + (q[1] - f.cy) * (1 + lift),
		};
	return { x: q[0], y: q[1] - lift * f.r * 1.4 };
}

/** Straight (well, great-circle) enough to follow; flights arc up by distance. */
export function legPath(
	f: MapFrame,
	a: LngLat,
	b: LngLat,
	flight: boolean,
): string {
	const distKm = geoDistance(a, b) * 6371;
	const n = Math.max(12, Math.round(distKm / 60));
	const interp = geoInterpolate(a, b);
	const peak = Math.min(0.22, 0.02 + distKm / 45000) / f.zoom;
	let d = "";
	let pen = false;
	let last: { x: number; y: number } | null = null;
	for (let i = 0; i <= n; i++) {
		const t = i / n;
		const q = projectPoint(
			f,
			interp(t) as LngLat,
			flight ? Math.sin(Math.PI * t) * peak : 0,
		);
		if (!q) {
			pen = false;
			last = null;
			continue;
		}
		// A flat map's edge: the line leaves one side and comes back on the other.
		if (f.kind === "flat" && last && Math.abs(q.x - last.x) > f.w / 3)
			pen = false;
		d += `${pen ? "L" : "M"}${fmt(q.x)} ${fmt(q.y)}`;
		pen = true;
		last = q;
	}
	return d;
}
