/**
 * Small geometry helpers for the engine: distances (`@turf/distance`),
 * antimeridian-safe great-circle arcs (`@turf/great-circle`), straight segments
 * and bbox centres. Coordinates are GeoJSON order: `[lng, lat]`.
 */
import { distance } from "@turf/distance";
import { greatCircle } from "@turf/great-circle";
import type { LineString, Position } from "geojson";

export type LngLat = [lng: number, lat: number];

/** `[lng, lat]` of something with nullable `lat`/`lng`, or null. */
export function lngLatOf(
	p: { lat?: number | null; lng?: number | null } | null | undefined,
): LngLat | null {
	if (
		!p ||
		p.lat == null ||
		p.lng == null ||
		!Number.isFinite(p.lat) ||
		!Number.isFinite(p.lng)
	)
		return null;
	return [p.lng, p.lat];
}

/** Great-circle (haversine) distance in kilometres. */
export function haversineKm(a: LngLat, b: LngLat): number {
	return distance(a, b, { units: "kilometers" });
}

export function straightLine(a: LngLat, b: LngLat): LineString {
	return { type: "LineString", coordinates: [a, b] };
}

/**
 * Shifts longitudes by ±360 so consecutive points never jump more than 180°.
 * MapLibre draws such a line continuously across the antimeridian, so a flight
 * EWR → HND stays one LineString instead of a split MultiLineString.
 */
export function unwrapLongitudes(coords: readonly Position[]): Position[] {
	const out: Position[] = [];
	let prev: number | null = null;
	for (const c of coords) {
		let lng = c[0] as number;
		if (prev !== null) {
			while (lng - prev > 180) lng -= 360;
			while (lng - prev < -180) lng += 360;
		}
		out.push([lng, c[1] as number]);
		prev = lng;
	}
	return out;
}

/**
 * The great-circle arc from `a` to `b` as ONE LineString (longitudes unwrapped
 * across the antimeridian). The point count scales with distance (16–256).
 */
export function greatCircleLine(a: LngLat, b: LngLat): LineString {
	if (a[0] === b[0] && a[1] === b[1]) return straightLine(a, b);
	const npoints = Math.max(
		16,
		Math.min(256, Math.round(haversineKm(a, b) / 25)),
	);
	const g = greatCircle(a, b, { npoints }).geometry;
	const coords = g.type === "LineString" ? g.coordinates : g.coordinates.flat();
	// Drop the duplicated split point (…, 180) (-180, …) left by the antimeridian cut.
	const unwrapped = unwrapLongitudes(coords).filter((p, i, arr) => {
		const q = arr[i - 1];
		return !q || q[0] !== p[0] || q[1] !== p[1];
	});
	return { type: "LineString", coordinates: unwrapped };
}

/** Concatenates line strings in order (segment geometries of a transit route). */
export function concatLines(lines: readonly LineString[]): LineString | null {
	const coordinates: Position[] = [];
	for (const l of lines) {
		for (const p of l.coordinates) {
			const q = coordinates.at(-1);
			if (!q || q[0] !== p[0] || q[1] !== p[1]) coordinates.push(p);
		}
	}
	return coordinates.length >= 2 ? { type: "LineString", coordinates } : null;
}

/** Centre of the bounding box of the points, or null for none. */
export function bboxCenter(points: readonly LngLat[]): LngLat | null {
	if (points.length === 0) return null;
	let minX = Number.POSITIVE_INFINITY;
	let minY = Number.POSITIVE_INFINITY;
	let maxX = Number.NEGATIVE_INFINITY;
	let maxY = Number.NEGATIVE_INFINITY;
	for (const [x, y] of points) {
		if (x < minX) minX = x;
		if (y < minY) minY = y;
		if (x > maxX) maxX = x;
		if (y > maxY) maxY = y;
	}
	return [(minX + maxX) / 2, (minY + maxY) / 2];
}
