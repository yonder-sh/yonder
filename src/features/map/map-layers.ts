/**
 * MapLibre layer specs for edges, ghost stubs, the route preview, the stops'
 * order while the days per city change, and the pin probe (DESIGN §2.3 and §9.3). One GeoJSON source per kind; one line layer per
 * style so each keeps its own width, dash and cap (MapLibre dashes are in
 * multiples of the line width).
 *
 * Feature-state (`promoteId: 'fid'`): `hover` widens a line by 2px, `selected`
 * shows the 7px `--selected-edge` underlay. Properties (see `EdgeProps`):
 * `o` (dimming), `approx` (60%), `est` (dashed), `color`, `proposed`. The
 * per-feature dimming lives in the colours' alpha (`withAlpha`), so every
 * `line-opacity` is a constant a fade can change without re-tiling.
 *
 * ADDENDUM §10 (over DESIGN §2.3): **dashes mean an estimate or a proposal**
 * and nothing else. Known legs are solid (transit, taxi/car/ferry) or a solid
 * double rule (a flight, like the Plan's rail); walks, stays and overnight
 * connectors are round dots. Only `unset`, the `*-est` layers and the proposal
 * overlay carry a dash pattern (`DASHED_LAYERS`).
 */
import type { LayerProps } from "@vis.gl/react-maplibre";
import type { ExpressionSpecification } from "maplibre-gl";
import { type EdgeStyle, edgeWidth } from "./map-data";
import type { LinePalette } from "./palette";

export const EDGE_SOURCE = "yonder-edges";
export const GHOST_SOURCE = "yonder-ghosts";
export const GHOST_LABEL_SOURCE = "yonder-ghost-labels";
export const PREVIEW_SOURCE = "yonder-preview";
export const SPLIT_ROUTE_SOURCE = "yonder-split-route";
export const PIN_SOURCE = "yonder-pins";
export const EDGE_HIT = "yonder-edges-hit";
export const GHOST_HIT = "yonder-ghosts-hit";
export const ARROW_ICON = "yonder-arrow";

const HOVER: ExpressionSpecification = [
	"boolean",
	["feature-state", "hover"],
	false,
];
const SELECTED: ExpressionSpecification = [
	"boolean",
	["feature-state", "selected"],
	false,
];

/** Width that grows by `grow` px (2 by default) on hover. */
const width = (w: number, grow = 2): ExpressionSpecification => [
	"case",
	HOVER,
	w + grow,
	w,
];

/** Per-feature alpha: dimming × (60% when approx). */
const ALPHA: ExpressionSpecification = [
	"*",
	["to-number", ["get", "o"], 1],
	["case", ["boolean", ["get", "approx"], false], 0.6, 1],
];

/**
 * A colour with the feature's alpha (`ALPHA`) folded in. The layer's own
 * opacity then stays a constant (`base × dimAll`): changing a data-driven
 * `line-opacity` makes MapLibre re-tile the whole source in its worker, and
 * the lens gesture's edge fade did that up to 10 times per lens change
 * (VIS2-11). A constant opacity just repaints.
 */
export const withAlpha = (
	c: string | ExpressionSpecification,
): ExpressionSpecification => {
	const rgba: ExpressionSpecification = [
		"to-rgba",
		typeof c === "string" ? ["to-color", c] : c,
	];
	return [
		"rgba",
		["at", 0, rgba],
		["at", 1, rgba],
		["at", 2, rgba],
		["*", ["at", 3, rgba], ALPHA],
	];
};

/** A layer's opacity: its base × the gesture fade / preview dim (a constant). */
const opacity = (base: number, dimAll: number): number =>
	Math.round(base * dimAll * 1000) / 1000;

type Style = {
	id: string;
	filter: ExpressionSpecification;
	color: string | ExpressionSpecification;
	width: number;
	/** Only for estimates (ADDENDUM §10). Dots are `[0.01, n]` with round caps. */
	dash?: number[];
	/** A double rule: `width` is each rule, `gap` the space between them. */
	gap?: number;
	/** Hover growth (default 2px; a double rule grows each rule by 1px). */
	hover?: number;
	cap: "round" | "butt";
	base: number;
};

/** The edge layers that may be dashed: estimates, the unset leg and proposals. */
export const DASHED_LAYERS = [
	"yonder-edges-unset",
	"yonder-edges-other-est",
	"yonder-edges-flight-est",
	"yonder-edges-transit-est",
	"yonder-edges-proposed",
] as const;

function styles(p: LinePalette): Style[] {
	const is = (s: EdgeStyle): ExpressionSpecification => [
		"==",
		["get", "style"],
		s,
	];
	const est: ExpressionSpecification = ["boolean", ["get", "est"], false];
	const color: ExpressionSpecification = [
		"to-color",
		["get", "color"],
		p.transit,
	];
	return [
		// Dots, not dashes: the walk to/from your stay (with the bed glyph).
		{
			id: "stay",
			filter: is("stay"),
			color: p.other,
			width: edgeWidth("stay"),
			dash: [0.01, 2],
			cap: "round",
			base: 0.9,
		},
		// A night with no travel: muted dots (the Plan's dotted hairline).
		{
			id: "overnight",
			filter: is("overnight"),
			color: p.muted,
			width: edgeWidth("overnight"),
			dash: [0.01, 2.5],
			cap: "round",
			base: 0.45,
		},
		// No mode yet = an estimate ("est." minutes): dashed.
		{
			id: "unset",
			filter: is("unset"),
			color: p.muted,
			width: edgeWidth("unset"),
			dash: [1, 3],
			cap: "butt",
			// DESIGN §2.3 says 60%; 75% keeps the 1.75px line readable over busy tiles.
			base: 0.75,
		},
		// A known taxi / car / ferry ride: a plain solid line in its colour.
		{
			id: "other",
			filter: ["all", is("other"), ["!", est]],
			color,
			width: edgeWidth("other"),
			cap: "round",
			base: 1,
		},
		{
			id: "other-est",
			filter: ["all", is("other"), est],
			color,
			width: edgeWidth("other"),
			dash: [1.5, 2],
			cap: "butt",
			base: 0.85,
		},
		// A known flight: a solid double rule along the great-circle arc (the
		// Plan's flight rail). An estimated flight is still dashed.
		{
			id: "flight",
			filter: ["all", is("flight"), ["!", est]],
			color,
			width: FLIGHT_RULE,
			gap: FLIGHT_GAP,
			hover: 1,
			cap: "butt",
			base: 1,
		},
		{
			id: "flight-est",
			filter: ["all", is("flight"), est],
			color,
			width: edgeWidth("flight"),
			dash: [2.5, 2],
			cap: "butt",
			base: 0.85,
		},
		// Walks are dotted already; an estimated walk is just lighter.
		{
			id: "walk",
			filter: is("walk"),
			color,
			width: edgeWidth("walk"),
			dash: [0.01, 2],
			cap: "round",
			base: 1,
		},
		{
			id: "transit",
			filter: ["all", is("transit"), ["!", est]],
			color,
			width: edgeWidth("transit"),
			cap: "round",
			base: 1,
		},
		// ADDENDUM §10: dashed means an estimate (a Japan rail estimate on its N02 track).
		{
			id: "transit-est",
			filter: ["all", is("transit"), est],
			color,
			width: 3.5,
			dash: [2, 1.4],
			cap: "butt",
			base: 0.9,
		},
	];
}

/** Each rule of a known flight's double line, and the gap between them (px). */
export const FLIGHT_RULE = 1.5;
export const FLIGHT_GAP = 1.5;

/** The line width a casing wraps (a flight's double rule is 2 × rule + gap). */
const CASED_WIDTH: ExpressionSpecification = [
	"match",
	["get", "style"],
	"transit",
	4.5,
	"walk",
	3,
	"flight",
	FLIGHT_RULE * 2 + FLIGHT_GAP,
	2.5,
];

export function edgeLayers(p: LinePalette, dimAll = 1): LayerProps[] {
	const casing: LayerProps = {
		id: "yonder-edges-casing",
		type: "line",
		source: EDGE_SOURCE,
		filter: [
			"match",
			["get", "style"],
			["walk", "transit", "flight", "other", "stay"],
			true,
			false,
		],
		layout: { "line-join": "round", "line-cap": "round" },
		paint: {
			"line-color": withAlpha(p.casing),
			"line-width": [
				"case",
				HOVER,
				["+", 5, CASED_WIDTH],
				["+", 3, CASED_WIDTH],
			],
			"line-opacity": opacity(0.85, dimAll),
		},
	};
	const selected: LayerProps = {
		id: "yonder-edges-selected",
		type: "line",
		source: EDGE_SOURCE,
		layout: { "line-join": "round", "line-cap": "round" },
		paint: {
			"line-color": p.selected,
			"line-width": 11,
			"line-opacity": ["case", SELECTED, 1, 0],
		},
	};
	const lines: LayerProps[] = styles(p).map((s) => ({
		id: `yonder-edges-${s.id}`,
		type: "line",
		source: EDGE_SOURCE,
		filter: s.filter,
		layout: { "line-join": "round", "line-cap": s.cap },
		paint: {
			"line-color": withAlpha(s.color),
			"line-width": width(s.width, s.hover),
			"line-opacity": opacity(s.base, dimAll),
			...(s.gap ? { "line-gap-width": s.gap } : {}),
			...(s.dash ? { "line-dasharray": s.dash } : {}),
		},
	}));
	const proposed: LayerProps = {
		id: "yonder-edges-proposed",
		type: "line",
		source: EDGE_SOURCE,
		filter: ["to-boolean", ["get", "proposed"]],
		layout: { "line-join": "round", "line-cap": "butt" },
		paint: {
			"line-color": withAlpha(["to-color", ["get", "proposed"], p.primary]),
			"line-width": 1.5,
			"line-dasharray": [1.5, 2.5],
			"line-offset": 3.5,
			"line-opacity": opacity(0.85, dimAll),
		},
	};
	const arrows: LayerProps = {
		id: "yonder-edges-arrows",
		type: "symbol",
		source: EDGE_SOURCE,
		filter: [
			"all",
			["boolean", ["get", "arrows"], false],
			["!=", ["get", "style"], "unset"],
		],
		layout: {
			"symbol-placement": "line",
			"symbol-spacing": 80,
			"icon-image": ARROW_ICON,
			"icon-size": 0.75,
			"icon-allow-overlap": true,
			"icon-ignore-placement": true,
			"icon-rotation-alignment": "map",
		},
		paint: {
			"icon-color": withAlpha(["to-color", ["get", "color"], p.transit]),
			"icon-opacity": opacity(0.7, dimAll),
			"icon-halo-color": withAlpha(p.casing),
			"icon-halo-width": 1,
		},
	};
	const hit: LayerProps = {
		id: EDGE_HIT,
		type: "line",
		source: EDGE_SOURCE,
		layout: { "line-join": "round", "line-cap": "round" },
		paint: { "line-color": "#000000", "line-opacity": 0, "line-width": 16 },
	};
	return [selected, casing, ...lines, proposed, arrows, hit];
}

/** Ghost stubs: one layer per mode colour (`line-gradient` can't read feature data). */
export function ghostLayers(p: LinePalette, dimAll = 1): LayerProps[] {
	const modes: [EdgeStyle, string][] = [
		["walk", p.walk],
		["transit", p.transit],
		["flight", p.flight],
		["other", p.other],
		["unset", p.muted],
	];
	const layers: LayerProps[] = modes.map(([mode, color]) => ({
		id: `yonder-ghost-${mode}`,
		type: "line",
		source: GHOST_SOURCE,
		filter: ["==", ["get", "style"], mode],
		layout: { "line-cap": "round" },
		paint: {
			"line-width": ["case", HOVER, 4.5, 2.5],
			"line-opacity": dimAll,
			"line-gradient": [
				"interpolate",
				["linear"],
				["line-progress"],
				0,
				hexAlpha(color, 0.45),
				1,
				hexAlpha(color, 0),
			],
		},
	}));
	layers.push({
		id: GHOST_HIT,
		type: "line",
		source: GHOST_SOURCE,
		paint: { "line-color": "#000000", "line-opacity": 0, "line-width": 16 },
	});
	return layers;
}

export function ghostLabelLayer(p: LinePalette): LayerProps {
	return {
		id: "yonder-ghost-labels",
		type: "symbol",
		source: GHOST_LABEL_SOURCE,
		layout: {
			"text-field": ["get", "label"],
			"text-font": ["Noto Sans Italic"],
			"text-size": 11,
			"text-anchor": "center",
			"text-offset": [0, -0.9],
			"text-allow-overlap": false,
			"text-optional": true,
		},
		paint: {
			"text-color": p.label,
			"text-halo-color": p.labelHalo,
			"text-halo-width": 1.5,
		},
	};
}

export function previewLayer(p: LinePalette): LayerProps {
	return {
		id: "yonder-preview",
		type: "line",
		source: PREVIEW_SOURCE,
		layout: { "line-join": "round", "line-cap": "round" },
		paint: {
			"line-color": ["to-color", ["get", "color"], p.transit],
			"line-width": 4,
			"line-opacity": 0.9,
		},
	};
}

/** The stops in order while the days per city change (the Plan's "How long in each city?"). */
export function splitRouteLayer(p: LinePalette): LayerProps {
	return {
		id: "yonder-split-route",
		type: "line",
		source: SPLIT_ROUTE_SOURCE,
		layout: { "line-join": "round", "line-cap": "round" },
		paint: {
			"line-color": p.primary,
			"line-width": 3,
			"line-opacity": 0.85,
		},
	};
}

/** Invisible circles under the pin markers (TI-6: tests query rendered pins). */
export function pinProbeLayer(): LayerProps {
	return {
		id: "yonder-pins-probe",
		type: "circle",
		source: PIN_SOURCE,
		paint: {
			"circle-radius": ["/", ["to-number", ["get", "size"], 20], 2],
			"circle-opacity": 0,
			"circle-stroke-opacity": 0,
		},
	};
}

/** `#rrggbb` + alpha → `rgba()` (for gradients). */
export function hexAlpha(hex: string, a: number): string {
	const n = Number.parseInt(hex.slice(1), 16);
	return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
}

/** SDF chevron for direction arrows, drawn at runtime (no sprite). */
export function makeArrowImage(size = 32): ImageData | null {
	if (typeof document === "undefined") return null;
	const c = document.createElement("canvas");
	c.width = size;
	c.height = size;
	const ctx = c.getContext("2d", { willReadFrequently: true });
	if (!ctx) return null;
	ctx.fillStyle = "#000";
	ctx.beginPath();
	// Points east = the direction of travel for `symbol-placement: line`.
	ctx.moveTo(size * 0.3, size * 0.22);
	ctx.lineTo(size * 0.74, size * 0.5);
	ctx.lineTo(size * 0.3, size * 0.78);
	ctx.lineTo(size * 0.42, size * 0.5);
	ctx.closePath();
	ctx.fill();
	return ctx.getImageData(0, 0, size, size);
}
