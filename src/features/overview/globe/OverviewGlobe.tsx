/**
 * The Overview's cinematic globe (docs/OVERVIEW.md §1): the whole route in
 * trip order on MapLibre's globe. Flights are lifted great-circle arcs in a
 * light neutral, ground legs lines in the destination country's colour, city
 * dots glow and grow with the nights, and at most two labels per country
 * never collide (`declutterLabels`).
 *
 * - On open the route draws itself in trip order (~3 s) while the camera
 *   sweeps from the start to the whole-route view; `prefers-reduced-motion`
 *   shows the finished route.
 * - During the trip a pulsing "you are here"; travelled legs are bright,
 *   the ones still to come dim.
 * - `focus` (a stay hovered on the route strip) turns the globe to it.
 *
 * The route is an SVG over the map, projected with the map's own camera
 * (`projection.ts`); without WebGL2 the same SVG draws the sphere too.
 */
import type { Map as MaplibreMap } from "maplibre-gl";
import {
	lazy,
	Suspense,
	useCallback,
	useEffect,
	useLayoutEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import {
	globeCamera,
	sphericalCap,
	zoomForGlobeRadius,
} from "@/features/map/geo-utils";
import type { LngLat } from "@/lib/engine/geo";
import {
	ROUTE_NEUTRAL,
	type RoutePlace,
	type TripRoute,
} from "../lib/trip-route";
import { OVERVIEW_TESTID } from "../testids";
import { declutterLabels, type LabelCandidate } from "./labels";
import {
	arcAngle,
	arcPoints,
	easeInOut,
	type GlobeCam,
	graticule,
	liftAt,
	pathOf,
	projector,
	slerp,
} from "./projection";

const GlobeMap = lazy(() => import("./GlobeMap"));

export type View = { center: LngLat; zoom: number };

const DRAW_MS = 3000;
const FLY_MS = 700;
const FLIGHT_INK = "#eeeeee";

/** `true`/`false` once checked on the client (as the workspace map does). */
function useWebGL2(): boolean | null {
	const [ok, setOk] = useState<boolean | null>(null);
	useEffect(() => {
		let result = false;
		try {
			result = !!document.createElement("canvas").getContext("webgl2");
		} catch {
			result = false;
		}
		setOk(result);
	}, []);
	return ok;
}

const reducedMotion = () =>
	typeof window !== "undefined" &&
	!!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
const finePointer = () =>
	typeof window !== "undefined" &&
	!!window.matchMedia?.("(pointer: fine)").matches;

// ---- text widths (labels) ---------------------------------------------------
let ctx: CanvasRenderingContext2D | null | undefined;
const widths = new Map<string, number>();
function textWidth(text: string, px: number): number {
	const key = `${px}|${text}`;
	const hit = widths.get(key);
	if (hit !== undefined) return hit;
	if (ctx === undefined) {
		try {
			ctx = document.createElement("canvas").getContext("2d");
		} catch {
			ctx = null;
		}
	}
	let w = text.length * px * 0.58;
	if (ctx) {
		ctx.font = `600 ${px}px "Commissioner Variable", system-ui, sans-serif`;
		const m = ctx.measureText(text).width;
		if (m > 0) w = m;
	}
	widths.set(key, w);
	return w;
}

// ---- the route, prepared once ---------------------------------------------

interface Hop {
	pts: { p: LngLat; t: number }[];
	flight: boolean;
	color: string;
	angle: number;
	/** Draw window on the 0–1 timeline. */
	s: number;
	e: number;
	date: string;
	toId: string;
	/** Stable per hop (React key). */
	key: string;
}

interface Dot {
	id: string;
	name: string;
	coord: LngLat;
	nights: number;
	color: string;
	countryKey: string;
	/** Drawn once the timeline passes it. */
	at: number;
	/** Its first stay (the strip's index), or -1. */
	stay: number;
}

function prepare(route: TripRoute): { hops: Hop[]; dots: Dot[] } {
	const raw = route.hops.filter((h) => h.from.coord && h.to.coord);
	const weight = raw.map(
		(h) =>
			1 +
			Math.sqrt(
				(arcAngle(h.from.coord as LngLat, h.to.coord as LngLat) * 6371) / 600,
			),
	);
	const total = weight.reduce((a, b) => a + b, 0) || 1;
	let acc = 0;
	const seen = new Map<string, number>();
	const hops: Hop[] = raw.map((h, i) => {
		const base = `${h.from.id}>${h.to.id}@${h.date}`;
		const n = seen.get(base) ?? 0;
		seen.set(base, n + 1);
		const a = h.from.coord as LngLat;
		const b = h.to.coord as LngLat;
		const s = acc / total;
		acc += weight[i] ?? 1;
		const flight = h.mode === "flight";
		return {
			pts: arcPoints(a, b),
			flight,
			color: flight
				? FLIGHT_INK
				: (route.colors[h.to.countryKey] ?? ROUTE_NEUTRAL),
			angle: arcAngle(a, b),
			s,
			e: acc / total,
			date: h.date,
			toId: h.to.id,
			key: `${base}#${n}`,
		};
	});
	const nights = new Map<string, number>();
	const stayOf = new Map<string, number>();
	route.stays.forEach((s, i) => {
		nights.set(s.id, (nights.get(s.id) ?? 0) + s.nights + s.transitNights);
		if (!stayOf.has(s.id)) stayOf.set(s.id, i);
	});
	const dots = new Map<string, Dot>();
	const add = (p: RoutePlace, at: number) => {
		if (!p.coord || dots.has(p.id)) return;
		const n = nights.get(p.id) ?? 0;
		dots.set(p.id, {
			id: p.id,
			name: p.name,
			coord: p.coord,
			nights: n,
			color: route.colors[p.countryKey] ?? ROUTE_NEUTRAL,
			countryKey: p.countryKey,
			at,
			stay: stayOf.get(p.id) ?? -1,
		});
	};
	if (raw[0]) add(raw[0].from, 0);
	for (const [i, h] of raw.entries()) add(h.to, hops[i]?.e ?? 1);
	// Stays the hops never reach (no located items around them).
	for (const s of route.stays) add(s, 1);
	return { hops, dots: [...dots.values()] };
}

const dotRadius = (nights: number) =>
	nights <= 0
		? 2.6
		: nights === 1
			? 3.6
			: nights <= 3
				? 4.6
				: nights <= 6
					? 5.6
					: 6.6;

// ---- the camera ----------------------------------------------------------------

/** How far from the stays the trip's start and end still count (the same side of the planet). */
const SAME_SIDE_DEG = 70;

/** The whole-route view for a `w × h` hero. */
export function finalView(
	route: TripRoute,
	fallback: LngLat[],
	w: number,
	h: number,
): View {
	const stays = route.stays.flatMap((s) => (s.coord ? [s.coord] : []));
	// The stops around the stays count too (a day trip, the airport city),
	// but not the long-haul ends (home may be over the horizon).
	const core = sphericalCap(stays);
	const near = route.hops.flatMap((h) =>
		[h.from.coord, h.to.coord].filter(
			(p): p is LngLat =>
				!!p &&
				(!core ||
					(arcAngle(p, core.center) * 180) / Math.PI < core.radius + 25),
		),
	);
	// Where the trip starts and ends (home) counts when it's on the stays' side
	// of the planet (Philadelphia for San Francisco), never over the horizon
	// (New York for Tokyo).
	const ends = [route.start?.coord, route.end?.coord].filter(
		(p): p is LngLat =>
			!!p &&
			(!core || (arcAngle(p, core.center) * 180) / Math.PI < SAME_SIDE_DEG),
	);
	const pts = [...stays, ...near, ...ends];
	const all = pts.length ? pts : fallback;
	const cap = sphericalCap(all);
	const pad = Math.max(24, Math.min(w, h) * 0.08);
	// A regional trip shows the planet; a trip inside one country zooms in
	// (a single city still shows its region, not a street map).
	const scale =
		cap && cap.radius < 12 ? 0.95 * (12 / Math.max(cap.radius, 4)) : 0.95;
	const cam = all.length
		? globeCamera(all, {
				width: w,
				height: h,
				pad: { top: pad, right: pad, bottom: pad, left: pad },
				maxZoom: 5.5,
				minZoom: -1.5,
				globeScale: scale,
			})
		: null;
	if (cam) return { center: cam.center, zoom: cam.zoom };
	// Spread over the world (or nothing yet): the whole planet.
	const center: LngLat =
		route.view.kind === "globe"
			? route.view.center
			: cap
				? cap.center
				: [route.view.centerLng, 20];
	const R = (Math.min(w, h) / 2) * 0.86;
	return { center, zoom: zoomForGlobeRadius(R, center[1]) };
}

const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
function between(a: View, b: View, t: number): View {
	return {
		center: slerp(a.center, b.center, t),
		zoom: lerp(a.zoom, b.zoom, t),
	};
}

// ---- the component -----------------------------------------------------------

const NO_POINTS: LngLat[] = [];

export function OverviewGlobe({
	route,
	fallbackPoints = NO_POINTS,
	today,
	hereStay,
	focus,
	className,
	interactive = true,
}: {
	route: TripRoute;
	/** Where to look without stays (the trip's countries). */
	fallbackPoints?: LngLat[];
	/** During/after the trip: legs up to this date are travelled (bright). */
	today: string | null;
	/** The stay "you are here" pulses on (during the trip). */
	hereStay: number | null;
	/** A stay to turn the globe to (the route strip's hover). */
	focus: number | null;
	className?: string;
	/** Mouse drags turn the globe (never touch: the page scrolls). */
	interactive?: boolean;
}) {
	const box = useRef<HTMLDivElement>(null);
	const [size, setSize] = useState<{ w: number; h: number } | null>(null);
	useLayoutEffect(() => {
		const el = box.current;
		if (!el) return;
		const measure = () => {
			const r = el.getBoundingClientRect();
			if (r.width > 0 && r.height > 0)
				setSize((s) =>
					s && Math.abs(s.w - r.width) < 1 && Math.abs(s.h - r.height) < 1
						? s
						: { w: r.width, h: r.height },
				);
		};
		measure();
		const ro = new ResizeObserver(measure);
		ro.observe(el);
		return () => ro.disconnect();
	}, []);

	const webgl = useWebGL2();
	const { hops, dots } = useMemo(() => prepare(route), [route]);
	const final = useMemo(
		() => (size ? finalView(route, fallbackPoints, size.w, size.h) : null),
		[route, fallbackPoints, size],
	);

	const [view, setView] = useState<View | null>(null);
	const [drawn, setDrawn] = useState(0);
	const mapRef = useRef<MaplibreMap | null>(null);
	const anim = useRef<number | null>(null);
	const viewRef = useRef<View | null>(null);
	viewRef.current = view;

	const apply = useCallback((v: View) => {
		setView(v);
		const m = mapRef.current;
		if (m) m.jumpTo({ center: v.center, zoom: v.zoom });
	}, []);
	const stop = useCallback(() => {
		if (anim.current !== null) cancelAnimationFrame(anim.current);
		anim.current = null;
	}, []);
	/** Tween the camera to `to` (and the drawing to `drawTo`) over `ms`. */
	const tween = useCallback(
		(from: View, to: View, ms: number, draw?: [number, number]) => {
			stop();
			if (ms <= 0 || reducedMotion()) {
				apply(to);
				if (draw) setDrawn(draw[1]);
				return;
			}
			const t0 = performance.now();
			const step = (t: number) => {
				const k = Math.min(1, (t - t0) / ms);
				apply(between(from, to, easeInOut(k)));
				if (draw) setDrawn(lerp(draw[0], draw[1], k));
				anim.current = k < 1 ? requestAnimationFrame(step) : null;
			};
			anim.current = requestAnimationFrame(step);
		},
		[apply, stop],
	);

	// The intro, once: draw the route while sweeping in from the start. Later
	// changes (a resize, someone's edit) just reframe.
	const played = useRef(false);
	const focusRef = useRef(focus);
	focusRef.current = focus;
	useEffect(() => {
		if (!final) return;
		if (played.current) {
			if (anim.current === null && focusRef.current === null) apply(final);
			return;
		}
		played.current = true;
		const start = hops[0]?.pts[0]?.p;
		if (!start || reducedMotion()) {
			apply(final);
			setDrawn(1);
			return;
		}
		const from: View = { center: start, zoom: final.zoom + 0.6 };
		apply(from);
		setDrawn(0);
		tween(from, final, DRAW_MS, [0, 1]);
	}, [final, hops, apply, tween]);

	// The strip's hover turns the globe there, and back when it leaves.
	const focused = useRef<number | null>(null);
	useEffect(() => {
		if (!final || focused.current === focus) return;
		focused.current = focus;
		const stay = focus !== null ? route.stays[focus] : undefined;
		const cur = viewRef.current ?? final;
		setDrawn(1);
		if (stay?.coord)
			tween(
				cur,
				{ center: stay.coord, zoom: Math.min(5.5, final.zoom + 1.1) },
				FLY_MS,
			);
		else tween(cur, final, FLY_MS);
	}, [focus, final, route, tween]);

	useEffect(() => stop, [stop]);

	const [mapReady, setMapReady] = useState(false);
	const onMap = useCallback((m: MaplibreMap | null) => {
		mapRef.current = m;
		setMapReady(!!m);
		const v = viewRef.current;
		if (m && v) m.jumpTo({ center: v.center, zoom: v.zoom });
	}, []);
	const onCamera = useCallback((v: View) => {
		const cur = viewRef.current;
		if (
			cur &&
			Math.abs(cur.zoom - v.zoom) < 1e-6 &&
			Math.abs(cur.center[0] - v.center[0]) < 1e-7 &&
			Math.abs(cur.center[1] - v.center[1]) < 1e-7
		)
			return;
		setView(v);
	}, []);

	const cam: GlobeCam | null =
		size && view ? { ...view, width: size.w, height: size.h } : null;

	return (
		<div
			ref={box}
			data-testid={OVERVIEW_TESTID.globe}
			data-drawn={drawn >= 1 ? "done" : "drawing"}
			data-map={mapReady ? "maplibre" : webgl === false ? "svg" : "loading"}
			className={className}
			style={{
				position: "relative",
				overflow: "hidden",
				// Space is the band's own (its glow shows round the planet).
				background: "transparent",
			}}
		>
			{webgl && view ? (
				<Suspense fallback={null}>
					<GlobeMap
						view={view}
						drag={interactive && finePointer()}
						onMap={onMap}
						onCamera={onCamera}
						onUserMove={stop}
					/>
				</Suspense>
			) : null}
			{cam ? (
				<RouteLayer
					cam={cam}
					hops={hops}
					dots={dots}
					drawn={drawn}
					today={today}
					here={hereStay}
					focus={focus}
					sphere={!mapReady}
				/>
			) : null}
		</div>
	);
}

// ---- the SVG route ---------------------------------------------------------

function RouteLayer({
	cam,
	hops,
	dots,
	drawn,
	today,
	here,
	focus,
	sphere,
}: {
	cam: GlobeCam;
	hops: Hop[];
	dots: Dot[];
	drawn: number;
	today: string | null;
	here: number | null;
	focus: number | null;
	/** Draw the planet too (no WebGL). */
	sphere: boolean;
}) {
	const proj = projector(cam);
	const grat = graticule(proj);
	const visibleDots = dots
		.filter((d) => d.at <= drawn + 1e-6)
		.map((d) => ({ d, q: proj.project(d.coord) }))
		.filter(({ q }) => q.visible);
	const done = drawn >= 1;
	const cands: LabelCandidate[] = visibleDots
		.filter(({ d }) => d.nights > 0)
		.map(({ d, q }) => {
			const px = d.nights >= 3 ? 13 : 11.5;
			return {
				id: d.id,
				x: q.x,
				y: q.y,
				r: dotRadius(d.nights) + 2,
				w: textWidth(d.name, px) + 2,
				h: px + 3,
				priority: d.nights + (d.stay === focus ? 100 : 0),
				group: d.countryKey,
			};
		});
	const labels = declutterLabels(cands, {
		width: cam.width,
		height: cam.height,
		dots: visibleDots.map(({ d, q }) => ({
			x: q.x,
			y: q.y,
			r: dotRadius(d.nights) + 1,
		})),
	});
	const byId = new Map(visibleDots.map((v) => [v.d.id, v]));
	const hereDot = here !== null ? dots.find((d) => d.stay === here) : undefined;
	const hereQ = hereDot ? proj.project(hereDot.coord) : null;
	const focusDot =
		focus !== null ? dots.find((d) => d.stay === focus) : undefined;
	const focusQ = focusDot ? proj.project(focusDot.coord) : null;
	return (
		<svg
			width={cam.width}
			height={cam.height}
			aria-hidden="true"
			style={{
				position: "absolute",
				inset: 0,
				pointerEvents: "none",
				overflow: "visible",
			}}
		>
			<defs>
				<radialGradient id="ov-sphere" cx="38%" cy="32%" r="75%">
					<stop offset="0%" stopColor="#1d2632" />
					<stop offset="55%" stopColor="#0f141b" />
					<stop offset="100%" stopColor="#07090c" />
				</radialGradient>
			</defs>
			{sphere ? (
				<circle
					cx={proj.cx}
					cy={proj.cy}
					r={proj.silhouette}
					fill="url(#ov-sphere)"
					stroke="#1f2937"
				/>
			) : null}
			<path
				d={grat}
				fill="none"
				stroke="#ffffff"
				strokeOpacity={0.06}
				strokeWidth={1}
			/>
			{hops.map((h) => {
				const f = h.e > h.s ? (drawn - h.s) / (h.e - h.s) : 1;
				if (f <= 0) return null;
				const lift = h.flight ? (t: number) => liftAt(t, h.angle) : null;
				const d = pathOf(h.pts, proj, lift, Math.min(1, f));
				if (!d) return null;
				const ahead = today !== null && h.date > today;
				return (
					<g key={h.key} opacity={ahead ? 0.3 : 1}>
						<path
							d={d}
							fill="none"
							stroke={h.color}
							strokeOpacity={0.16}
							strokeWidth={h.flight ? 6 : 8}
							strokeLinecap="round"
							strokeLinejoin="round"
						/>
						<path
							d={d}
							fill="none"
							stroke={h.color}
							strokeOpacity={h.flight ? 0.85 : 1}
							strokeWidth={h.flight ? 1.5 : 2.6}
							strokeLinecap="round"
							strokeLinejoin="round"
						/>
					</g>
				);
			})}
			{visibleDots.map(({ d, q }) => {
				const r = dotRadius(d.nights);
				return (
					<g key={d.id}>
						<circle
							cx={q.x}
							cy={q.y}
							r={r * 2.4}
							fill={d.color}
							opacity={0.18}
						/>
						<circle cx={q.x} cy={q.y} r={r} fill={d.color} />
					</g>
				);
			})}
			{focusQ?.visible ? (
				<circle
					cx={focusQ.x}
					cy={focusQ.y}
					r={11}
					fill="none"
					stroke="#ffffff"
					strokeWidth={1.5}
				/>
			) : null}
			{hereQ?.visible && done ? (
				<g data-testid={OVERVIEW_TESTID.here}>
					<circle
						className="overview-pulse"
						cx={hereQ.x}
						cy={hereQ.y}
						r={9}
						fill="none"
						stroke="#ffffff"
						strokeWidth={2}
					/>
					<circle cx={hereQ.x} cy={hereQ.y} r={5} fill="#ffffff" />
				</g>
			) : null}
			{labels.map((l) => {
				const v = byId.get(l.id);
				if (!v) return null;
				const px = v.d.nights >= 3 ? 13 : 11.5;
				return (
					<text
						key={l.id}
						x={l.x}
						y={l.y + px}
						fontSize={px}
						fontWeight={600}
						fill="#f5f5f5"
						stroke="#040507"
						strokeWidth={3}
						strokeOpacity={0.8}
						paintOrder="stroke"
						style={{ fontFamily: "var(--font-sans)" }}
					>
						{v.d.name}
					</text>
				);
			})}
		</svg>
	);
}
