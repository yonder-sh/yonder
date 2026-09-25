/**
 * The landing hero's globe, as numbers (pure: no DOM, no React). One fixed
 * camera over East Asia in a square `SIZE × SIZE` viewBox, with the same
 * maths as the Overview globe (`overview/globe/projection.ts`: MapLibre's
 * globe camera), so the page's SVG route and the pre-rendered land layer
 * (`scripts/landing/globe.ts` → `public/landing/globe-land.svg`, d3-geo with
 * the same perspective) line up exactly. The OG image is drawn from it too.
 *
 * The route draws itself with CSS (`stroke-dashoffset`, one delay per hop),
 * so it needs no script, starts at first paint and `prefers-reduced-motion`
 * simply shows it finished.
 */
import { zoomForGlobeRadius } from "@/features/map/geo-utils";
import {
	arcAngle,
	arcPoints,
	graticule,
	liftAt,
	type Projector,
	pathOf,
	projector,
} from "@/features/overview/globe/projection";
import { ROUTE_NEUTRAL } from "@/features/overview/lib/trip-route";
import type { LngLat } from "@/lib/engine/geo";
import { countryOf, DEMO_STAYS, type DemoStay } from "../demo-route";

/** The viewBox (a square; the page scales it). */
export const SIZE = 1000;
/**
 * Where the camera looks: east of the route, so the route sits left of the
 * planet's centre and the planet can run off the page on the right.
 */
export const CENTER: LngLat = [133, 21];
/** The sphere's radius at the centre's scale (viewBox units). */
export const RADIUS = 960;
/** The planet's centre moves this far from the box's (it overflows the box). */
export const OFFSET = { x: 170, y: 90 } as const;
/** The land layer's box: the disc overflows the viewBox, so it's bigger. */
export const LAND_BOX = { x: -200, y: -200, size: SIZE + 400 } as const;
/** How long the route takes to draw, and when it starts (ms). */
export const DRAW_MS = 3400;
export const DRAW_DELAY_MS = 350;

/** Flights are a light neutral, as on the Overview. */
const FLIGHT_INK = "#eeeeee";

export function sceneProjector(): Projector {
	return projector({
		center: CENTER,
		zoom: zoomForGlobeRadius(RADIUS, CENTER[1]),
		width: SIZE,
		height: SIZE,
	});
}

/**
 * The camera as a vertical-perspective projection: the eye's distance from
 * the globe's centre in radii (`P`) and the horizon's angle from the centre.
 * `scripts/landing/globe.ts` feeds them to d3-geo for the land layer.
 */
export function scenePerspective(proj: Projector = sceneProjector()): {
	P: number;
	horizonDeg: number;
} {
	// silhouette = R·√(D/(D+2R)) and P = (D+R)/R  ⇒  P = (1+s²)/(1−s²), s = silhouette/R.
	const s2 = (proj.silhouette / proj.R) ** 2;
	const P = (1 + s2) / (1 - s2);
	return { P, horizonDeg: (Math.acos(1 / P) * 180) / Math.PI };
}

export interface SceneHop {
	key: string;
	d: string;
	color: string;
	flight: boolean;
	/** Draw window on the 0–1 timeline. */
	s: number;
	e: number;
}

export interface SceneDot {
	id: string;
	name: string;
	x: number;
	y: number;
	r: number;
	color: string;
	at: number;
	label: DemoStay["label"];
	minor: boolean;
}

export interface Scene {
	/** The planet's centre in the camera's frame (add `OFFSET` for the box). */
	cx: number;
	cy: number;
	/** The visible disc's radius. */
	silhouette: number;
	graticule: string;
	hops: SceneHop[];
	dots: SceneDot[];
}

/** City dots grow with the nights, as on the Overview globe. */
export const dotRadius = (nights: number) =>
	nights <= 1 ? 5.5 : nights <= 3 ? 7 : nights <= 6 ? 8.5 : 10;

const round = (d: string) =>
	d.replace(/\d+\.\d+/g, (n) => Number(n).toFixed(1));

type Leg = {
	from: LngLat;
	to: LngLat;
	flight: boolean;
	color: string;
	key: string;
};

function legs(): Leg[] {
	const out: Leg[] = [];
	DEMO_STAYS.forEach((s, i) => {
		const prev = DEMO_STAYS[i - 1];
		if (!prev) return;
		const flight = s.modeIn === "flight";
		out.push({
			from: prev.at,
			to: s.at,
			flight,
			color: flight ? FLIGHT_INK : countryOf(s.country).color,
			key: `${prev.id}>${s.id}`,
		});
	});
	return out;
}

export function buildScene(proj: Projector = sceneProjector()): Scene {
	const raw = legs();
	// Each hop's share of the timeline: longer hops take a little longer
	// (the Overview's weighting).
	const weight = raw.map(
		(l) => 1 + Math.sqrt((arcAngle(l.from, l.to) * 6371) / 600),
	);
	const total = weight.reduce((a, b) => a + b, 0);
	let acc = 0;
	const hops: SceneHop[] = [];
	for (const [i, l] of raw.entries()) {
		const s = acc / total;
		acc += weight[i] ?? 1;
		const angle = arcAngle(l.from, l.to);
		const d = pathOf(
			arcPoints(l.from, l.to),
			proj,
			l.flight ? (t) => liftAt(t, angle) : null,
		);
		if (!d) continue;
		hops.push({
			key: l.key,
			d: round(d),
			color: l.color,
			flight: l.flight,
			s,
			e: acc / total,
		});
	}
	const dots: SceneDot[] = DEMO_STAYS.map((s, i) => {
		const q = proj.project(s.at);
		const hop = hops.find((h) => h.key.endsWith(`>${s.id}`));
		return {
			id: s.id,
			name: s.name,
			x: Math.round(q.x * 10) / 10,
			y: Math.round(q.y * 10) / 10,
			r: dotRadius(s.nights),
			color: countryOf(s.country).color ?? ROUTE_NEUTRAL,
			at: hop ? hop.e : i / DEMO_STAYS.length,
			label: s.label,
			minor: !!s.minor,
		};
	});
	return {
		cx: proj.cx,
		cy: proj.cy,
		silhouette: proj.silhouette,
		graticule: round(graticule(proj)),
		hops,
		dots,
	};
}
