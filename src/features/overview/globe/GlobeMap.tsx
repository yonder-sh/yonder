/**
 * The Overview hero's MapLibre globe (docs/OVERVIEW.md §1), its own lazy
 * chunk like the workspace map. It draws only the planet — the app's dark
 * basemap cut down to water, land and borders, recoloured for the black hero
 * band, with MapLibre's atmosphere — while the route is an SVG over it
 * (`OverviewGlobe`), fed this map's camera on every move.
 *
 * Not a trap for scrolling: no scroll or pinch zoom, no keyboard; dragging
 * turns the globe with a mouse (touch drags scroll the page).
 */
import "maplibre-gl/dist/maplibre-gl.css";
import { Map as MapGL, type MapRef } from "@vis.gl/react-maplibre";
import type { Map as MaplibreMap, StyleSpecification } from "maplibre-gl";
import workerUrl from "maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url";
import { useEffect, useRef, useState } from "react";
import type { LngLat } from "@/lib/engine/geo";

const mapLib = import("maplibre-gl");

/** The hero's planet on black (the band is dark in both themes). */
export const HERO = {
	space: "#040507",
	land: "#1b2029",
	water: "#0b1017",
	border: "#343c49",
} as const;

const KEEP = new Set([
	"background",
	"water",
	"boundary_country_z0-4",
	"boundary_country_z5-",
]);

function heroStyle(base: StyleSpecification): StyleSpecification {
	const layers = base.layers
		.filter((l) => KEEP.has(l.id))
		.map((l) => {
			if (l.type === "background")
				return { ...l, paint: { "background-color": HERO.land } };
			if (l.type === "fill")
				return { ...l, paint: { ...l.paint, "fill-color": HERO.water } };
			if (l.type === "line")
				return {
					...l,
					paint: { ...l.paint, "line-color": HERO.border, "line-width": 0.8 },
				};
			return l;
		});
	return {
		...base,
		layers,
		projection: { type: "globe" },
		// The soft halo round the planet.
		sky: {
			"atmosphere-blend": [
				"interpolate",
				["linear"],
				["zoom"],
				0,
				0.9,
				5,
				0.7,
				8,
				0,
			],
		},
	} as StyleSpecification;
}

let styleOnce: Promise<StyleSpecification> | null = null;
const loadStyle = () => {
	styleOnce ??= import("@/features/map/styles/yonder-dark.json").then((m) =>
		heroStyle(m.default as unknown as StyleSpecification),
	);
	return styleOnce;
};

export type GlobeView = { center: LngLat; zoom: number };

export default function GlobeMap({
	view,
	drag,
	onMap,
	onCamera,
	onUserMove,
}: {
	/** Where the camera starts. */
	view: GlobeView;
	/** Mouse drags turn the globe. */
	drag: boolean;
	onMap: (map: MaplibreMap | null) => void;
	/** Every camera change (ours and the user's). */
	onCamera: (v: GlobeView) => void;
	/** A drag began: stop any camera animation. */
	onUserMove: () => void;
}) {
	const [style, setStyle] = useState<StyleSpecification | null>(null);
	const ref = useRef<MapRef>(null);
	const initial = useRef(view);
	useEffect(() => {
		let live = true;
		void loadStyle().then((s) => live && setStyle(s));
		return () => {
			live = false;
		};
	}, []);
	useEffect(() => () => onMap(null), [onMap]);
	if (!style) return null;
	return (
		<MapGL
			ref={ref}
			mapLib={mapLib}
			workerUrl={workerUrl}
			initialViewState={{
				longitude: initial.current.center[0],
				latitude: initial.current.center[1],
				zoom: initial.current.zoom,
			}}
			mapStyle={style}
			projection={{ type: "globe" }}
			minZoom={-2}
			maxZoom={8}
			scrollZoom={false}
			boxZoom={false}
			doubleClickZoom={false}
			keyboard={false}
			touchZoomRotate={false}
			touchPitch={false}
			dragRotate={false}
			pitchWithRotate={false}
			dragPan={drag}
			attributionControl={{ compact: true }}
			// Tiles that fail (offline, a CDN blip) leave the plain sphere.
			onError={() => undefined}
			onLoad={(e) => {
				// The attribution starts folded to its (i) on the poster.
				const attrib = e.target
					.getContainer()
					.querySelector(".maplibregl-ctrl-attrib");
				attrib?.classList.remove("maplibregl-compact-show");
				attrib?.removeAttribute("open");
				onMap(e.target);
			}}
			onMove={(e) => {
				const c = e.target.getCenter();
				onCamera({ center: [c.lng, c.lat], zoom: e.target.getZoom() });
			}}
			onDragStart={onUserMove}
			style={{ position: "absolute", inset: 0 }}
		/>
	);
}
