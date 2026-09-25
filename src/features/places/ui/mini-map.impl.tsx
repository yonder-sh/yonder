/**
 * The small location map (rate cards, the palette preview, Drop a pin):
 * MapLibre through `@vis.gl/react-maplibre` on the checked-in Yonder
 * basemap (WP-Map's `yonder-light/dark.json`: recoloured OpenFreeMap with
 * POIs, shields and sprites stripped, DESIGN §2.5/§9.1), so no style
 * warnings and the same look as the trip map. Loaded lazily (`mini-map.tsx`)
 * so the ~1 MB library never lands in the main bundle; react-maplibre
 * imports `maplibre-gl` itself.
 *
 * A11y: a still map is `role="img"` with its label and nothing focusable
 * inside (MapLibre's canvas is taken out of the tab order); on a pannable
 * one the canvas itself is the labelled region. The attribution links sit
 * outside either.
 */
import "maplibre-gl/dist/maplibre-gl.css";
import { Map as MapGL, type MapRef, Marker } from "@vis.gl/react-maplibre";
import type { StyleSpecification } from "maplibre-gl";
import workerUrl from "maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url";
import { useEffect, useRef, useState } from "react";
import { pinStyle } from "@/lib/domain/taxonomy";
import type { NodeType, PlaceCategory } from "@/lib/schemas/enums";

export type MiniMapProps = {
	lat: number;
	lng: number;
	zoom?: number;
	type?: NodeType;
	category?: PlaceCategory | null;
	/** Drop a pin: a fixed crosshair; `onCenter` reports the centre on every move end. */
	pick?: boolean;
	onCenter?: (at: { lat: number; lng: number }) => void;
	interactive?: boolean;
	className?: string;
	label?: string;
};

type Theme = "light" | "dark";

const STYLE_LOADERS: Record<Theme, () => Promise<{ default: unknown }>> = {
	light: () => import("@/features/map/styles/yonder-light.json"),
	dark: () => import("@/features/map/styles/yonder-dark.json"),
};
const loaded: Partial<Record<Theme, StyleSpecification>> = {};

/** The Yonder basemap for `theme`, loaded once per page (null while loading). */
export function useYonderStyle(theme: Theme): StyleSpecification | null {
	const [style, setStyle] = useState<StyleSpecification | null>(
		() => loaded[theme] ?? null,
	);
	useEffect(() => {
		const have = loaded[theme];
		if (have) {
			setStyle(have);
			return;
		}
		let live = true;
		void STYLE_LOADERS[theme]().then((m) => {
			const spec = m.default as StyleSpecification;
			loaded[theme] = spec;
			if (live) setStyle(spec);
		});
		return () => {
			live = false;
		};
	}, [theme]);
	return style;
}

/**
 * Tiles that can't be fetched (offline, a navigation aborting the TileJSON)
 * leave the quiet basemap colour; they aren't errors worth a console line.
 */
export function isNetworkError(err: unknown): boolean {
	const e = err as { name?: string; status?: number; message?: string } | null;
	return (
		e?.name === "AbortError" ||
		e?.status !== undefined ||
		/Failed to fetch|NetworkError|AJAXError|Load failed/i.test(e?.message ?? "")
	);
}

export function useDark(): boolean {
	const [dark, setDark] = useState(
		() =>
			typeof document !== "undefined" &&
			document.documentElement.classList.contains("dark"),
	);
	useEffect(() => {
		const el = document.documentElement;
		const obs = new MutationObserver(() =>
			setDark(el.classList.contains("dark")),
		);
		obs.observe(el, { attributes: true, attributeFilter: ["class"] });
		return () => obs.disconnect();
	}, []);
	return dark;
}

export default function MiniMapImpl({
	lat,
	lng,
	zoom = 14,
	type = "place",
	category,
	pick,
	onCenter,
	interactive = true,
	className,
	label,
}: MiniMapProps) {
	const ref = useRef<MapRef>(null);
	const dark = useDark();
	const style = useYonderStyle(dark ? "dark" : "light");
	const live = interactive || !!pick;
	// Follow the prop (the next card) without remounting the map.
	useEffect(() => {
		ref.current?.jumpTo({ center: [lng, lat], zoom });
	}, [lat, lng, zoom]);
	const pin = pinStyle({ type, category: category ?? null });
	const name = label ?? "Map of the location";
	const map = style ? (
		<MapGL
			ref={ref}
			workerUrl={workerUrl}
			initialViewState={{ latitude: lat, longitude: lng, zoom }}
			mapStyle={style}
			style={{ position: "absolute", inset: 0 }}
			// A still map is a picture: no handlers, canvas out of the tab order.
			interactive={live}
			locale={{ "Map.Title": name }}
			dragRotate={false}
			pitchWithRotate={false}
			touchZoomRotate={live}
			scrollZoom={live ? { around: "center" } : false}
			dragPan={live}
			doubleClickZoom={live}
			keyboard={false}
			attributionControl={false}
			onError={(e) => {
				if (!isNetworkError(e.error)) console.error(e.error ?? e);
			}}
			onMoveEnd={(e) => {
				if (!pick || !onCenter) return;
				const c = e.target.getCenter();
				onCenter({ lat: c.lat, lng: c.lng });
			}}
		>
			{pick ? null : (
				<Marker longitude={lng} latitude={lat} anchor="bottom">
					<span
						aria-hidden="true"
						className="block size-5 -translate-y-0.5 rounded-full border-2 border-white shadow-float"
						style={{ backgroundColor: pin.fill }}
					/>
				</Marker>
			)}
		</MapGL>
	) : null;
	return (
		<div
			className={className}
			style={{ position: "relative", isolation: "isolate" }}
		>
			{live ? (
				// MapLibre's canvas is the labelled, focusable region ("Map.Title").
				<div className="absolute inset-0 bg-basemap-land">{map}</div>
			) : (
				<div
					role="img"
					aria-label={name}
					className="absolute inset-0 bg-basemap-land"
				>
					{map}
				</div>
			)}
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
			{pick ? (
				<span
					aria-hidden="true"
					className="pointer-events-none absolute top-1/2 left-1/2 z-10 -translate-x-1/2 -translate-y-full"
				>
					<svg width="28" height="36" viewBox="0 0 28 36" role="presentation">
						<path
							d="M14 35c0 0 12-12.4 12-21A12 12 0 0 0 2 14c0 8.6 12 21 12 21Z"
							fill="var(--primary)"
							stroke="white"
							strokeWidth="2"
						/>
						<circle cx="14" cy="14" r="4" fill="white" />
					</svg>
				</span>
			) : null}
		</div>
	);
}
