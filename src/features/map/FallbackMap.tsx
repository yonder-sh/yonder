/**
 * The no-WebGL2 fallback (SPEC §18.3): the same pins and edges as the real map
 * (`buildPins`/`buildEdges`), drawn as an SVG sketch on a plain projection.
 * Pins are buttons (select, double-click zooms in), edges are styled by mode
 * and clickable at their midpoint. It also renders in component tests, where
 * there is no WebGL.
 */
import { cn } from "cn";
import { useEffect, useMemo, useRef } from "react";
import { EditGuard } from "@/components/common/edit-guard";
import { Button } from "@/components/ui/button";
import { pinStyle } from "@/lib/domain/taxonomy";
import { TESTID } from "@/lib/testids";
import { registerMapProjector } from "@/lib/workspace/map-projector";
import { useUi } from "@/lib/workspace/ui-store";
import { useWorkspace } from "@/lib/workspace/use-workspace";
import { pinMatcher } from "./filter-match";
import {
	buildEdges,
	buildPins,
	type EdgeStyle,
	type MapDataOptions,
} from "./map-data";
import { LINES } from "./palette";
import { MAP_TESTID } from "./testids";
import { DEFAULT_SHOW, useMapTheme, useSharedFilter } from "./use-map-state";

type XY = { x: number; y: number };

function projector(points: { lat: number; lng: number }[]) {
	const lngs = points.map((p) => p.lng);
	const lats = points.map((p) => p.lat);
	let [minX, maxX] = [Math.min(...lngs), Math.max(...lngs)];
	let [minY, maxY] = [Math.min(...lats), Math.max(...lats)];
	const pad = (a: number, b: number) => Math.max((b - a) * 0.15, 0.01);
	const px = pad(minX, maxX);
	const py = pad(minY, maxY);
	minX -= px;
	maxX += px;
	minY -= py;
	maxY += py;
	const project = (lat: number, lng: number): XY => ({
		x: (lng - minX) / (maxX - minX || 1),
		y: 1 - (lat - minY) / (maxY - minY || 1),
	});
	/** The inverse (FB-17 live cursors travel as lng/lat): fractions → lng/lat. */
	project.invert = (x: number, y: number) => ({
		lng: minX + x * (maxX - minX || 1),
		lat: minY + (1 - y) * (maxY - minY || 1),
	});
	return project;
}

const DASH: Record<EdgeStyle, string | undefined> = {
	walk: "0.5 5",
	transit: undefined,
	flight: "6 4",
	other: "10 4",
	unset: "2 6",
	stay: "2 4",
	overnight: "3 6",
};

export function FallbackMap({ variant }: { variant: "desktop" | "mobile" }) {
	const { model, ix, sel, nav, scope, lens, days, who, access, proposals } =
		useWorkspace();
	const openAddPlace = useUi((s) => s.openAddPlace);
	const dayMode = useUi((s) => s.dayFilterMode);
	const [filter] = useSharedFilter();
	const theme = useMapTheme();
	const opts = useMemo<MapDataOptions>(
		() => ({
			theme,
			palette: LINES[theme],
			lens,
			scopeId: scope?.id ?? null,
			days,
			dayMode,
			who,
			show: DEFAULT_SHOW,
			matches: pinMatcher(filter, { ix, meMemberId: access.memberId }),
			marks: proposals.marks,
		}),
		[
			theme,
			lens,
			scope,
			days,
			dayMode,
			who,
			filter,
			ix,
			access.memberId,
			proposals.marks,
		],
	);
	const pins = useMemo(() => buildPins(model, ix, opts), [model, ix, opts]);
	const edges = useMemo(
		() => buildEdges(model, ix, pins, opts),
		[model, ix, pins, opts],
	);
	const project = useMemo(() => (pins.length ? projector(pins) : null), [pins]);
	// FB-17: live cursors over the sketch travel as lng/lat, like on the real map.
	const outerRef = useRef<HTMLDivElement>(null);
	const boxRef = useRef<HTMLDivElement>(null);
	useEffect(() => {
		const outer = outerRef.current;
		const box = boxRef.current;
		if (!project || !outer || !box) return;
		return registerMapProjector({
			container: outer,
			unproject(x, y) {
				const r = box.getBoundingClientRect();
				if (r.width < 1 || r.height < 1) return null;
				return project.invert((x - r.left) / r.width, (y - r.top) / r.height);
			},
			project(lng, lat) {
				const r = box.getBoundingClientRect();
				const p = project(lat, lng);
				return { x: r.left + p.x * r.width, y: r.top + p.y * r.height };
			},
			easeTo() {
				// The sketch shows the whole scope: nothing to pan.
			},
		});
	}, [project]);

	if (!project) {
		return (
			<div
				data-testid={MAP_TESTID.fallback}
				className="flex size-full items-center justify-center"
			>
				<div
					className="grid justify-items-center gap-3"
					data-testid={MAP_TESTID.empty}
				>
					<p className="text-sm text-muted-foreground">
						Nothing on the map here yet.
					</p>
					<EditGuard>
						<Button
							size="sm"
							variant="outline"
							onClick={() => openAddPlace({ mode: "search" })}
						>
							Add a place
						</Button>
					</EditGuard>
				</div>
			</div>
		);
	}

	const selRep = sel?.kind === "node" ? sel.id : null;
	const pad =
		variant === "mobile"
			? { top: 150, right: 40, bottom: 170, left: 40 }
			: { top: 48, right: 64, bottom: 48, left: 48 };
	const xy = (c: number[]) => project(c[1] ?? 0, c[0] ?? 0);
	return (
		<div
			ref={outerRef}
			data-testid={MAP_TESTID.fallback}
			className="relative size-full"
			style={{
				backgroundImage:
					"linear-gradient(color-mix(in oklab, var(--border) 55%, transparent) 1px, transparent 1px), linear-gradient(90deg, color-mix(in oklab, var(--border) 55%, transparent) 1px, transparent 1px)",
				backgroundSize: "64px 64px",
			}}
		>
			<div ref={boxRef} className="absolute" style={pad}>
				<svg
					className="absolute inset-0 size-full overflow-visible"
					aria-hidden="true"
				>
					{edges.features.map((f) => {
						const pts = f.geometry.coordinates.map(xy);
						const d = pts
							.map(
								(p, i) =>
									`${i ? "L" : "M"}${(p.x * 100).toFixed(3)} ${(p.y * 100).toFixed(3)}`,
							)
							.join(" ");
						const s = f.properties.style;
						return (
							<g
								key={f.properties.fid}
								opacity={f.properties.o * (f.properties.approx ? 0.6 : 1)}
							>
								<svg
									aria-hidden="true"
									viewBox="0 0 100 100"
									preserveAspectRatio="none"
									className="overflow-visible"
									width="100%"
									height="100%"
								>
									<path
										d={d}
										fill="none"
										stroke="var(--map-casing)"
										strokeWidth={6}
										strokeLinecap="round"
										vectorEffect="non-scaling-stroke"
									/>
									<path
										data-testid={TESTID.edge}
										d={d}
										fill="none"
										stroke={f.properties.color}
										strokeWidth={s === "transit" ? 4 : 2.5}
										strokeDasharray={
											f.properties.est && s === "transit" ? "6 4" : DASH[s]
										}
										strokeLinecap="round"
										vectorEffect="non-scaling-stroke"
									/>
								</svg>
							</g>
						);
					})}
				</svg>
				{edges.features.map((f) => {
					const c = f.geometry.coordinates;
					const mid = c[Math.floor(c.length / 2)] ?? c[0];
					if (!mid) return null;
					const p = xy(mid);
					return (
						<button
							key={`hit-${f.properties.fid}`}
							type="button"
							aria-label={`${ix.node(f.properties.from)?.name ?? "?"} to ${ix.node(f.properties.to)?.name ?? "?"}`}
							onClick={() => {
								const [k, a = "", b = ""] = f.properties.sel.split(".");
								if (k === "e") nav.select({ kind: "edge", from: a, to: b });
								else if (k === "l")
									nav.select({
										kind: "leg",
										target: { kind: "pair", fromItemId: a, toItemId: b },
									});
								else if (k === "s")
									nav.select({
										kind: "leg",
										target: {
											kind: "stay",
											dayId: a,
											end: b as "start" | "end",
										},
									});
							}}
							className="absolute size-5 -translate-x-1/2 -translate-y-1/2 rounded-full"
							style={{ left: `${p.x * 100}%`, top: `${p.y * 100}%` }}
						/>
					);
				})}
				{pins.map((p) => {
					const pos = project(p.lat, p.lng);
					const node = ix.node(p.repId);
					if (!node) return null;
					const style = pinStyle(node);
					const selected = selRep === p.repId;
					return (
						<button
							key={p.repId}
							type="button"
							data-testid={TESTID.pin}
							data-rep-id={p.repId}
							data-hollow={p.hollow || undefined}
							aria-label={p.ariaLabel}
							onClick={() => nav.select({ kind: "node", id: p.repId })}
							onDoubleClick={() => nav.zoomIn(p.repId)}
							className={cn(
								"group absolute z-10 flex -translate-x-1/2 -translate-y-1/2 flex-col items-center",
								selected && "z-20",
							)}
							style={{
								left: `${pos.x * 100}%`,
								top: `${pos.y * 100}%`,
								opacity: p.opacity,
							}}
						>
							<span
								className={cn(
									"flex items-center justify-center rounded-full border-2 border-[var(--map-casing)] font-mono text-[11px] font-semibold shadow-sm transition-transform group-hover:scale-110",
									p.hollow && "border-dashed bg-background!",
									p.repMode === "coarser" && "border-dashed",
									selected &&
										"ring-2 ring-primary ring-offset-2 ring-offset-[var(--map-casing)]",
								)}
								style={{
									width: p.size,
									height: p.size,
									backgroundColor: style.fill,
									color: p.hollow ? style.fill : style.ink,
								}}
							>
								{p.number ?? ""}
							</span>
							<span className="mt-1 max-w-32 truncate rounded bg-background/85 px-1 text-[11px] leading-4 font-medium text-foreground shadow-sm">
								{node.name}
							</span>
						</button>
					);
				})}
			</div>
			<p className="pointer-events-none absolute bottom-2 left-3 text-[10px] text-muted-foreground">
				Simplified map · this browser can't draw the full map (WebGL2)
			</p>
		</div>
	);
}
