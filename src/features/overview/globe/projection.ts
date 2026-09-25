/**
 * The Overview globe's screen maths (docs/OVERVIEW.md §1), pure. The route is
 * drawn in an SVG over MapLibre's globe, so flights can be LIFTED arcs (a
 * MapLibre line always lies on the ground). This is MapLibre's own globe
 * camera (bearing 0, pitch 0, no padding): a sphere of `globeRadiusAt(zoom)`
 * px seen from 1.5 × the canvas height above the centre, the same model
 * `geo-utils` fits the map's whole-trip globe with, so a surface point lands
 * where MapLibre draws it. Without WebGL the same maths draws the sphere.
 */
import {
	CAMERA_DISTANCE_PER_HEIGHT,
	globeRadiusAt,
} from "@/features/map/geo-utils";
import type { LngLat } from "@/lib/engine/geo";

export type GlobeCam = {
	center: LngLat;
	zoom: number;
	width: number;
	height: number;
};

export type Screen = { x: number; y: number; visible: boolean };

export interface Projector {
	cx: number;
	cy: number;
	/** The globe's radius (px, at the centre's scale). */
	R: number;
	/** The sphere's outline on screen (px). */
	silhouette: number;
	/** `lift`: height above the ground, as a share of the radius. */
	project(p: LngLat, lift?: number): Screen;
}

type Vec3 = [number, number, number];
const RAD = Math.PI / 180;
const vec = (p: LngLat): Vec3 => {
	const lng = p[0] * RAD;
	const lat = p[1] * RAD;
	return [
		Math.cos(lat) * Math.cos(lng),
		Math.cos(lat) * Math.sin(lng),
		Math.sin(lat),
	];
};
const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

export function projector(cam: GlobeCam): Projector {
	const R = globeRadiusAt(cam.zoom, cam.center[1]);
	const D = CAMERA_DISTANCE_PER_HEIGHT * cam.height;
	const cx = cam.width / 2;
	const cy = cam.height / 2;
	const lng0 = cam.center[0] * RAD;
	const lat0 = cam.center[1] * RAD;
	const up = vec(cam.center);
	const east: Vec3 = [-Math.sin(lng0), Math.cos(lng0), 0];
	const north: Vec3 = [
		-Math.sin(lat0) * Math.cos(lng0),
		-Math.sin(lat0) * Math.sin(lng0),
		Math.cos(lat0),
	];
	// The camera on the axis through the centre, D above the surface.
	const L = D + R;
	return {
		cx,
		cy,
		R,
		silhouette: R * Math.sqrt(D / (D + 2 * R)),
		project(p, lift = 0) {
			const v = vec(p);
			const Rp = R * (1 + lift);
			const px = Rp * dot(v, east);
			const py = Rp * dot(v, north);
			const pz = Rp * dot(v, up);
			const depth = L - pz;
			if (depth <= 1e-6) return { x: cx, y: cy, visible: false };
			const x = cx + (D * px) / depth;
			const y = cy - (D * py) / depth;
			// Hidden when the ray from the camera meets the sphere first.
			const dx = px;
			const dy = py;
			const dz = pz - L;
			const a = dx * dx + dy * dy + dz * dz;
			const b = 2 * L * dz;
			const c = L * L - R * R;
			const disc = b * b - 4 * a * c;
			let visible = true;
			if (disc > 0) {
				const t = (-b - Math.sqrt(disc)) / (2 * a);
				visible = !(t > 0 && t < 1 - 1e-6);
			}
			return { x, y, visible };
		},
	};
}

/** Great-circle angle between two points (radians). */
export function arcAngle(a: LngLat, b: LngLat): number {
	return Math.acos(Math.max(-1, Math.min(1, dot(vec(a), vec(b)))));
}

/** The point `t` of the way from `a` to `b` along the great circle. */
export function slerp(a: LngLat, b: LngLat, t: number): LngLat {
	const A = vec(a);
	const B = vec(b);
	const d = Math.acos(Math.max(-1, Math.min(1, dot(A, B))));
	if (d < 1e-9) return a;
	const s1 = Math.sin((1 - t) * d) / Math.sin(d);
	const s2 = Math.sin(t * d) / Math.sin(d);
	const v: Vec3 = [
		s1 * A[0] + s2 * B[0],
		s1 * A[1] + s2 * B[1],
		s1 * A[2] + s2 * B[2],
	];
	return [
		Math.atan2(v[1], v[0]) / RAD,
		Math.asin(Math.max(-1, Math.min(1, v[2]))) / RAD,
	];
}

/** How high a flight arc rises at `t` (share of the radius): longer flights higher. */
export function liftAt(t: number, angle: number): number {
	const km = angle * 6371;
	return Math.sin(Math.PI * t) * Math.min(0.22, 0.02 + km / 45_000);
}

/** `n + 1` points along a great circle, `t` from 0 to 1. */
export function arcPoints(a: LngLat, b: LngLat): { p: LngLat; t: number }[] {
	const km = arcAngle(a, b) * 6371;
	const n = Math.max(8, Math.min(160, Math.round(km / 60)));
	return Array.from({ length: n + 1 }, (_, i) => ({
		p: slerp(a, b, i / n),
		t: i / n,
	}));
}

/**
 * An SVG path through the projected points, broken where they go out of
 * sight (behind the globe). `upTo` (0–1) draws only that share of the way.
 */
export function pathOf(
	pts: readonly { p: LngLat; t: number }[],
	proj: Projector,
	lift: ((t: number) => number) | null,
	upTo = 1,
): string {
	let d = "";
	let pen = false;
	for (let i = 0; i < pts.length; i++) {
		const cur = pts[i];
		if (!cur) break;
		let { p, t } = cur;
		if (t > upTo) {
			const prev = pts[i - 1];
			if (!prev || upTo <= prev.t) break;
			// The last, partial step.
			const k = (upTo - prev.t) / (t - prev.t);
			p = [
				prev.p[0] + (p[0] - prev.p[0]) * k,
				prev.p[1] + (p[1] - prev.p[1]) * k,
			];
			if (Math.abs(cur.p[0] - prev.p[0]) > 180) p = prev.p;
			t = upTo;
		}
		const q = proj.project(p, lift ? lift(t) : 0);
		if (!q.visible) {
			pen = false;
		} else {
			d += `${pen ? "L" : "M"}${q.x.toFixed(1)} ${q.y.toFixed(1)}`;
			pen = true;
		}
		if (t >= upTo) break;
	}
	return d;
}

/** Faint meridians and parallels (every 20°), as one path. */
export function graticule(proj: Projector): string {
	let d = "";
	for (let lng = -180; lng < 180; lng += 20)
		d += pathOf(
			Array.from({ length: 37 }, (_, i) => ({
				p: [lng, -90 + i * 5] as LngLat,
				t: 0,
			})),
			proj,
			null,
		);
	for (let lat = -60; lat <= 60; lat += 20)
		d += pathOf(
			Array.from({ length: 73 }, (_, i) => ({
				p: [-180 + i * 5, lat] as LngLat,
				t: 0,
			})),
			proj,
			null,
		);
	return d;
}

export const easeInOut = (t: number) =>
	t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2;
