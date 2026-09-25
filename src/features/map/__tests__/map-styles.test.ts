/**
 * The checked-in basemap styles (`pnpm map:styles`, DESIGN §2.5/§9.1): the
 * recolour is deterministic, POIs and icons are gone (no sprite needed), and
 * the colours are the palette's. FB-04: the Satellite style draws keyless
 * imagery with its attribution, the CSP lets its tiles in, and the map's
 * light tone inside the dark app mirrors the brand's light tokens.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildSecurityHeaders } from "@/server/security-headers.server";
import {
	buildSatelliteStyle,
	buildStyle,
	FALLBACK,
	mix,
	paletteFromCss,
	SATELLITE,
} from "../../../../scripts/build-map-styles";
import { effectiveMapStyle, mapTone } from "../palette";
import dark from "../styles/yonder-dark.json";
import light from "../styles/yonder-light.json";
import satellite from "../styles/yonder-satellite.json";

const ROOT = join(__dirname, "../../../..");

type L = {
	id: string;
	type: string;
	"source-layer"?: string;
	minzoom?: number;
	layout?: Record<string, unknown>;
	paint?: Record<string, unknown>;
};

describe("basemap styles", () => {
	for (const [name, style, pal] of [
		["light", light, FALLBACK.light],
		["dark", dark, FALLBACK.dark],
	] as const) {
		const layers = style.layers as L[];
		it(`${name}: no POIs, shields or icons, and no sprite`, () => {
			expect("sprite" in style).toBe(false);
			for (const l of layers) {
				expect(l["source-layer"]).not.toBe("poi");
				expect(l.id).not.toMatch(/shield|oneway|airport/);
				expect(
					Object.keys(l.layout ?? {}).some((k) => k.startsWith("icon-")),
				).toBe(false);
			}
			expect(Object.keys(style.sources)).toEqual(["openmaptiles"]);
		});
		it(`${name}: land, water and labels use the DESIGN §2.5 palette`, () => {
			const bg = layers.find((l) => l.type === "background");
			expect(bg?.paint?.["background-color"]).toBe(pal.land);
			const water = layers.find(
				(l) => l["source-layer"] === "water" && l.type === "fill",
			);
			expect(water?.paint?.["fill-color"]).toBe(pal.water);
			const city = layers.find((l) => /city/.test(l.id) && l.type === "symbol");
			expect(city?.paint?.["text-color"]).toBe(pal.label);
			const country = layers.find(
				(l) => /country/.test(l.id) && l.type === "symbol",
			);
			expect(country?.layout?.["text-transform"]).toBe("uppercase");
			const building = layers.find((l) => l["source-layer"] === "building");
			expect(building?.minzoom).toBe(15);
		});
	}

	it("reads the basemap tokens from styles.css blocks", () => {
		const css =
			":root { --basemap-land: #010203; } .dark { --basemap-water: #0a0b0c; }";
		expect(paletteFromCss(css, ":root", FALLBACK.light).land).toBe("#010203");
		expect(paletteFromCss(css, ".dark", FALLBACK.dark).water).toBe("#0a0b0c");
		expect(mix("#000000", "#ffffff", 0.5)).toBe("#808080");
	});

	it("drops rasters and icon layers from any OpenFreeMap-like base", () => {
		const out = buildStyle(
			{
				version: 8,
				sprite: "x",
				glyphs: "g",
				sources: {
					openmaptiles: { type: "vector" },
					ne2_shaded: { type: "raster" },
				},
				layers: [
					{ id: "background", type: "background" },
					{ id: "ne2", type: "raster", source: "ne2_shaded" },
					{ id: "poi_r1", type: "symbol", "source-layer": "poi" },
					{
						id: "label_city",
						type: "symbol",
						"source-layer": "place",
						layout: { "icon-image": "dot", "text-field": "{name}" },
					},
				],
			},
			FALLBACK.light,
			"t",
		);
		expect(out.layers.map((l) => l.id)).toEqual(["background", "label_city"]);
		expect(out.layers[1]?.layout?.["icon-image"]).toBeUndefined();
		expect(out.sprite).toBeUndefined();
	});
});

describe("Satellite (FB-04)", () => {
	const layers = satellite.layers as L[];
	type Src = {
		type: string;
		tiles?: string[];
		attribution?: string;
		url?: string;
	};
	const sources = satellite.sources as Record<string, Src>;

	it("draws keyless Esri imagery under the names, with its attribution", () => {
		expect(sources.satellite?.type).toBe("raster");
		expect(sources.satellite?.tiles?.[0]).toMatch(
			/^https:\/\/server\.arcgisonline\.com\/ArcGIS\/rest\/services\/World_Imagery\/MapServer\/tile\/\{z\}\/\{y\}\/\{x\}$/,
		);
		expect(sources.satellite?.tiles?.[0]).not.toMatch(/token|key=/i);
		expect(sources.satellite?.attribution).toContain("Esri");
		expect(sources.satellite?.attribution).toContain(
			"Esri, Vantor, Earthstar Geographics, and the GIS User Community",
		);
		// The OpenFreeMap names keep their own © OpenMapTiles/OSM (from the TileJSON).
		expect(sources.openmaptiles?.url).toBe(
			"https://tiles.openfreemap.org/planet",
		);
		expect(layers[0]?.type).toBe("background");
		expect(layers[1]).toMatchObject({
			id: "satellite",
			type: "raster",
			source: "satellite",
		});
		// Names in white on a dark halo, above the imagery; no icons (no sprite).
		const city = layers.find((l) => l.id === "place_city");
		expect(city?.paint?.["text-color"]).toBe("#f4f6fb");
		expect(String(city?.paint?.["text-halo-color"])).toMatch(
			/^rgba\(8, 10, 18/,
		);
		expect("sprite" in satellite).toBe(false);
		for (const l of layers)
			expect(
				Object.keys(l.layout ?? {}).some((k) => k.startsWith("icon-")),
			).toBe(false);
		expect(layers.some((l) => l["source-layer"] === "boundary")).toBe(true);
	});

	it("is what the build script makes from an OpenFreeMap-like base", () => {
		const out = buildSatelliteStyle({
			version: 8,
			glyphs: "g",
			sources: {
				openmaptiles: { type: "vector" },
				ne2_shaded: { type: "raster" },
			},
			layers: [
				{ id: "background", type: "background" },
				{ id: "water", type: "fill", "source-layer": "water" },
				{
					id: "highway_motorway_inner",
					type: "line",
					"source-layer": "transportation",
					minzoom: 6,
				},
				{ id: "highway_minor", type: "line", "source-layer": "transportation" },
				{
					id: "boundary_country_z5-",
					type: "line",
					"source-layer": "boundary",
				},
				{ id: "poi_r1", type: "symbol", "source-layer": "poi" },
				{
					id: "place_city",
					type: "symbol",
					"source-layer": "place",
					layout: { "icon-image": "dot" },
				},
			],
		});
		expect(out.layers.map((l) => l.id)).toEqual([
			"background",
			"satellite",
			"highway_motorway_inner",
			"boundary_country_z5-",
			"place_city",
		]);
		expect(Object.keys(out.sources)).toEqual(["satellite", "openmaptiles"]);
		expect(out.sources.satellite).toMatchObject({
			type: "raster",
			maxzoom: SATELLITE.maxzoom,
		});
		expect(out.layers[2]?.minzoom).toBe(8);
	});

	it("the CSP lets every raster host of the styles in (connect-src and img-src)", () => {
		const csp =
			buildSecurityHeaders({
				S3_PUBLIC_ENDPOINT: undefined,
				S3_ENDPOINT: "http://localhost:8080",
				VITE_COLLAB_URL: undefined,
				isProduction: true,
				APP_URL: "https://trips.example.com",
			})["Content-Security-Policy"] ?? "";
		const directive = (name: string) =>
			csp
				.split(";")
				.map((d) => d.trim())
				.find((d) => d.startsWith(`${name} `)) ?? "";
		for (const style of [light, dark, satellite])
			for (const src of Object.values(style.sources as Record<string, Src>))
				for (const url of [
					...(src.tiles ?? []),
					...(src.url ? [src.url] : []),
				]) {
					const origin = new URL(url.replace(/\{[^}]+\}/g, "0")).origin;
					expect(directive("connect-src"), origin).toContain(origin);
					if (src.type === "raster")
						expect(directive("img-src"), origin).toContain(origin);
				}
	});

	it("the map follows the app theme unless satellite is on; satellite is a dark tone", () => {
		expect(effectiveMapStyle(undefined, "dark")).toBe("dark");
		expect(effectiveMapStyle(undefined, "light")).toBe("light");
		expect(effectiveMapStyle("satellite", "light")).toBe("satellite");
		// An old saved light or dark no longer overrides the theme.
		expect(effectiveMapStyle("light", "dark")).toBe("dark");
		expect(effectiveMapStyle("dark", "light")).toBe("light");
		expect(mapTone("satellite")).toBe("dark");
		expect(mapTone("dark")).toBe("dark");
		expect(mapTone("light")).toBe("light");
	});
});

describe("the map's light tone inside the dark app (FB-04)", () => {
	/** `--name: value;` pairs of the first block whose selector matches. */
	const block = (css: string, selector: RegExp): Map<string, string> => {
		const plain = css.replace(/\/\*[\s\S]*?\*\//g, "");
		const m = new RegExp(`${selector.source}\\s*\\{([^}]*)\\}`).exec(plain);
		const out = new Map<string, string>();
		for (const d of (m?.[1] ?? "").split(";")) {
			const i = d.indexOf(":");
			const k = d.slice(0, i).trim();
			if (k.startsWith("--"))
				out.set(
					k,
					d
						.slice(i + 1)
						.trim()
						.replace(/\s+/g, " "),
				);
		}
		return out;
	};
	it("mirrors :root of the brand theme and styles.css, token by token", () => {
		const read = (p: string) => readFileSync(join(ROOT, p), "utf8");
		const mapCss = block(
			read("src/features/map/map.css"),
			/:where\(\.dark\) \.yonder-map-ground\.is-light/,
		);
		const brand = block(read("brand/tokens/theme.css"), /:root/);
		const app = block(read("src/styles.css"), /:root/);
		expect(mapCss.size).toBeGreaterThan(30);
		for (const [k, v] of mapCss) {
			const want = brand.get(k) ?? app.get(k);
			expect(want, `${k} is a light token`).toBeDefined();
			expect(v, k).toBe(want);
		}
	});
});
