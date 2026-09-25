/**
 * The basemap as MapLibre gets it: the recoloured style plus the projection
 * the map is on when it's set (FB-04).
 *
 * A style switch reloads the whole style (`styleDiffing={false}`), and a
 * stylesheet without a projection comes up in mercator: MapLibre moves the
 * camera onto a mercator transform, which clamps the whole-trip globe's
 * camera (centre 63°N → 20°N on a desktop, lat 0 and zoom 0 → 0.72 on a
 * phone) before react-maplibre puts the globe back. The FB-10 framing was
 * lost until Fit or a reload. A stylesheet that already says `globe` keeps
 * the camera where it is.
 */
import type { LayerSpecification, StyleSpecification } from "maplibre-gl";
import type { MapStyle } from "./palette";

// Objects, not strings: react-maplibre 8 hands a CHANGED projection prop
// straight to maplibre's setProjection, which reads `.type`.
export const GLOBE = { type: "globe" } as const;
export const MERCATOR = { type: "mercator" } as const;

/** The Overview hero's planet (`HERO` in overview/globe/GlobeMap.tsx). */
export const GLOBE_HERO = {
	land: "#1b2029",
	water: "#0b1017",
	border: "#343c49",
} as const;

/**
 * The dark basemap wears the hero's colours up to `HERO_UNTIL` and today's
 * by `FLAT_FROM`, where the globe has all but flattened: the flat map at city
 * zooms is untouched.
 */
export const HERO_UNTIL = 4;
export const FLAT_FROM = 6;

type Paint = Record<string, unknown>;

/** Paint (globe value per property) for the dark layers seen at globe zooms. */
const DARK_GLOBE: Record<string, Paint> = {
	background: { "background-color": GLOBE_HERO.land },
	water: { "fill-color": GLOBE_HERO.water },
	waterway: { "line-color": GLOBE_HERO.water },
	// The hero has no parks or airports: they melt into the land.
	landuse_park: { "fill-color": GLOBE_HERO.land },
	"aeroway-area": { "fill-color": GLOBE_HERO.land },
	// Motorways and state lines stay, quieter than the country borders.
	highway_motorway_subtle: { "line-color": "#252b35" },
	boundary_state: { "line-color": "#282f3a" },
	"boundary_country_z0-4": {
		"line-color": GLOBE_HERO.border,
		"line-width": 0.8,
	},
	"boundary_country_z5-": {
		"line-color": GLOBE_HERO.border,
		"line-width": 0.8,
	},
};

/** The globe value at `HERO_UNTIL`, the flat one from `FLAT_FROM`. */
const byZoom = (globe: unknown, flat: unknown) => [
	"interpolate",
	["linear"],
	["zoom"],
	HERO_UNTIL,
	globe,
	FLAT_FROM,
	flat,
];

function darkGlobePaint(layer: LayerSpecification): Paint | undefined {
	// Label halos follow the ground they sit on.
	if (layer.type === "symbol")
		return (layer.minzoom ?? 0) < FLAT_FROM
			? {
					"text-halo-color":
						layer["source-layer"] === "water_name"
							? GLOBE_HERO.water
							: GLOBE_HERO.land,
				}
			: undefined;
	return DARK_GLOBE[layer.id];
}

/** The dark basemap in the hero's colours at globe zooms (a copy). */
export function heroTinted(base: StyleSpecification): StyleSpecification {
	const layers = base.layers.map((layer) => {
		const globe = darkGlobePaint(layer);
		if (!globe || !("paint" in layer) || !layer.paint) return layer;
		const flat = layer.paint as Paint;
		const paint: Paint = { ...flat };
		for (const [k, v] of Object.entries(globe)) {
			// A zoom curve can't nest inside another: only constants blend.
			const f = flat[k];
			if (typeof f === "string" || typeof f === "number")
				paint[k] = byZoom(v, f);
		}
		return { ...layer, paint } as LayerSpecification;
	});
	return { ...base, layers };
}

/**
 * The basemap as loaded, ready for the whole-trip globe. No atmosphere on any
 * of them (MapLibre's halo is lit by a sun: a glare on one side, or the whole
 * planet glowing; the owner had it removed). The light and satellite basemaps
 * are the checked-in styles themselves; the dark one takes the Overview hero's
 * colours at globe zooms. Dark tones float in space (map.css).
 */
export function globeBasemap(
	style: MapStyle,
	base: StyleSpecification,
): StyleSpecification {
	return style === "dark" ? heroTinted(base) : base;
}

/** `base` drawn on the globe (a copy) or flat (`base` itself). */
export function projectedStyle(
	base: StyleSpecification,
	globe: boolean,
): StyleSpecification {
	return globe ? { ...base, projection: GLOBE } : base;
}

/**
 * Remembers one derived spec per basemap: only a new basemap makes a new
 * spec (and so a style reload). The globe coming or going later goes through
 * the map's `projection` prop, which needs no reload.
 */
export type ProjectedStyleMemo = {
	base: StyleSpecification | null;
	spec: StyleSpecification | null;
};

export function nextProjectedStyle(
	memo: ProjectedStyleMemo,
	base: StyleSpecification | null,
	globe: boolean,
): ProjectedStyleMemo {
	if (memo.base === base) return memo;
	return { base, spec: base && projectedStyle(base, globe) };
}
