/**
 * The hero's globe: the demo trip drawing itself across East Asia (the
 * Overview's look: a dark planet, flights as light lifted arcs, ground legs
 * and city dots in each country's colour). All SVG, rendered on the server;
 * the land is a pre-rendered layer (`/landing/globe-land.svg`) and the route
 * animates with CSS only (`landing.css`), so there's no script, no MapLibre
 * and nothing to hydrate. Reduced motion shows the finished route.
 */

import { cn } from "cn";
import type { CSSProperties } from "react";
import { HERO_GLOBE } from "./colors";
import {
	buildScene,
	DRAW_DELAY_MS,
	DRAW_MS,
	LAND_BOX,
	OFFSET,
	SIZE,
} from "./scene";

const scene = buildScene();

/** Label box offsets from the dot (viewBox units). */
const LABEL = { gap: 9, size: 25, sizeBig: 28 } as const;

const ms = (n: number) => `${Math.round(n)}ms`;

export function LandingGlobe({ className }: { className?: string }) {
	const { cx, cy, silhouette: r } = scene;
	const halo = r + 90;
	return (
		<svg
			viewBox={`0 0 ${SIZE} ${SIZE}`}
			role="img"
			aria-labelledby="landing-globe-title"
			overflow="visible"
			className={cn("landing-globe block h-auto w-full", className)}
		>
			<title id="landing-globe-title">
				A globe with an example trip drawn on it: from New York to Tokyo and
				Kyoto in Japan, Seoul and Busan in South Korea, Taipei in Taiwan, then
				Hanoi, Hội An and Saigon in Vietnam, and back to New York.
			</title>
			<defs>
				<radialGradient
					id="lg-halo"
					cx={cx}
					cy={cy}
					r={halo}
					gradientUnits="userSpaceOnUse"
				>
					<stop
						offset={r / halo}
						stopColor={HERO_GLOBE.halo}
						stopOpacity={0.32}
					/>
					<stop
						offset={(r + 22) / halo}
						stopColor={HERO_GLOBE.halo}
						stopOpacity={0.1}
					/>
					<stop offset={1} stopColor={HERO_GLOBE.halo} stopOpacity={0} />
				</radialGradient>
				<radialGradient id="lg-sea" cx="36%" cy="30%" r="78%">
					<stop offset="0%" stopColor={HERO_GLOBE.waterLit} />
					<stop offset="60%" stopColor={HERO_GLOBE.water} />
					<stop offset="100%" stopColor="#06080b" />
				</radialGradient>
				{/* The night side: the planet darkens towards its lower-right limb. */}
				<radialGradient id="lg-shade" cx="34%" cy="28%" r="82%">
					<stop offset="55%" stopColor="#000" stopOpacity={0} />
					<stop offset="100%" stopColor="#000" stopOpacity={0.55} />
				</radialGradient>
				<clipPath id="lg-disc">
					<circle cx={cx} cy={cy} r={r} />
				</clipPath>
			</defs>
			<g transform={`translate(${OFFSET.x} ${OFFSET.y})`}>
				<circle cx={cx} cy={cy} r={halo} fill="url(#lg-halo)" />
				<circle cx={cx} cy={cy} r={r} fill="url(#lg-sea)" />
				<image
					href="/landing/globe-land.svg"
					x={LAND_BOX.x}
					y={LAND_BOX.y}
					width={LAND_BOX.size}
					height={LAND_BOX.size}
					clipPath="url(#lg-disc)"
				/>
				<path
					d={scene.graticule}
					fill="none"
					stroke="#ffffff"
					strokeOpacity={0.055}
					strokeWidth={1.2}
				/>
				<circle cx={cx} cy={cy} r={r} fill="url(#lg-shade)" />
				<circle
					cx={cx}
					cy={cy}
					r={r}
					fill="none"
					stroke={HERO_GLOBE.halo}
					strokeOpacity={0.28}
					strokeWidth={1.5}
				/>
				{/* The svg is one image (its <title>): the route, dots and labels inside are drawing, not content. */}
				<g>
					{scene.hops.map((h) => {
						const style = {
							"--delay": ms(DRAW_DELAY_MS + h.s * DRAW_MS),
							"--dur": ms((h.e - h.s) * DRAW_MS),
						} as CSSProperties;
						return (
							<g key={h.key} style={style}>
								<path
									className="lg-draw"
									pathLength={1}
									d={h.d}
									fill="none"
									stroke={h.color}
									strokeOpacity={h.home ? 0.07 : 0.16}
									strokeWidth={h.flight ? 9 : 12}
									strokeLinecap="round"
									strokeLinejoin="round"
								/>
								<path
									className="lg-draw"
									pathLength={1}
									d={h.d}
									fill="none"
									stroke={h.color}
									strokeOpacity={h.home ? 0.4 : h.flight ? 0.85 : 1}
									strokeWidth={h.flight ? 2.4 : 4}
									strokeLinecap="round"
									strokeLinejoin="round"
								/>
							</g>
						);
					})}
					{scene.dots.map((d) => {
						const delay = DRAW_DELAY_MS + d.at * DRAW_MS - 80;
						return (
							<g
								key={d.id}
								className="lg-pop"
								style={{ "--delay": ms(delay) } as CSSProperties}
							>
								<circle
									cx={d.x}
									cy={d.y}
									r={d.r * 2.6}
									fill={d.color}
									opacity={0.2}
								/>
								<circle cx={d.x} cy={d.y} r={d.r} fill={d.color} />
							</g>
						);
					})}
					{scene.dots.map((d) => {
						const big = d.r >= 8;
						const size = big ? LABEL.sizeBig : LABEL.size;
						const off = d.r + LABEL.gap;
						const pos: {
							x: number;
							y: number;
							anchor: "start" | "middle" | "end";
						} =
							d.label === "right"
								? { x: d.x + off, y: d.y + size * 0.35, anchor: "start" }
								: d.label === "left"
									? { x: d.x - off, y: d.y + size * 0.35, anchor: "end" }
									: d.label === "above"
										? { x: d.x, y: d.y - off, anchor: "middle" }
										: { x: d.x, y: d.y + off + size * 0.72, anchor: "middle" };
						return (
							<text
								key={d.id}
								className={cn("lg-fade lg-label", d.minor && "lg-minor")}
								style={
									{
										"--delay": ms(DRAW_DELAY_MS + d.at * DRAW_MS + 120),
									} as CSSProperties
								}
								x={pos.x}
								y={pos.y}
								textAnchor={pos.anchor}
								fontSize={size}
								fontWeight={600}
								fill={HERO_GLOBE.label}
								stroke={HERO_GLOBE.space}
								strokeWidth={6}
								strokeOpacity={0.85}
								paintOrder="stroke"
							>
								{d.name}
							</text>
						);
					})}
				</g>
			</g>
		</svg>
	);
}
