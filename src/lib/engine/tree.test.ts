import "./__fixtures__/host-tz";
import { describe, expect, it } from "vitest";
import { demo, N, scenario } from "./__fixtures__/demo";
import { indexGraph } from "./graph-index";
import {
	allowedChildTypes,
	allowedTypes,
	canMoveUnder,
	canNest,
	categoryForType,
	isSchedulable,
	resolveSlugPath,
	siblingSlugs,
	slugify,
	slugPath,
	uniqueSlug,
} from "./tree";

const ix = indexGraph(demo.graph);

describe("nesting (§7.1)", () => {
	it("allows a child rank ≥ its parent's; anything at the root", () => {
		expect(canNest("area", "area")).toBe(true); // Asakusa › Kappabashi
		expect(canNest("place", "place")).toBe(true); // Nakano Broadway › shop
		expect(canNest("region", "area")).toBe(true); // Mt. Fuji › Kawaguchiko
		expect(canNest("place", "city")).toBe(false);
		expect(canNest(null, "place")).toBe(true);
		expect(allowedChildTypes(ix, N.tokyo as string)).toEqual([
			"city",
			"area",
			"place",
		]);
		expect(allowedChildTypes(ix, null)).toHaveLength(5);
	});

	it("limits type changes between the parent's rank and the lowest child rank", () => {
		expect(allowedTypes(ix, N.asakusa as string)).toEqual(["city", "area"]); // child Kappabashi is an area
		expect(allowedTypes(ix, N.hands as string)).toEqual(["area", "place"]);
		expect(allowedTypes(ix, N.japan as string)).toEqual(["country", "region"]); // its coarsest child, Mt. Fuji, is a region
		expect(allowedTypes(ix, "unknown")).toEqual([]);
		expect(categoryForType("area", "bar")).toBeNull();
		expect(categoryForType("place", null)).toBe("other");
		expect(categoryForType("place", "bar")).toBe("bar");
	});

	it("refuses moves that would invert ranks or create a cycle", () => {
		expect(canMoveUnder(ix, N.itoya as string, N.shibuya as string)).toBe(true);
		expect(canMoveUnder(ix, N.tokyo as string, N.shibuya as string)).toBe(
			false,
		);
		expect(canMoveUnder(ix, N.asakusa as string, N.kappabashi as string)).toBe(
			false,
		); // its own child
		expect(canMoveUnder(ix, N.tokyo as string, null)).toBe(true);
	});

	it("does not schedule dropped nodes or anything under them", () => {
		const s = scenario({
			nodes: [
				{
					key: "gone",
					parent: "japan",
					type: "city",
					name: "Dropped city",
					status: "dropped",
				},
				{ key: "inside", parent: "gone", type: "place", name: "Inside" },
			],
			days: [],
		});
		const i2 = indexGraph(s.graph);
		expect(isSchedulable(i2, s.N.inside as string)).toBe(false);
		expect(isSchedulable(i2, N.tokyo as string)).toBe(true);
	});
});

describe("slugs and scope URLs", () => {
	it("NFKD-normalises, strips diacritics, and falls back for pure CJK", () => {
		expect(slugify("Sensō-ji", "x")).toBe("senso-ji");
		expect(slugify("Türkiye", "x")).toBe("turkiye");
		expect(slugify("  Bar Benfiddich!! ", "x")).toBe("bar-benfiddich");
		expect(slugify("Hồ Chí Minh City", "x")).toBe("ho-chi-minh-city");
		expect(slugify("浅草寺", "0192f3ab-1234")).toBe("n-0192f3");
		expect(slugify("a".repeat(70), "x")).toHaveLength(60);
		expect(slugify(`${"a".repeat(59)} b`, "x")).toBe("a".repeat(59));
	});

	it("dedupes against live siblings with -2, -3", () => {
		expect(uniqueSlug("tokyo", [])).toBe("tokyo");
		expect(uniqueSlug("tokyo", ["tokyo", "tokyo-2"])).toBe("tokyo-3");
		expect(siblingSlugs(ix, N.tokyo as string, N.itoya as string)).toEqual([
			"shibuya",
			"harajuku",
			"asakusa",
		]);
	});

	it("round-trips a scope URL and stops at the deepest segment that resolves", () => {
		expect(slugPath(ix, N.knifeShop as string)).toEqual([
			"japan",
			"tokyo",
			"asakusa",
			"kappabashi",
			"kama-asa-knives",
		]);
		const ok = resolveSlugPath(ix, ["japan", "tokyo", "shibuya"]);
		expect(ok).toMatchObject({ complete: true, node: { id: N.shibuya } });
		const renamed = resolveSlugPath(ix, [
			"japan",
			"tokyo",
			"shibuya-old",
			"hands",
		]);
		expect(renamed.complete).toBe(false);
		expect(renamed.node?.id).toBe(N.tokyo);
		expect(resolveSlugPath(ix, [])).toEqual({
			node: null,
			path: [],
			complete: true,
		});
	});
});
