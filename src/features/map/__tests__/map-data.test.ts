/**
 * WP-Map data (pure): pins, edges, ghost stubs, clustering, the shared filter
 * and the Japan N02 track geometry (JAPAN_TRANSIT §3), on the demo fixture.
 */
import type { LineString } from "geojson";
import { describe, expect, it } from "vitest";
import { indexGraph } from "@/lib/engine/graph-index";
import type { MarkKey, ProposalMark } from "@/lib/engine/proposals";
import type { GraphLeg, Lens, TripGraph } from "@/lib/engine/types";
import { buildModel } from "@/lib/engine/visits";
import { demo, demoGraph, N } from "@/lib/fixtures/demo";
import { EMPTY_FILTER, type WorkspaceFilter } from "@/lib/workspace/filter";
import { filterContextOf, matchesFilter } from "@/lib/workspace/filter-match";
import {
	attachEdgesToClusters,
	CLUSTER_RADIUS_PX,
	clusterOfRep,
	clustersAt,
	makeClusterIndex,
	spiderOffsets,
} from "../clusters";
import {
	countMatchingPlaces,
	filterActive,
	type MapFilterContext,
	pinMatcher,
} from "../filter-match";
import {
	alongMidpoint,
	boundsOf,
	globeFit,
	metres,
	NO_INSETS,
	quadCurve,
	scalePadding,
	snapEnds,
	toward,
} from "../geo-utils";
import {
	buildChips,
	buildEdges,
	buildGhosts,
	buildPins,
	commonParent,
	edgeTip,
	fitBoundsFor,
	inJapan,
	legUsesN02,
	type MapDataOptions,
	oneRepHint,
	type PinView,
	selectedFids,
	viaItems,
} from "../map-data";
import { LINES } from "../palette";
import jpRoute from "./jp-route.json";

const I = demo.I;

function opts(
	over: Partial<MapDataOptions> & { lens: Lens; scopeId: string | null },
): MapDataOptions {
	return {
		theme: "light",
		palette: LINES.light,
		days: null,
		dayMode: "only",
		who: null,
		show: { ideas: true, dropped: false, stays: true },
		matches: () => true,
		marks: new Map(),
		...over,
	};
}

function setup(
	graph: TripGraph,
	scopeId: string | null,
	lens: Lens,
	over: Partial<MapDataOptions> = {},
) {
	const ix = indexGraph(graph);
	const model = buildModel(ix, scopeId, lens, over.days ?? null);
	const o = opts({ lens, scopeId, ...over });
	const pins = buildPins(model, ix, o);
	const edges = buildEdges(model, ix, pins, o);
	const ghosts = buildGhosts(model, ix, pins, o);
	return { ix, model, o, pins, edges, ghosts };
}

/** The demo graph with the Fuji Excursion leg replaced by a real Japan `estimate` route (N02 track). */
function withEstimate(): TripGraph {
	return {
		...demoGraph,
		legs: demoGraph.legs.map(
			(l): GraphLeg =>
				l.id === demo.L.fuji
					? {
							...l,
							source: "estimate",
							isEdited: false,
							durationMin: 159,
							details: { kind: "transit", route: jpRoute as never },
						}
					: l,
		),
	};
}

describe("pins", () => {
	it("draws one pin per visited rep, numbered in visit order, with an accessible label", () => {
		const { pins, model } = setup(demoGraph, N.tokyo as string, "place");
		const visited = pins.filter((p) => !p.hollow);
		expect(visited.length).toBe(new Set(model.visits.map((v) => v.repId)).size);
		const hands = pins.find((p) => p.repId === N.hands);
		expect(hands).toMatchObject({ number: 1, shape: "place", stops: 1 });
		expect(hands?.ariaLabel).toBe("1. Hands Shibuya, 1 stop, Day 1");
	});

	it("uses the level's shape and grows with time spent (DESIGN §9.2)", () => {
		const { pins } = setup(demoGraph, null, "city");
		const tokyo = pins.find((p) => p.repId === N.tokyo);
		expect(tokyo?.shape).toBe("city");
		// 22px × (1 + min(.35, minutes/1440)).
		expect(tokyo?.size).toBeGreaterThan(22);
		expect(tokyo?.size).toBeLessThanOrEqual(22 * 1.35 + 0.1);
		const countries = setup(demoGraph, null, "country").pins;
		expect(countries.find((p) => p.repId === N.japan)?.shape).toBe("country");
	});

	it("hides ideas when 'Show ideas' is off and while a day range is active", () => {
		const all = setup(demoGraph, null, "city").pins;
		expect(all.some((p) => p.hollow)).toBe(true);
		const off = setup(demoGraph, null, "city", {
			show: { ideas: false, dropped: false, stays: true },
		}).pins;
		expect(off.some((p) => p.hollow)).toBe(false);
		const day = setup(demoGraph, null, "city", {
			days: { from: "2027-10-03", to: "2027-10-03" },
		}).pins;
		expect(day.some((p) => p.hollow)).toBe(false);
	});

	it("'Dim others' keeps every pin but fades the ones outside the selected days", () => {
		const ix = indexGraph(demoGraph);
		const full = buildModel(ix, null, "city", null);
		const o = opts({
			lens: "city",
			scopeId: null,
			days: { from: "2027-10-03", to: "2027-10-03" },
			dayMode: "dim",
		});
		const pins = buildPins(full, ix, o);
		expect(pins.find((p) => p.repId === N.tokyo)?.opacity).toBe(1);
		expect(pins.find((p) => p.repId === N.kyoto)?.opacity).toBe(0.25);
		const edges = buildEdges(full, ix, pins, o);
		expect(edges.features.some((f) => f.properties.o === 0.25)).toBe(true);
	});

	it("marks a proposed place with its author's colour (E7)", () => {
		const mark: ProposalMark = {
			proposalId: "p1",
			op: "node.create" as ProposalMark["op"],
			kind: "create",
			author: { userId: "u", memberId: null, name: "Maya", color: 2 },
		};
		const marks = new Map<MarkKey, ProposalMark[]>([
			[`node:${N.itoya}`, [mark]],
		]);
		const { pins } = setup(demoGraph, N.tokyo as string, "place", { marks });
		const itoya = pins.find((p) => p.repId === N.itoya);
		expect(itoya?.proposal).toMatchObject({ name: "Maya", color: "#c98a1c" });
		expect(itoya?.ariaLabel).toMatch(/suggested by Maya$/);
	});

	it("marks the pin of an item with a suggested removal, not the coarser pins (E7)", () => {
		const mark: ProposalMark = {
			proposalId: "p3",
			op: "item.delete" as ProposalMark["op"],
			kind: "delete",
			author: { userId: "u", memberId: null, name: "Maya", color: 2 },
		};
		const marks = new Map<MarkKey, ProposalMark[]>([[`item:${I.sky}`, [mark]]]);
		const place = setup(demoGraph, N.tokyo as string, "place", { marks });
		const sky = place.pins.find((p) => p.repId === N.shibuyaSky);
		expect(sky?.proposal).toMatchObject({ deleted: true, name: "Maya" });
		expect(sky?.ariaLabel).toMatch(/removal suggested by Maya$/);
		expect(place.pins.filter((p) => p.proposal).map((p) => p.repId)).toEqual([
			N.shibuyaSky,
		]);
		// At the city lens Shibuya Sky rolls up into Tokyo: Tokyo stays unmarked.
		const city = setup(demoGraph, null, "city", { marks });
		expect(city.pins.some((p) => p.proposal)).toBe(false);
	});

	it("draws a place with no coordinates on its parent's, marked approximate (GRAN-07)", () => {
		const g: TripGraph = {
			...demoGraph,
			nodes: demoGraph.nodes.map((n) =>
				n.id === N.loft ? { ...n, lat: null, lng: null } : n,
			),
		};
		const { pins } = setup(g, N.tokyo as string, "place");
		const loft = pins.find((p) => p.repId === N.loft);
		const shibuya = g.nodes.find((n) => n.id === N.shibuya);
		expect(loft).toMatchObject({
			approx: true,
			lat: shibuya?.lat,
			lng: shibuya?.lng,
		});
		expect(loft?.ariaLabel).toContain("location not set, shown at Shibuya");
	});

	it("shows dropped places only with 'Show dropped' on", () => {
		const g: TripGraph = {
			...demoGraph,
			nodes: demoGraph.nodes.map((n) =>
				n.id === N.osaka ? { ...n, status: "dropped" as const } : n,
			),
			items: demoGraph.items.filter((it) => it.nodeId !== N.kix),
			legs: demoGraph.legs.filter((l) => l.id !== demo.L.flight),
		};
		expect(setup(g, null, "city").pins.some((p) => p.repId === N.osaka)).toBe(
			false,
		);
		const shown = setup(g, null, "city", {
			show: { ideas: true, dropped: true, stays: true },
		}).pins.find((p) => p.repId === N.osaka);
		expect(shown).toMatchObject({ dropped: true, hollow: true });
	});
});

describe("edges", () => {
	it("styles by mode and selects the pair leg when one transition stands behind it", () => {
		const { edges } = setup(demoGraph, N.tokyo as string, "place");
		const walk = edges.features.find(
			(f) => f.properties.pairKey === `${I.hands}>${I.loft}`,
		);
		expect(walk?.properties).toMatchObject({
			style: "walk",
			est: false,
			arrows: true,
		});
		expect(walk?.properties.sel).toBe(`l.${I.hands}.${I.loft}`);
		const unset = edges.features.find((f) => f.properties.style === "unset");
		expect(unset?.properties.approx).toBe(true);
	});

	it("draws a flight as a great circle, never through (0,0)", () => {
		const { edges } = setup(demoGraph, null, "city");
		const flight = edges.features.find((f) => f.properties.style === "flight");
		expect(flight?.geometry.coordinates.length).toBeGreaterThan(10);
		for (const c of flight?.geometry.coordinates ?? [])
			expect(Math.abs(c[0] ?? 0) + Math.abs(c[1] ?? 0)).toBeGreaterThan(1);
	});

	it("draws a Japan estimate on its real N02 track at the place lens, snapped to the pins", () => {
		const { edges, pins } = setup(withEstimate(), N.japan as string, "place");
		const f = edges.features.find(
			(x) => x.properties.pairKey === `${I.itoya}>${I.dropBags}`,
		);
		expect(f).toBeDefined();
		expect(f?.properties).toMatchObject({
			style: "transit",
			est: true,
			approx: false,
			track: true,
		});
		expect(f?.geometry.coordinates.length).toBeGreaterThan(100);
		const itoya = pins.find((p) => p.repId === N.itoya);
		expect(f?.geometry.coordinates[0]).toEqual([itoya?.lng, itoya?.lat]);
		// It follows the Chuo line through Otsuki (~35.61, 138.94), not a straight cut.
		const nearOtsuki = f?.geometry.coordinates.some(
			(c) => metres(c, [138.94, 35.61]) < 5_000,
		);
		expect(nearOtsuki).toBe(true);
	});

	it("keeps the N02 track at coarser lenses instead of a straight pin-to-pin line", () => {
		const est = setup(withEstimate(), N.japan as string, "city").edges;
		const plain = setup(demoGraph, N.japan as string, "city").edges;
		const trackEdge = est.features.find(
			(f) => f.properties.style === "transit",
		);
		const straight = plain.features.find(
			(f) => f.properties.style === "transit",
		);
		expect(straight?.geometry.coordinates.length).toBe(2);
		expect(trackEdge?.properties.track).toBe(true);
		expect(trackEdge?.properties.est).toBe(true);
		expect(trackEdge?.geometry.coordinates.length).toBeGreaterThan(100);
		// Starts at the Tokyo pin, ends at the Mt. Fuji rep's pin.
		expect(trackEdge?.geometry.coordinates[0]).toEqual(
			straight?.geometry.coordinates[0],
		);
		expect(trackEdge?.geometry.coordinates.at(-1)).toEqual(
			straight?.geometry.coordinates.at(-1),
		);
	});

	it("uses a route's single line colour for transit", () => {
		const route = {
			...(jpRoute as object),
			segments: (jpRoute as { segments: object[] }).segments.map((s) =>
				(s as { mode: string }).mode === "walk"
					? s
					: { ...s, color: "#0079c2" },
			),
		};
		const g: TripGraph = {
			...demoGraph,
			legs: demoGraph.legs.map((l) =>
				l.id === demo.L.fuji
					? { ...l, details: { kind: "transit", route: route as never } }
					: l,
			),
		};
		const { edges } = setup(g, N.japan as string, "place");
		const f = edges.features.find(
			(x) => x.properties.pairKey === `${I.itoya}>${I.dropBags}`,
		);
		expect(f?.properties.color).toBe("#0079c2");
	});

	it("bows the return edge of a two-way pair to the left", () => {
		const line = quadCurve([139.7, 35.6], [139.8, 35.6]);
		expect(line.coordinates.length).toBe(25);
		// Travelling east, left is north.
		const mid = line.coordinates[12] ?? [0, 0];
		expect(mid[1] ?? 0).toBeGreaterThan(35.6);
	});

	it("marks the selected leg's feature", () => {
		const { edges, model } = setup(demoGraph, N.tokyo as string, "place");
		const fids = selectedFids(edges, model, {
			kind: "leg",
			target: {
				kind: "pair",
				fromItemId: I.hands as string,
				toItemId: I.loft as string,
			},
		});
		expect(fids.size).toBe(1);
		const coarse = setup(demoGraph, N.japan as string, "city");
		const edgeSel = selectedFids(coarse.edges, coarse.model, {
			kind: "leg",
			target: {
				kind: "pair",
				fromItemId: I.itoya as string,
				toItemId: I.dropBags as string,
			},
		});
		expect(edgeSel.size).toBe(1);
	});

	it("puts a count chip on edges travelled more than once and a bed on stay edges", () => {
		const { edges } = setup(demoGraph, null, "city");
		const chips = buildChips(edges, (g: LineString) =>
			alongMidpoint(g.coordinates),
		);
		for (const c of chips) expect(c.kind === "stay" || c.count > 1).toBe(true);
	});
});

describe("N02 credit (JAPAN_TRANSIT §5)", () => {
	const legWith = (route: object): GraphLeg => ({
		...(demoGraph.legs.find((l) => l.id === demo.L.fuji) as GraphLeg),
		details: { kind: "transit", route: route as never },
	});
	const ix = indexGraph(demoGraph);
	const rail = (jpRoute as { segments: { mode: string }[] }).segments;

	it("credits estimates and custom routes drawn on N02 rail shapes", () => {
		expect(legUsesN02(ix, legWith(jpRoute))).toBe(true);
		// A custom route from the station look-up: `manual`, no build id, real track.
		const custom = {
			id: "m:1",
			source: "manual",
			durationMin: 150,
			walkMin: 0,
			transfers: 1,
			segments: rail,
		};
		expect(legUsesN02(ix, legWith(custom))).toBe(true);
	});

	it("doesn't credit typed-in routes, routes abroad or other providers", () => {
		const typed = {
			id: "m:2",
			source: "manual",
			durationMin: 20,
			walkMin: 0,
			transfers: 0,
			segments: [{ mode: "subway", durationMin: 20, lineName: "Ginza" }],
		};
		expect(legUsesN02(ix, legWith(typed))).toBe(false);
		const seoul = {
			...typed,
			segments: [
				{
					mode: "subway",
					durationMin: 20,
					geometry: {
						type: "LineString",
						coordinates: [
							[126.97, 37.55],
							[127.02, 37.5],
						],
					},
				},
			],
		};
		expect(legUsesN02(ix, legWith(seoul))).toBe(false);
		expect(
			legUsesN02(
				ix,
				legWith({ ...jpRoute, source: "google", dataBuild: undefined }),
			),
		).toBe(false);
		expect(legUsesN02(ix, null)).toBe(false);
	});

	it("knows Japan's railways from its neighbours'", () => {
		for (const c of [
			[139.7, 35.69], // Tokyo
			[138.76, 35.5], // Kawaguchiko
			[141.35, 43.06], // Sapporo
			[129.87, 32.75], // Nagasaki
			[127.68, 26.21], // Naha
		])
			expect(inJapan(c)).toBe(true);
		for (const c of [
			[126.97, 37.55], // Seoul
			[129.04, 35.1], // Busan
			[131.9, 43.1], // Vladivostok
			[121.5, 25.05], // Taipei
		])
			expect(inJapan(c)).toBe(false);
	});
});

describe("ghost stubs", () => {
	it("point from the scope toward the place the trip continues to, clamped and labelled", () => {
		const { ghosts, pins, ix } = setup(demoGraph, N.tokyo as string, "place");
		expect(ghosts.lines.features.length).toBeGreaterThan(0);
		const g = ghosts.lines.features[0];
		const start = g?.geometry.coordinates[0] ?? [0, 0];
		expect(pins.some((p) => p.lng === start[0] && p.lat === start[1])).toBe(
			true,
		);
		expect(g?.properties.sel.startsWith("l.")).toBe(true);
		expect(ghosts.labels.features.map((f) => f.properties.label)).toContain(
			"to Kawaguchiko",
		);
		// Double-click zooms out to the common parent of Tokyo and Kawaguchiko: Japan.
		expect(commonParent(ix, N.itoya as string, N.kawaguchiko as string)).toBe(
			N.japan,
		);
	});
	it("points a day-range stub at the next located stop, not the country (GRAN-14)", () => {
		// Day 2 ends at Itoya; day 3 opens with "Breakfast", which has no place.
		for (const lens of ["place", "area"] as const) {
			const { ghosts, ix } = setup(demoGraph, null, lens, {
				days: { from: "2027-10-04", to: "2027-10-04" },
			});
			const out = ghosts.lines.features.find((f) =>
				f.properties.fid.includes("|out|"),
			);
			const target = lens === "place" ? N.ryokan : N.kawaguchiko;
			expect(out?.properties.label).toBe(
				`to ${ix.node(target as string)?.name}`,
			);
			expect(
				ghosts.labels.features.map((f) => f.properties.label),
			).not.toContain("to Japan");
			// It heads west toward Kawaguchiko, not to Japan's centroid (138.25, 36.2).
			const [start, end] = out?.geometry.coordinates ?? [];
			expect((end?.[0] ?? 0) - (start?.[0] ?? 0)).toBeLessThan(0);
			expect(end?.[1] ?? 99).toBeLessThan(start?.[1] ?? 0);
			// Its click still opens the boundary leg (Itoya → Drop bags).
			expect(out?.properties.sel).toBe(`l.${I.itoya}.${I.dropBags}`);
		}
	});
});

describe("hover tooltip and the one-pin hint", () => {
	it("says which legs an edge stands for, 'via Lunch' included (GRAN-06)", () => {
		const { ix, model, edges } = setup(demoGraph, N.tokyo as string, "place");
		const f = edges.features.find(
			(x) => x.properties.from === N.loft && x.properties.to === N.meijiJingu,
		);
		if (!f) throw new Error("no Loft → Meiji edge");
		// No leg row yet: the schedule's suggestion stands in.
		const tip = edgeTip(f.properties, model, ix, () => "walk ~12m?");
		expect(tip?.title).toBe("Shibuya Loft → Meiji Jingu");
		expect(tip?.detail).toBe("Not set · walk ~12m? · via Lunch");
		expect(viaItems(ix, I.loft as string, I.meiji as string)).toEqual([
			"Lunch",
		]);
		expect(viaItems(ix, I.hands as string, I.loft as string)).toEqual([]);
	});

	it("describes a set leg with its mode and time, and names overnight connectors", () => {
		const walk = demoGraph.legs.find((l) => l.id === demo.L.handsLoft);
		if (!walk) throw new Error("fixture");
		const g: TripGraph = {
			...demoGraph,
			legs: [
				...demoGraph.legs,
				{
					...walk,
					id: "00000000-0000-4000-8000-00000000beef",
					fromItemId: I.loft as string,
					toItemId: I.meiji as string,
					durationMin: 12,
					distanceM: null,
				},
			],
		};
		const { ix, model, edges } = setup(g, N.tokyo as string, "place");
		const f = edges.features.find(
			(x) => x.properties.from === N.loft && x.properties.to === N.meijiJingu,
		);
		if (!f) throw new Error("no Loft → Meiji edge");
		expect(edgeTip(f.properties, model, ix)?.detail).toBe(
			"Walk · 12m · via Lunch",
		);
		const night = edges.features.find((x) => x.properties.kind === "overnight");
		if (night)
			expect(edgeTip(night.properties, model, ix)?.detail).toBe("Overnight");
	});

	it("says 'Everything here is in Japan' when the scope is one pin at this lens (GRAN-10)", () => {
		const day1 = demo.D.d1;
		const tokyoOnly: TripGraph = {
			...demoGraph,
			days: demoGraph.days.map((d) => ({ ...d, nightNodeId: null })),
			items: demoGraph.items.filter((it) => it.dayId === day1),
			legs: demoGraph.legs.filter((l) => l.id === demo.L.handsLoft),
		};
		const root = setup(tokyoOnly, null, "country");
		expect(oneRepHint(root.pins, root.edges, root.o)).toBe(
			"Everything here is in Japan",
		);
		const city = setup(tokyoOnly, N.japan as string, "city");
		expect(oneRepHint(city.pins, city.edges, city.o)).toBe(
			"Everything here is in Tokyo",
		);
		// Several pins, the place lens, or selected days: no hint.
		const place = setup(tokyoOnly, N.tokyo as string, "place");
		expect(oneRepHint(place.pins, place.edges, place.o)).toBeNull();
		const full = setup(demoGraph, null, "country");
		expect(oneRepHint(full.pins, full.edges, full.o)).toBeNull();
		// A night elsewhere is a pin too: then it isn't "everything".
		const withNight = setup(
			{ ...tokyoOnly, days: demoGraph.days },
			N.japan as string,
			"city",
		);
		expect(oneRepHint(withNight.pins, withNight.edges, withNight.o)).toBeNull();
		const days = setup(tokyoOnly, null, "country", {
			days: { from: "2027-10-03", to: "2027-10-03" },
		});
		expect(oneRepHint(days.pins, days.edges, days.o)).toBeNull();
	});
});

describe("filter", () => {
	// The per-node rules are F's shared matcher; the map reads them per pin.
	const nodeMatches = (
		node: Parameters<typeof matchesFilter>[0],
		f: WorkspaceFilter,
		c: MapFilterContext,
	) => matchesFilter(node, f, filterContextOf(c.ix, c.meMemberId));
	const ix = indexGraph(demoGraph);
	const ctx = { ix, meMemberId: null };
	const shopping: WorkspaceFilter = { ...EMPTY_FILTER, groups: ["shopping"] };

	it("matches places by category group, and coarser pins by what they hold", () => {
		const hands = ix.node(N.hands);
		const meiji = ix.node(N.meijiJingu);
		if (!hands || !meiji) throw new Error("fixture");
		expect(nodeMatches(hands, shopping, ctx)).toBe(true);
		expect(nodeMatches(meiji, shopping, ctx)).toBe(false);
		const m = pinMatcher(shopping, ctx);
		expect(m(N.tokyo as string)).toBe(true);
		expect(m(N.kyoto as string)).toBe(false);
		expect(pinMatcher(EMPTY_FILTER, ctx)(N.kyoto as string)).toBe(true);
	});

	it("reads minimum priority as the max of every member, or one member's", () => {
		const g: TripGraph = {
			...demoGraph,
			nodes: demoGraph.nodes.map((n) =>
				n.id === N.sensoji ? { ...n, priorities: { a: "must", b: "meh" } } : n,
			),
		};
		const gx = indexGraph(g);
		const node = gx.node(N.sensoji);
		if (!node) throw new Error("fixture");
		const c = { ix: gx, meMemberId: "b" };
		expect(
			nodeMatches(node, { ...EMPTY_FILTER, minPriority: "really_want" }, c),
		).toBe(true);
		expect(
			nodeMatches(
				node,
				{ ...EMPTY_FILTER, minPriority: "really_want", priorityOf: "b" },
				c,
			),
		).toBe(false);
		expect(nodeMatches(node, { ...EMPTY_FILTER, unratedBy: "me" }, c)).toBe(
			false,
		);
		expect(nodeMatches(node, { ...EMPTY_FILTER, unratedBy: "zz" }, c)).toBe(
			true,
		);
	});

	it("hides non-matching ideas and dims non-matching visited pins", () => {
		const m = pinMatcher(shopping, ctx);
		const { pins } = setup(demoGraph, N.tokyo as string, "place", {
			matches: m,
		});
		const meiji = pins.find((p) => p.repId === N.meijiJingu);
		expect(meiji?.filteredOut).toBe(true);
		expect(meiji?.opacity).toBeLessThan(0.5);
		expect(pins.find((p) => p.repId === N.hands)?.filteredOut).toBe(false);
		expect(countMatchingPlaces(shopping, ctx, N.tokyo as string)).toEqual({
			match: 4,
			total: 7,
		});
	});

	it("ignores 'Unrated by me' for a link guest (no member id)", () => {
		const unrated = { ...EMPTY_FILTER, unratedBy: "me" as const };
		expect(filterActive(unrated, ctx)).toBe(false);
		expect(pinMatcher(unrated, ctx)(N.kyoto as string)).toBe(true);
		expect(filterActive(unrated, { ix, meMemberId: "m1" })).toBe(true);
	});
});

describe("clusters (GRAN-09)", () => {
	it("merges Hands and Loft (~50 m apart) at z13 and splits them by z17", () => {
		const { pins, edges } = setup(demoGraph, N.shibuya as string, "place");
		const index = makeClusterIndex(pins);
		const at13 = clustersAt(index, 13);
		const both = at13.find((c) => c.repIds.includes(N.hands as string));
		expect(both?.repIds).toContain(N.loft);
		expect(clustersAt(index, 18).length).toBe(0);
		// The Hands → Loft walk is inside the cluster: hidden while clustered.
		const shown = attachEdgesToClusters(edges, clusterOfRep(at13), () => null);
		expect(
			shown.features.some(
				(f) => f.properties.pairKey === `${I.hands}>${I.loft}`,
			),
		).toBe(false);
	});

	it("never leaves two chips overlapping (closer than the radius)", () => {
		// Web-mercator pixels at zoom z, and back.
		const px = (lng: number, lat: number, z: number): [number, number] => {
			const scale = 512 * 2 ** z;
			const s = Math.sin((lat * Math.PI) / 180);
			return [
				(lng / 360 + 0.5) * scale,
				(0.5 - (0.25 * Math.log((1 + s) / (1 - s))) / Math.PI) * scale,
			];
		};
		const lngLat = (x: number, y: number, z: number): [number, number] => {
			const scale = 512 * 2 ** z;
			return [
				(x / scale - 0.5) * 360,
				(Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / scale))) * 180) / Math.PI,
			];
		};
		// Four places around Shinjuku station, laid out (in z14 pixels) so that
		// supercluster makes two clusters whose centres end up ~25 px apart.
		const z = 14;
		const [x0, y0] = px(139.7005, 35.6909, z);
		const pins = (
			[
				[0, 0],
				[20, 0],
				[40, 0],
				[25, 20],
			] as const
		).map(([dx, dy], i) => {
			const [lng, lat] = lngLat(x0 + dx, y0 + dy, z);
			return { repId: `p${i}`, lng, lat } as PinView;
		});
		const index = makeClusterIndex(pins);
		// What supercluster alone gives: two "2" chips about 25 px apart.
		const raw = index
			.getClusters([-180, -85, 180, 85], z)
			.filter((f) => "cluster" in f.properties && f.properties.cluster);
		expect(raw).toHaveLength(2);
		const chips = clustersAt(index, z);
		expect(chips).toHaveLength(1);
		expect(chips[0]?.count).toBe(4);
		expect(new Set(chips[0]?.repIds)).toEqual(
			new Set(["p0", "p1", "p2", "p3"]),
		);
		// A click zooms one level in, where they split again.
		expect(chips[0]?.expansionZoom).toBe(z + 1);
		expect(clustersAt(index, z + 1)).toHaveLength(0);
		// On the demo trip, at every zoom: no chip within the radius of another
		// chip or of a lone pin.
		const { pins: demoPins } = setup(demoGraph, null, "place");
		const demoIndex = makeClusterIndex(demoPins);
		for (let zz = 3; zz <= 17; zz++) {
			const cs = clustersAt(demoIndex, zz);
			const inChip = new Set(cs.flatMap((c) => c.repIds));
			const dots = [
				...cs.map((c) => px(c.lng, c.lat, zz)),
				...demoPins
					.filter((p) => !inChip.has(p.repId))
					.map((p) => px(p.lng, p.lat, zz)),
			];
			cs.forEach((_, i) => {
				const a = dots[i] as [number, number];
				dots.forEach((b, j) => {
					if (i !== j)
						expect(Math.hypot(a[0] - b[0], a[1] - b[1])).toBeGreaterThanOrEqual(
							CLUSTER_RADIUS_PX,
						);
				});
			});
		}
	});

	it("spiderfies on a circle", () => {
		const offs = spiderOffsets(4);
		expect(offs).toHaveLength(4);
		for (const [x, y] of offs) expect(Math.round(Math.hypot(x, y))).toBe(40);
	});
});

describe("geometry helpers", () => {
	it("fits a Pacific trip across the antimeridian, not across Europe", () => {
		const b = boundsOf([
			[139.7, 35.6],
			[-157.8, 21.3],
		]);
		expect(b?.[0][0]).toBeCloseTo(139.7);
		expect(b?.[1][0]).toBeCloseTo(202.2);
		const atlantic = boundsOf([
			[-74, 40.7],
			[29, 41],
			[139.7, 35.6],
		]);
		expect(atlantic?.[0][0]).toBe(-74);
		expect(atlantic?.[1][0]).toBeCloseTo(139.7);
	});

	it("clamps a stub and snaps a track to its pins", () => {
		const end = toward([139.7, 35.6], [135.7, 35.0], 10_000);
		expect(metres([139.7, 35.6], end)).toBeCloseTo(10_000, -2);
		const snapped = snapEnds(
			{
				type: "LineString",
				coordinates: [
					[139.76, 35.675],
					[138.8, 35.5],
				],
			},
			[139.7672, 35.6723],
			[138.8, 35.5],
		);
		expect(snapped.coordinates).toHaveLength(3);
		expect(snapped.coordinates[0]).toEqual([139.7672, 35.6723]);
	});

	it("fits the globe with a centred camera and moves it clear of the inspector with the camera padding (MAP-01)", () => {
		// 1440 px map, a 500 px inspector on the right (fitPadding adds 36 + 40).
		const pad = { top: 48, right: 576, bottom: 48, left: 36 };
		const first = globeFit(pad, NO_INSETS);
		// The camera looks at the middle of the bounds: the padding's centre
		// shift is cancelled, never turned into ~160° of longitude.
		expect(first.fit.left - first.fit.right).toBeCloseTo(-2 * first.offset[0]);
		expect(first.fit.top - first.fit.bottom).toBeCloseTo(-2 * first.offset[1]);
		// Fitting from a camera with no padding yet: symmetric, the same total room.
		expect(first.fit.left).toBeCloseTo(first.fit.right);
		expect(first.fit.left + first.fit.right).toBeCloseTo(pad.left + pad.right);
		expect(first.offset).toEqual([0, 0]);
		// The one-sided part becomes the camera's own padding: the globe slides left.
		expect(first.camera).toEqual({ top: 0, right: 540, bottom: 0, left: 0 });
		// Once the camera has that padding, the fit is the plain padding.
		const again = globeFit(pad, first.camera);
		expect(again.fit).toEqual(pad);
		expect(again.camera).toEqual(first.camera);
		// The inspector closes: back to no camera padding.
		const closed = globeFit(
			{ top: 48, right: 76, bottom: 48, left: 36 },
			first.camera,
		);
		expect(closed.camera).toEqual({ top: 0, right: 40, bottom: 0, left: 0 });
		// Padding never exceeds the canvas.
		const small = scalePadding(pad, 600, 400, 0.7);
		expect(small.left + small.right).toBeCloseTo(420);
		expect(small.top).toBe(48);
	});

	it("fits visited pins, or the ideas when nothing is visited", () => {
		const { pins } = setup(demoGraph, N.tokyo as string, "place");
		expect(fitBoundsFor(pins)).not.toBeNull();
		expect(fitBoundsFor([])).toBeNull();
	});
});

describe("zoom gesture (DESIGN §11)", () => {
	it("splits new pins out of their old ancestor and merges them from their old children", async () => {
		const { pinOrigins, easeZoom } = await import("../use-pin-motion");
		const city = setup(demoGraph, N.japan as string, "city");
		const area = setup(demoGraph, N.japan as string, "area");
		const split = pinOrigins(city.ix, city.pins, area.pins);
		const tokyo = city.pins.find((p) => p.repId === N.tokyo);
		// Shibuya (an area of Tokyo) starts on the Tokyo pin.
		expect(split.get(N.shibuya as string)).toEqual([tokyo?.lng, tokyo?.lat]);
		const merge = pinOrigins(city.ix, area.pins, city.pins);
		const from = merge.get(N.tokyo as string);
		expect(from).toBeDefined();
		expect(from).not.toEqual([tokyo?.lng, tokyo?.lat]);
		expect(easeZoom(0)).toBe(0);
		expect(easeZoom(1)).toBe(1);
		expect(easeZoom(0.5)).toBeGreaterThan(0.5);
	});
});
