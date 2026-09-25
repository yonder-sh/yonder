/**
 * Map-side geometry helpers (pure): curved returns, snapping a stored track to
 * its pins, stub clamping, along-line midpoints and antimeridian-aware bounds.
 * Coordinates are GeoJSON order `[lng, lat]`.
 */
import type { LineString, Position } from "geojson";
import type { LngLat } from "@/lib/engine/geo";

const R = 6_371_008.8;
const rad = (d: number) => (d * Math.PI) / 180;

/** Haversine metres. */
export function metres(a: Position, b: Position): number {
	const [lng1 = 0, lat1 = 0] = a;
	const [lng2 = 0, lat2 = 0] = b;
	const dLat = rad(lat2 - lat1);
	const dLng = rad(lng2 - lng1);
	const s =
		Math.sin(dLat / 2) ** 2 +
		Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(dLng / 2) ** 2;
	return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
}

/**
 * A quadratic curve from `a` to `b`, bowed to the LEFT of travel by `frac` of
 * the chord (DESIGN §9.3 "Return edges"), so both directions of a pair stay
 * readable. Longitudes are compared on the short way round.
 */
export function quadCurve(
	a: LngLat,
	b: LngLat,
	frac = 0.12,
	steps = 24,
): LineString {
	let bx = b[0];
	while (bx - a[0] > 180) bx -= 360;
	while (bx - a[0] < -180) bx += 360;
	// Work in a locally scaled plane (x shrinks with latitude) so the bow is round.
	const k = Math.cos(rad((a[1] + b[1]) / 2)) || 1e-6;
	const ax = a[0] * k;
	const bxs = bx * k;
	const dx = bxs - ax;
	const dy = b[1] - a[1];
	const len = Math.hypot(dx, dy);
	if (len === 0) return { type: "LineString", coordinates: [a, b] };
	// Left normal of (dx, dy) is (-dy, dx).
	const cx = (ax + bxs) / 2 + (-dy / len) * len * frac * 2;
	const cy = (a[1] + b[1]) / 2 + (dx / len) * len * frac * 2;
	const coordinates: Position[] = [];
	for (let i = 0; i <= steps; i++) {
		const t = i / steps;
		const u = 1 - t;
		const x = u * u * ax + 2 * u * t * cx + t * t * bxs;
		const y = u * u * a[1] + 2 * u * t * cy + t * t * b[1];
		coordinates.push([x / k, y]);
	}
	return { type: "LineString", coordinates };
}

/**
 * A stored track that starts or ends away from its pins (a rail route from
 * station to station) gets a short connector to each pin, so the line meets
 * the markers instead of stopping in empty space. Within `tolerance` metres
 * nothing is added.
 */
export function snapEnds(
	line: LineString,
	from: LngLat | null,
	to: LngLat | null,
	tolerance = 40,
): LineString {
	const coords = [...line.coordinates];
	const first = coords[0];
	const last = coords.at(-1);
	if (from && first && metres(first, from) > tolerance) coords.unshift(from);
	if (to && last && metres(last, to) > tolerance) coords.push(to);
	return { type: "LineString", coordinates: coords };
}

/** Total length in metres. */
export function lineLength(coords: readonly Position[]): number {
	let sum = 0;
	for (let i = 1; i < coords.length; i++)
		sum += metres(coords[i - 1] as Position, coords[i] as Position);
	return sum;
}

/** The point halfway along the line (by length). */
export function alongMidpoint(coords: readonly Position[]): LngLat | null {
	if (coords.length === 0) return null;
	if (coords.length === 1) {
		const p = coords[0] as Position;
		return [p[0] ?? 0, p[1] ?? 0];
	}
	const half = lineLength(coords) / 2;
	let acc = 0;
	for (let i = 1; i < coords.length; i++) {
		const a = coords[i - 1] as Position;
		const b = coords[i] as Position;
		const d = metres(a, b);
		if (acc + d >= half && d > 0) {
			const t = (half - acc) / d;
			return [
				(a[0] ?? 0) + ((b[0] ?? 0) - (a[0] ?? 0)) * t,
				(a[1] ?? 0) + ((b[1] ?? 0) - (a[1] ?? 0)) * t,
			];
		}
		acc += d;
	}
	const p = coords.at(-1) as Position;
	return [p[0] ?? 0, p[1] ?? 0];
}

/**
 * The point on the way from `a` toward `b`, at most `maxMetres` from `a`
 * (a ghost stub points off-scope without flying across the map).
 */
export function toward(a: LngLat, b: LngLat, maxMetres: number): LngLat {
	let bx = b[0];
	while (bx - a[0] > 180) bx -= 360;
	while (bx - a[0] < -180) bx += 360;
	const d = metres(a, [bx, b[1]]);
	if (d <= maxMetres || d === 0) return [bx, b[1]];
	const t = maxMetres / d;
	return [a[0] + (bx - a[0]) * t, a[1] + (b[1] - a[1]) * t];
}

export type Bounds = [
	[west: number, south: number],
	[east: number, north: number],
];

/**
 * The smallest box around the points. Longitudes wrap: when the widest empty
 * gap between points crosses ±180 is NOT the largest gap, the box spans the
 * antimeridian and `east` exceeds 180 (MapLibre fits such boxes fine), so a
 * Tokyo + Honolulu trip isn't shown across Europe.
 */
export function boundsOf(points: readonly Position[]): Bounds | null {
	const pts = points.filter(
		(p) => Number.isFinite(p[0]) && Number.isFinite(p[1]),
	);
	if (pts.length === 0) return null;
	let south = Number.POSITIVE_INFINITY;
	let north = Number.NEGATIVE_INFINITY;
	const lngs: number[] = [];
	for (const p of pts) {
		const lat = p[1] as number;
		let lng = p[0] as number;
		while (lng > 180) lng -= 360;
		while (lng < -180) lng += 360;
		lngs.push(lng);
		if (lat < south) south = lat;
		if (lat > north) north = lat;
	}
	lngs.sort((a, b) => a - b);
	const first = lngs[0] as number;
	const last = lngs.at(-1) as number;
	// Largest gap between consecutive longitudes, including the wrap gap.
	let gap = first + 360 - last;
	let west = first;
	let east = last;
	for (let i = 1; i < lngs.length; i++) {
		const g = (lngs[i] as number) - (lngs[i - 1] as number);
		if (g > gap) {
			gap = g;
			west = lngs[i] as number;
			east = (lngs[i - 1] as number) + 360;
		}
	}
	return [
		[west, south],
		[east, north],
	];
}

/** Bounds diagonal in metres (0 for a single point). */
export function boundsDiagonal(b: Bounds | null): number {
	if (!b) return 0;
	return metres(b[0], b[1]);
}

// ---------------------------------------------------------------------------
// Camera padding
// ---------------------------------------------------------------------------

export type Insets = {
	top: number;
	right: number;
	bottom: number;
	left: number;
};
export const NO_INSETS: Insets = { top: 0, right: 0, bottom: 0, left: 0 };

/** MapLibre's `getPadding()` may leave sides out. */
export const insetsOf = (p: Partial<Insets>): Insets => ({
	top: p.top ?? 0,
	right: p.right ?? 0,
	bottom: p.bottom ?? 0,
	left: p.left ?? 0,
});

export function sameInsets(
	a: Partial<Insets>,
	b: Partial<Insets>,
	eps = 0.5,
): boolean {
	const x = insetsOf(a);
	const y = insetsOf(b);
	return (
		Math.abs(x.top - y.top) < eps &&
		Math.abs(x.right - y.right) < eps &&
		Math.abs(x.bottom - y.bottom) < eps &&
		Math.abs(x.left - y.left) < eps
	);
}

/**
 * Fitting on the globe (the country lens of the whole trip). MapLibre centres
 * a globe fit with mercator maths, so a one-sided padding at world zoom (the
 * ~500px inspector) swings the camera ~160° of longitude round the Earth and
 * the trip ends up behind it. Instead:
 *
 * - `camera`: the one-sided part of the padding becomes the camera's own
 *   padding (a shifted vanishing point), which slides the globe sideways into
 *   the uncovered area instead of turning it;
 * - `fit` + `offset` for `cameraForBounds`: the camera looks at the middle of
 *   the bounds (`offset` cancels the centre shift the padding would make), and
 *   the zoom keeps the bounds inside `pad` once `camera` replaces `current`
 *   (the camera padding in force while MapLibre measures the fit).
 */
export function globeFit(
	pad: Insets,
	currentPadding: Partial<Insets>,
): { fit: Insets; offset: [number, number]; camera: Insets } {
	const current = insetsOf(currentPadding);
	const mx = Math.min(pad.left, pad.right);
	const my = Math.min(pad.top, pad.bottom);
	const camera = {
		top: pad.top - my,
		right: pad.right - mx,
		bottom: pad.bottom - my,
		left: pad.left - mx,
	};
	// How far the vanishing point moves from the current padding to `camera`.
	const dx = (camera.left - camera.right - (current.left - current.right)) / 2;
	const dy = (camera.top - camera.bottom - (current.top - current.bottom)) / 2;
	const fit = {
		top: pad.top - dy,
		right: pad.right + dx,
		bottom: pad.bottom + dy,
		left: pad.left - dx,
	};
	return {
		fit,
		offset: [(fit.right - fit.left) / 2, (fit.bottom - fit.top) / 2],
		camera,
	};
}

// ---------------------------------------------------------------------------
// The whole-trip globe (FB-10, QA MAP-01, PLAN-R3-04)
// ---------------------------------------------------------------------------

type Vec3 = [number, number, number];
const deg = (r: number) => (r * 180) / Math.PI;

const toVec = (p: Position): Vec3 => {
	const lng = rad(p[0] ?? 0);
	const lat = rad(p[1] ?? 0);
	return [
		Math.cos(lat) * Math.cos(lng),
		Math.cos(lat) * Math.sin(lng),
		Math.sin(lat),
	];
};
const toLngLat = (v: Vec3): LngLat => [
	deg(Math.atan2(v[1], v[0])),
	deg(Math.asin(Math.max(-1, Math.min(1, v[2])))),
];
const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const unit = (v: Vec3): Vec3 | null => {
	const n = Math.hypot(v[0], v[1], v[2]);
	return n < 1e-12 ? null : [v[0] / n, v[1] / n, v[2] / n];
};
/** The angle between two unit vectors, radians. */
const angle = (a: Vec3, b: Vec3) =>
	Math.acos(Math.max(-1, Math.min(1, dot(a, b))));

/**
 * The smallest spherical cap holding every point: its centre and angular
 * radius in degrees (Bădoiu–Clarkson: step toward the farthest point by a
 * shrinking share of the way; ~0.1° from the optimum for a few dozen points).
 * `null` without points.
 */
export function sphericalCap(
	points: readonly Position[],
): { center: LngLat; radius: number } | null {
	const vs = points
		.filter((p) => Number.isFinite(p[0]) && Number.isFinite(p[1]))
		.map(toVec);
	if (vs.length === 0) return null;
	const sum: Vec3 = [0, 0, 0];
	for (const v of vs) {
		sum[0] += v[0];
		sum[1] += v[1];
		sum[2] += v[2];
	}
	let c = unit(sum) ?? (vs[0] as Vec3);
	const farthest = (at: Vec3) => {
		let best = vs[0] as Vec3;
		let d = -1;
		for (const v of vs) {
			const a = angle(at, v);
			if (a > d) {
				d = a;
				best = v;
			}
		}
		return { v: best, d };
	};
	for (let k = 1; k <= 600; k++) {
		const { v, d } = farthest(c);
		if (d < 1e-9) break;
		// Slerp from c toward v by 1/(k+1) of the angle.
		const t = d / (k + 1);
		const s = Math.sin(d);
		const a = Math.sin(d - t) / s;
		const b = Math.sin(t) / s;
		c =
			unit([c[0] * a + v[0] * b, c[1] * a + v[1] * b, c[2] * a + v[2] * b]) ??
			c;
	}
	return { center: toLngLat(c), radius: deg(farthest(c).d) };
}

/** Initial bearing from `a` to `b` (radians, clockwise from north) and the angle between them. */
function azimuth(a: LngLat, b: Position): { az: number; theta: number } {
	const f1 = rad(a[1]);
	const f2 = rad(b[1] ?? 0);
	const dl = rad((b[0] ?? 0) - a[0]);
	const az = Math.atan2(
		Math.sin(dl) * Math.cos(f2),
		Math.cos(f1) * Math.sin(f2) - Math.sin(f1) * Math.cos(f2) * Math.cos(dl),
	);
	return { az, theta: angle(toVec(a), toVec(b)) };
}

/** The point `theta` radians from `a` toward bearing `az`. */
function destination(a: LngLat, az: number, theta: number): LngLat {
	const f1 = rad(a[1]);
	const l1 = rad(a[0]);
	const f2 = Math.asin(
		Math.sin(f1) * Math.cos(theta) +
			Math.cos(f1) * Math.sin(theta) * Math.cos(az),
	);
	const l2 =
		l1 +
		Math.atan2(
			Math.sin(az) * Math.sin(theta) * Math.cos(f1),
			Math.cos(theta) - Math.sin(f1) * Math.sin(f2),
		);
	return [((((deg(l2) + 540) % 360) + 360) % 360) - 180, deg(f2)];
}

/** MapLibre's default field of view (36.87°): the camera sits 1.5 × the canvas height above the centre. */
export const CAMERA_DISTANCE_PER_HEIGHT = 0.5 / Math.tan(rad(36.87) / 2);

/**
 * Screen distance from the centre of a point `theta` radians away, on a globe
 * of `R` px seen from `D` px above its surface (MapLibre's vertical
 * perspective: an azimuthal projection, so the direction is the bearing).
 */
export const perspectiveRadius = (theta: number, R: number, D: number) =>
	(D * R * Math.sin(theta)) / (D + R - R * Math.cos(theta));

/** How far from the centre the horizon is, radians. */
export const horizonAngle = (R: number, D: number) => Math.acos(R / (D + R));

/** MapLibre's globe radius in px at `zoom` over `lat` (`getGlobeRadiusPixels`, 512px tiles). */
export const globeRadiusAt = (zoom: number, lat: number) =>
	(512 * 2 ** zoom) / (2 * Math.PI) / Math.cos(rad(lat));
export const zoomForGlobeRadius = (R: number, lat: number) =>
	Math.log2((R * 2 * Math.PI * Math.cos(rad(lat))) / 512);

/** The largest cap the globe still shows: past it the edges wrap out of sight, so the map goes flat. */
export const GLOBE_MAX_CAP = 75;
/** Pins stay this far inside the horizon (degrees), so none sit on the limb. */
const HORIZON_MARGIN = 7;

export type GlobeCamera = {
	center: LngLat;
	zoom: number;
	/** The one-sided part of the padding, as the camera's own padding (`globeFit`). */
	padding: Insets;
	/** The trip's cap radius (degrees). */
	cap: number;
};

/**
 * The whole-trip globe camera (FB-10, QA MAP-01): every point on the visible
 * side of the Earth, inside the uncovered part of the map (`pad`), and the
 * Earth still reads as a globe. MapLibre's own globe fit centres the camera
 * with mercator maths, which put the USA and Türkiye behind the horizon of
 * an Arctic-spanning trip (and threw when the bounds couldn't fit the
 * padding, PLAN-R3-04); this never calls it.
 *
 * - The centre is the middle of the smallest cap holding the points, nudged
 *   so their on-screen box is centred in the free area.
 * - The zoom is the largest that keeps every point inside the free area
 *   (azimuthal perspective, bearing 0), `HORIZON_MARGIN` inside the horizon,
 *   and the whole sphere at most `globeScale` × the free area's shorter side
 *   (so a trip within one region still shows the planet, not a curved map).
 * - `null` when the points need more than `GLOBE_MAX_CAP` of the sphere
 *   (show them flat instead) or there are none.
 */
export function globeCamera(
	points: readonly Position[],
	view: {
		width: number;
		height: number;
		pad: Insets;
		maxZoom: number;
		minZoom?: number;
		/** The sphere's on-screen diameter, at most this share of the free area's shorter side. */
		globeScale?: number;
	},
): GlobeCamera | null {
	const cap = sphericalCap(points);
	if (!cap || cap.radius > GLOBE_MAX_CAP) return null;
	const { width: W, height: H, pad } = view;
	const minZoom = view.minZoom ?? -2;
	const bw = Math.max(1, W - pad.left - pad.right);
	const bh = Math.max(1, H - pad.top - pad.bottom);
	const D = CAMERA_DISTANCE_PER_HEIGHT * H;
	const scale = view.globeScale ?? 1;

	// The largest R (px) for a centre: fit, horizon, "still a globe", maxZoom.
	const radiusFor = (center: LngLat): { R: number; theta: number } => {
		let R = Number.POSITIVE_INFINITY;
		let theta = 0;
		for (const p of points) {
			const a = azimuth(center, p);
			theta = Math.max(theta, a.theta);
			if (a.theta < 1e-9) continue;
			// Where the ray at this bearing leaves the free box.
			const sx = Math.abs(Math.sin(a.az));
			const sy = Math.abs(Math.cos(a.az));
			const rMax = Math.min(
				sx > 1e-9 ? bw / 2 / sx : Number.POSITIVE_INFINITY,
				sy > 1e-9 ? bh / 2 / sy : Number.POSITIVE_INFINITY,
			);
			// r(θ, R) = D R sinθ / (D + R(1 − cosθ)) = rMax, solved for R.
			const den = D * Math.sin(a.theta) - rMax * (1 - Math.cos(a.theta));
			if (den > 0) R = Math.min(R, (rMax * D) / den);
		}
		// Every point clear of the horizon: cos(θ + margin) ≥ R / (D + R).
		const cm = Math.cos(Math.min(Math.PI / 2, theta + rad(HORIZON_MARGIN)));
		R = Math.min(R, (D * cm) / Math.max(1e-6, 1 - cm));
		// The sphere's silhouette (radius R·√(D / (D + 2R))) within the free box.
		const rh = (scale * Math.min(bw, bh)) / 2;
		// Solve R √(D/(D+2R)) = rh: R² D = rh² (D + 2R).
		const Rs = (rh * rh + Math.sqrt(rh ** 4 + rh * rh * D * D)) / D;
		R = Math.min(R, Rs);
		const lat = center[1];
		const zMax = Math.max(minZoom, view.maxZoom);
		R = Math.min(R, globeRadiusAt(zMax, lat));
		R = Math.max(R, globeRadiusAt(minZoom, lat));
		return { R, theta };
	};

	let center = cap.center;
	let { R } = radiusFor(center);
	// Centre the points' on-screen box in the free area (a few passes).
	for (let i = 0; i < 4; i++) {
		let x0 = Number.POSITIVE_INFINITY;
		let x1 = Number.NEGATIVE_INFINITY;
		let y0 = Number.POSITIVE_INFINITY;
		let y1 = Number.NEGATIVE_INFINITY;
		for (const p of points) {
			const a = azimuth(center, p);
			const r = perspectiveRadius(a.theta, R, D);
			const x = r * Math.sin(a.az);
			const y = -r * Math.cos(a.az);
			x0 = Math.min(x0, x);
			x1 = Math.max(x1, x);
			y0 = Math.min(y0, y);
			y1 = Math.max(y1, y);
		}
		const cx = (x0 + x1) / 2;
		const cy = (y0 + y1) / 2;
		const off = Math.hypot(cx, cy);
		if (off < 1) break;
		// The ground point under the box centre: invert r(θ) by bisection.
		let lo = 0;
		let hi = horizonAngle(R, D);
		for (let k = 0; k < 40; k++) {
			const mid = (lo + hi) / 2;
			if (perspectiveRadius(mid, R, D) < off) lo = mid;
			else hi = mid;
		}
		const next = destination(center, Math.atan2(cx, -cy), lo);
		const fit = radiusFor(next);
		if (deg(fit.theta) > GLOBE_MAX_CAP) break;
		center = next;
		R = fit.R;
	}
	const zoom = Math.max(
		minZoom,
		Math.min(view.maxZoom, zoomForGlobeRadius(R, center[1])),
	);
	const mx = Math.min(pad.left, pad.right);
	const my = Math.min(pad.top, pad.bottom);
	return {
		center,
		zoom,
		padding: {
			top: pad.top - my,
			right: pad.right - mx,
			bottom: pad.bottom - my,
			left: pad.left - mx,
		},
		cap: cap.radius,
	};
}

/** Padding can't exceed the canvas: shrink it to at most `k` of each dimension. */
export function scalePadding(
	pad: Insets,
	width: number,
	height: number,
	k: number,
): Insets {
	const sx = Math.min(1, (width * k) / Math.max(1, pad.left + pad.right));
	const sy = Math.min(1, (height * k) / Math.max(1, pad.top + pad.bottom));
	return {
		top: pad.top * sy,
		right: pad.right * sx,
		bottom: pad.bottom * sy,
		left: pad.left * sx,
	};
}

/**
 * Fit padding that never gives up the covered part of the map (QA MT-R2-02).
 * `hard` is what the inspector / sheet / pills cover; `soft` is the breathing
 * room around the fitted points. When everything doesn't fit in `k` of the
 * canvas, the room shrinks first, down to `min` px a side (a pin's half-width,
 * so a pin at the fit's edge still clears the panel). Only when even that
 * leaves less than `minFree` px does the whole padding scale (a tiny map).
 */
export function clearPadding(
	hard: Insets,
	soft: Insets,
	width: number,
	height: number,
	k: number,
	{ min = 20, minFree = 72 }: { min?: number; minFree?: number } = {},
): Insets {
	const axis = (
		size: number,
		h0: number,
		h1: number,
		s0: number,
		s1: number,
	): [number, number] | null => {
		if (h0 + h1 + s0 + s1 <= size * k) return [h0 + s0, h1 + s1];
		const m0 = Math.min(s0, min);
		const m1 = Math.min(s1, min);
		const budget = Math.max(0, size * k - h0 - h1);
		const f = s0 + s1 > 0 ? Math.min(1, budget / (s0 + s1)) : 0;
		const r0 = Math.max(m0, s0 * f);
		const r1 = Math.max(m1, s1 * f);
		if (size - (h0 + h1 + r0 + r1) < minFree) return null;
		return [h0 + r0, h1 + r1];
	};
	const sum: Insets = {
		top: hard.top + soft.top,
		right: hard.right + soft.right,
		bottom: hard.bottom + soft.bottom,
		left: hard.left + soft.left,
	};
	const x = axis(width, hard.left, hard.right, soft.left, soft.right);
	const y = axis(height, hard.top, hard.bottom, soft.top, soft.bottom);
	const fallback = scalePadding(sum, width, height, k);
	return {
		left: x ? x[0] : fallback.left,
		right: x ? x[1] : fallback.right,
		top: y ? y[0] : fallback.top,
		bottom: y ? y[1] : fallback.bottom,
	};
}
