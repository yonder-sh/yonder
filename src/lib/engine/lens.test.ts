import "./__fixtures__/host-tz";
import { describe, expect, it } from "vitest";
import { demo, N, scenario } from "./__fixtures__/demo";
import { indexGraph } from "./graph-index";
import {
	defaultLens,
	lensAfterZoomIn,
	lensAfterZoomOut,
	lensOptions,
	repAt,
	resolveLens,
	stepLens,
	suggestsFinerLens,
} from "./lens";

const ix = indexGraph(demo.graph);
const enabled = (scopeId: string | null) =>
	lensOptions(ix, scopeId)
		.filter((o) => o.enabled && o.visible)
		.map((o) => o.lens);

describe("repAt (§8.2)", () => {
	it("picks the outermost node of the lens type below the scope", () => {
		expect(repAt(ix, N.hands as string, "area", null)).toEqual({
			id: N.shibuya,
			mode: "exact",
		});
		expect(repAt(ix, N.hands as string, "city", null)).toEqual({
			id: N.tokyo,
			mode: "exact",
		});
		expect(repAt(ix, N.hands as string, "country", null)).toEqual({
			id: N.japan,
			mode: "exact",
		});
		// Area under area: the outer area wins at the root, the inner one inside Asakusa.
		expect(repAt(ix, N.knifeShop as string, "area", null)).toEqual({
			id: N.asakusa,
			mode: "exact",
		});
		expect(
			repAt(ix, N.knifeShop as string, "area", N.asakusa as string),
		).toEqual({ id: N.kappabashi, mode: "exact" });
	});

	it("falls back to a finer node when the path skips the lens type, else the node itself (coarser)", () => {
		expect(repAt(ix, N.ryokan as string, "city", null)).toEqual({
			id: N.kawaguchiko,
			mode: "finer",
		});
		expect(repAt(ix, N.tokyo as string, "area", null)).toEqual({
			id: N.tokyo,
			mode: "coarser",
		});
		expect(repAt(ix, N.tokyo as string, "place", null)).toEqual({
			id: N.tokyo,
			mode: "coarser",
		});
		expect(repAt(ix, N.hands as string, "place", null)).toEqual({
			id: N.hands,
			mode: "exact",
		});
		expect(repAt(ix, "unknown", "city", null)).toEqual({
			id: "unknown",
			mode: "coarser",
		});
	});

	it("uses the whole path for a node outside the scope", () => {
		expect(repAt(ix, N.kiyomizu as string, "city", N.tokyo as string)).toEqual({
			id: N.kyoto,
			mode: "exact",
		});
	});
});

describe("lens options", () => {
	it("enables everything at the root; region is visible only when a region exists", () => {
		expect(enabled(null)).toEqual([
			"country",
			"region",
			"city",
			"area",
			"place",
		]);
		const flat = indexGraph({
			...demo.graph,
			nodes: demo.graph.nodes.filter(
				(n) =>
					n.type !== "region" && n.parentId !== N.mtFuji && n.id !== N.ryokan,
			),
		});
		expect(lensOptions(flat, null).find((o) => o.lens === "region")).toEqual({
			lens: "region",
			enabled: true,
			visible: false,
		});
	});

	it("enables finer levels, the scope's own level when it nests, and always place", () => {
		expect(enabled(N.japan as string)).toEqual([
			"region",
			"city",
			"area",
			"place",
		]);
		expect(enabled(N.tokyo as string)).toEqual(["area", "place"]);
		expect(enabled(N.shibuya as string)).toEqual(["place"]);
		expect(enabled(N.asakusa as string)).toEqual(["area", "place"]);
		expect(enabled(N.hands as string)).toEqual(["place"]);
		expect(enabled(N.southKorea as string)).toEqual(["city", "area", "place"]); // no region in Korea
	});

	it("a trip that stays in one country opens at its cities", () => {
		const japanOnly = indexGraph(
			scenario({
				days: [
					{ items: [{ k: "sensoji", node: "sensoji" }] },
					{ night: "ryokan", items: [{ k: "kiyomizu", node: "kiyomizu" }] },
				],
			}).graph,
		);
		expect(defaultLens(japanOnly, null)).toBe("city");
		expect(defaultLens(japanOnly, N.japan as string)).toBe("region");
		// The demo goes to Japan and Korea: countries, as before.
		expect(defaultLens(ix, null)).toBe("country");
	});

	it("defaults to the first usable level finer than the scope", () => {
		expect(defaultLens(ix, null)).toBe("country");
		expect(defaultLens(ix, N.japan as string)).toBe("region");
		expect(defaultLens(ix, N.southKorea as string)).toBe("city");
		expect(defaultLens(ix, N.tokyo as string)).toBe("area");
		expect(defaultLens(ix, N.asakusa as string)).toBe("place");
		expect(defaultLens(ix, N.hands as string)).toBe("place");
		expect(resolveLens(ix, N.tokyo as string, "country")).toBe("area");
		expect(resolveLens(ix, N.tokyo as string, "place")).toBe("place");
		expect(resolveLens(ix, null, undefined)).toBe("country");
	});
});

describe("navigation (§8.5)", () => {
	it("zoomIn keeps going one level finer when usable, else the new default", () => {
		expect(lensAfterZoomIn(ix, "country", N.japan as string)).toBe("region");
		expect(lensAfterZoomIn(ix, "country", N.southKorea as string)).toBe("city"); // region hidden in Korea
		expect(lensAfterZoomIn(ix, "city", N.tokyo as string)).toBe("area");
		expect(lensAfterZoomIn(ix, "area", N.shibuya as string)).toBe("place");
	});

	it("zoomOut goes one level coarser when usable, else the parent's default", () => {
		expect(lensAfterZoomOut(ix, "area", N.japan as string)).toBe("city");
		expect(lensAfterZoomOut(ix, "place", N.tokyo as string)).toBe("area");
		expect(lensAfterZoomOut(ix, "region", null)).toBe("country");
	});

	it("steps across usable levels and stays put at the ends", () => {
		expect(stepLens(ix, N.southKorea as string, "city", -1)).toBe("city");
		expect(stepLens(ix, null, "country", 1)).toBe("region");
		expect(stepLens(ix, null, "place", 1)).toBe("place");
		expect(stepLens(ix, N.tokyo as string, "place", -1)).toBe("area");
	});

	it("offers a finer lens when the map is zoomed well past the lens", () => {
		expect(suggestsFinerLens(14, "city")).toBe(true);
		expect(suggestsFinerLens(13, "city")).toBe(false);
		expect(suggestsFinerLens(20, "place")).toBe(false);
	});
});
