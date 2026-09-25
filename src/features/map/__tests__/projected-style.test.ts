/**
 * FB-04 (QA re-test, defect 2): a style switch on the whole-trip globe kept
 * reloading in mercator, which clamped the FB-10 camera. The stylesheet the
 * map gets now carries the globe, and only a new basemap makes a new one.
 */
import type { StyleSpecification } from "maplibre-gl";
import { describe, expect, it } from "vitest";
import {
	FLAT_FROM,
	GLOBE,
	GLOBE_HERO,
	globeBasemap,
	HERO_UNTIL,
	heroTinted,
	nextProjectedStyle,
	type ProjectedStyleMemo,
	projectedStyle,
} from "../projected-style";
import dark from "../styles/yonder-dark.json";
import light from "../styles/yonder-light.json";
import satellite from "../styles/yonder-satellite.json";

type S = StyleSpecification;
const STYLES = { light, dark, satellite } as unknown as Record<
	"light" | "dark" | "satellite",
	S
>;

describe("projectedStyle", () => {
	for (const [name, base] of Object.entries(STYLES)) {
		it(`${name}: says globe on the globe, without touching the checked-in style`, () => {
			// The checked-in styles carry no projection: without ours they load in mercator.
			expect(base.projection).toBeUndefined();
			const spec = projectedStyle(base, true);
			expect(spec.projection).toEqual({ type: "globe" });
			expect(spec.sources).toBe(base.sources);
			expect(spec.layers).toBe(base.layers);
			expect(base.projection).toBeUndefined();
			expect(projectedStyle(base, false)).toBe(base);
		});
	}
});

describe("nextProjectedStyle", () => {
	const empty: ProjectedStyleMemo = { base: null, spec: null };

	it("no basemap yet: no spec", () => {
		expect(nextProjectedStyle(empty, null, true)).toBe(empty);
	});

	it("a basemap switch on the globe reloads straight onto the globe", () => {
		const a = nextProjectedStyle(empty, STYLES.light, true);
		expect(a.spec?.projection).toEqual(GLOBE);
		const b = nextProjectedStyle(a, STYLES.satellite, true);
		expect(b.spec).not.toBe(a.spec);
		expect(b.spec?.projection).toEqual(GLOBE);
		expect(b.spec?.name).toBe("Yonder satellite");
	});

	it("the globe coming or going keeps the same spec (no style reload; the projection prop does it)", () => {
		const a = nextProjectedStyle(empty, STYLES.dark, false);
		expect(a.spec).toBe(STYLES.dark);
		expect(nextProjectedStyle(a, STYLES.dark, true)).toBe(a);
		const g = nextProjectedStyle(empty, STYLES.dark, true);
		expect(nextProjectedStyle(g, STYLES.dark, false)).toBe(g);
	});

	it("a switch after leaving the globe loads flat again", () => {
		const a = nextProjectedStyle(empty, STYLES.light, true);
		const b = nextProjectedStyle(a, STYLES.dark, false);
		expect(b.spec).toBe(STYLES.dark);
		expect(b.spec?.projection).toBeUndefined();
	});
});

type Layer = S["layers"][number];
const paintOf = (s: S, id: string) =>
	(
		s.layers.find((l) => l.id === id) as Layer & {
			paint: Record<string, unknown>;
		}
	).paint;
const byZoom = (globe: unknown, flat: unknown) => [
	"interpolate",
	["linear"],
	["zoom"],
	HERO_UNTIL,
	globe,
	FLAT_FROM,
	flat,
];

describe("globeBasemap", () => {
	it("light: the checked-in style itself (no atmosphere, no recolouring)", () => {
		const spec = globeBasemap("light", STYLES.light);
		expect(spec).toBe(STYLES.light);
		expect(spec.sky).toBeUndefined();
		expect(spec.light).toBeUndefined();
	});

	it("satellite: the checked-in style itself (no atmosphere)", () => {
		const spec = globeBasemap("satellite", STYLES.satellite);
		expect(spec).toBe(STYLES.satellite);
		expect(spec.sky).toBeUndefined();
	});

	it("dark: no atmosphere, and the hero's colours at globe zooms only", () => {
		const spec = globeBasemap("dark", STYLES.dark);
		expect(spec.sky).toBeUndefined();
		expect(spec.light).toBeUndefined();
		expect(spec.sources).toBe(STYLES.dark.sources);
		expect(paintOf(spec, "background")["background-color"]).toEqual(
			byZoom(GLOBE_HERO.land, "#141414"),
		);
		expect(paintOf(spec, "water")["fill-color"]).toEqual(
			byZoom(GLOBE_HERO.water, "#141c26"),
		);
		for (const id of ["boundary_country_z0-4", "boundary_country_z5-"]) {
			expect(paintOf(spec, id)["line-color"]).toEqual(
				byZoom(GLOBE_HERO.border, "#3a3a3a"),
			);
			expect(paintOf(spec, id)["line-width"]).toEqual(byZoom(0.8, 1.1));
			expect(paintOf(spec, id)["line-dasharray"]).toEqual([3, 2]);
		}
		expect(paintOf(spec, "place_city")["text-halo-color"]).toEqual(
			byZoom(GLOBE_HERO.land, "#141414"),
		);
		expect(paintOf(spec, "water_name")["text-halo-color"]).toEqual(
			byZoom(GLOBE_HERO.water, "#141c26"),
		);
		// City-zoom layers are the checked-in ones.
		expect(spec.layers.find((l) => l.id === "building")).toBe(
			STYLES.dark.layers.find((l) => l.id === "building"),
		);
		// The checked-in style is untouched.
		expect(paintOf(STYLES.dark, "background")["background-color"]).toBe(
			"#141414",
		);
		expect(STYLES.dark.sky).toBeUndefined();
	});

	it("dark: every recoloured value is a zoom curve ending on today's colour by FLAT_FROM", () => {
		const tinted = heroTinted(STYLES.dark);
		let curves = 0;
		tinted.layers.forEach((layer, i) => {
			const before = (
				STYLES.dark.layers[i] as { paint?: Record<string, unknown> }
			).paint;
			const after = (layer as { paint?: Record<string, unknown> }).paint;
			for (const [k, v] of Object.entries(after ?? {})) {
				if (v === before?.[k]) continue;
				curves++;
				const c = v as unknown[];
				expect(c.slice(0, 4)).toEqual([
					"interpolate",
					["linear"],
					["zoom"],
					HERO_UNTIL,
				]);
				expect(c[5]).toBe(FLAT_FROM);
				expect(c[6]).toBe(before?.[k]);
			}
		});
		expect(curves).toBeGreaterThan(10);
	});

	it("feeds nextProjectedStyle without a reload when the globe comes or goes", () => {
		const dark = globeBasemap("dark", STYLES.dark);
		const empty: ProjectedStyleMemo = { base: null, spec: null };
		const a = nextProjectedStyle(empty, dark, true);
		expect(a.spec?.projection).toEqual(GLOBE);
		expect(a.spec?.sky).toBeUndefined();
		expect(nextProjectedStyle(a, dark, false)).toBe(a);
	});
});
