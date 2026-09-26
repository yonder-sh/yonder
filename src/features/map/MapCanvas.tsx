/**
 * The MapLibre map (DESIGN §9, SPEC §18.3 WP-Map). Lazy: `TripMap` loads this
 * chunk only when WebGL2 is available, and `maplibre-gl` itself loads through
 * `mapLib` in its own chunk.
 *
 * - Basemap: the recoloured OpenFreeMap styles in `./styles`, or keyless Esri
 *   imagery under their names (satellite), as chosen in View settings or the
 *   layer menu (FB-04; the app theme until then). Pins, lines and MapLibre's
 *   controls take the basemap's tone, the chrome around them the app's.
 * - `globe` for the whole trip at the country lens when it spans more than
 *   one country (FB-10), framing every country (`globeCamera`).
 * - Pins are HTML markers (`PinMarker`), clustered under 28px at the place and
 *   area lens; edges, ghost stubs and the route preview are GeoJSON layers with
 *   `promoteId: 'fid'` for hover/selection feature-state.
 * - While the Plan's days per city change (`splitRoute`, desktop), the stops
 *   in that order: numbered "1 · 4d" badges over the cities, joined by lines.
 * - Everything is clickable: pins select (`n.`), double-click zooms in; edges
 *   select `l.` / `s.` / `e.`; ghost stubs select their boundary leg and
 *   double-click zooms out to the common parent. Background click clears.
 * - The camera fits the scope on scope, lens or day changes (600 ms, jump with
 *   reduced motion), keeping clear of the inspector/sheet (`mapPadding`).
 * - `window.__tripMap` (TI-6) under `VITE_E2E=1`, with `__yonder` data.
 */
import "maplibre-gl/dist/maplibre-gl.css";
import "./map.css";
import {
	Layer,
	Map as MapGL,
	type MapLayerMouseEvent,
	type MapRef,
	Source,
	useControl,
	useMap,
} from "@vis.gl/react-maplibre";
import { cn } from "cn";
import type { FeatureCollection, LineString, Point, Position } from "geojson";
import type {
	AttributionControl as MaplibreAttribution,
	Map as MaplibreMap,
	StyleSpecification,
} from "maplibre-gl";
import workerUrl from "maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url";
import {
	type CSSProperties,
	type RefObject,
	useCallback,
	useEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import { presenceColor } from "@/components/common/member";
import { LENS_ZOOM, repAt, suggestsFinerLens } from "@/lib/engine/lens";
import type { Lens } from "@/lib/engine/types";
import { buildModel } from "@/lib/engine/visits";
import { todayIn } from "@/lib/format";
import { usePeers, useTripAwareness } from "@/lib/realtime/presence";
import {
	bool,
	oneOf,
	useFollowState,
	useFollowValue,
} from "@/lib/realtime/view-ui";
import { describeFilter } from "@/lib/workspace/filter-match";
import {
	notifyMapMoved,
	registerMapProjector,
} from "@/lib/workspace/map-projector";
import { parseSel } from "@/lib/workspace/search";
import { useUi } from "@/lib/workspace/ui-store";
import { useWorkspace } from "@/lib/workspace/use-workspace";
import {
	isCameraFollowing,
	pauseCameraFollow,
	useCameraFollow,
	useCamFollow,
} from "./camera-follow";
import {
	attachEdgesToClusters,
	CLUSTER_MAX_ZOOM,
	type Cluster,
	clusterLens,
	clusterOfRep,
	clustersAt,
	makeClusterIndex,
	spiderOffsets,
} from "./clusters";
import { countMatchingPlaces, filterActive, pinMatcher } from "./filter-match";
import {
	alongMidpoint,
	boundsOf,
	CAMERA_DISTANCE_PER_HEIGHT,
	clearPadding,
	globeCamera,
	globeFit,
	globeRadiusAt,
	type Insets,
	NO_INSETS,
	sameInsets,
} from "./geo-utils";
import {
	createEdgeTipStore,
	EdgeTooltip,
	EmptyMapCard,
	FilterChip,
	FinerChip,
	FollowBackChip,
	MapControls,
	OneRepHint,
	TilesDownChip,
} from "./MapControls";
import {
	buildChips,
	buildEdges,
	buildGhosts,
	buildPins,
	type EdgeProps,
	edgeTip,
	fitBoundsFor,
	fitPointsFor,
	legUsesN02,
	type MapDataOptions,
	oneRepHint,
	type PinView,
	selectedFids,
	wantsGlobe,
} from "./map-data";
import {
	ARROW_ICON,
	EDGE_HIT,
	EDGE_SOURCE,
	edgeLayers,
	GHOST_HIT,
	GHOST_LABEL_SOURCE,
	GHOST_SOURCE,
	ghostLabelLayer,
	ghostLayers,
	makeArrowImage,
	PIN_SOURCE,
	PREVIEW_SOURCE,
	pinProbeLayer,
	previewLayer,
	SPLIT_ROUTE_SOURCE,
	splitRouteLayer,
} from "./map-layers";
import {
	ClusterMarker,
	EdgeChipMarker,
	type LabelSide,
	PinMarker,
	SpiderLegs,
	SplitStopMarker,
} from "./PinMarker";
import { LINES, type MapStyle, mapTone } from "./palette";
import {
	GLOBE,
	globeBasemap,
	MERCATOR,
	nextProjectedStyle,
	type ProjectedStyleMemo,
} from "./projected-style";
import { MAP_TESTID } from "./testids";
import {
	isNetworkError,
	type MapErrorEventLike,
	TILES_OK,
	type TileHealth,
	tileHealthOnData,
	tileHealthOnError,
} from "./tile-health";
import {
	useDayModePersistence,
	useMapShow,
	useMapStyle,
	useSharedFilter,
} from "./use-map-state";
import { usePinMotion } from "./use-pin-motion";

// maplibre-gl loads in its own chunk (the crawler sees this import, so Vite
// pre-bundles it instead of re-optimising on the first map).
const mapLib = import("maplibre-gl");

const PIN_PROBE = pinProbeLayer();

/**
 * The whole-trip globe's sphere is at most this share of the free area's
 * shorter side (FB-10: the planet reads as a globe, not a curved map).
 */
const GLOBE_SCALE = 1.1;

/** The fit padding for a `W × H` map, at most `k` of it (see `clearPadding`). */
const padIn = (
	pad: { hard: Insets; soft: Insets },
	W: number,
	H: number,
	k: number,
): Insets => clearPadding(pad.hard, pad.soft, W, H, k);

/**
 * A faint, even glow round the dark-tone globe: the Overview's look without
 * MapLibre's atmosphere, whose sun lights one side (or the whole planet). A
 * circle behind the canvas (the globe covers its middle, so only the soft
 * edge shows) that follows the planet's outline on every camera move, with
 * the same camera maths as `geo-utils` (pitch 0; padding moves the centre).
 * It fades out as MapLibre's globe flattens into a map.
 */
function GlobeGlow({
	mapRef,
	loaded,
}: {
	mapRef: RefObject<MapRef | null>;
	loaded: boolean;
}) {
	const el = useRef<HTMLDivElement>(null);
	useEffect(() => {
		const map = mapRef.current?.getMap();
		const div = el.current;
		if (!loaded || !map || !div) return;
		const place = () => {
			const box = map.getContainer();
			const W = box.clientWidth;
			const H = box.clientHeight;
			const { left = 0, right = 0, top = 0, bottom = 0 } = map.getPadding();
			const zoom = map.getZoom();
			const R = globeRadiusAt(zoom, map.getCenter().lat);
			const D = CAMERA_DISTANCE_PER_HEIGHT * H;
			const r = R * Math.sqrt(D / (D + 2 * R));
			const cx = left + (W - left - right) / 2;
			const cy = top + (H - top - bottom) / 2;
			div.style.width = `${2 * r}px`;
			div.style.height = `${2 * r}px`;
			div.style.transform = `translate(${cx - r}px, ${cy - r}px)`;
			div.style.opacity = String(Math.min(1, Math.max(0, (5 - zoom) / 2)));
		};
		place();
		map.on("move", place);
		map.on("resize", place);
		return () => {
			map.off("move", place);
			map.off("resize", place);
		};
	}, [mapRef, loaded]);
	return <div ref={el} className="yonder-globe-glow" aria-hidden />;
}

const STYLE_LOADERS: Record<MapStyle, () => Promise<{ default: unknown }>> = {
	light: () => import("./styles/yonder-light.json"),
	dark: () => import("./styles/yonder-dark.json"),
	satellite: () => import("./styles/yonder-satellite.json"),
};

/**
 * The basemap for `style`, each loaded once per page. While a newly chosen
 * style loads, the previous one stays up (the map never blanks mid-switch).
 */
function useBasemap(style: MapStyle): StyleSpecification | null {
	const [styles, setStyles] = useState<
		Partial<Record<MapStyle, StyleSpecification>>
	>({});
	const shown = useRef<StyleSpecification | null>(null);
	useEffect(() => {
		if (styles[style]) return;
		let live = true;
		void STYLE_LOADERS[style]().then((m) => {
			if (live)
				setStyles((s) => ({
					...s,
					[style]: globeBasemap(style, m.default as StyleSpecification),
				}));
		});
		return () => {
			live = false;
		};
	}, [style, styles]);
	shown.current = styles[style] ?? shown.current;
	return shown.current;
}

/**
 * The basemap carrying the projection the map is on when it's set, so a
 * style switch on the whole-trip globe keeps its camera (FB-04, see
 * `projectedStyle`). Only a new basemap makes a new spec.
 */
function useProjectedStyle(
	basemap: StyleSpecification | null,
	globe: boolean,
): StyleSpecification | null {
	const memo = useRef<ProjectedStyleMemo>({ base: null, spec: null });
	memo.current = nextProjectedStyle(memo.current, basemap, globe);
	return memo.current.spec;
}

const reducedMotion = () =>
	typeof window !== "undefined" &&
	window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

const LENS_PLURAL: Record<Lens, string> = {
	country: "countries",
	region: "regions",
	city: "cities",
	area: "areas",
	place: "places",
};
const LENS_ORDER: Lens[] = ["country", "region", "city", "area", "place"];

const N02_CREDIT =
	'<a href="https://nlftp.mlit.go.jp/ksj/gml/datalist/KsjTmplt-N02-2025.html" target="_blank" rel="noopener noreferrer">Rail: MLIT N02 (CC BY 4.0)</a>';

/**
 * The compact attribution, one control for the map's life (VIS2-11). The N02
 * credit (JAPAN_TRANSIT §5) comes and goes with the lens: the control's
 * options are updated in place instead of remounting it, and its compact
 * check skips the container-width read (always compact here), which forced a
 * layout of the whole workspace on every lens change.
 */
function Attribution({ extra }: { extra: string | undefined }) {
	const ctl = useControl<MaplibreAttribution>(
		({ mapLib }) => {
			const c = new mapLib.AttributionControl({
				compact: true,
				customAttribution: extra,
			});
			c._updateCompact = () => {
				const el = c._container;
				if (
					!el ||
					el.classList.contains("maplibregl-compact") ||
					el.classList.contains("maplibregl-attrib-empty")
				)
					return;
				el.setAttribute("open", "");
				el.classList.add("maplibregl-compact", "maplibregl-compact-show");
			};
			return c;
		},
		{ position: "bottom-left" },
	);
	useEffect(() => {
		if (ctl.options.customAttribution === extra) return;
		ctl.options = { ...ctl.options, customAttribution: extra };
		if (ctl._map) ctl._updateAttributions();
	}, [ctl, extra]);
	return null;
}

/** Registers the runtime arrow icon before the symbol layer first asks for it. */
function ArrowImage() {
	const { current } = useMap();
	useState(() => {
		const map = current?.getMap();
		map?.setMissingStyleImageResolver((id: string) => {
			if (id !== ARROW_ICON || map.hasImage(id)) return;
			const img = makeArrowImage(32);
			if (img) map.addImage(id, img, { sdf: true, pixelRatio: 2 });
		});
		return null;
	});
	return null;
}

// ---- label placement (DOM markers never collide on their own) -----------

let measureCtx: CanvasRenderingContext2D | null = null;
let measureFont = "";
const widthCache = new Map<string, number>();
/**
 * A label's width, cached per name (VIS2-11: a lens change re-measured every
 * label and read the body's computed style each time, a forced style recalc
 * right after React's commit). The font is read once; the cache is dropped
 * when a web font finishes loading.
 */
function textWidth(text: string): number {
	const hit = widthCache.get(text);
	if (hit !== undefined) return hit;
	if (!measureCtx) {
		measureCtx = document.createElement("canvas").getContext("2d");
		document.fonts?.addEventListener?.("loadingdone", () => {
			widthCache.clear();
			measureFont = "";
		});
	}
	if (!measureCtx) return text.length * 6.5;
	if (!measureFont) {
		measureFont = `500 12px ${getComputedStyle(document.body).fontFamily}`;
		measureCtx.font = measureFont;
	}
	const w = Math.min(176, measureCtx.measureText(text).width);
	if (widthCache.size > 4000) widthCache.clear();
	widthCache.set(text, w);
	return w;
}

const isDayMode = oneOf<"only" | "dim">(["only", "dim"]);

/**
 * The map's size without a forced layout: MapLibre sizes its canvas (inline
 * `style.width/height`, from its own ResizeObserver). Reading `clientWidth`
 * right after a lens change's React commit laid out the whole workspace
 * synchronously (VIS2-11).
 */
function mapSize(map: MaplibreMap): { W: number; H: number } {
	const cv = map.getCanvas();
	const W = Number.parseFloat(cv.style.width);
	const H = Number.parseFloat(cv.style.height);
	if (W > 0 && H > 0) return { W, H };
	const c = map.getContainer();
	return { W: c.clientWidth, H: c.clientHeight };
}

type Rect = [number, number, number, number];
const overlaps = (a: Rect, b: Rect) =>
	a[0] < b[2] && a[2] > b[0] && a[1] < b[3] && a[3] > b[1];

/**
 * Greedy labels: visited pins in number order, then ideas; right side, else
 * left, above or below, else none. Country pins put their name below. ~1 ms for 300 pins.
 */
function placeLabels(
	map: MaplibreMap,
	pins: readonly PinView[],
	widths: Map<string, number>,
	lens: Lens,
	/** Pixels covered on the right (the floating inspector). */
	rightInset = 0,
	/** Cluster chips (26px): labels keep off them too. */
	clusterAt: readonly [number, number][] = [],
): Map<string, LabelSide> {
	const { W: CW, H } = mapSize(map);
	const W = CW - rightInset;
	const pts = new Map(pins.map((p) => [p.repId, map.project([p.lng, p.lat])]));
	const dots: Rect[] = pins.map((p) => {
		const q = pts.get(p.repId) as { x: number; y: number };
		const r = p.size / 2 + 2;
		return [q.x - r, q.y - r, q.x + r, q.y + r];
	});
	for (const [lng, lat] of clusterAt) {
		const q = map.project([lng, lat]);
		dots.push([q.x - 15, q.y - 15, q.x + 15, q.y + 15]);
	}
	const placed: Rect[] = [];
	const out = new Map<string, LabelSide>();
	const ranked = [...pins].sort(
		(a, b) =>
			Number(a.hollow) - Number(b.hollow) ||
			(a.number ?? 9999) - (b.number ?? 9999),
	);
	const zoom = map.getZoom();
	for (const p of ranked) {
		if (p.filteredOut) continue;
		if (p.hollow && zoom < LENS_ZOOM[lens] - 1) continue;
		const q = pts.get(p.repId);
		if (!q || q.x < 0 || q.y < 0 || q.x > W || q.y > H) continue;
		const w = widths.get(p.repId) ?? 100;
		const r = p.size / 2 + 6;
		const cands: [LabelSide, Rect][] =
			p.shape === "country"
				? [["below", [q.x - w / 2, q.y + r, q.x + w / 2, q.y + r + 18]]]
				: [
						["right", [q.x + r, q.y - 8, q.x + r + w, q.y + 8]],
						["left", [q.x - r - w, q.y - 8, q.x - r, q.y + 8]],
						["above", [q.x - w / 2, q.y - r - 14, q.x + w / 2, q.y - r + 2]],
						["below", [q.x - w / 2, q.y + r - 2, q.x + w / 2, q.y + r + 14]],
					];
		for (const [side, rect] of cands) {
			if (rect[0] < 2 || rect[2] > W - 2 || rect[1] < 2 || rect[3] > H - 2)
				continue;
			if (placed.some((x) => overlaps(rect, x))) continue;
			if (dots.some((d) => overlaps(rect, d))) continue;
			placed.push(rect);
			out.set(p.repId, side);
			break;
		}
	}
	return out;
}

const sameLabels = (a: Map<string, LabelSide>, b: Map<string, LabelSide>) =>
	a.size === b.size && [...a].every(([k, v]) => b.get(k) === v);

/** TI-6 perf hook: n place pins in a grid over twice the view each way (far enough apart not to cluster). */
function syntheticPins(
	n: number,
	b: {
		getWest(): number;
		getEast(): number;
		getSouth(): number;
		getNorth(): number;
	},
): PinView[] {
	const cols = Math.ceil(Math.sqrt(n * 1.6));
	const rows = Math.ceil(n / cols);
	const w = b.getEast() - b.getWest();
	const h = b.getNorth() - b.getSouth();
	const cats = [
		"restaurant",
		"museum",
		"shopping",
		"park",
		"bar",
		"temple_shrine",
	];
	const out: PinView[] = [];
	for (let i = 0; i < n; i++) {
		const c = i % cols;
		const r = Math.floor(i / cols);
		const lng = b.getWest() - w / 2 + ((c + 0.5) / cols) * w * 2;
		const lat = b.getSouth() - h / 2 + ((r + 0.5) / rows) * h * 2;
		out.push({
			repId: `synthetic-${i}`,
			name: `Synthetic ${i + 1}`,
			type: "place",
			shape: "place",
			lng,
			lat,
			number: 100 + i,
			visits: 1,
			stops: 1,
			minutes: 60,
			hollow: false,
			dropped: false,
			stay: false,
			repMode: "exact",
			approx: false,
			size: 24,
			opacity: 1,
			filteredOut: false,
			dayIds: [],
			countryCode: null,
			category: cats[i % cats.length] ?? "other",
			ariaLabel: `Synthetic ${i + 1}`,
			proposal: null,
		});
	}
	return out;
}

// ---------------------------------------------------------------------------

export default function MapCanvas({
	variant,
}: {
	variant: "desktop" | "mobile";
}) {
	const ws = useWorkspace();
	const { ix, sel, nav, scope, lens, days, who, access, lensOptions } = ws;
	const scopeId = scope?.id ?? null;
	const [mapStyle, setSatellite] = useMapStyle();
	// Pins, lines and labels follow the basemap's tone (satellite is dark).
	const theme = mapTone(mapStyle);
	const palette = LINES[theme];
	const basemap = useBasemap(mapStyle);
	const [show, setShow, viewShow] = useMapShow();
	useDayModePersistence();
	const dayMode = useUi((s) => s.dayFilterMode);
	const setDayMode = useUi((s) => s.setDayFilterMode);
	const hover = useUi((s) => s.hover);
	const setHover = useUi((s) => s.setHover);
	const previewRoute = useUi((s) => s.previewRoute);
	const splitRoute = useUi((s) => s.splitRoute);
	// The phone's sheet covers its map: the route shows beside the Plan only.
	const route = variant === "desktop" && splitRoute?.length ? splitRoute : null;
	const padding = useUi((s) => s.mapPadding);
	const sheetSnap = useUi((s) => s.sheetSnap);
	const setMapZoom = useUi((s) => s.setMapZoom);
	const openAddPlace = useUi((s) => s.openAddPlace);
	const [filter, setFilter] = useSharedFilter();
	const peers = usePeers();
	// FB-21d: what the map shows travels with my view; a follower mirrors it.
	const live = ws.mode === "live";
	useFollowValue(
		"map.ideas",
		show.ideas,
		(v) => viewShow({ ideas: v }),
		bool,
		live,
	);
	useFollowValue(
		"map.dropped",
		show.dropped,
		(v) => viewShow({ dropped: v }),
		bool,
		live,
	);
	useFollowValue(
		"map.stays",
		show.stays,
		(v) => viewShow({ stays: v }),
		bool,
		live,
	);
	useFollowValue("map.days", dayMode, setDayMode, isDayMode, live);

	// ---- basemap health (QA ERR-06) -----------------------------------------
	const basemapSources = useRef<ReadonlySet<string>>(new Set());
	basemapSources.current = useMemo(
		() => new Set(Object.keys(basemap?.sources ?? {})),
		[basemap],
	);
	const [tiles, setTiles] = useState<TileHealth>(TILES_OK);
	const tilesRef = useRef(tiles);
	// Another basemap (FB-04) starts with a clean bill of health.
	useEffect(() => {
		void basemap;
		tilesRef.current = TILES_OK;
		setTiles(TILES_OK);
	}, [basemap]);

	// ---- data -------------------------------------------------------------
	const mapRef = useRef<MapRef>(null);
	const dim = dayMode === "dim" && days !== null;
	const fullModel = useMemo(
		() => (dim ? buildModel(ix, scopeId, lens, null) : ws.model),
		[dim, ix, scopeId, lens, ws.model],
	);
	const matches = useMemo(
		() => pinMatcher(filter, { ix, meMemberId: access.memberId }),
		[filter, ix, access.memberId],
	);
	const opts = useMemo<MapDataOptions>(
		() => ({
			theme,
			palette,
			lens,
			scopeId,
			days,
			dayMode,
			who,
			show,
			matches,
			marks: ws.proposals.marks,
		}),
		[
			theme,
			palette,
			lens,
			scopeId,
			days,
			dayMode,
			who,
			show,
			matches,
			ws.proposals.marks,
		],
	);
	// TI-6 perf hook (VITE_E2E only): `__tripMapStress(n)` adds n synthetic pins.
	const [stress, setStress] = useState<readonly PinView[]>([]);
	const pins = useMemo(() => {
		const real = buildPins(fullModel, ix, opts);
		return stress.length ? [...real, ...stress] : real;
	}, [fullModel, ix, opts, stress]);
	const edges = useMemo(
		() => buildEdges(fullModel, ix, pins, opts),
		[fullModel, ix, pins, opts],
	);
	const ghosts = useMemo(
		() => buildGhosts(fullModel, ix, pins, opts),
		[fullModel, ix, pins, opts],
	);
	const filterCount = useMemo(
		() =>
			!filterActive(filter, { ix, meMemberId: access.memberId })
				? null
				: countMatchingPlaces(
						filter,
						{ ix, meMemberId: access.memberId },
						scopeId,
					),
		[filter, ix, access.memberId, scopeId],
	);
	const filterText = useMemo(
		() =>
			filterCount
				? describeFilter(filter, {
						meMemberId: access.memberId,
						members: ws.graph.members,
					})
				: null,
		[filterCount, filter, access.memberId, ws.graph.members],
	);
	const [filterOpen, setFilterOpen] = useFollowState(
		"map.filter",
		false,
		bool,
		{
			enabled: ws.mode === "live",
		},
	);
	const hint = useMemo(
		() => oneRepHint(pins, edges, { lens, scopeId, days }),
		[pins, edges, lens, scopeId, days],
	);
	const usesN02 = useMemo(
		() =>
			fullModel.transitions.some(
				(t) =>
					legUsesN02(ix, t.leg) ||
					legUsesN02(ix, t.stayLegs?.end ?? null) ||
					legUsesN02(ix, t.stayLegs?.start ?? null),
			),
		[fullModel, ix],
	);

	// ---- map + camera -----------------------------------------------------
	const [loaded, setLoaded] = useState(false);
	const [epoch, setEpoch] = useState(0);
	const [zoom, setZoom] = useState<number>(LENS_ZOOM[lens]);
	const zInt = Math.floor(zoom);

	/**
	 * `hard`: what the inspector covers (never given up while there's room,
	 * QA MT-R2-02); `soft`: breathing room, and the controls column on the
	 * right. `clearPadding` shrinks only the soft part when the map is narrow.
	 */
	const fitPadding = useMemo((): { hard: Insets; soft: Insets } => {
		if (variant === "mobile") {
			const h = typeof window === "undefined" ? 800 : window.innerHeight;
			const bottom =
				typeof sheetSnap === "number" && sheetSnap <= 1
					? Math.round(sheetSnap * h) + 24
					: 150;
			return {
				hard: NO_INSETS,
				soft: {
					top: 140,
					bottom: Math.min(bottom, h * 0.6),
					left: 40,
					right: 56,
				},
			};
		}
		return {
			hard: {
				top: padding.top,
				right: padding.right,
				bottom: padding.bottom,
				left: padding.left,
			},
			soft: { top: 36, right: 36 + 40, bottom: 36, left: 36 },
		};
	}, [variant, padding, sheetSnap]);

	// The whole trip at the country lens frames every country, ideas included
	// (FB-10), on a globe when they span more than one country (`wantsGlobe`).
	const wholeTrip = lens === "country" && !scopeId;
	const fitPts = useMemo(
		() => fitPointsFor(pins, { all: wholeTrip }),
		[pins, wholeTrip],
	);
	const ownGlobe = useMemo(
		() => wholeTrip && wantsGlobe(pins),
		[wholeTrip, pins],
	);
	// FB-22: mirroring someone's camera, the map takes their projection too.
	const leaderGlobe = useCamFollow((s) =>
		s.leader && !s.paused ? s.leaderGlobe : null,
	);
	const globe = leaderGlobe ?? ownGlobe;
	const styleSpec = useProjectedStyle(basemap, globe);
	const maxFitZoom = Math.min(
		16,
		LENS_ZOOM[lens] + (fitPts.length <= 1 ? 0 : 2),
	);
	const latest = useRef({ fitPts, fitPadding, maxFitZoom, globe });
	latest.current = { fitPts, fitPadding, maxFitZoom, globe };

	/**
	 * Moves the camera so `pts` sit inside `pad`. Mercator: `fitBounds`, with
	 * no camera padding left over from the globe. Globe: `globeCamera`, every
	 * point on the visible side of the Earth (QA MAP-01) and the planet still a
	 * globe; `reveal` (a selection brought into view) only pans or zooms out.
	 * MapLibre's own globe fit is never used: it aims with mercator maths and
	 * throws when the bounds can't fit the padding (QA PLAN-R3-04), which took
	 * the workspace down through the route's error boundary.
	 */
	const fitInside = useCallback(
		(
			pts: readonly Position[],
			pad: Insets,
			maxZoom: number,
			duration: number,
			reveal = false,
		) => {
			const map = mapRef.current?.getMap();
			if (!map || pts.length === 0) return;
			const d = reducedMotion() ? 0 : duration;
			try {
				if (latest.current.globe) {
					const { W, H } = mapSize(map);
					const cam = globeCamera(pts, {
						width: W,
						height: H,
						pad,
						maxZoom,
						globeScale: reveal ? Number.POSITIVE_INFINITY : GLOBE_SCALE,
					});
					if (cam) {
						map.easeTo({
							center: cam.center,
							zoom: cam.zoom,
							bearing: 0,
							padding: cam.padding,
							duration: d,
						});
						return;
					}
				}
				const b = boundsOf(pts);
				if (!b) return;
				if (!sameInsets(map.getPadding(), NO_INSETS)) map.setPadding(NO_INSETS);
				map.fitBounds(b, { padding: pad, maxZoom, duration: d });
			} catch (err) {
				// A camera that can't fit keeps the current view; the map never throws.
				if (import.meta.env.DEV) console.warn("[map] fit skipped", err);
			}
		},
		[],
	);

	/**
	 * Set when the person pans or zooms the map themselves; a fit clears it.
	 * Until then the whole-trip globe keeps framing the whole trip when the
	 * inspector opens or closes (QA MAP-01: every country in view, "with any
	 * inspector open").
	 */
	const userMoved = useRef(false);
	const fitCamera = useCallback(
		(duration = 600) => {
			const map = mapRef.current;
			const {
				fitPts: pts,
				fitPadding: pad,
				maxFitZoom: maxZoom,
			} = latest.current;
			if (!map || pts.length === 0) return;
			// FB-22: the camera is the leader's while I follow their map.
			if (isCameraFollowing()) return;
			userMoved.current = false;
			const { W, H } = mapSize(map.getMap());
			fitInside(pts, padIn(pad, W, H, 0.7), maxZoom, duration);
		},
		[fitInside],
	);

	// A trip that becomes a globe (or flat) refits with its new projection.
	const fitKey = `${scopeId}|${lens}|${ws.search.days ?? ""}|${dayMode}|${globe}`;
	const fitted = useRef<string | null>(null);
	useEffect(() => {
		if (!loaded || fitted.current === fitKey) return;
		const first = fitted.current === null;
		fitted.current = fitKey;
		fitCamera(first ? 0 : 600);
	}, [loaded, fitKey, fitCamera]);

	// Keep a selected pin clear of the inspector / sheet (DESIGN §9, SPEC §12.5).
	const visitRep = useMemo(
		() => new Map(fullModel.visits.map((v) => [v.key, v.repId])),
		[fullModel.visits],
	);
	const selectedRep = useMemo(() => {
		if (sel?.kind === "node") {
			if (pins.some((p) => p.repId === sel.id)) return sel.id;
			if (!ix.node(sel.id)) return null;
			const r = repAt(ix, sel.id, lens, scopeId).id;
			return pins.some((p) => p.repId === r) ? r : null;
		}
		if (sel?.kind === "item") {
			const vk = fullModel.visitOfItem[sel.id];
			return vk ? (visitRep.get(vk) ?? null) : null;
		}
		return null;
	}, [sel, pins, ix, lens, scopeId, fullModel.visitOfItem, visitRep]);

	/**
	 * Brings points into the part of the map that isn't covered (inspector,
	 * sheet, pills): pans, or zooms out just enough — never zooms in past where
	 * you are. Nothing moves when they're already visible.
	 */
	const reveal = useCallback(
		(target: readonly (readonly number[])[]) => {
			const map = mapRef.current;
			if (!map || target.length === 0 || isCameraFollowing()) return;
			// The untouched whole-trip globe reveals by showing the whole trip.
			const whole = latest.current.globe && !userMoved.current;
			const pts = whole ? latest.current.fitPts : target;
			const pad = latest.current.fitPadding;
			const { W, H } = mapSize(map.getMap());
			// Lenient (nothing moves for a point already in view), but a pin must
			// clear the inspector: its covered part counts in full.
			const loose = clearPadding(
				pad.hard,
				{
					top: pad.soft.top * 0.6,
					right: Math.min(pad.soft.right, 16),
					bottom: pad.soft.bottom * 0.6,
					left: pad.soft.left * 0.6,
				},
				W,
				H,
				0.8,
				{ min: 12 },
			);
			const inside = pts.every((p) => {
				const q = map.project([p[0] ?? 0, p[1] ?? 0]);
				return (
					q.x > Math.min(loose.left, W * 0.2) &&
					q.x < W - Math.min(loose.right, W * 0.8) &&
					q.y > Math.min(loose.top, H * 0.2) &&
					q.y < H - Math.min(loose.bottom, H * 0.5)
				);
			});
			if (inside) return;
			if (whole) return fitCamera(450);
			fitInside(
				pts.map((p) => [p[0] ?? 0, p[1] ?? 0]),
				padIn(pad, W, H, 0.8),
				map.getZoom(),
				450,
				true,
			);
		},
		[fitInside, fitCamera],
	);

	// A selected pin stays clear of the inspector / sheet (it re-checks when the
	// inspector opens and changes the padding), but data edits never move the map.
	const pinsRef = useRef(pins);
	pinsRef.current = pins;
	useEffect(() => {
		void fitPadding;
		if (!loaded || !selectedRep) return;
		const p = pinsRef.current.find((x) => x.repId === selectedRep);
		if (p) reveal([[p.lng, p.lat]]);
	}, [selectedRep, loaded, fitPadding, reveal]);

	// ---- clusters -----------------------------------------------------------
	const clusterIndex = useMemo(
		() => (clusterLens(lens) ? makeClusterIndex(pins) : null),
		[pins, lens],
	);
	const clusters = useMemo(
		() => (clusterIndex ? clustersAt(clusterIndex, zInt) : []),
		[clusterIndex, zInt],
	);
	const [spider, setSpider] = useState<Cluster | null>(null);
	useEffect(() => {
		// A new zoom level or new pins re-cluster; drop an open spider.
		void zInt;
		void pins;
		setSpider(null);
	}, [zInt, pins]);
	const byRep = useMemo(() => {
		const m = clusterOfRep(clusters.filter((c) => c.id !== spider?.id));
		return m;
	}, [clusters, spider]);
	const pinBy = useMemo(() => new Map(pins.map((p) => [p.repId, p])), [pins]);
	const shownEdges = useMemo(
		() =>
			attachEdgesToClusters(edges, byRep, (id) => {
				const p = pinBy.get(id);
				return p ? [p.lng, p.lat] : null;
			}),
		[edges, byRep, pinBy],
	);
	const chips = useMemo(
		() => buildChips(shownEdges, (g) => alongMidpoint(g.coordinates)),
		[shownEdges],
	);
	const spiderPins = useMemo(() => {
		if (!spider) return new Map<string, [number, number]>();
		const offs = spiderOffsets(spider.repIds.length);
		return new Map(
			spider.repIds.map((id, i) => [id, offs[i] as [number, number]]),
		);
	}, [spider]);
	// The zoom gesture: new pins slide from the ones they replace (DESIGN §11).
	const motion = usePinMotion(ix, pins, `${scopeId}|${lens}`);
	// The pins at their own spots: the probe source, the labels and the e2e hook
	// follow these, so the gesture's frames don't re-send the source or re-place
	// labels 36 times per lens change (VIS2-11). Only the markers slide.
	const shownPins = useMemo(
		() => pins.filter((p) => !byRep.has(p.repId) || spiderPins.has(p.repId)),
		[pins, byRep, spiderPins],
	);
	const visiblePins = useMemo(
		() =>
			motion.pins === pins
				? shownPins
				: motion.pins.filter(
						(p) => !byRep.has(p.repId) || spiderPins.has(p.repId),
					),
		[motion.pins, pins, shownPins, byRep, spiderPins],
	);
	const pinFC = useMemo<FeatureCollection<Point>>(
		() => ({
			type: "FeatureCollection",
			features: [
				...shownPins.map((p) => ({
					type: "Feature" as const,
					geometry: { type: "Point" as const, coordinates: [p.lng, p.lat] },
					properties: {
						repId: p.repId,
						size: p.size,
						hollow: p.hollow,
						number: p.number,
					},
				})),
				...clusters
					.filter((c) => c.id !== spider?.id)
					.map((c) => ({
						type: "Feature" as const,
						geometry: { type: "Point" as const, coordinates: [c.lng, c.lat] },
						properties: {
							cluster: true,
							count: c.count,
							size: 26,
							repIds: c.repIds.join(","),
						},
					})),
			],
		}),
		[shownPins, clusters, spider],
	);

	const openCluster = useCallback((c: Cluster) => {
		const map = mapRef.current;
		if (!map) return;
		if (
			c.expansionZoom <= CLUSTER_MAX_ZOOM &&
			c.expansionZoom > map.getZoom()
		) {
			map.easeTo({
				center: [c.lng, c.lat],
				zoom: c.expansionZoom + 0.1,
				duration: reducedMotion() ? 0 : 400,
			});
		} else setSpider(c);
	}, []);

	// ---- hover + selection sync -------------------------------------------
	const hoveredReps = useMemo(() => {
		const s = new Set<string>();
		if (!hover) return s;
		const repOfItem = (id: string) => {
			const vk = fullModel.visitOfItem[id];
			const r = vk ? visitRep.get(vk) : undefined;
			if (r) s.add(r);
		};
		switch (hover.kind) {
			case "rep":
				s.add(hover.id);
				break;
			case "item":
				repOfItem(hover.id);
				break;
			case "pair": {
				const [a = "", b = ""] = hover.id.split(">");
				repOfItem(a);
				repOfItem(b);
				break;
			}
			case "edge": {
				const [a = "", b = ""] = hover.id.split("#")[0]?.split(">") ?? [];
				s.add(a);
				s.add(b);
				break;
			}
			case "day":
				for (const p of pins) if (p.dayIds.includes(hover.id)) s.add(p.repId);
				break;
		}
		return s;
	}, [hover, fullModel.visitOfItem, visitRep, pins]);

	const selFids = useMemo(
		() => selectedFids(shownEdges, fullModel, sel),
		[shownEdges, fullModel, sel],
	);

	// A selected leg or edge (from the map, the timeline or a link) is brought
	// into the uncovered part of the map, the same way.
	const selFidsRef = useRef({ selFids, shownEdges });
	selFidsRef.current = { selFids, shownEdges };
	useEffect(() => {
		void fitPadding;
		if (!loaded || (sel?.kind !== "leg" && sel?.kind !== "edge")) return;
		const { selFids: ids, shownEdges: fc } = selFidsRef.current;
		reveal(
			fc.features
				.filter((f) => ids.has(f.properties.fid))
				.flatMap((f) => f.geometry.coordinates),
		);
	}, [sel, loaded, fitPadding, reveal]);

	// On the globe the camera's own padding keeps it clear of the inspector /
	// sheet (`globeFit`): when they open or close, the untouched whole-trip
	// globe refits (smaller beside the inspector, MAP-01), a moved one slides;
	// unless a fit or a reveal is already on its way (declared after both, so
	// it sees them).
	useEffect(() => {
		const map = mapRef.current?.getMap();
		if (!map || !loaded || map.isMoving() || isCameraFollowing()) return;
		if (globe && !userMoved.current) return fitCamera(300);
		const { W, H } = mapSize(map);
		const want = globe
			? globeFit(padIn(fitPadding, W, H, 0.7), map.getPadding()).camera
			: NO_INSETS;
		if (sameInsets(map.getPadding(), want)) return;
		map.easeTo({ padding: want, duration: reducedMotion() ? 0 : 300 });
	}, [loaded, globe, fitPadding, fitCamera]);

	const hoverFids = useMemo(() => {
		const out = new Set<string>();
		if (!hover) return out;
		for (const f of shownEdges.features) {
			const p = f.properties;
			if (hover.kind === "edge" && p.edgeKey === hover.id) out.add(p.fid);
			else if (hover.kind === "pair" && p.pairKey === hover.id) out.add(p.fid);
			else if (hover.kind === "pair" && !p.pairKey) {
				const e = fullModel.edges.find((x) => x.key === p.edgeKey);
				const [a, b] = hover.id.split(">");
				if (e?.transitions.some((t) => t.fromItemId === a && t.toItemId === b))
					out.add(p.fid);
			} else if (
				hover.kind === "rep" &&
				(p.from === hover.id || p.to === hover.id)
			)
				out.add(p.fid);
		}
		return out;
	}, [hover, shownEdges, fullModel.edges]);

	useEffect(() => {
		const map = mapRef.current?.getMap();
		if (!map || !loaded) return;
		const onData = (e: {
			sourceId?: string;
			sourceDataType?: string;
			tile?: unknown;
		}) => {
			if (e.sourceId === EDGE_SOURCE && e.sourceDataType === "metadata")
				setEpoch((x) => x + 1);
			// A basemap tile that loads clears "Map tiles couldn't load".
			const next = tileHealthOnData(
				tilesRef.current,
				e,
				basemapSources.current,
			);
			if (next !== tilesRef.current) {
				tilesRef.current = next;
				setTiles(next);
			}
		};
		map.on("sourcedata", onData);
		return () => {
			map.off("sourcedata", onData);
		};
	}, [loaded]);

	useEffect(() => {
		const map = mapRef.current?.getMap();
		void epoch;
		if (!map || !loaded || !map.getSource(EDGE_SOURCE)) return;
		map.removeFeatureState({ source: EDGE_SOURCE });
		for (const id of selFids)
			map.setFeatureState({ source: EDGE_SOURCE, id }, { selected: true });
		for (const id of hoverFids)
			map.setFeatureState({ source: EDGE_SOURCE, id }, { hover: true });
	}, [selFids, hoverFids, loaded, epoch]);

	// ---- labels -------------------------------------------------------------
	const rightInset =
		variant === "desktop" && padding.right > 24 ? padding.right - 12 : 0;
	const [labels, setLabels] = useState<Map<string, LabelSide>>(() => new Map());
	const labelClusters = useMemo(
		() =>
			clusters
				.filter((c) => c.id !== spider?.id)
				.map((c) => [c.lng, c.lat] as [number, number]),
		[clusters, spider],
	);
	const labelPins = useMemo(
		() => shownPins.filter((p) => !spiderPins.has(p.repId)),
		[shownPins, spiderPins],
	);
	useEffect(() => {
		const map = mapRef.current?.getMap();
		if (!map || !loaded) return;
		const widths = new Map(labelPins.map((p) => [p.repId, textWidth(p.name)]));
		const relabel = () => {
			const next = placeLabels(
				map,
				labelPins,
				widths,
				lens,
				rightInset,
				labelClusters,
			);
			setLabels((prev) => (sameLabels(prev, next) ? prev : next));
		};
		relabel();
		map.on("moveend", relabel);
		map.on("resize", relabel);
		return () => {
			map.off("moveend", relabel);
			map.off("resize", relabel);
		};
	}, [loaded, labelPins, lens, rightInset, labelClusters]);

	// ---- the next stop (only on a current trip day): an apricot halo -------
	const nextRep = useMemo(() => {
		const now = Date.now();
		for (const it of ix.ordered) {
			const at = ws.schedule.items[it.id];
			if (!at || at.start.getTime() <= now) continue;
			if (ix.day(it.dayId)?.date !== todayIn(at.tz)) return null;
			const vk = fullModel.visitOfItem[it.id];
			return vk ? (visitRep.get(vk) ?? null) : null;
		}
		return null;
	}, [ix, ws.schedule, fullModel.visitOfItem, visitRep]);

	// ---- peers ------------------------------------------------------------
	const peerColors = useMemo(() => {
		const m = new Map<string, string>();
		for (const p of peers) {
			const s = p.view?.sel;
			if (s?.startsWith("n.")) m.set(s.slice(2), presenceColor(p.user.color));
		}
		return m;
	}, [peers]);

	// ---- edge tooltip (desktop hover) --------------------------------------
	const tipStore = useMemo(createEdgeTipStore, []);
	const tipData = useRef({ fullModel, ix, legs: ws.schedule.legs });
	tipData.current = { fullModel, ix, legs: ws.schedule.legs };
	const tipCache = useRef<{ fid: string; text: ReturnType<typeof edgeTip> }>(
		null,
	);
	const showTip = useCallback(
		(props: Partial<EdgeProps> | null, point: { x: number; y: number }) => {
			if (variant !== "desktop" || !props?.fid || !props.edgeKey) {
				tipCache.current = null;
				tipStore.set(null);
				return;
			}
			if (tipCache.current?.fid !== props.fid) {
				const d = tipData.current;
				tipCache.current = {
					fid: props.fid,
					text: edgeTip(
						{ edgeKey: props.edgeKey, pairKey: props.pairKey ?? null },
						d.fullModel,
						d.ix,
						(pk) => d.legs[pk]?.suggestion?.label ?? null,
					),
				};
			}
			const text = tipCache.current.text;
			if (!text) return tipStore.set(null);
			const c = mapRef.current?.getContainer();
			const W = c?.clientWidth ?? 1000;
			const H = c?.clientHeight ?? 800;
			tipStore.set({
				x: Math.min(point.x + 14, W - 290),
				y: point.y + 18 > H - 60 ? point.y - 56 : point.y + 18,
				...text,
			});
		},
		[variant, tipStore],
	);
	useEffect(() => {
		// New data or a new view: the hovered edge may be gone.
		void edges;
		tipCache.current = null;
		tipStore.set(null);
	}, [edges, tipStore]);

	// ---- handlers ---------------------------------------------------------
	const mapHovering = useRef(false);
	const ghostHover = useRef<string | number | null>(null);
	const [cursor, setCursor] = useState<string | undefined>(undefined);
	const selectPin = useCallback(
		(repId: string) => nav.select({ kind: "node", id: repId }),
		[nav],
	);
	const zoomInPin = useCallback((repId: string) => nav.zoomIn(repId), [nav]);
	const hoverPin = useCallback(
		(repId: string | null) =>
			setHover(repId ? { kind: "rep", id: repId } : null),
		[setHover],
	);

	const onClick = useCallback(
		(e: MapLayerMouseEvent) => {
			const f = e.features?.[0];
			if (f) {
				const s = parseSel(f.properties?.sel as string | undefined);
				if (s) nav.select(s);
				return;
			}
			setSpider(null);
			if (sel) nav.select(null);
		},
		[nav, sel],
	);
	const onDblClick = useCallback(
		(e: MapLayerMouseEvent) => {
			const f = e.features?.[0];
			if (f?.layer.id === GHOST_HIT) {
				e.preventDefault();
				const parent = (f.properties?.parentId as string | undefined) ?? null;
				nav.zoomTo(parent);
			}
		},
		[nav],
	);
	const onMouseMove = useCallback(
		(e: MapLayerMouseEvent) => {
			const target = e.originalEvent.target as Element | null;
			if (target?.closest?.(".maplibregl-marker")) return;
			const f = e.features?.[0];
			const map = mapRef.current?.getMap();
			// Ghost stubs hover through their own source.
			const gid = f?.layer.id === GHOST_HIT ? (f.id ?? null) : null;
			if (map && ghostHover.current !== gid) {
				if (ghostHover.current != null && map.getSource(GHOST_SOURCE))
					map.setFeatureState(
						{ source: GHOST_SOURCE, id: ghostHover.current },
						{ hover: false },
					);
				if (gid != null)
					map.setFeatureState(
						{ source: GHOST_SOURCE, id: gid },
						{ hover: true },
					);
				ghostHover.current = gid;
			}
			setCursor(f ? "pointer" : undefined);
			showTip(
				f?.layer.id === EDGE_HIT ? (f.properties as Partial<EdgeProps>) : null,
				e.point,
			);
			if (f?.layer.id === EDGE_HIT) {
				const pk = f.properties?.pairKey as string | undefined;
				const ek = f.properties?.edgeKey as string;
				const next = pk
					? { kind: "pair" as const, id: pk }
					: { kind: "edge" as const, id: ek };
				mapHovering.current = true;
				const cur = useUi.getState().hover;
				if (cur?.kind !== next.kind || cur.id !== next.id) setHover(next);
			} else if (mapHovering.current) {
				mapHovering.current = false;
				setHover(null);
			}
		},
		[setHover, showTip],
	);
	const onMouseLeave = useCallback(() => {
		setCursor(undefined);
		tipStore.set(null);
		if (mapHovering.current) {
			mapHovering.current = false;
			setHover(null);
		}
	}, [setHover, tipStore]);

	// MapLibre prints errors to the console unless someone listens. Tiles and
	// glyphs that fail to load (offline, a navigation aborting a fetch, a flaky
	// network) are expected: the basemap goes blank, the app doesn't break, and
	// the map says "Map tiles couldn't load" (QA ERR-06).
	const onError = useCallback((e: MapErrorEventLike) => {
		const next = tileHealthOnError(tilesRef.current, e, basemapSources.current);
		if (next !== tilesRef.current) {
			tilesRef.current = next;
			setTiles(next);
		}
		if (!isNetworkError(e.error)) console.error(e.error ?? e);
	}, []);

	const onMoveStart = useCallback((e: { originalEvent?: unknown }) => {
		// A drag, wheel or pinch (not our own easeTo): the person took the camera.
		if (e.originalEvent) userMoved.current = true;
	}, []);

	const onMoveEnd = useCallback(() => {
		const map = mapRef.current;
		if (!map) return;
		const z = map.getZoom();
		setZoom(z);
		setMapZoom(z);
	}, [setMapZoom]);

	const onLoad = useCallback(() => {
		setLoaded(true);
		const map = mapRef.current?.getMap();
		if (map) {
			const z = map.getZoom();
			setZoom(z);
			setMapZoom(z);
		}
		if (import.meta.env.VITE_E2E === "1" && map)
			(window as unknown as { __tripMap?: unknown }).__tripMap = map;
	}, [setMapZoom]);

	useEffect(() => {
		if (import.meta.env.VITE_E2E !== "1") return;
		const w = window as unknown as {
			__tripMap?: unknown;
			__tripMapStress?: (n: number) => void;
		};
		w.__tripMapStress = (n) => {
			const map = mapRef.current;
			const count = Math.max(0, Math.min(2000, n));
			if (map) setStress(count ? syntheticPins(count, map.getBounds()) : []);
		};
		return () => {
			delete w.__tripMap;
			delete w.__tripMapStress;
		};
	}, []);

	// FB-22: my camera travels; a followed person's camera is mirrored,
	// fitted to the part of MY map nothing covers (inspector, sheet, chrome).
	const { awareness } = useTripAwareness();
	const following = useUi((s) => s.following);
	const visibleInsets = useMemo(() => {
		if (variant === "mobile") {
			const h = typeof window === "undefined" ? 800 : window.innerHeight;
			const sheet =
				typeof sheetSnap === "number" && sheetSnap <= 1
					? Math.round(sheetSnap * h)
					: typeof sheetSnap === "string" && sheetSnap.endsWith("px")
						? Number.parseFloat(sheetSnap) || 150
						: 150;
			return { top: 112, right: 0, bottom: Math.min(sheet, h * 0.6), left: 0 };
		}
		return {
			top: padding.top,
			right: padding.right,
			bottom: padding.bottom,
			left: padding.left,
		};
	}, [variant, padding, sheetSnap]);
	useCameraFollow({
		map: loaded ? (mapRef.current?.getMap() ?? null) : null,
		awareness: ws.mode === "live" ? awareness : null,
		following,
		inset: visibleInsets,
		globe,
	});
	const camLeader = useCamFollow((s) => (s.paused ? s.leader : null));
	const resumeCam = useCamFollow((s) => s.resume);

	// FB-17: live cursors over the map travel as lng/lat (the cursor layer asks
	// this projector), and re-project whenever the camera moves.
	useEffect(() => {
		if (!loaded) return;
		const map = mapRef.current?.getMap();
		if (!map) return;
		const container = map.getContainer();
		const unregister = registerMapProjector({
			container,
			unproject(x, y) {
				const r = container.getBoundingClientRect();
				const ll = map.unproject([x - r.left, y - r.top]);
				return { lng: ll.lng, lat: ll.lat };
			},
			project(lng, lat) {
				const r = container.getBoundingClientRect();
				const p = map.project([lng, lat]);
				return { x: p.x + r.left, y: p.y + r.top };
			},
			easeTo(lng, lat) {
				const reduced =
					typeof matchMedia === "function" &&
					matchMedia("(prefers-reduced-motion: reduce)").matches;
				map.easeTo({ center: [lng, lat], duration: reduced ? 0 : 500 });
			},
		});
		const moved = () => notifyMapMoved();
		map.on("move", moved);
		map.on("resize", moved);
		return () => {
			map.off("move", moved);
			map.off("resize", moved);
			unregister();
		};
	}, [loaded]);

	// TI-6: what the map drew, for specs (pins are DOM markers, not a source).
	useEffect(() => {
		if (import.meta.env.VITE_E2E !== "1") return;
		const map = mapRef.current?.getMap() as
			| (MaplibreMap & { __yonder?: unknown })
			| undefined;
		if (!map || !loaded) return;
		map.__yonder = {
			lens,
			scopeId,
			pins: pins.map((p) => ({ ...p })),
			visiblePins: shownPins.map((p) => p.repId),
			clusters,
			edges: shownEdges,
			allEdges: edges,
			ghosts: ghosts.lines,
			chips,
			labels: Object.fromEntries(labels),
			selectedFids: [...selFids],
		};
	}, [
		loaded,
		lens,
		scopeId,
		pins,
		shownPins,
		clusters,
		shownEdges,
		edges,
		ghosts,
		chips,
		labels,
		selFids,
	]);

	// ---- chips + controls -------------------------------------------------
	const finer = useMemo(() => {
		const i = LENS_ORDER.indexOf(lens);
		for (const l of LENS_ORDER.slice(i + 1)) {
			const o = lensOptions.find((x) => x.lens === l);
			if (o?.enabled && o.visible) return l;
		}
		return null;
	}, [lens, lensOptions]);
	const showFiner = finer !== null && suggestsFinerLens(zoom, lens);

	// Edges fade in with the gesture and dim to 40% under a route preview.
	const edgeFade =
		Math.round((previewRoute || route ? 0.4 : 1) * motion.progress * 20) / 20;
	const layers = useMemo(
		() => edgeLayers(palette, edgeFade),
		[palette, edgeFade],
	);
	const gLayers = useMemo(
		() => ghostLayers(palette, edgeFade),
		[palette, edgeFade],
	);
	const gLabel = useMemo(() => ghostLabelLayer(palette), [palette]);
	const previewLayerProps = useMemo(() => previewLayer(palette), [palette]);
	// The chips and clusters don't move with the gesture: kept as the same
	// elements so the gesture's per-frame renders skip them (VIS2-11).
	const chipMarkers = useMemo(
		() =>
			chips.map((c) => (
				<EdgeChipMarker
					key={c.key}
					lng={c.lng}
					lat={c.lat}
					kind={c.kind}
					count={c.count}
					onClick={() => {
						const s = parseSel(c.sel);
						if (s) nav.select(s);
					}}
				/>
			)),
		[chips, nav],
	);
	const clusterMarkers = useMemo(
		() =>
			clusters
				.filter((c) => c.id !== spider?.id)
				.map((c) => (
					<ClusterMarker
						key={`c${c.id}`}
						lng={c.lng}
						lat={c.lat}
						count={c.count}
						proposalColor={
							c.repIds
								.map((id) => pinBy.get(id)?.proposal?.color)
								.find(Boolean) ?? null
						}
						onClick={() => openCluster(c)}
					/>
				)),
		[clusters, spider, pinBy, openCluster],
	);
	const preview = useMemo<FeatureCollection<LineString>>(
		() => ({ type: "FeatureCollection", features: previewRoute ?? [] }),
		[previewRoute],
	);
	const routeLines = useMemo<FeatureCollection<LineString>>(
		() => ({
			type: "FeatureCollection",
			features: (route ?? []).slice(1).map((s, i) => {
				const a = route?.[i] ?? s;
				return {
					type: "Feature",
					properties: {},
					geometry: {
						type: "LineString",
						coordinates: [
							[a.lng, a.lat],
							[s.lng, s.lat],
						],
					},
				};
			}),
		}),
		[route],
	);
	const routeLayerProps = useMemo(() => splitRouteLayer(palette), [palette]);
	// One badge per city (a city the route comes back to lists both stops).
	const routeStops = useMemo(() => {
		const by = new Map<string, NonNullable<typeof route>>();
		for (const s of route ?? [])
			by.set(s.cityId, [...(by.get(s.cityId) ?? []), s]);
		return [...by.values()];
	}, [route]);

	const isMobile = variant === "mobile";
	const controlStyle: CSSProperties = isMobile
		? { top: "calc(env(safe-area-inset-top, 0px) + 124px)", right: 12 }
		: { bottom: 12, right: padding.right > 24 ? padding.right : 12 };
	const chipTop = isMobile ? "calc(env(safe-area-inset-top, 0px) + 124px)" : 12;
	const empty = pins.length === 0 && ghosts.lines.features.length === 0;

	// biome-ignore lint/correctness/useExhaustiveDependencies: only the first render matters; afterwards fit() drives the camera
	const initialViewState = useMemo(() => {
		const b = fitBoundsFor(pins, { all: wholeTrip });
		if (b)
			return {
				bounds: b,
				fitBoundsOptions: { padding: 40, maxZoom: latest.current.maxFitZoom },
			};
		const c = ix.coordOf(scopeId);
		return c
			? { longitude: c[0], latitude: c[1], zoom: LENS_ZOOM[lens] - 2 }
			: { longitude: 135, latitude: 30, zoom: 1.5 };
	}, []);

	if (!styleSpec) {
		return (
			<div className="size-full animate-pulse bg-basemap-land" aria-hidden />
		);
	}

	return (
		<div
			className="yonder-map absolute inset-0"
			data-testid={MAP_TESTID.canvas}
			data-map-style={mapStyle}
			data-globe={globe ? "" : undefined}
		>
			{/* The basemap's tone (FB-04): a dark basemap in the light app (or a
			    light one in the dark app) keeps readable pins, labels and
			    attribution; the controls and chips outside keep the app's. */}
			<div
				className={cn(
					"yonder-map-ground absolute inset-0",
					theme === "dark" ? "dark is-dark" : "is-light",
				)}
			>
				{globe && theme === "dark" ? (
					<GlobeGlow mapRef={mapRef} loaded={loaded} />
				) : null}
				<MapGL
					ref={mapRef}
					mapLib={mapLib}
					workerUrl={workerUrl}
					initialViewState={initialViewState}
					// Carries the projection (`useProjectedStyle`): a style switch on
					// the globe reloads straight onto the globe, camera kept (FB-04).
					mapStyle={styleSpec}
					// A style switch reloads the whole style: a diff would drop the
					// projection and our layers without a `style.load`, after which
					// react-maplibre re-applies both.
					styleDiffing={false}
					// An object, not the string: react-maplibre 8 hands a CHANGED
					// projection prop straight to maplibre's setProjection, which reads
					// `.type` ("Unknown projection name: undefined" for a string).
					projection={globe ? GLOBE : MERCATOR}
					interactiveLayerIds={[EDGE_HIT, GHOST_HIT]}
					onClick={onClick}
					onDblClick={onDblClick}
					onMouseMove={onMouseMove}
					onMouseLeave={onMouseLeave}
					onMoveStart={onMoveStart}
					onMoveEnd={onMoveEnd}
					onLoad={onLoad}
					onError={onError}
					cursor={cursor}
					dragRotate={false}
					pitchWithRotate={false}
					touchPitch={false}
					maxZoom={19}
					attributionControl={false}
					style={{ position: "absolute", inset: 0 }}
				>
					<ArrowImage />
					<Attribution extra={usesN02 ? N02_CREDIT : undefined} />
					<Source
						id={EDGE_SOURCE}
						type="geojson"
						data={shownEdges}
						promoteId="fid"
					>
						{layers.map((l) => (
							<Layer key={l.id} {...l} />
						))}
					</Source>
					<Source
						id={GHOST_SOURCE}
						type="geojson"
						data={ghosts.lines}
						promoteId="fid"
						lineMetrics
					>
						{gLayers.map((l) => (
							<Layer key={l.id} {...l} />
						))}
					</Source>
					<Source id={GHOST_LABEL_SOURCE} type="geojson" data={ghosts.labels}>
						<Layer {...gLabel} />
					</Source>
					<Source id={PREVIEW_SOURCE} type="geojson" data={preview}>
						<Layer {...previewLayerProps} />
					</Source>
					<Source id={SPLIT_ROUTE_SOURCE} type="geojson" data={routeLines}>
						<Layer {...routeLayerProps} />
					</Source>
					<Source id={PIN_SOURCE} type="geojson" data={pinFC}>
						<Layer {...PIN_PROBE} />
					</Source>

					{chipMarkers}
					{spider ? (
						<SpiderLegs
							lng={spider.lng}
							lat={spider.lat}
							offsets={[...spiderPins.values()]}
						/>
					) : null}
					{visiblePins.map((p) => {
						const off = spiderPins.get(p.repId);
						return (
							<PinMarker
								key={p.repId}
								pin={
									off && spider ? { ...p, lng: spider.lng, lat: spider.lat } : p
								}
								offset={off}
								selected={p.repId === selectedRep}
								hovered={hoveredReps.has(p.repId)}
								next={p.repId === nextRep}
								peerColor={peerColors.get(p.repId) ?? null}
								label={off ? "right" : (labels.get(p.repId) ?? null)}
								onSelect={selectPin}
								onZoomIn={zoomInPin}
								onHover={hoverPin}
							/>
						);
					})}
					{clusterMarkers}
					{routeStops.map((stops) => (
						<SplitStopMarker key={stops[0]?.cityId} stops={stops} />
					))}
				</MapGL>
			</div>

			{showFiner && finer ? (
				<FinerChip
					label={`Show ${LENS_PLURAL[finer]}`}
					onClick={() => nav.setLens(finer)}
					style={{ top: chipTop, left: "50%", transform: "translateX(-50%)" }}
				/>
			) : null}
			{hint && !showFiner && !empty ? (
				<OneRepHint
					text={hint}
					action={finer ? `Show ${LENS_PLURAL[finer]}` : null}
					onAction={() => finer && nav.setLens(finer)}
					align={isMobile ? "start" : "center"}
					style={
						isMobile
							? { top: chipTop, left: 12, maxWidth: "calc(100% - 80px)" }
							: { top: chipTop, left: "50%", transform: "translateX(-50%)" }
					}
				/>
			) : null}
			{camLeader ? (
				<FollowBackChip
					name={camLeader.name}
					onClick={resumeCam}
					// Top centre, under a "Show cities" chip when there is one
					// (toasts own the bottom).
					style={{
						top:
							showFiner || (hint && !empty)
								? isMobile
									? "calc(env(safe-area-inset-top, 0px) + 176px)"
									: 52
								: chipTop,
						left: "50%",
						transform: "translateX(-50%)",
						zIndex: 5,
					}}
				/>
			) : null}
			{filterCount ? (
				<FilterChip
					match={filterCount.match}
					total={filterCount.total}
					description={filterText}
					onOpen={() => setFilterOpen(true)}
					onClear={() => setFilter(null)}
					style={{
						// Below a top-centre chip ("Show areas", the one-pin hint).
						top:
							showFiner || (hint && !empty)
								? isMobile
									? "calc(env(safe-area-inset-top, 0px) + 176px)"
									: 48
								: chipTop,
						left: 12,
						maxWidth: isMobile ? "calc(100% - 80px)" : 420,
					}}
				/>
			) : null}
			{tiles.down ? (
				<TilesDownChip
					style={
						isMobile
							? {
									// Under the chips of the top-left column (the sheet covers the bottom).
									top: `calc(env(safe-area-inset-top, 0px) + ${
										124 +
										52 *
											(
												(showFiner || (hint && !empty) ? 1 : 0) +
													(filterCount ? 1 : 0)
											)
									}px)`,
									left: 12,
									maxWidth: "calc(100% - 80px)",
								}
							: {
									// Above the attribution, clear of the controls and the inspector.
									bottom: 40,
									left: 12,
									maxWidth: `calc(100% - ${rightInset + 96}px)`,
								}
					}
				/>
			) : null}
			<MapControls
				variant={variant}
				palette={palette}
				satellite={mapStyle === "satellite"}
				setSatellite={setSatellite}
				style={controlStyle}
				onFit={() => {
					pauseCameraFollow();
					fitCamera(600);
				}}
				onZoom={(d) => {
					pauseCameraFollow();
					userMoved.current = true;
					if (d > 0) mapRef.current?.zoomIn();
					else mapRef.current?.zoomOut();
				}}
				show={show}
				setShow={setShow}
				dayMode={dayMode}
				setDayMode={setDayMode}
				daysActive={days !== null}
				filter={filter}
				setFilter={setFilter}
				members={ws.graph.members}
				meMemberId={access.memberId}
				filterOpen={filterOpen}
				onFilterOpenChange={setFilterOpen}
			/>
			<EdgeTooltip store={tipStore} />
			{empty ? (
				<EmptyMapCard
					onAdd={() =>
						openAddPlace({ mode: "search", parentId: scopeId ?? undefined })
					}
				/>
			) : null}
		</div>
	);
}
