/**
 * The Places map (docs/PLACES.md §1): every place in the filtered set as a
 * pin coloured by its group score, hollow when it isn't on a day. A side
 * list follows the map's bounds (highest score first). Clicking a pin or a
 * row selects the place: the pin gets its name + score, the panel swaps from
 * the list to the place's details ("← All places" goes back), and the camera
 * flies to it (street level, padded clear of the panel; reduced motion
 * jumps). Back flies back to the view you had. Loaded lazily (MapLibre).
 */
import "maplibre-gl/dist/maplibre-gl.css";
import { Map as MapGL, type MapRef, Marker } from "@vis.gl/react-maplibre";
import { cn } from "cn";
import { ArrowLeft } from "lucide-react";
import type { LngLatBoundsLike } from "maplibre-gl";
import workerUrl from "maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url";
import { useReducedMotion } from "motion/react";
import {
	type CSSProperties,
	useEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import { EmptyState } from "@/components/common/empty-state";
import { PriorityDot } from "@/components/common/priority-dot";
import { Button } from "@/components/ui/button";
import { InspectorBody } from "@/features/shell/InspectorBody";
import { PRIORITIES } from "@/lib/domain/taxonomy";
import { useWorkspace } from "@/lib/workspace/use-workspace";
import { isNetworkError, useDark, useYonderStyle } from "../ui/mini-map.impl";
import type { PlaceRow } from "./model";
import { formatScore, scoreTier } from "./score";
import { PLACES_TAB_TESTID } from "./testids";
import { ScoreChip } from "./ui";
import type { PlacesData } from "./use-places";

const PANEL_W = 380;

type Bounds = { w: number; s: number; e: number; n: number };

function located(r: PlaceRow): r is PlaceRow & {
	node: PlaceRow["node"] & { lat: number; lng: number };
} {
	return r.node.lat !== null && r.node.lng !== null;
}

/** The score colour of a pin, light and dark (the tier's pill colour). */
function pinVars(score: number): CSSProperties {
	const t = PRIORITIES[scoreTier(score)];
	return { "--pin": t.light.bg, "--pin-d": t.dark.bg } as CSSProperties;
}

function Pin({
	row,
	selected,
	onPick,
}: {
	row: PlaceRow;
	selected: boolean;
	onPick: () => void;
}) {
	const hollow = row.status !== "scheduled";
	return (
		<button
			type="button"
			data-testid={PLACES_TAB_TESTID.mapPin}
			data-place={row.id}
			data-hollow={hollow || undefined}
			aria-label={`${row.name}, score ${formatScore(row.score)}`}
			aria-pressed={selected}
			onClick={(e) => {
				e.stopPropagation();
				onPick();
			}}
			style={pinVars(row.score)}
			className="group relative flex cursor-pointer items-center outline-none"
		>
			{/* A dark hairline and a soft shadow: pale tiers vanish on a light basemap. */}
			<span
				className={cn(
					"block rounded-full shadow-[0_0_0_1px_rgb(0_0_0/0.4),0_1px_3px_rgb(0_0_0/0.35)] transition-transform group-hover:scale-125 group-focus-visible:ring-2 group-focus-visible:ring-ring",
					selected ? "size-[18px]" : "size-3.5",
					hollow
						? "border-[3.5px] border-(--pin) bg-background dark:border-(--pin-d)"
						: "bg-(--pin) dark:bg-(--pin-d)",
				)}
			/>
			{selected ? (
				<span className="absolute left-6 flex items-center gap-1.5 rounded-full bg-background/95 py-0.5 pr-1 pl-2.5 text-[13px] font-semibold whitespace-nowrap shadow-float">
					{row.name}
					<ScoreChip score={row.score} size="sm" />
				</span>
			) : null}
		</button>
	);
}

function Legend() {
	const bands: [number, string][] = [
		[5, "+5 and up"],
		[3, "+3 to +4"],
		[1, "+1 to +2"],
		[0, "0"],
		[-1, "below 0"],
	];
	return (
		<div className="absolute top-3 left-3 z-10 grid gap-1.5 rounded-xl border bg-background/95 px-3 py-2.5 text-xs shadow-float">
			<span className="font-semibold">Group score</span>
			{bands.map(([s, label]) => (
				<span
					key={label}
					className="flex items-center gap-1.5"
					style={pinVars(s)}
				>
					<span className="size-3 rounded-full border-[3px] border-(--pin) shadow-[0_0_0_1px_rgb(0_0_0/0.25)] dark:border-(--pin-d)" />
					{label}
				</span>
			))}
			<span className="text-muted-foreground">Hollow = not on a day yet</span>
		</div>
	);
}

export default function PlacesMap({ data }: { data: PlacesData }) {
	const { sel, nav } = useWorkspace();
	const dark = useDark();
	const style = useYonderStyle(dark ? "dark" : "light");
	const reduce = useReducedMotion();
	const ref = useRef<MapRef>(null);
	const rows = useMemo(() => data.visible.filter(located), [data.visible]);
	const [bounds, setBounds] = useState<Bounds | null>(null);
	const selId = sel?.kind === "node" ? sel.id : null;
	const selected = selId ? data.byId.get(selId) : undefined;
	// The camera to fly back to with "← All places".
	const before = useRef<{ center: [number, number]; zoom: number } | null>(
		null,
	);

	// biome-ignore lint/correctness/useExhaustiveDependencies: framed once, on the first set (a filter change keeps the camera)
	const initial = useMemo(() => {
		if (!rows.length) return undefined;
		let w = 180;
		let s = 90;
		let e = -180;
		let n = -90;
		for (const r of rows) {
			w = Math.min(w, r.node.lng);
			e = Math.max(e, r.node.lng);
			s = Math.min(s, r.node.lat);
			n = Math.max(n, r.node.lat);
		}
		return [
			[w, s],
			[e, n],
		] as LngLatBoundsLike;
	}, [rows.length > 0]);

	// Fly to the selection (street level, clear of nothing: the panel sits beside).
	useEffect(() => {
		const map = ref.current;
		if (!map || !selected || !located(selected)) return;
		if (!before.current) {
			const c = map.getCenter();
			before.current = { center: [c.lng, c.lat], zoom: map.getZoom() };
		}
		const to = {
			center: [selected.node.lng, selected.node.lat] as [number, number],
			zoom: Math.max(map.getZoom(), 15.5),
			padding: { top: 40, bottom: 40, left: 40, right: 40 },
		};
		if (reduce) map.jumpTo(to);
		else map.flyTo({ ...to, duration: 900, essential: false });
	}, [selected, reduce]);

	const back = () => {
		nav.select(null);
		const map = ref.current;
		const to = before.current;
		before.current = null;
		if (!map || !to) return;
		if (reduce) map.jumpTo(to);
		else map.flyTo({ ...to, duration: 800 });
	};

	const inView = useMemo(() => {
		const b = bounds;
		const xs = b
			? rows.filter(
					(r) =>
						r.node.lng >= b.w &&
						r.node.lng <= b.e &&
						r.node.lat >= b.s &&
						r.node.lat <= b.n,
				)
			: rows;
		return [...xs].sort(
			(a, c) => c.score - a.score || a.name.localeCompare(c.name),
		);
	}, [rows, bounds]);

	const ranked = useMemo(
		() =>
			[...rows]
				.sort((a, c) => c.score - a.score || a.name.localeCompare(c.name))
				.map((r) => r.id),
		[rows],
	);
	const rank = (id: string) => ranked.indexOf(id) + 1;

	const readBounds = () => {
		const b = ref.current?.getBounds();
		if (b)
			setBounds({
				w: b.getWest(),
				s: b.getSouth(),
				e: b.getEast(),
				n: b.getNorth(),
			});
	};

	if (!rows.length)
		return (
			<div className="grid flex-1 place-items-center p-6">
				<EmptyState line="None of these places has a location yet." />
			</div>
		);

	return (
		<div
			className="flex min-h-0 flex-1 max-md:flex-col"
			data-testid={PLACES_TAB_TESTID.map}
		>
			<div className="relative min-h-0 min-w-0 flex-1 bg-basemap-land max-md:min-h-[45svh]">
				{style ? (
					<MapGL
						ref={ref}
						workerUrl={workerUrl}
						initialViewState={
							initial
								? {
										bounds: initial,
										fitBoundsOptions: { padding: 48, maxZoom: 14 },
									}
								: undefined
						}
						mapStyle={style}
						style={{ position: "absolute", inset: 0 }}
						dragRotate={false}
						pitchWithRotate={false}
						attributionControl={{ compact: true }}
						onLoad={readBounds}
						onMoveEnd={readBounds}
						onClick={() => (selId ? back() : undefined)}
						onError={(e) => {
							if (!isNetworkError(e.error)) console.error(e.error ?? e);
						}}
					>
						{rows.map((r) => (
							<Marker
								key={r.id}
								longitude={r.node.lng}
								latitude={r.node.lat}
								anchor="left"
								offset={[-7, 0]}
								style={{ zIndex: r.id === selId ? 10 : 1 }}
							>
								<Pin
									row={r}
									selected={r.id === selId}
									onPick={() => nav.select({ kind: "node", id: r.id })}
								/>
							</Marker>
						))}
					</MapGL>
				) : null}
				<Legend />
			</div>
			<aside
				className="flex min-h-0 shrink-0 flex-col border-l bg-card md:w-[380px] max-md:h-[45svh] max-md:border-t max-md:border-l-0"
				style={{ maxWidth: PANEL_W + 40 }}
			>
				{selected ? (
					<InspectorBody
						className="h-full"
						top={
							<div
								className="flex shrink-0 items-center gap-2 border-b px-3 py-2"
								data-testid={PLACES_TAB_TESTID.mapDetails}
							>
								<Button
									variant="outline"
									size="sm"
									onClick={back}
									data-testid={PLACES_TAB_TESTID.mapBack}
								>
									<ArrowLeft />
									All places
								</Button>
								<span className="text-xs text-muted-foreground">
									#{rank(selected.id)} by score of {rows.length}
								</span>
							</div>
						}
					/>
				) : (
					<>
						<div className="shrink-0 border-b px-4 pt-3 pb-2.5">
							<h3 className="font-display text-base font-semibold">
								In view · {inView.length}{" "}
								{inView.length === 1 ? "place" : "places"}
							</h3>
							<p className="text-xs text-muted-foreground">
								The list follows the map; highest score first.
							</p>
						</div>
						<ul
							className="min-h-0 flex-1 overflow-y-auto"
							data-testid={PLACES_TAB_TESTID.mapList}
						>
							{inView.map((r) => {
								// The ratings that count (a left-out person's don't).
								const mine = data.memberIds.flatMap((m) => {
									const p = r.node.priorities[m];
									return p ? [p] : [];
								});
								const top = mine.length
									? ([...mine].sort(
											(a, b) => PRIORITIES[b].score - PRIORITIES[a].score,
										)[0] ?? null)
									: null;
								return (
									<li key={r.id} data-cursor-anchor={`place:${r.id}`}>
										<button
											type="button"
											data-testid={PLACES_TAB_TESTID.mapRow}
											data-place={r.id}
											onClick={() => nav.select({ kind: "node", id: r.id })}
											className="flex w-full cursor-pointer items-center gap-2.5 border-b px-4 py-2 text-left hover:bg-muted/50"
										>
											<span
												className={cn(
													"size-2.5 shrink-0 rounded-full shadow-[0_0_0_1px_rgb(0_0_0/0.3)]",
													r.status !== "scheduled"
														? "border-[2.5px] border-(--pin) dark:border-(--pin-d)"
														: "bg-(--pin) dark:bg-(--pin-d)",
												)}
												style={pinVars(r.score)}
											/>
											<span className="min-w-0 flex-1">
												<span className="block truncate text-sm font-medium">
													{r.name}
												</span>
												<span className="flex min-w-0 items-center gap-2 text-xs text-muted-foreground">
													<span className="truncate">{r.where}</span>
													{top ? (
														<PriorityDot priority={top} className="text-xs" />
													) : null}
												</span>
											</span>
											<ScoreChip score={r.score} />
										</button>
									</li>
								);
							})}
						</ul>
						{inView.length === 0 ? (
							<p className="px-4 py-6 text-center text-sm text-muted-foreground">
								Nothing in this part of the map. Zoom out.
							</p>
						) : null}
					</>
				)}
			</aside>
		</div>
	);
}
