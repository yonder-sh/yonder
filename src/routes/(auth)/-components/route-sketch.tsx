import { cn } from "cn";
import { useEffect, useState } from "react";

/**
 * Decorative map for the auth pages (DESIGN §10.1 `RouteSketch`): East Asia
 * from world-atlas 110m through d3-geo, with a dashed route that stops just
 * short of an apricot "yonder point" (the brand's idea: where you're heading,
 * just past what's planned).
 *
 * The land path is computed on the client after mount from lazily imported
 * chunks, so neither the SSR HTML nor the page's main bundle carries the atlas;
 * the sketch fades in. It is `aria-hidden`.
 */
const W = 800;
const H = 1000;
/** [lng, lat] of the stops: Tokyo, Kyoto, Seoul, Taipei, then Hanoi (yonder). */
const STOPS: [number, number][] = [
	[139.69, 35.68],
	[135.77, 35.01],
	[126.98, 37.57],
	[121.56, 25.03],
	[105.85, 21.03],
];
const BOUNDS = {
	type: "MultiPoint" as const,
	coordinates: [
		[98, 8],
		[146, 44],
	],
};

interface Sketch {
	land: string;
	route: string;
	stops: [number, number][];
}

/** Gentle arcs between stops, ending `stopShortPx` before the last one. */
function arcPath(points: [number, number][], stopShortPx: number): string {
	let d = "";
	for (let i = 0; i < points.length - 1; i++) {
		const [x0, y0] = points[i] as [number, number];
		let [x1, y1] = points[i + 1] as [number, number];
		const dx = x1 - x0;
		const dy = y1 - y0;
		const len = Math.hypot(dx, dy) || 1;
		if (i === points.length - 2) {
			// Leave the gap before the last point (never close it).
			x1 -= (dx / len) * stopShortPx;
			y1 -= (dy / len) * stopShortPx;
		}
		const bend = (i % 2 === 0 ? 1 : -1) * Math.min(60, len * 0.18);
		const cx = (x0 + x1) / 2 + (-dy / len) * bend;
		const cy = (y0 + y1) / 2 + (dx / len) * bend;
		d += `${i === 0 ? `M${x0.toFixed(1)} ${y0.toFixed(1)}` : ""}Q${cx.toFixed(1)} ${cy.toFixed(1)} ${x1.toFixed(1)} ${y1.toFixed(1)}`;
	}
	return d;
}

async function buildSketch(): Promise<Sketch> {
	const [{ geoMercator, geoPath }, { feature }, atlas] = await Promise.all([
		import("d3-geo"),
		import("topojson-client"),
		import("world-atlas/land-110m.json"),
	]);
	// biome-ignore lint/suspicious/noExplicitAny: world-atlas ships untyped TopoJSON
	const topo = (atlas as any).default ?? atlas;
	const land = feature(topo, topo.objects.land);
	// Rotated to 120°E so the antimeridian cut (which breaks Eurasia's fill)
	// falls in the Atlantic, far off-screen. The SVG viewport does the cropping.
	const projection = geoMercator()
		.rotate([-120, 0])
		.fitExtent(
			[
				[40, 120],
				[W - 40, H - 120],
			],
			BOUNDS,
		);
	const path = geoPath(projection).digits(0);
	const stops = STOPS.map((c) => projection(c) as [number, number]);
	return { land: path(land) ?? "", route: arcPath(stops, 22), stops };
}

export function RouteSketch({ className }: { className?: string }) {
	const [sketch, setSketch] = useState<Sketch | null>(null);

	useEffect(() => {
		let alive = true;
		buildSketch()
			.then((s) => alive && setSketch(s))
			.catch(() => {
				// decorative: a blank panel is fine
			});
		return () => {
			alive = false;
		};
	}, []);

	const last = sketch?.stops[sketch.stops.length - 1];

	return (
		<svg
			aria-hidden="true"
			viewBox={`0 0 ${W} ${H}`}
			preserveAspectRatio="xMidYMid slice"
			className={cn(
				"block size-full transition-opacity duration-700 ease-out motion-reduce:transition-none",
				sketch ? "opacity-100" : "opacity-0",
				className,
			)}
		>
			<defs>
				<pattern
					id="yonder-sketch-grid"
					width="40"
					height="40"
					patternUnits="userSpaceOnUse"
				>
					<path
						d="M40 0H0V40"
						fill="none"
						className="stroke-foreground/5"
						strokeWidth="1"
					/>
				</pattern>
			</defs>
			<rect width={W} height={H} fill="url(#yonder-sketch-grid)" />
			{sketch && (
				<>
					<path
						d={sketch.land}
						className="fill-background stroke-foreground/15"
						strokeWidth="1.2"
						strokeLinejoin="round"
					/>
					<path
						d={sketch.route}
						fill="none"
						className="stroke-foreground/70"
						strokeWidth="2.5"
						strokeDasharray="2 9"
						strokeLinecap="round"
					/>
					{sketch.stops.slice(0, -1).map(([x, y], i) => (
						<circle
							// biome-ignore lint/suspicious/noArrayIndexKey: fixed list
							key={i}
							cx={x}
							cy={y}
							r="7"
							className="fill-background stroke-primary"
							strokeWidth="3.5"
						/>
					))}
					{last && (
						<>
							<circle
								cx={last[0]}
								cy={last[1]}
								r="22"
								fill="var(--glow, #f8b05d)"
								opacity="0.22"
							/>
							<circle
								cx={last[0]}
								cy={last[1]}
								r="10"
								fill="var(--glow, #f8b05d)"
							/>
						</>
					)}
				</>
			)}
		</svg>
	);
}
