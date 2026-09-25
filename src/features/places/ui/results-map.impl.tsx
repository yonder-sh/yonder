/**
 * The search results on a map (the add-place palette): a numbered pin per
 * result, matching the list, the highlighted one on top. Pan and zoom to
 * check the spot; a pin opens that result. Loaded lazily (`results-map.tsx`)
 * like the mini map, on the same Yonder basemap.
 */
import "maplibre-gl/dist/maplibre-gl.css";
import { Map as MapGL, type MapRef, Marker } from "@vis.gl/react-maplibre";
import { cn } from "cn";
import workerUrl from "maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url";
import { useEffect, useRef } from "react";
import { isNetworkError, useDark, useYonderStyle } from "./mini-map.impl";

export type ResultPin = {
	ref: string;
	/** Its number in the list (1-based). */
	n: number;
	title: string;
	lat: number;
	lng: number;
};

export type ResultsMapProps = {
	pins: readonly ResultPin[];
	/** The highlighted result's ref. */
	active: string | null;
	onPick: (ref: string) => void;
	className?: string;
};

type Bounds = [[number, number], [number, number]];

function boundsOf(pins: readonly ResultPin[]): Bounds {
	let w = 180;
	let s = 90;
	let e = -180;
	let n = -90;
	for (const p of pins) {
		w = Math.min(w, p.lng);
		e = Math.max(e, p.lng);
		s = Math.min(s, p.lat);
		n = Math.max(n, p.lat);
	}
	return [
		[w, s],
		[e, n],
	];
}

const FIT = { padding: 48, maxZoom: 15 } as const;

export default function ResultsMapImpl({
	pins,
	active,
	onPick,
	className,
}: ResultsMapProps) {
	const ref = useRef<MapRef>(null);
	const dark = useDark();
	const style = useYonderStyle(dark ? "dark" : "light");
	const key = pins.map((p) => p.ref).join();
	// New results: frame them all (the map stays where you panned otherwise).
	// biome-ignore lint/correctness/useExhaustiveDependencies: refits when the result set changes
	useEffect(() => {
		if (pins.length)
			ref.current?.fitBounds(boundsOf(pins), { ...FIT, duration: 300 });
	}, [key]);
	return (
		<div
			className={cn("relative isolate bg-basemap-land", className)}
			data-testid="results-map"
		>
			{style && pins.length ? (
				<MapGL
					ref={ref}
					workerUrl={workerUrl}
					initialViewState={{
						bounds: boundsOf(pins),
						fitBoundsOptions: FIT,
					}}
					mapStyle={style}
					style={{ position: "absolute", inset: 0 }}
					locale={{ "Map.Title": "Map of the search results" }}
					dragRotate={false}
					pitchWithRotate={false}
					touchPitch={false}
					keyboard={false}
					attributionControl={false}
					onError={(e) => {
						if (!isNetworkError(e.error)) console.error(e.error ?? e);
					}}
				>
					{pins.map((p) => {
						const on = p.ref === active;
						return (
							<Marker
								key={p.ref}
								longitude={p.lng}
								latitude={p.lat}
								anchor="bottom"
								style={{ zIndex: on ? 2 : 1 }}
							>
								<button
									type="button"
									aria-label={`${p.n}. ${p.title}`}
									data-active={on || undefined}
									onClick={(e) => {
										e.stopPropagation();
										onPick(p.ref);
									}}
									className={cn(
										"grid cursor-pointer place-items-center rounded-full border-2 border-white font-mono font-semibold shadow-float transition-transform tnum",
										on
											? "size-8 scale-110 bg-primary text-[13px] text-primary-foreground"
											: "size-7 bg-foreground text-xs text-background hover:scale-110",
									)}
								>
									{p.n}
								</button>
							</Marker>
						);
					})}
				</MapGL>
			) : null}
			<span className="pointer-events-auto absolute right-1 bottom-1 z-10 rounded bg-background/80 px-1 text-[9px] leading-3 text-muted-foreground">
				©{" "}
				<a
					href="https://openfreemap.org"
					target="_blank"
					rel="noopener noreferrer"
					className="hover:underline"
				>
					OpenFreeMap
				</a>{" "}
				©{" "}
				<a
					href="https://www.openstreetmap.org/copyright"
					target="_blank"
					rel="noopener noreferrer"
					className="hover:underline"
				>
					OSM
				</a>
			</span>
		</div>
	);
}
