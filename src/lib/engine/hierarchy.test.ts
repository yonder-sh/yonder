import "./__fixtures__/host-tz";
import { describe, expect, it } from "vitest";
import { nodes } from "./__fixtures__/asia-trip";
import {
	compareGranularity,
	createHierarchy,
	HierarchyError,
	type HierarchyNode,
	NODE_TYPE_ORDER,
	validateHierarchy,
} from "./hierarchy";

const h = createHierarchy(nodes);
const ids = (list: readonly HierarchyNode[]) => list.map((n) => n.id);

const node = (
	id: string,
	parentId: string | null,
	type: HierarchyNode["type"],
	extra: Partial<HierarchyNode> = {},
): HierarchyNode => ({
	id,
	parentId,
	type,
	name: id,
	lat: 0,
	lng: 0,
	...extra,
});

describe("granularity ordering", () => {
	it("orders coarse to fine", () => {
		expect(NODE_TYPE_ORDER).toEqual([
			"country",
			"region",
			"city",
			"area",
			"place",
		]);
		expect(compareGranularity("country", "place")).toBeLessThan(0);
		expect(compareGranularity("area", "city")).toBeGreaterThan(0);
		expect(compareGranularity("city", "city")).toBe(0);
	});
});

describe("lookups", () => {
	it("indexes the real trip", () => {
		expect(h.size).toBe(nodes.length);
		expect(h.get("golden-gai")?.name).toBe("Golden Gai");
		expect(h.has("nope")).toBe(false);
		expect(() => h.require("nope")).toThrow(RangeError);
		expect(ids(h.roots())).toEqual(["us", "jp", "kr", "vn", "tw"]);
		expect(h.parent("golden-gai")?.id).toBe("shinjuku");
		expect(h.parent("jp")).toBeUndefined();
		expect(ids(h.children("tokyo"))).toEqual([
			"haneda",
			"shibuya",
			"shinjuku",
			"asakusa",
			"nakano",
			"teamlab-planets",
		]);
		expect(h.children("golden-gai")).toEqual([]);
		expect(h.children("unknown")).toEqual([]);
	});

	it("reports depth", () => {
		expect(h.depth("jp")).toBe(0);
		expect(h.depth("tokyo")).toBe(1);
		expect(h.depth("golden-gai")).toBe(3);
		expect(h.depth("oishi-park")).toBe(4); // jp > yamanashi > fujikawaguchiko > kawaguchiko > oishi
		expect(h.depth("icn")).toBe(1);
		expect(h.depth("unknown")).toBe(-1);
	});
});

describe("ancestors / path", () => {
	it("returns nearest-first ancestors of Golden Gai", () => {
		expect(ids(h.ancestors("golden-gai"))).toEqual(["shinjuku", "tokyo", "jp"]);
		expect(ids(h.ancestors("golden-gai", { includeSelf: true }))).toEqual([
			"golden-gai",
			"shinjuku",
			"tokyo",
			"jp",
		]);
	});

	it("builds a root-first breadcrumb path", () => {
		expect(h.path("golden-gai").map((n) => n.name)).toEqual([
			"Japan",
			"Tokyo",
			"Shinjuku",
			"Golden Gai",
		]);
		expect(ids(h.path("sa-pa"))).toEqual(["vn", "lao-cai-province", "sa-pa"]);
		expect(ids(h.path("jp"))).toEqual(["jp"]);
	});

	it("handles roots and unknown ids", () => {
		expect(h.ancestors("jp")).toEqual([]);
		expect(h.ancestors("unknown")).toEqual([]);
		expect(h.path("unknown")).toEqual([]);
	});
});

describe("descendants / subtree", () => {
	it("walks Shinjuku depth-first in input order", () => {
		expect(ids(h.descendants("shinjuku"))).toEqual([
			"golden-gai",
			"bar-benfiddich",
			"yodobashi-shinjuku",
			"omoide-yokocho",
			"hotel-gracery",
		]);
	});

	it("walks Tokyo pre-order including areas and a place directly under the city", () => {
		const d = ids(h.descendants("tokyo", { includeSelf: true }));
		expect(d[0]).toBe("tokyo");
		expect(d.slice(1, 5)).toEqual([
			"haneda",
			"hnd",
			"anamori-inari",
			"jal-sky-museum",
		]);
		expect(d.at(-1)).toBe("teamlab-planets");
		expect(d).toHaveLength(1 + 6 + 3 + 2 + 5 + 2 + 1); // tokyo + 6 children + grandchildren
	});

	it("exposes cached subtree id sets", () => {
		const s = h.subtreeIds("jp");
		expect(s.has("jp")).toBe(true);
		expect(s.has("golden-gai")).toBe(true);
		expect(s.has("oishi-park")).toBe(true);
		expect(s.has("icn")).toBe(false);
		expect(h.subtreeIds("jp")).toBe(s); // cached
		expect(h.subtreeIds("unknown").size).toBe(0);
		expect([...h.subtreeIds("golden-gai")]).toEqual(["golden-gai"]);
	});

	it("answers subtree membership (ancestor-or-self)", () => {
		expect(h.isInSubtree("golden-gai", "jp")).toBe(true);
		expect(h.isInSubtree("golden-gai", "tokyo")).toBe(true);
		expect(h.isInSubtree("golden-gai", "golden-gai")).toBe(true);
		expect(h.isInSubtree("tokyo", "golden-gai")).toBe(false);
		expect(h.isInSubtree("golden-gai", "shibuya")).toBe(false);
		expect(h.isInSubtree("icn", "seoul")).toBe(false);
		expect(h.isInSubtree("unknown", "jp")).toBe(false);
		expect(h.isInSubtree("jp", "unknown")).toBe(false);
	});
});

describe("nearestOfType (exact) vs collapseTo (with fallback)", () => {
	it("finds exact-type ancestors", () => {
		expect(h.nearestOfType("golden-gai", "city")?.id).toBe("tokyo");
		expect(h.nearestOfType("golden-gai", "country")?.id).toBe("jp");
		expect(h.nearestOfType("golden-gai", "place")?.id).toBe("golden-gai");
		expect(h.nearestOfType("golden-gai", "region")).toBeUndefined(); // Tokyo has no region
		expect(h.nearestOfType("icn", "city")).toBeUndefined(); // ICN sits directly under Korea
	});

	it("collapses a place to its area", () => {
		expect(h.collapseTo("golden-gai", "area")?.id).toBe("shinjuku");
		expect(h.collapseTo("golden-gai", "city")?.id).toBe("tokyo");
		expect(h.collapseTo("golden-gai", "country")?.id).toBe("jp");
		expect(h.collapseTo("golden-gai", "place")?.id).toBe("golden-gai");
	});

	it("falls back to the city when the area level is missing", () => {
		expect(h.collapseTo("teamlab-planets", "area")?.id).toBe("tokyo");
		expect(h.collapseTo("kix", "area")?.id).toBe("osaka");
		expect(h.collapseTo("fushimi-inari", "area")?.id).toBe("kyoto");
		expect(h.collapseTo("gyeongbokgung", "area")?.id).toBe("seoul");
	});

	it("falls back to the country when city and region are missing", () => {
		expect(h.collapseTo("icn", "city")?.id).toBe("kr");
		expect(h.collapseTo("icn", "area")?.id).toBe("kr");
		expect(h.collapseTo("tpe", "city")?.id).toBe("tw");
	});

	it("uses regions only where they exist", () => {
		expect(h.collapseTo("oishi-park", "region")?.id).toBe("yamanashi");
		expect(h.collapseTo("chureito", "region")?.id).toBe("yamanashi");
		expect(h.collapseTo("sa-pa", "region")?.id).toBe("lao-cai-province");
		expect(h.collapseTo("lao-cai-station", "region")?.id).toBe(
			"lao-cai-province",
		);
		expect(h.collapseTo("golden-gai", "region")?.id).toBe("jp"); // no Kanto node -> country
		expect(h.collapseTo("ewr", "region")?.id).toBe("nj");
	});

	it("returns nodes already coarser than the granularity unchanged", () => {
		expect(h.collapseTo("tokyo", "place")?.id).toBe("tokyo");
		expect(h.collapseTo("shinjuku", "place")?.id).toBe("shinjuku");
		expect(h.collapseTo("jp", "area")?.id).toBe("jp");
		expect(h.collapseTo("unknown", "area")).toBeUndefined();
	});

	it("keeps nested places at place granularity (shop inside a mall)", () => {
		const nested = createHierarchy([
			...nodes,
			node("mandarake", "nakano-broadway", "place", { name: "Mandarake" }),
		]);
		expect(nested.collapseTo("mandarake", "place")?.id).toBe("mandarake");
		expect(nested.collapseTo("mandarake", "area")?.id).toBe("nakano");
	});
});

describe("time zone resolution", () => {
	it("inherits from the nearest ancestor", () => {
		expect(h.resolveTimezone("golden-gai")).toBe("Asia/Tokyo");
		expect(h.resolveTimezone("icn")).toBe("Asia/Seoul");
		expect(h.resolveTimezone("sa-pa")).toBe("Asia/Ho_Chi_Minh");
		expect(h.resolveTimezone("tpe")).toBe("Asia/Taipei");
		expect(h.resolveTimezone("ewr")).toBe("America/New_York"); // from the New Jersey region
	});

	it("returns undefined when nothing on the path has a zone", () => {
		expect(h.resolveTimezone("us")).toBeUndefined();
		expect(h.resolveTimezone("unknown")).toBeUndefined();
	});

	it("prefers the node's own zone and canonicalizes case", () => {
		const x = createHierarchy([
			node("c", null, "country", { tz: "Asia/Tokyo" }),
			node("p", "c", "place", { tz: "asia/seoul" }),
			node("bad", "c", "place", { tz: "Mars/Olympus_Mons" }),
		]);
		expect(x.resolveTimezone("p")).toBe("Asia/Seoul");
		expect(x.resolveTimezone("bad")).toBe("Asia/Tokyo"); // invalid zone skipped
	});
});

describe("commonAncestor", () => {
	it("finds the lowest common ancestor", () => {
		expect(h.commonAncestor("golden-gai", "yodobashi-shinjuku")?.id).toBe(
			"shinjuku",
		);
		expect(h.commonAncestor("golden-gai", "sensoji")?.id).toBe("tokyo");
		expect(h.commonAncestor("golden-gai", "dotonbori")?.id).toBe("jp");
		expect(h.commonAncestor("golden-gai", "shinjuku")?.id).toBe("shinjuku");
		expect(h.commonAncestor("golden-gai", "icn")).toBeUndefined();
		expect(h.commonAncestor("golden-gai", "unknown")).toBeUndefined();
	});
});

describe("validation", () => {
	it("accepts the real trip; only the multi-zone US country lacks a zone (its region has one)", () => {
		expect(validateHierarchy(nodes)).toEqual([
			expect.objectContaining({
				code: "no-timezone",
				severity: "warning",
				nodeId: "us",
			}),
		]);
	});

	it("reports every issue kind", () => {
		const issues = validateHierarchy([
			node("jp", null, "country", { tz: "Asia/Tokyo" }),
			node("jp", null, "country"),
			node("orphan", "missing", "place"),
			node("a", "b", "area", { tz: "Asia/Tokyo" }),
			node("b", "a", "area"),
			node("city-under-area", "a", "city"),
			node("bad-tz", "jp", "place", { tz: "Not/A_Zone" }),
			node("bad-coords", "jp", "place", { lat: 123, lng: 0 }),
			node("weird", "jp", "planet" as HierarchyNode["type"]),
			node("no-tz", null, "country"),
		]);
		const codes = issues.map((i) => `${i.code}:${i.nodeId}`);
		expect(codes).toContain("duplicate-id:jp");
		expect(codes).toContain("missing-parent:orphan");
		expect(codes).toContain("cycle:a");
		expect(codes).toContain("rank-inversion:city-under-area");
		expect(codes).toContain("invalid-timezone:bad-tz");
		expect(codes).toContain("invalid-coordinates:bad-coords");
		expect(codes).toContain("invalid-type:weird");
		expect(codes).toContain("no-timezone:no-tz");
		expect(codes).toContain("no-timezone:orphan");
		expect(codes.filter((c) => c.startsWith("cycle"))).toHaveLength(1);
		expect(issues.find((i) => i.code === "rank-inversion")?.severity).toBe(
			"warning",
		);
		expect(issues.find((i) => i.code === "cycle")?.severity).toBe("error");
	});

	it("strict mode throws on structural problems only", () => {
		expect(() =>
			createHierarchy([node("a", "b", "area"), node("b", "a", "area")]),
		).toThrow(HierarchyError);
		expect(() => createHierarchy([node("x", "missing", "place")])).toThrow(
			/missing parent/,
		);
		expect(() =>
			createHierarchy([node("x", null, "country"), node("x", null, "country")]),
		).toThrow(/duplicate/);
		// Data-quality warnings do not throw.
		expect(() =>
			createHierarchy([node("c", null, "city"), node("k", "c", "country")]),
		).not.toThrow();
		try {
			createHierarchy([node("x", "missing", "place")]);
		} catch (e) {
			expect(e).toBeInstanceOf(HierarchyError);
			expect((e as HierarchyError).issues[0]?.code).toBe("missing-parent");
		}
	});

	it("lenient mode tolerates broken data without looping", () => {
		const lenient = createHierarchy(
			[
				node("a", "b", "area"),
				node("b", "a", "area"),
				node("orphan", "missing", "place", { tz: "Asia/Tokyo" }),
				node("dup", null, "country", { name: "first" }),
				node("dup", null, "country", { name: "second" }),
			],
			{ strict: false },
		);
		expect(ids(lenient.ancestors("a"))).toEqual(["b"]);
		expect(ids(lenient.descendants("a"))).toEqual(["b"]);
		expect(lenient.isInSubtree("a", "b")).toBe(true);
		expect(lenient.get("dup")?.name).toBe("first");
		expect(ids(lenient.roots())).toEqual(["orphan", "dup"]);
		expect(lenient.resolveTimezone("orphan")).toBe("Asia/Tokyo");
		expect(lenient.resolveTimezone("a")).toBeUndefined();
	});
});
