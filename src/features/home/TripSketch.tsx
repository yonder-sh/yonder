/**
 * The trip's RouteSketch (DESIGN §10.3 hero and card covers): the land of
 * world-atlas 110m through d3-geo, fitted to the trip's city-level route
 * points (`MyTrip.routePoints`, `[lng, lat]` in trip order) with 24px of
 * padding, a dashed dusk route through the stops and, on the hero only, one
 * apricot point on the first stop ("next"; DESIGN §1.2: glow once per region).
 *
 * The atlas is lazily imported on the client after mount and memoised, so
 * neither the SSR HTML nor the dashboard bundle carries it; until then (and
 * for trips with no located cities) a quiet deterministic sketch shows.
 * Decorative: `aria-hidden`.
 */
import { cn } from "cn";
import type { GeoPermissibleObjects } from "d3-geo";
import { useEffect, useMemo, useState } from "react";
import { COUNTRY_VIEWS } from "@/data/countries";

const W = 400;
const H = 300;
const PAD = 24;

type Atlas = {
	land: GeoPermissibleObjects;
	borders: GeoPermissibleObjects;
};
let atlasPromise: Promise<Atlas> | null = null;

/** world-atlas countries-110m → land + interior borders (one lazy chunk, loaded once). */
function loadAtlas(): Promise<Atlas> {
	atlasPromise ??= Promise.all([
		import("topojson-client"),
		import("world-atlas/countries-110m.json"),
	]).then(([{ feature, mesh }, atlas]) => {
		// biome-ignore lint/suspicious/noExplicitAny: world-atlas ships untyped TopoJSON
		const topo = (atlas as any).default ?? atlas;
		return {
			land: feature(topo, topo.objects.land) as GeoPermissibleObjects,
			borders: mesh(
				topo,
				topo.objects.countries,
				(a: unknown, b: unknown) => a !== b,
			) as GeoPermissibleObjects,
		};
	});
	return atlasPromise;
}

type Drawn = {
	land: string;
	borders: string;
	stops: [number, number][];
	route: string;
};

/** Gentle alternating arcs between consecutive stops. */
function arcs(points: [number, number][]): string {
	let d = "";
	for (let i = 0; i < points.length - 1; i++) {
		const [x0, y0] = points[i] as [number, number];
		const [x1, y1] = points[i + 1] as [number, number];
		const dx = x1 - x0;
		const dy = y1 - y0;
		const len = Math.hypot(dx, dy) || 1;
		const bend = (i % 2 === 0 ? 1 : -1) * Math.min(28, len * 0.18);
		const cx = (x0 + x1) / 2 + (-dy / len) * bend;
		const cy = (y0 + y1) / 2 + (dx / len) * bend;
		d += `${i === 0 ? `M${x0.toFixed(1)} ${y0.toFixed(1)}` : ""}Q${cx.toFixed(1)} ${cy.toFixed(1)} ${x1.toFixed(1)} ${y1.toFixed(1)}`;
	}
	return d;
}

/** A bbox of the points, widened to at least ~6° so one city isn't a street map. */
function extentOf(points: [number, number][]): GeoJSON.MultiPoint {
	const lngs = points.map((p) => p[0]);
	const lats = points.map((p) => p[1]);
	let [x0, x1] = [Math.min(...lngs), Math.max(...lngs)];
	let [y0, y1] = [Math.min(...lats), Math.max(...lats)];
	const minSpan = 6;
	if (x1 - x0 < minSpan) {
		const c = (x0 + x1) / 2;
		[x0, x1] = [c - minSpan / 2, c + minSpan / 2];
	}
	if (y1 - y0 < minSpan * 0.75) {
		const c = (y0 + y1) / 2;
		[y0, y1] = [c - (minSpan * 0.75) / 2, c + (minSpan * 0.75) / 2];
	}
	return {
		type: "MultiPoint",
		coordinates: [
			[x0, y0],
			[x1, y1],
		],
	};
}

async function draw(points: [number, number][]): Promise<Drawn> {
	const [{ geoMercator, geoPath }, atlas] = await Promise.all([
		import("d3-geo"),
		loadAtlas(),
	]);
	const midLng =
		points.reduce((s, p) => s + p[0], 0) / Math.max(points.length, 1);
	// Rotate to the trip so the antimeridian cut stays far off-screen.
	const projection = geoMercator()
		.rotate([-midLng, 0])
		.fitExtent(
			[
				[PAD + 8, PAD + 8],
				[W - PAD - 8, H - PAD - 8],
			],
			extentOf(points),
		);
	const path = geoPath(projection).digits(1);
	const stops = points
		.map((p) => projection(p))
		.filter((p): p is [number, number] => !!p);
	return {
		land: path(atlas.land) ?? "",
		borders: path(atlas.borders) ?? "",
		stops,
		route: arcs(stops),
	};
}

/** Deterministic 0..1 randoms from a seed (the placeholder sketch). */
function rand(seed: string) {
	let h = 2166136261;
	for (let i = 0; i < seed.length; i++)
		h = Math.imul(h ^ seed.charCodeAt(i), 16777619);
	return () => {
		h = Math.imul(h ^ (h >>> 15), 2246822507);
		h = Math.imul(h ^ (h >>> 13), 3266489909);
		h ^= h >>> 16;
		return (h >>> 0) / 4294967296;
	};
}

function Placeholder({ seed }: { seed: string }) {
	const r = rand(seed);
	const a = 150 + r() * 30;
	return (
		<>
			<path
				d={`M-10 ${a} C 80 ${90 + r() * 40}, 160 ${200 - r() * 40}, 260 ${120 + r() * 30} S 380 ${60 + r() * 40}, 420 ${90 + r() * 30} L 420 310 L -10 310 Z`}
				className="fill-basemap-land"
			/>
			<path
				d={`M${200 + r() * 60} -10 C ${260 + r() * 40} 40, 330 ${50 + r() * 30}, 420 ${30 + r() * 20} L 420 -10 Z`}
				className="fill-basemap-land"
			/>
		</>
	);
}

export function TripSketch({
	seed,
	points = [],
	countryCodes = [],
	glow = false,
	className,
}: {
	seed: string;
	/** `[lng, lat]` in trip order (city level). */
	points?: [number, number][];
	/** Fallback anchors when no city has coordinates. */
	countryCodes?: string[];
	/** The hero's apricot "next" point on the first stop. */
	glow?: boolean;
	className?: string;
}) {
	const pts = useMemo<[number, number][]>(() => {
		if (points.length) return points;
		return countryCodes
			.map((c) => COUNTRY_VIEWS[c])
			.filter((v): v is NonNullable<typeof v> => !!v)
			.map((v) => [v[0], v[1]]);
	}, [points, countryCodes]);
	const key = JSON.stringify(pts);
	const [drawn, setDrawn] = useState<{ key: string; d: Drawn } | null>(null);

	// Redraw only when the coordinates change (`key`), not whenever a parent
	// re-renders with an equal but new array: every dashboard re-render (a
	// card menu opening) used to re-project every sketch, which hung a
	// dashboard with a few hundred trips (found at integration).
	useEffect(() => {
		const at = JSON.parse(key) as [number, number][];
		if (!at.length) return;
		let alive = true;
		draw(at)
			.then((d) => alive && setDrawn({ key, d }))
			.catch(() => {
				// decorative: keep the placeholder
			});
		return () => {
			alive = false;
		};
	}, [key]);

	const d = drawn?.key === key ? drawn.d : null;
	const first = d?.stops[0];
	return (
		<svg
			viewBox={`0 0 ${W} ${H}`}
			preserveAspectRatio="xMidYMid slice"
			aria-hidden="true"
			data-sketch={d ? "drawn" : "placeholder"}
			className={cn("block size-full bg-basemap-water", className)}
		>
			{d ? (
				<g className="animate-in fade-in duration-500">
					<path
						d={d.land}
						className="fill-basemap-land stroke-foreground/15 dark:fill-foreground/[0.07]"
						strokeWidth="0.75"
						strokeLinejoin="round"
					/>
					<path
						d={d.borders}
						fill="none"
						className="stroke-foreground/10"
						strokeWidth="0.75"
						strokeLinejoin="round"
					/>
					{d.stops.length > 1 ? (
						<>
							<path
								d={d.route}
								fill="none"
								stroke="var(--map-casing)"
								strokeWidth="5"
								strokeLinecap="round"
							/>
							<path
								d={d.route}
								fill="none"
								className="stroke-primary"
								strokeWidth="2"
								strokeDasharray="5 5"
								strokeLinecap="round"
							/>
						</>
					) : null}
					{d.stops.map(([x, y], i) =>
						glow && i === 0 ? null : (
							<circle
								// biome-ignore lint/suspicious/noArrayIndexKey: stops repeat (Tokyo → Kyoto → Tokyo)
								key={i}
								cx={x}
								cy={y}
								r="4"
								className="fill-card stroke-primary"
								strokeWidth="2"
							/>
						),
					)}
					{glow && first ? (
						<>
							<circle
								cx={first[0]}
								cy={first[1]}
								r="11"
								fill="var(--glow)"
								opacity="0.25"
							/>
							<circle cx={first[0]} cy={first[1]} r="5.5" fill="var(--glow)" />
						</>
					) : null}
				</g>
			) : (
				<Placeholder seed={seed} />
			)}
		</svg>
	);
}
