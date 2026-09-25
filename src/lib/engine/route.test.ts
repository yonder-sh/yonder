import "./__fixtures__/host-tz";
import { describe, expect, it } from "vitest";
import { nodes, timeline } from "./__fixtures__/asia-trip";
import { createHierarchy } from "./hierarchy";
import {
	type CollapseOptions,
	collapseRoute,
	groupEdgesByPair,
	type MapGraph,
	pairKey,
	type RouteInput,
	routeFromTimeline,
} from "./route";
import { computeTimeline } from "./timeline";

const h = createHierarchy(nodes);
const computed = computeTimeline(timeline, h);
const route = routeFromTimeline(computed);
const collapse = (opts: CollapseOptions, r: RouteInput = route) =>
	collapseRoute(r, h, opts);

const visitNodes = (g: MapGraph) => g.visits.map((v) => v.nodeId);
const edgePairs = (g: MapGraph) =>
	g.edges.map((e) => `${e.fromNodeId}>${e.toNodeId}`);
const pin = (g: MapGraph, id: string) => {
	const p = g.pins.find((x) => x.nodeId === id);
	if (!p) throw new Error(`no pin ${id}`);
	return p;
};

describe("routeFromTimeline", () => {
	it("uses computed leg durations (e.g. from flight times) and day dates", () => {
		expect(route.stops).toHaveLength(computed.items.length);
		expect(route.stops[0]).toEqual({
			itemId: "ewr-checkin",
			nodeId: "ewr",
			dayId: "d0",
			date: "2027-10-07",
		});
		expect(
			route.stops.find((s) => s.itemId === "d1-dinner")?.nodeId,
		).toBeNull();
		expect(route.legs.find((l) => l.id === "L-ewr-hnd")?.durationMin).toBe(840);
	});
});

describe("country granularity: the whole trip", () => {
	const g = collapse({ granularity: "country" });

	it("produces one visit per country stint, returning to the US at the end", () => {
		expect(visitNodes(g)).toEqual(["us", "jp", "kr", "vn", "tw", "us"]);
		expect(g.pins.map((p) => p.nodeId)).toEqual(["us", "jp", "kr", "vn", "tw"]);
		expect(pin(g, "us").visitIndices).toEqual([0, 5]);
		expect(pin(g, "jp").visitIndices).toEqual([1]);
		expect(g.pins.every((p) => !p.isFallback)).toBe(true);
		expect(g.issues).toEqual([]);
	});

	it("aggregates exactly the international flights onto the edges", () => {
		expect(
			g.edges.map((e) => ({
				pair: `${e.fromNodeId}>${e.toNodeId}`,
				legs: e.legIds,
				min: e.totalDurationMin,
				modes: e.modes,
			})),
		).toEqual([
			{ pair: "us>jp", legs: ["L-ewr-hnd"], min: 840, modes: ["flight"] },
			{ pair: "jp>kr", legs: ["L-kix-icn"], min: 120, modes: ["flight"] },
			{ pair: "kr>vn", legs: ["L-pus-sgn"], min: 295, modes: ["flight"] },
			{ pair: "vn>tw", legs: ["L-han-tpe"], min: 175, modes: ["flight"] },
			{ pair: "tw>us", legs: ["L-tpe-ewr"], min: 1690, modes: ["flight"] },
		]);
		const first = g.edges[0];
		expect(first).toMatchObject({
			index: 0,
			fromVisit: 0,
			toVisit: 1,
			fromItemId: "ewr-checkin",
			toItemId: "hnd-arrival",
			primaryMode: "flight",
			durationByMode: { flight: 840 },
			missingLegCount: 0,
			dayIds: ["d0", "d1"],
		});
	});

	it("keeps domestic travel as internal legs of the country pin", () => {
		const jp = pin(g, "jp");
		expect(jp.internalLegIds).toHaveLength(17);
		expect(jp.internalLegIds[0]).toBe("L-hnd-anamori");
		expect(jp.internalLegIds.at(-1)).toBe("L-namba-kix");
		expect(jp.internalDurationMin).toBe(90 + 70 + 156 + 265 + 45);
		expect(jp.dayIds).toEqual(["d1", "d3", "d5", "d6", "d10"]);
		expect(jp.itemIds).toContain("golden-gai");
		expect(jp.itemIds).not.toContain("d1-dinner"); // nodeless items are not pinned anywhere
	});
});

describe("city granularity: missing levels and gaps", () => {
	const g = collapse({ granularity: "city" });

	it("walks the real city order, with fallbacks for airports that hang off a country", () => {
		expect(visitNodes(g)).toEqual([
			"newark",
			"tokyo",
			"fujikawaguchiko",
			"fujiyoshida",
			"fujikawaguchiko",
			"nagoya",
			"osaka",
			"kr",
			"seoul",
			"busan",
			"hcmc",
			"hanoi",
			"lao-cai",
			"sa-pa",
			"hanoi",
			"tw",
			"taipei",
			"tw",
			"newark",
		]);
		expect(pin(g, "kr").isFallback).toBe(true);
		expect(pin(g, "tw").isFallback).toBe(true);
		expect(pin(g, "tokyo").isFallback).toBe(false);
		expect(pin(g, "fujikawaguchiko").visitIndices).toEqual([2, 4]);
		expect(pin(g, "hanoi").visitIndices).toEqual([11, 14]);
		expect(g.edges).toHaveLength(18);
	});

	it("marks edges whose hops have no transit leg yet (days not connected)", () => {
		const missing = g.edges
			.filter((e) => e.missingLegCount > 0)
			.map((e) => `${e.fromNodeId}>${e.toNodeId}`);
		expect(missing).toEqual([
			"fujikawaguchiko>fujiyoshida",
			"nagoya>osaka",
			"seoul>busan",
			"hcmc>hanoi",
			"sa-pa>hanoi",
			"taipei>tw",
		]);
		const noLegs = g.edges.find((e) => e.fromNodeId === "nagoya");
		expect(noLegs).toMatchObject({
			legIds: [],
			totalDurationMin: 0,
			modes: [],
			primaryMode: null,
			missingLegCount: 1,
			dayIds: ["d6", "d10"],
		});
	});

	it("puts the overnight train on the Hanoi -> Lao Cai edge", () => {
		const e = g.edges.find(
			(x) => x.fromNodeId === "hanoi" && x.toNodeId === "lao-cai",
		);
		expect(e).toMatchObject({
			legIds: ["L-night-train"],
			totalDurationMin: 470,
			primaryMode: "transit",
			dayIds: ["d22", "d23"],
		});
	});

	it("keeps intra-city legs internal (Tokyo walks, Fuji ropeway)", () => {
		expect(pin(g, "tokyo").internalLegIds).toContain("L-benfiddich-gg");
		expect(pin(g, "tokyo").internalLegIds).not.toContain("L-fuji-excursion");
		expect(
			g.edges.find((e) => e.toNodeId === "fujikawaguchiko")?.legIds,
		).toEqual(["L-fuji-excursion"]);
	});

	it("groups traversals by node pair", () => {
		const groups = groupEdgesByPair(g.edges);
		const fuji = groups.find(
			(x) => x.pairKey === pairKey("fujikawaguchiko", "fujiyoshida"),
		);
		expect(fuji).toMatchObject({
			edgeIndices: [2, 3],
			bidirectional: true,
			legIds: ["L-chureito-ryokan"],
			nodeIds: ["fujikawaguchiko", "fujiyoshida"],
		});
		const taipei = groups.find((x) => x.pairKey === pairKey("tw", "taipei"));
		expect(taipei?.bidirectional).toBe(true);
		const flight = groups.find((x) => x.pairKey === pairKey("osaka", "kr"));
		expect(flight).toMatchObject({
			bidirectional: false,
			modes: ["flight"],
			totalDurationMin: 120,
		});
		expect(groups).toHaveLength(16); // 18 traversals, 2 pairs travelled twice
		expect(pairKey("a", "b")).toBe(pairKey("b", "a"));
	});
});

describe("area granularity inside Tokyo", () => {
	const g = collapse({ granularity: "area", subtreeRootId: "tokyo" });

	it("collapses places to areas, merging consecutive stops", () => {
		expect(visitNodes(g)).toEqual([
			"haneda",
			"shibuya",
			"shinjuku",
			"nakano",
			"shinjuku",
		]);
		expect(g.visits[0]?.itemIds).toEqual(["hnd-arrival", "anamori"]);
		expect(g.visits[4]?.itemIds).toEqual([
			"yodobashi",
			"omoide",
			"benfiddich",
			"golden-gai",
			"d5-breakfast",
		]);
		expect(g.visits[4]?.dayIds).toEqual(["d3", "d5"]);
		expect(g.pins.map((p) => [p.nodeId, p.visitIndices])).toEqual([
			["haneda", [0]],
			["shibuya", [1]],
			["shinjuku", [2, 4]],
			["nakano", [3]],
		]);
	});

	it("aggregates legs through nodeless stops (dinner) and reports mixed modes", () => {
		const e = g.edges[1];
		expect(e).toMatchObject({
			fromNodeId: "shibuya",
			toNodeId: "shinjuku",
			fromItemId: "sky",
			toItemId: "d1-hotel",
			legIds: ["L-sky-dinner", "L-dinner-hotel"],
			totalDurationMin: 25,
			modes: ["walk", "transit"],
			durationByMode: { walk: 5, transit: 20 },
			primaryMode: "transit",
			viaItemIds: ["d1-dinner"],
			missingLegCount: 0,
		});
	});

	it("counts hops without a leg across days", () => {
		expect(g.edges[2]).toMatchObject({
			fromNodeId: "shinjuku",
			toNodeId: "nakano",
			legIds: ["L-breakfast-nakano"],
			missingLegCount: 1,
			viaItemIds: ["d3-breakfast"],
			dayIds: ["d1", "d3"],
		});
	});

	it("stops at the subtree boundary: no edge out of Tokyo or in from the airport flight", () => {
		expect(edgePairs(g)).toEqual([
			"haneda>shibuya",
			"shibuya>shinjuku",
			"shinjuku>nakano",
			"nakano>shinjuku",
		]);
		expect(g.edges.flatMap((e) => e.legIds)).not.toContain("L-fuji-excursion");
		expect(g.edges.flatMap((e) => e.legIds)).not.toContain("L-ewr-hnd");
		expect(pin(g, "haneda").internalLegIds).toEqual(["L-hnd-anamori"]);
		expect(pin(g, "shinjuku").internalLegIds).toEqual([
			"L-yodobashi-omoide",
			"L-omoide-benfiddich",
			"L-benfiddich-gg",
		]);
		expect(pin(g, "shinjuku").internalDurationMin).toBe(35);
	});
});

describe("place granularity inside Shinjuku", () => {
	const g = collapse({ granularity: "place", subtreeRootId: "shinjuku" });

	it("breaks the chain when the route leaves the subtree (Nakano) and resumes after", () => {
		expect(visitNodes(g)).toEqual([
			"hotel-gracery",
			"yodobashi-shinjuku",
			"omoide-yokocho",
			"bar-benfiddich",
			"golden-gai",
			"shinjuku",
		]);
		expect(edgePairs(g)).toEqual([
			"yodobashi-shinjuku>omoide-yokocho",
			"omoide-yokocho>bar-benfiddich",
			"bar-benfiddich>golden-gai",
			"golden-gai>shinjuku",
		]);
		expect(pin(g, "shinjuku").isFallback).toBe(true); // breakfast attached to the area itself
		expect(g.edges[3]?.missingLegCount).toBe(1);
		expect(g.edges[3]?.dayIds).toEqual(["d3", "d5"]);
	});
});

describe("clamping to the subtree root", () => {
	it("never collapses above the selected subtree", () => {
		const g = collapse({ granularity: "country", subtreeRootId: "tokyo" });
		expect(visitNodes(g)).toEqual(["tokyo"]);
		expect(g.edges).toEqual([]);
		expect(g.pins[0]?.isFallback).toBe(true);
		expect(g.pins[0]?.internalLegIds.length).toBeGreaterThan(0);
	});

	it("region granularity inside Japan uses regions where they exist, else cities fall back to Japan", () => {
		const g = collapse({ granularity: "region", subtreeRootId: "jp" });
		expect(visitNodes(g)).toEqual(["jp", "yamanashi", "jp"]);
		expect(g.edges.map((e) => e.legIds)).toEqual([
			["L-fuji-excursion"],
			["L-fuji-nagoya"],
		]);
	});
});

describe("day filters", () => {
	it("restricts to a date range", () => {
		const g = collapse({
			granularity: "area",
			dateRange: { from: "2027-10-10", to: "2027-10-10" },
		});
		expect(visitNodes(g)).toEqual(["nakano", "shinjuku"]);
		expect(g.edges[0]).toMatchObject({
			legIds: ["L-lunch-yodobashi"],
			missingLegCount: 1,
			viaItemIds: ["d3-lunch"],
		});
	});

	it("open-ended ranges work", () => {
		const g = collapse({
			granularity: "country",
			dateRange: { from: "2027-11-01" },
		});
		expect(visitNodes(g)).toEqual(["vn", "tw", "us"]);
		const g2 = collapse({
			granularity: "country",
			dateRange: { to: "2027-10-17" },
		});
		expect(visitNodes(g2)).toEqual(["us", "jp", "kr"]);
	});

	it("restricts to explicit day ids (an overnight leg between selected days is kept)", () => {
		const g = collapse({ granularity: "city", dayIds: ["d22", "d23"] });
		expect(visitNodes(g)).toEqual(["hanoi", "lao-cai", "sa-pa"]);
		expect(g.edges.map((e) => e.legIds)).toEqual([
			["L-night-train"],
			["L-laocai-sapa"],
		]);
	});

	it("drops a leg whose other end is outside the day filter", () => {
		const g = collapse({ granularity: "city", dayIds: ["d23"] });
		expect(visitNodes(g)).toEqual(["lao-cai", "sa-pa"]);
		expect(g.edges.flatMap((e) => e.legIds)).toEqual(["L-laocai-sapa"]);
	});

	it("combines subtree and day filters", () => {
		const g = collapse({
			granularity: "place",
			subtreeRootId: "shibuya",
			dayIds: ["d1"],
		});
		expect(visitNodes(g)).toEqual(["shibuya-crossing", "shibuya-sky"]);
		expect(g.edges[0]?.legIds).toEqual(["L-crossing-sky"]);
	});
});

describe("robustness", () => {
	it("treats unknown nodes as pass-through and reports bad legs", () => {
		const r: RouteInput = {
			stops: [
				{ itemId: "a", nodeId: "sensoji" },
				{ itemId: "b", nodeId: "ghost" },
				{ itemId: "c", nodeId: "golden-gai" },
			],
			legs: [
				{
					id: "ab",
					fromItemId: "a",
					toItemId: "b",
					mode: "transit",
					durationMin: 20,
				},
				{
					id: "bc",
					fromItemId: "b",
					toItemId: "c",
					mode: "walk",
					durationMin: 5,
				},
				{
					id: "ac",
					fromItemId: "a",
					toItemId: "c",
					mode: "walk",
					durationMin: 5,
				},
				{
					id: "zz",
					fromItemId: "a",
					toItemId: "nope",
					mode: "walk",
					durationMin: 5,
				},
			],
		};
		const g = collapse({ granularity: "area" }, r);
		expect(visitNodes(g)).toEqual(["asakusa", "shinjuku"]);
		expect(g.edges[0]).toMatchObject({
			legIds: ["ab", "bc"],
			totalDurationMin: 25,
			primaryMode: "transit",
			viaItemIds: ["b"],
		});
		expect(g.issues.map((i) => i.code)).toEqual([
			"leg-not-consecutive",
			"leg-unknown-item",
			"unknown-node",
		]);
	});

	it("picks the first mode on duration ties and handles an unknown subtree root", () => {
		const r: RouteInput = {
			stops: [
				{ itemId: "a", nodeId: "sensoji" },
				{ itemId: "x" },
				{ itemId: "b", nodeId: "golden-gai" },
			],
			legs: [
				{
					id: "1",
					fromItemId: "a",
					toItemId: "x",
					mode: "walk",
					durationMin: 10,
				},
				{
					id: "2",
					fromItemId: "x",
					toItemId: "b",
					mode: "transit",
					durationMin: 10,
				},
			],
		};
		expect(collapse({ granularity: "area" }, r).edges[0]?.primaryMode).toBe(
			"walk",
		);
		const g = collapse({ granularity: "area", subtreeRootId: "atlantis" }, r);
		expect(g.pins).toEqual([]);
		expect(g.issues.map((i) => i.code)).toEqual(["unknown-subtree-root"]);
	});

	it("handles an empty route", () => {
		expect(collapse({ granularity: "city" }, { stops: [], legs: [] })).toEqual({
			granularity: "city",
			pins: [],
			edges: [],
			visits: [],
			issues: [],
		});
	});

	it("output is JSON-serializable", () => {
		const g = collapse({ granularity: "city" });
		expect(JSON.parse(JSON.stringify(g))).toEqual(g);
	});
});

// ---------------------------------------------------------------------------
// Added during independent verification: repeat visits
// ---------------------------------------------------------------------------

describe("repeat visits", () => {
	it("Fuji days at area granularity: ryokan -> Chureito -> ryokan is two visits of one pin, nodeless lunch merges", () => {
		const g = collapse({
			granularity: "area",
			dateRange: { from: "2027-10-12", to: "2027-10-13" },
		});
		expect(visitNodes(g)).toEqual([
			"shinjuku",
			"kawaguchiko",
			"fujiyoshida",
			"kawaguchiko",
			"nagoya",
		]);
		// Drop bags -> (Lunch) -> Oishi -> Ropeway -> check-in -> kaiseki all stay in one visit.
		expect(g.visits[1]?.itemIds).toEqual([
			"ryokan-drop",
			"oishi",
			"ropeway",
			"ryokan-checkin",
			"kaiseki",
		]);
		const k = pin(g, "kawaguchiko");
		expect(k.visitIndices).toEqual([1, 3]);
		expect(k.firstVisit).toBe(1);
		expect(k.internalLegIds).toEqual([
			"L-lunch-oishi",
			"L-oishi-ropeway",
			"L-ropeway-ryokan",
		]);
		expect(k.dayIds).toEqual(["d5", "d6"]);
		expect(pin(g, "fujiyoshida").isFallback).toBe(true); // Chureito hangs directly off the city
		expect(pin(g, "nagoya").isFallback).toBe(true); // item on the city node itself
		expect(
			g.edges.map((e) => [
				`${e.fromNodeId}>${e.toNodeId}`,
				e.legIds,
				e.missingLegCount,
			]),
		).toEqual([
			["shinjuku>kawaguchiko", ["L-fuji-excursion"], 0],
			["kawaguchiko>fujiyoshida", [], 1], // no leg from dinner to the sunrise trip yet
			["fujiyoshida>kawaguchiko", ["L-chureito-ryokan"], 0],
			["kawaguchiko>nagoya", ["L-fuji-nagoya"], 0],
		]);
		expect(g.edges.map((e) => [e.fromVisit, e.toVisit])).toEqual([
			[0, 1],
			[1, 2],
			[2, 3],
			[3, 4],
		]);
		const pairs = groupEdgesByPair(g.edges);
		expect(
			pairs.find((p) => p.pairKey === pairKey("kawaguchiko", "fujiyoshida")),
		).toMatchObject({ edgeIndices: [1, 2], bidirectional: true });
	});

	it("a day filter that skips a day splits the chain: Shinjuku (d1) and Shinjuku (d5) are two visits, no self-edge", () => {
		const g = collapse({
			granularity: "area",
			subtreeRootId: "tokyo",
			dayIds: ["d1", "d5"],
		});
		expect(visitNodes(g)).toEqual([
			"haneda",
			"shibuya",
			"shinjuku",
			"shinjuku",
		]);
		expect(edgePairs(g)).toEqual(["haneda>shibuya", "shibuya>shinjuku"]);
		expect(pin(g, "shinjuku").visitIndices).toEqual([2, 3]);
		expect(g.visits.map((v) => v.itemIds)).toEqual([
			["hnd-arrival", "anamori"],
			["crossing", "sky"],
			["d1-hotel"],
			["d5-breakfast"],
		]);
	});

	it("Tokyo -> Fuji -> Tokyo: inside the Tokyo subtree the excursion breaks the chain (no fake Tokyo->Tokyo line)", () => {
		const r: RouteInput = {
			stops: [
				{ itemId: "a", nodeId: "sensoji" },
				{ itemId: "b", nodeId: "oishi-park" },
				{ itemId: "c", nodeId: "golden-gai" },
				{ itemId: "d", nodeId: "kappabashi" },
			],
			legs: [
				{
					id: "ab",
					fromItemId: "a",
					toItemId: "b",
					mode: "transit",
					durationMin: 120,
				},
				{
					id: "bc",
					fromItemId: "b",
					toItemId: "c",
					mode: "transit",
					durationMin: 110,
				},
				{
					id: "cd",
					fromItemId: "c",
					toItemId: "d",
					mode: "transit",
					durationMin: 25,
				},
			],
		};
		const inside = collapse({ granularity: "city", subtreeRootId: "tokyo" }, r);
		expect(visitNodes(inside)).toEqual(["tokyo", "tokyo"]);
		expect(inside.edges).toEqual([]);
		expect(pin(inside, "tokyo")).toMatchObject({
			visitIndices: [0, 1],
			internalLegIds: ["cd"],
			internalDurationMin: 25,
		});

		const whole = collapse({ granularity: "city" }, r);
		expect(visitNodes(whole)).toEqual(["tokyo", "fujikawaguchiko", "tokyo"]);
		expect(
			whole.edges.map((e) => [`${e.fromNodeId}>${e.toNodeId}`, e.legIds]),
		).toEqual([
			["tokyo>fujikawaguchiko", ["ab"]],
			["fujikawaguchiko>tokyo", ["bc"]],
		]);
		expect(pin(whole, "tokyo").visitIndices).toEqual([0, 2]);
		expect(groupEdgesByPair(whole.edges)).toEqual([
			expect.objectContaining({
				edgeIndices: [0, 1],
				legIds: ["ab", "bc"],
				totalDurationMin: 230,
				bidirectional: true,
			}),
		]);
	});

	it("at every granularity: no self-edges, visit/pin/edge bookkeeping is consistent, every leg is accounted for once", () => {
		const allLegIds = route.legs.map((l) => l.id);
		for (const granularity of [
			"country",
			"region",
			"city",
			"area",
			"place",
		] as const) {
			const g = collapse({ granularity });
			expect(g.edges.every((e) => e.fromNodeId !== e.toNodeId)).toBe(true);
			// Consecutive visits differ; each edge joins consecutive visits.
			for (let i = 1; i < g.visits.length; i++)
				expect(g.visits[i]?.nodeId).not.toBe(g.visits[i - 1]?.nodeId);
			expect(g.edges.map((e) => [e.fromVisit, e.toVisit])).toEqual(
				g.visits.slice(1).map((_, i) => [i, i + 1]),
			);
			// Every visit index belongs to exactly one pin, and pins list them in order.
			const fromPins = g.pins
				.flatMap((p) => p.visitIndices.map((v) => [v, p.nodeId] as const))
				.sort((a, b) => a[0] - b[0]);
			expect(fromPins).toEqual(g.visits.map((v) => [v.index, v.nodeId]));
			for (const p of g.pins)
				expect(p.visitIndices).toEqual(
					[...p.visitIndices].sort((a, b) => a - b),
				);
			// Each leg is on exactly one edge or inside exactly one pin, except the trailing
			// drive home, which ends at a nodeless stop after the last pin.
			const accounted = [
				...g.edges.flatMap((e) => e.legIds),
				...g.pins.flatMap((p) => p.internalLegIds),
			];
			expect(new Set(accounted).size).toBe(accounted.length);
			expect(allLegIds.filter((id) => !accounted.includes(id))).toEqual([
				"L-ewr-home",
			]);
			// Durations add up.
			const total = route.legs
				.filter((l) => l.id !== "L-ewr-home")
				.reduce((s, l) => s + l.durationMin, 0);
			const summed =
				g.edges.reduce((s, e) => s + e.totalDurationMin, 0) +
				g.pins.reduce((s, p) => s + p.internalDurationMin, 0);
			expect(summed).toBe(total);
		}
	});
});
