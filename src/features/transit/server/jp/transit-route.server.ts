/**
 * Adapter from the estimate engine's routes to the app's `TransitRoute` /
 * `TransitSegment` (SPEC §6.5 `legs.ts`; JAPAN_TRANSIT §3). Transfers become
 * `walk` segments with `vehicleType: "TRANSFER"` whose minutes include the
 * wait. Geometry is the real N02 track shape, capped at 200 points per route
 * (and per segment).
 */
import type {
	LineString,
	SegmentMode,
	TransitRoute,
	TransitSegment,
} from "@/lib/schemas/legs";
import { type LngLat, simplify } from "./geo.server";
import { operatorEn } from "./line-names.server";
import { lineColor, shortLineName } from "./line-style.server";
import type { EstimateRoute } from "./router.server";

/** Stored lines are capped at this many points (SPEC §6.6). */
export const MAX_LINE_POINTS = 200;

/** Douglas–Peucker with a growing tolerance until the line has ≤ `max` points. */
export function capPoints(
	coords: readonly LngLat[],
	max = MAX_LINE_POINTS,
): LngLat[] {
	const rounded = coords.map(
		([x, y]) =>
			[Math.round(x * 1e5) / 1e5, Math.round(y * 1e5) / 1e5] as LngLat,
	);
	if (rounded.length <= max) return rounded;
	let tol = 10;
	let out = simplify(rounded, tol);
	while (out.length > max && tol < 100_000) {
		tol *= 2;
		out = simplify(rounded, tol);
	}
	return out.length > max
		? [rounded[0] as LngLat, rounded[rounded.length - 1] as LngLat]
		: out;
}

const line = (coords: readonly LngLat[], max?: number): LineString => ({
	type: "LineString",
	coordinates: capPoints(coords, max),
});

const stop = (p: {
	name: string;
	nameEn?: string;
	lat: number;
	lng: number;
}) => ({
	name: (p.nameEn ? `${p.nameEn} (${p.name})` : p.name).slice(0, 200),
	lat: p.lat,
	lng: p.lng,
});

export type ToTransitRouteOptions = {
	/** `manifest.build`: lets autofill refresh unedited legs when the data changes. */
	dataBuild?: string;
	/** Caveats shown with the route ("A bus is probably faster"). */
	warnings?: string[];
};

export function toTransitRoute(
	r: EstimateRoute,
	o: ToTransitRouteOptions = {},
): TransitRoute {
	const segments: TransitSegment[] = r.segments.map((s) => {
		const durationMin = Math.max(0, Math.round(s.durationMin));
		if (s.kind === "walk")
			return {
				mode: "walk" as SegmentMode,
				from: stop(s.from),
				to: stop(s.to),
				durationMin,
			};
		if (s.kind === "transfer")
			return {
				mode: "walk" as SegmentMode,
				vehicleType: "TRANSFER",
				from: stop(s.from),
				to: stop(s.to),
				durationMin,
			};
		const color = lineColor(s.lineKey);
		const seg: TransitSegment = {
			mode: s.mode,
			vehicleType: s.cls.toUpperCase(),
			lineName: (s.lineNameEn ?? s.lineName).slice(0, 200),
			lineShort: shortLineName(s.lineNameEn, s.lineName).slice(0, 40),
			agency: operatorEn(s.operator).slice(0, 200),
			headsign: s.through
				? s.through === "likely"
					? "Likely through service"
					: "Through service"
				: undefined,
			stopCount: s.stopCount,
			from: stop(s.from),
			to: stop(s.to),
			durationMin,
			...(color ? { color: color.bg, textColor: color.fg } : {}),
		};
		if (!seg.headsign) delete seg.headsign;
		if (s.geometry && s.geometry.length >= 2)
			seg.geometry = line(s.geometry, 80);
		return seg;
	});
	const coords = r.segments.flatMap((s) =>
		s.kind === "ride" && s.geometry
			? s.geometry
			: [[s.from.lng, s.from.lat] as LngLat, [s.to.lng, s.to.lat] as LngLat],
	);
	const out: TransitRoute = {
		id: r.id,
		source: "estimate",
		durationMin: r.durationMin,
		walkMin: r.walkMin,
		transfers: r.transfers,
		segments,
		geometry: line(coords),
		label: `${r.label} · est.`.slice(0, 80),
		range: { lo: r.rangeMin[0], hi: r.rangeMin[1] },
	};
	if (o.warnings?.length) out.warnings = o.warnings.slice(0, 10);
	if (o.dataBuild) out.dataBuild = o.dataBuild;
	return out;
}
