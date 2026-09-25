/**
 * `pnpm map:styles` (WP-Map, SPEC §18.3, DESIGN §9.1): builds the basemap
 * styles the map ships with, `src/features/map/styles/yonder-{light,dark,
 * satellite}.json`. Light and dark come from OpenFreeMap's keyless styles
 * (Positron for light, Dark for dark), recoloured to DESIGN §2.5 and trimmed:
 *
 * - background → land; water → water; parks and woods → park
 * - roads → road on a road casing; minor roads and paths only from z13
 * - every POI, shield, one-way arrow and airport icon removed (no sprite needed)
 * - building footprints at 4% ink from z15; rail lines as faint context
 * - labels in the basemap label colour with a 1.2px halo; country labels
 *   uppercase with 0.1em tracking; only city/town labels below z10
 * - boundaries dashed `[3, 2]`
 * - the Natural Earth raster (hill shading) dropped
 *
 * Colours are read from `src/styles.css` (`--basemap-*` in `:root` and
 * `.dark`, which mirror DESIGN §2.5); map styles need hex, not oklch (BRAND.md).
 *
 * Satellite (owner feedback FB-04): keyless Esri World Imagery (`SATELLITE`,
 * with its attribution) under the Dark style's place, water and road names,
 * country boundaries and a faint major-road network, all in white on a soft
 * dark halo; the imagery slightly desaturated so pins and routes stay the
 * loudest thing on the map.
 *
 * The outputs are checked in; re-run when OpenFreeMap or the palette changes.
 * A file whose content is unchanged is left alone (it may be Biome-formatted).
 *
 *   N pnpm map:styles            # fetch, recolour, write
 *   N pnpm map:styles --check    # exit 1 when the checked-in files are stale
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

type Json = null | boolean | number | string | Json[] | { [k: string]: Json };
type Layer = {
	id: string;
	type: string;
	source?: string;
	"source-layer"?: string;
	minzoom?: number;
	maxzoom?: number;
	filter?: Json;
	layout?: Record<string, Json>;
	paint?: Record<string, Json>;
	[k: string]: unknown;
};
type Style = {
	version: number;
	name?: string;
	sources: Record<string, Record<string, Json>>;
	sprite?: string;
	glyphs?: string;
	layers: Layer[];
	[k: string]: unknown;
};

export type BasemapPalette = {
	land: string;
	water: string;
	park: string;
	road: string;
	roadCasing: string;
	boundary: string;
	label: string;
	labelHalo: string;
	/** Building footprints (ink at 4%). */
	ink: string;
};

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT_DIR = join(ROOT, "src/features/map/styles");
const SOURCES = {
	light: "https://tiles.openfreemap.org/styles/positron",
	dark: "https://tiles.openfreemap.org/styles/dark",
} as const;

/** DESIGN §2.5 (used when styles.css can't be read). */
export const FALLBACK: Record<"light" | "dark", BasemapPalette> = {
	light: {
		land: "#f0f2f7",
		water: "#d9e3ee",
		park: "#e3ece6",
		road: "#ffffff",
		roadCasing: "#e0e3eb",
		boundary: "#c3c9d6",
		label: "#6b7285",
		labelHalo: "#f0f2f7",
		ink: "#181d2f",
	},
	dark: {
		land: "#141414",
		water: "#141c26",
		park: "#141a16",
		road: "#202020",
		roadCasing: "#2e2e2e",
		boundary: "#3a3a3a",
		label: "#8f8f8f",
		labelHalo: "#141414",
		ink: "#eef0f6",
	},
};

const TOKEN: Record<Exclude<keyof BasemapPalette, "ink">, string> = {
	land: "--basemap-land",
	water: "--basemap-water",
	park: "--basemap-park",
	road: "--basemap-road",
	roadCasing: "--basemap-road-casing",
	boundary: "--basemap-boundary",
	label: "--basemap-label",
	labelHalo: "--basemap-label-halo",
};

/** Reads the `--basemap-*` hex values of one CSS block (`:root {` or `.dark {`). */
export function paletteFromCss(
	css: string,
	block: ":root" | ".dark",
	fallback: BasemapPalette,
): BasemapPalette {
	const out = { ...fallback };
	// Every block with that selector (styles.css has one of each with basemap tokens).
	const re = new RegExp(`${block.replace(".", "\\.")}\\s*\\{([^}]*)\\}`, "g");
	for (const m of css.matchAll(re)) {
		const body = m[1] ?? "";
		for (const [k, name] of Object.entries(TOKEN)) {
			const v = new RegExp(`${name}:\\s*(#[0-9a-fA-F]{6})`).exec(body)?.[1];
			if (v) out[k as keyof typeof TOKEN] = v.toLowerCase();
		}
	}
	return out;
}

const POI_SOURCE_LAYERS = new Set([
	"poi",
	"aerodrome_label",
	"mountain_peak",
	"housenumber",
]);

/** `true` when a layer should not ship at all. */
function dropLayer(l: Layer): boolean {
	if (
		l.source === "ne2_shaded" ||
		l.type === "raster" ||
		l.type === "hillshade"
	)
		return true;
	const sl = l["source-layer"] ?? "";
	if (POI_SOURCE_LAYERS.has(sl)) return true;
	const id = l.id.toLowerCase();
	if (
		/shield|oneway|^poi|_poi\b|airport|landuse_residential|ice_shelf|glacier/.test(
			id,
		)
	)
		return true;
	return false;
}

const isLabel = (l: Layer) => l.type === "symbol";

/** Removes icons from symbol layers (city dots etc.), so no sprite is needed. */
function stripIcons(layout: Record<string, Json>): Record<string, Json> {
	const out: Record<string, Json> = {};
	for (const [k, v] of Object.entries(layout))
		if (!k.startsWith("icon-")) out[k] = v;
	if (
		out["text-anchor"] !== undefined &&
		typeof out["text-anchor"] !== "string"
	)
		out["text-anchor"] = "center";
	delete out["text-offset"];
	delete out["text-variable-anchor"];
	delete out["text-variable-anchor-offset"];
	delete out["text-justify"];
	return out;
}

function labelLayer(l: Layer, p: BasemapPalette): Layer {
	const sl = l["source-layer"] ?? "";
	const id = l.id.toLowerCase();
	const layout = stripIcons({ ...(l.layout ?? {}) });
	const paint: Record<string, Json> = {
		"text-color": p.label,
		"text-halo-color": p.labelHalo,
		"text-halo-width": 1.2,
		"text-halo-blur": 0,
	};
	const next: Layer = { ...l, layout, paint };
	if (sl === "place") {
		const country = /country/.test(id);
		const cityOrTown = /city|town/.test(id);
		const state = /state/.test(id);
		if (country) {
			layout["text-transform"] = "uppercase";
			layout["text-letter-spacing"] = 0.1;
			layout["text-size"] = [
				"interpolate",
				["linear"],
				["zoom"],
				2,
				10,
				6,
				13,
			] as Json;
			paint["text-color"] = p.label;
		} else if (cityOrTown) {
			layout["text-size"] = [
				"interpolate",
				["linear"],
				["zoom"],
				4,
				11,
				10,
				12,
				14,
				13,
			] as Json;
		} else if (state) {
			layout["text-size"] = 11;
			layout["text-transform"] = "uppercase";
			layout["text-letter-spacing"] = 0.08;
			next.minzoom = Math.max(l.minzoom ?? 0, 5);
			next.maxzoom = Math.min(l.maxzoom ?? 24, 8);
		} else {
			// Villages, suburbs, hamlets: only from z10 (DESIGN §9.1).
			layout["text-size"] = 11;
			next.minzoom = Math.max(l.minzoom ?? 0, 10);
		}
	} else if (sl === "transportation_name") {
		layout["text-size"] = 10;
		next.minzoom = Math.max(l.minzoom ?? 0, 13);
		paint["text-halo-width"] = 1;
	} else if (sl === "water_name" || sl === "waterway") {
		layout["text-size"] = 11;
		paint["text-color"] = mix(p.label, p.water, 0.25);
		paint["text-halo-color"] = p.water;
	}
	return next;
}

function recolour(l: Layer, p: BasemapPalette): Layer {
	const sl = l["source-layer"] ?? "";
	const id = l.id.toLowerCase();
	const paint = { ...(l.paint ?? {}) };
	const next: Layer = { ...l, paint };
	switch (l.type) {
		case "background":
			next.paint = { "background-color": p.land };
			return next;
		case "fill": {
			if (sl === "water")
				next.paint = { "fill-color": p.water, "fill-antialias": true };
			else if (sl === "park" || /park/.test(id))
				next.paint = { "fill-color": p.park, "fill-opacity": 0.9 };
			else if (/wood|forest|grass/.test(id))
				next.paint = { "fill-color": p.park, "fill-opacity": 0.55 };
			else if (sl === "building") {
				next.paint = { "fill-color": p.ink, "fill-opacity": 0.04 };
				next.minzoom = 15;
			} else if (sl === "aeroway")
				next.paint = { "fill-color": p.roadCasing, "fill-opacity": 0.6 };
			else if (sl === "transportation")
				next.paint = { "fill-color": p.road, "fill-opacity": 0.9 };
			else next.paint = { "fill-color": p.land };
			return next;
		}
		case "line": {
			const width = paint["line-width"] ?? 1;
			if (sl === "waterway") {
				next.paint = { "line-color": p.water, "line-width": width };
			} else if (sl === "boundary") {
				next.paint = {
					"line-color": p.boundary,
					"line-width": /3|state|disputed/.test(id) ? 0.8 : 1.1,
					"line-dasharray": [3, 2],
				};
			} else if (sl === "aeroway") {
				next.paint = { "line-color": p.roadCasing, "line-width": width };
			} else if (/rail/.test(id)) {
				// Rail lines are useful context for transit; keep them faint.
				const dash = /dash/.test(id);
				next.paint = dash
					? {
							"line-color": p.land,
							"line-width": width,
							"line-dasharray": [2, 3],
						}
					: {
							"line-color": p.boundary,
							"line-width": width,
							"line-opacity": 0.7,
						};
			} else if (sl === "transportation") {
				const casing = /casing/.test(id);
				const subtle = /subtle/.test(id);
				next.paint = {
					"line-color": casing || subtle ? p.roadCasing : p.road,
					"line-width": width,
				};
				if (/minor|path|pier/.test(id))
					next.minzoom = Math.max(l.minzoom ?? 0, 13);
			} else {
				next.paint = { "line-color": p.roadCasing, "line-width": width };
			}
			delete next.layout?.["line-dasharray"];
			return next;
		}
		default:
			return next;
	}
}

/** Linear mix of two hex colours (t = share of b). */
export function mix(a: string, b: string, t: number): string {
	const pa = [1, 3, 5].map((i) => Number.parseInt(a.slice(i, i + 2), 16));
	const pb = [1, 3, 5].map((i) => Number.parseInt(b.slice(i, i + 2), 16));
	return `#${pa
		.map((v, i) => Math.round(v * (1 - t) + (pb[i] ?? 0) * t))
		.map((v) => v.toString(16).padStart(2, "0"))
		.join("")}`;
}

/**
 * FB-04: the Satellite style's imagery, keyless: Esri World Imagery (global;
 * 0.3–1 m in cities, so the place lens still shows streets). Its terms ask for
 * "Powered by Esri" and the service's own copyright line (MapServer
 * `copyrightText`). Beyond z18 MapLibre overzooms instead of fetching Esri's
 * "Map data not yet available" tiles in rural areas.
 */
export const SATELLITE = {
	type: "raster",
	tiles: [
		"https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
	],
	tileSize: 256,
	maxzoom: 18,
	attribution:
		'Powered by <a href="https://www.esri.com/" target="_blank" rel="noopener noreferrer">Esri</a> · Source: Esri, Vantor, Earthstar Geographics, and the GIS User Community',
} as const;

/** Names over imagery: near-white text on a soft dark halo. */
export const SATELLITE_PALETTE: BasemapPalette = {
	land: "#0b0e17",
	water: "#0b1a2b",
	park: "#0b0e17",
	road: "#ffffff",
	roadCasing: "#0b0e17",
	boundary: "#ffffff",
	label: "#f4f6fb",
	labelHalo: "#0b0e17",
	ink: "#ffffff",
};
const SATELLITE_HALO = "rgba(8, 10, 18, 0.72)";

/**
 * The Satellite style (pure; exported for the unit test): the imagery, then
 * a faint major-road network, the boundaries and the names of an
 * OpenFreeMap base (the Dark style), recoloured for imagery.
 */
export function buildSatelliteStyle(
	base: Style,
	name = "Yonder satellite",
): Style {
	const p = SATELLITE_PALETTE;
	const kept = base.layers.filter((l) => !dropLayer(l));
	const roads: Layer[] = kept
		.filter(
			(l) =>
				l.type === "line" &&
				l["source-layer"] === "transportation" &&
				/^highway_(motorway|major)_inner$/.test(l.id),
		)
		.map((l) => ({
			...l,
			minzoom: Math.max(l.minzoom ?? 0, 8),
			paint: {
				"line-color": p.road,
				"line-width": l.paint?.["line-width"] ?? 1,
				"line-opacity": [
					"interpolate",
					["linear"],
					["zoom"],
					8,
					0.16,
					14,
					0.32,
				] as Json,
			},
		}));
	const boundaries: Layer[] = kept
		.filter((l) => l.type === "line" && l["source-layer"] === "boundary")
		.map((l) => {
			const minor = /state|disputed/.test(l.id.toLowerCase());
			// Sea borders are noise over imagery (dashes across open water).
			const onLand: Json = ["!=", ["get", "maritime"], 1];
			return {
				...l,
				filter: l.filter ? (["all", l.filter, onLand] as Json) : onLand,
				paint: {
					"line-color": p.boundary,
					"line-width": minor ? 0.8 : 1.1,
					"line-opacity": minor ? 0.3 : 0.55,
					"line-dasharray": [3, 2],
				},
			};
		});
	const labels: Layer[] = kept.filter(isLabel).map((l) => {
		const next = labelLayer(l, p);
		next.paint = {
			...next.paint,
			"text-halo-color": SATELLITE_HALO,
			"text-halo-width": 1.4,
			"text-halo-blur": 0.4,
		};
		return next;
	});
	const vector: Style["sources"] = {};
	for (const [k, v] of Object.entries(base.sources))
		if (k !== "ne2_shaded" && v.type !== "raster") vector[k] = v;
	return {
		version: 8,
		name,
		metadata: {
			"yonder:generated":
				"scripts/build-map-styles.ts: Esri World Imagery under OpenFreeMap names (© OpenMapTiles © OpenStreetMap contributors); do not edit by hand",
		},
		sources: {
			satellite: { ...SATELLITE } as unknown as Record<string, Json>,
			...vector,
		},
		glyphs: base.glyphs,
		layers: [
			{
				id: "background",
				type: "background",
				paint: { "background-color": p.land },
			},
			{
				id: "satellite",
				type: "raster",
				source: "satellite",
				paint: {
					"raster-saturation": -0.15,
					"raster-brightness-max": 0.92,
					"raster-fade-duration": 150,
				},
			},
			...roads,
			...boundaries,
			...labels,
		],
	};
}

/** The pure transform (exported for the unit test). */
export function buildStyle(
	base: Style,
	p: BasemapPalette,
	name: string,
): Style {
	const layers = base.layers
		.filter((l) => !dropLayer(l))
		.map((l) => (isLabel(l) ? labelLayer(l, p) : recolour(l, p)));
	const sources: Style["sources"] = {};
	for (const [k, v] of Object.entries(base.sources))
		if (k !== "ne2_shaded" && v.type !== "raster") sources[k] = v;
	const out: Style = {
		version: 8,
		name,
		metadata: {
			"yonder:generated":
				"scripts/build-map-styles.ts from OpenFreeMap (© OpenMapTiles © OpenStreetMap contributors); do not edit by hand",
		},
		sources,
		glyphs: base.glyphs,
		layers,
	};
	return out;
}

/** Same style content (the checked-in files may be Biome-formatted). */
function sameContent(file: string, style: Style): boolean {
	try {
		return (
			JSON.stringify(JSON.parse(readFileSync(file, "utf8"))) ===
			JSON.stringify(style)
		);
	} catch {
		return false;
	}
}

async function main() {
	const check = process.argv.includes("--check");
	let css = "";
	try {
		css = readFileSync(join(ROOT, "src/styles.css"), "utf8");
	} catch {
		// defaults
	}
	const palettes = {
		light: paletteFromCss(css, ":root", FALLBACK.light),
		dark: paletteFromCss(css, ".dark", FALLBACK.dark),
	};
	const bases: Partial<Record<"light" | "dark", Style>> = {};
	for (const mode of ["light", "dark"] as const) {
		const res = await fetch(SOURCES[mode], {
			headers: { "user-agent": "yonder-build-map-styles" },
		});
		if (!res.ok) throw new Error(`${SOURCES[mode]}: HTTP ${res.status}`);
		bases[mode] = (await res.json()) as Style;
	}
	const out: [string, Style, number][] = [];
	for (const mode of ["light", "dark"] as const) {
		const base = bases[mode] as Style;
		out.push([
			mode,
			buildStyle(base, palettes[mode], `Yonder ${mode}`),
			base.layers.length,
		]);
	}
	const dark = bases.dark as Style;
	out.push(["satellite", buildSatelliteStyle(dark), dark.layers.length]);

	let stale = false;
	for (const [mode, style, from] of out) {
		const file = join(OUT_DIR, `yonder-${mode}.json`);
		if (sameContent(file, style)) {
			if (!check) console.log(`unchanged ${file}`);
			continue;
		}
		if (check) {
			stale = true;
			console.error(`stale: ${file}`);
			continue;
		}
		writeFileSync(file, `${JSON.stringify(style, null, "\t")}\n`);
		console.log(`wrote ${file}: ${style.layers.length} layers (from ${from})`);
	}
	if (stale) process.exitCode = 1;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1])
	await main();
