import "./__fixtures__/host-tz";
import { describe, expect, it } from "vitest";
import { demo, N, scenario } from "./__fixtures__/demo";
import { indexGraph, readDetails } from "./graph-index";

describe("indexGraph ordering", () => {
	it("orders days by date and items by (day.date, position, id); unscheduled apart", () => {
		const s = scenario({
			days: [
				{ date: "2027-10-05", items: [{ k: "c", node: "sensoji" }] },
				{
					date: "2027-10-03",
					items: [
						{ k: "a", node: "hands" },
						{ k: "b", title: "Lunch" },
					],
				},
			],
			unscheduled: [{ k: "u", node: "itoya" }],
		});
		const ix = indexGraph(s.graph);
		expect(ix.days.map((d) => d.date)).toEqual(["2027-10-03", "2027-10-05"]);
		expect(ix.ordered.map((i) => i.id)).toEqual([s.I.a, s.I.b, s.I.c]);
		expect(ix.located.map((i) => i.id)).toEqual([s.I.a, s.I.c]);
		expect(ix.unscheduled.map((i) => i.id)).toEqual([s.I.u]);
		expect(ix.orderOf(s.I.u as string)).toBe(-1);
		expect(ix.dayIndex.get("2027-10-05")).toBe(1);
		expect(ix.dayNumber(s.D.d2 as string)).toBe(1);
		expect(ix.prevDay(s.D.d1 as string)).toBeUndefined(); // 10-04 doesn't exist
		expect(ix.pairs).toEqual([
			{
				fromItemId: s.I.a,
				toItemId: s.I.c,
				key: `${s.I.a}>${s.I.c}`,
				crossDay: true,
			},
		]);
		expect(ix.prevLocated(s.I.c as string)?.id).toBe(s.I.a);
		expect(ix.nextLocated(s.I.b as string)?.id).toBe(s.I.c);
	});

	it("sorts children by position then id and walks the outline depth-first", () => {
		const ix = indexGraph(demo.graph);
		expect(ix.children(null).map((n) => n.name)).toEqual([
			"Japan",
			"South Korea",
			"Taiwan",
			"Türkiye",
			"USA",
		]);
		expect(ix.children(N.tokyo as string).map((n) => n.name)).toEqual([
			"Shibuya",
			"Harajuku",
			"Asakusa",
			"Itoya Ginza",
		]);
		expect(ix.path(N.knifeShop as string).map((n) => n.name)).toEqual([
			"Japan",
			"Tokyo",
			"Asakusa",
			"Kappabashi",
			"Kama-asa (knives)",
		]);
		expect(ix.outline[0]?.name).toBe("Japan");
		expect(ix.outlineIndex(N.shibuya as string)).toBeLessThan(
			ix.outlineIndex(N.harajuku as string),
		);
		expect(ix.isWithin(N.hands, N.tokyo as string)).toBe(true);
		expect(ix.isWithin(N.hands, N.kyoto as string)).toBe(false);
		expect(ix.isWithin(N.hands, null)).toBe(true);
		expect(ix.isWithin(null, null)).toBe(false);
	});
});

describe("effective nodes (§8.1)", () => {
	it("uses the previous located item across days, else the next one, else null", () => {
		const s = scenario({
			days: [
				{
					items: [
						{ k: "early", title: "Coffee" },
						{ k: "a", node: "hands" },
						{ k: "lunch", title: "Lunch" },
					],
				},
				{
					items: [
						{ k: "breakfast", title: "Breakfast" },
						{ k: "b", node: "kiyomizu" },
					],
				},
			],
			unscheduled: [
				{ k: "u1", node: "itoya" },
				{ k: "u2", title: "Idea" },
			],
		});
		const ix = indexGraph(s.graph);
		const eff = (k: string) => ix.effectiveNodeId(s.I[k] as string);
		expect(eff("early")).toBe(N.hands); // nothing located earlier in the trip → the next one
		expect(eff("lunch")).toBe(N.hands);
		expect(eff("breakfast")).toBe(N.hands); // across days
		expect(eff("u1")).toBe(N.itoya);
		expect(eff("u2")).toBeNull();
		const none = indexGraph(
			scenario({ days: [{ items: [{ k: "x", title: "X" }] }] }).graph,
		);
		expect(none.effectiveNodeId(none.ordered[0]?.id as string)).toBeNull();
	});

	it("puts items before a day's first located item at last night's stay", () => {
		const s = scenario({
			days: [
				{ night: "ryokan", items: [{ k: "a", node: "hands" }] },
				{
					items: [
						{ k: "bf", title: "Breakfast" },
						{ k: "b", node: "kiyomizu" },
						{ k: "after", title: "Tea" },
					],
				},
			],
		});
		const ix = indexGraph(s.graph);
		expect(ix.effectiveNodeId(s.I.bf as string)).toBe(N.ryokan);
		expect(ix.effectiveNodeId(s.I.after as string)).toBe(N.kiyomizu);
		expect(ix.scheduledNodeIds.has(N.ryokan as string)).toBe(true);
		expect(ix.scheduledNodeIds.has(N.mtFuji as string)).toBe(true); // ancestors too
		expect(ix.scheduledNodeIds.has(N.kawaguchiko as string)).toBe(true);
		expect(ix.scheduledNodeIds.has(N.itoya as string)).toBe(false);
	});
});

describe("legs, boundaries, stays, blocks", () => {
	it("keys legs by pair and by stay, and classifies boundaries", () => {
		const s = scenario({
			days: [
				{ items: [{ k: "a", node: "hands" }] },
				{ items: [{ k: "b", node: "sensoji" }] },
				{ night: "ryokan", items: [{ k: "c", node: "itoya" }] },
				{ items: [{ k: "d", node: "kiyomizu" }] },
				{ items: [{ k: "e", node: "kix" }] },
				{ items: [{ k: "f", node: "icn" }] },
			],
			legs: [
				{ k: "ab", from: "a", to: "b", mode: "transit", min: 30 },
				{
					k: "ef",
					from: "e",
					to: "f",
					mode: "flight",
					dep: ["2027-10-07T13:05", "Asia/Tokyo"],
					arr: ["2027-10-08T15:05", "Asia/Seoul"],
				},
				{
					k: "stay",
					stay: { day: "d4", end: "start" },
					mode: null,
					hasContent: true,
				},
			],
		});
		const ix = indexGraph(s.graph);
		expect(ix.legByPair.get(`${s.I.a}>${s.I.b}`)?.id).toBe(s.L.ab);
		expect(ix.legByStay.get(`${s.D.d4}:start`)?.id).toBe(s.L.stay);
		expect(ix.boundaryKind(s.I.a as string, s.I.b as string)).toBe("moded");
		expect(ix.boundaryKind(s.I.b as string, s.I.c as string)).toBe("overnight");
		expect(ix.boundaryKind(s.I.c as string, s.I.d as string)).toBe("stay");
		expect(ix.boundaryKind(s.I.e as string, s.I.f as string)).toBe("timed");
		expect(ix.morningStay(s.D.d4 as string)).toMatchObject({
			fromNodeId: N.ryokan,
			toNodeId: N.kiyomizu,
			anchorItemId: s.I.d,
		});
		expect(ix.eveningStay(s.D.d3 as string)).toMatchObject({
			fromNodeId: N.itoya,
			toNodeId: N.ryokan,
			anchorItemId: s.I.c,
		});
		expect(ix.eveningStay(s.D.d2 as string)).toBeNull();
		expect(ix.flightBlocks).toEqual([[s.I.e, s.I.f]]);
		expect(ix.blockOf(s.I.f as string)).toEqual([s.I.e, s.I.f]);
		expect(ix.blockOf(s.I.a as string)).toBeNull();
	});

	it("skips stay legs when the boundary is crossed by a leg with a mode, or the stop is the stay itself", () => {
		const s = scenario({
			days: [
				{ night: "ryokan", items: [{ k: "a", node: "itoya" }] },
				{ items: [{ k: "b", node: "kiyomizu" }] },
			],
			legs: [{ from: "a", to: "b", mode: "transit", min: 200 }],
		});
		const ix = indexGraph(s.graph);
		expect(ix.morningStay(s.D.d2 as string)).toBeNull();
		expect(ix.eveningStay(s.D.d1 as string)).toBeNull();
		const same = scenario({
			days: [
				{ night: "ryokan", items: [{ k: "a", node: "ryokan" }] },
				{ items: [{ k: "b", node: "ryokan" }] },
			],
		});
		const ix2 = indexGraph(same.graph);
		expect(ix2.morningStay(same.D.d2 as string)).toBeNull();
		expect(ix2.eveningStay(same.D.d1 as string)).toBeNull();
		expect(ix2.pairs).toEqual([]); // same node: no pair
	});

	it("chains connecting flights into one block", () => {
		const s = scenario({
			days: [
				{ items: [{ k: "tpe", node: "tpe", min: 0 }] },
				{
					items: [
						{ k: "ist", node: "ist", min: 140 },
						{ k: "ewr", node: "ewr", min: 0 },
					],
				},
			],
			legs: [
				{
					from: "tpe",
					to: "ist",
					mode: "flight",
					dep: ["2027-10-03T23:25", "Asia/Taipei"],
					arr: ["2027-10-04T07:35", "Europe/Istanbul"],
				},
				{
					from: "ist",
					to: "ewr",
					mode: "flight",
					dep: ["2027-10-04T09:55", "Europe/Istanbul"],
					arr: ["2027-10-04T13:40", "America/New_York"],
				},
			],
		});
		expect(indexGraph(s.graph).flightBlocks).toEqual([
			[s.I.tpe, s.I.ist, s.I.ewr],
		]);
	});
});

describe("significant and detached legs (§7.8)", () => {
	it("detaches only significant legs whose pair broke", () => {
		const s = scenario({
			days: [
				{
					items: [
						{ k: "a", node: "hands" },
						{ k: "x", node: "meijiJingu" },
						{ k: "b", node: "sensoji" },
					],
				},
			],
			legs: [
				{
					k: "edited",
					from: "a",
					to: "b",
					mode: "transit",
					min: 30,
					isEdited: true,
					source: "google",
				},
				{ k: "auto", from: "b", to: "a", mode: "walk", min: 5, source: "osrm" },
				{
					k: "content",
					from: "x",
					to: "a",
					mode: null,
					hasContent: true,
					source: "estimate",
				},
				{
					k: "current",
					from: "a",
					to: "x",
					mode: "walk",
					min: 5,
					isEdited: true,
				},
			],
		});
		const ix = indexGraph(s.graph);
		expect(ix.detachedLegs.map((d) => d.legId)).toEqual([
			s.L.edited,
			s.L.content,
		]);
		expect(ix.isSignificant(ix.leg(s.L.auto) as never)).toBe(false);
		expect(ix.isSignificant(ix.leg(s.L.current) as never)).toBe(true);
	});

	it("counts manual modes, flights, fixed times, bookings and manual routes as significant", () => {
		const base = {
			days: [
				{
					items: [
						{ k: "a", node: "hands" },
						{ k: "b", node: "sensoji" },
					],
				},
			],
		};
		const sig = (leg: Parameters<typeof scenario>[0]["legs"]) => {
			const s = scenario({ ...base, legs: leg });
			const ix = indexGraph(s.graph);
			return ix.isSignificant(ix.graph.legs[0] as never);
		};
		expect(sig([{ from: "a", to: "b", mode: "walk", source: "manual" }])).toBe(
			true,
		);
		expect(sig([{ from: "a", to: "b", mode: null, source: "manual" }])).toBe(
			false,
		);
		expect(
			sig([
				{
					from: "a",
					to: "b",
					mode: "transit",
					source: "google",
					details: { kind: "transit", booking: { seats: [] } },
				},
			]),
		).toBe(true);
		expect(
			sig([
				{
					from: "a",
					to: "b",
					mode: "transit",
					source: "google",
					details: {
						kind: "transit",
						route: {
							id: "r",
							source: "manual",
							durationMin: 5,
							walkMin: 0,
							transfers: 0,
							segments: [],
						},
					},
				},
			]),
		).toBe(true);
		expect(
			sig([
				{
					from: "a",
					to: "b",
					mode: "transit",
					source: "google",
					details: {
						kind: "transit",
						route: {
							id: "r",
							source: "google",
							durationMin: 5,
							walkMin: 0,
							transfers: 0,
							segments: [],
						},
					},
				},
			]),
		).toBe(false);
	});

	it("reads the DB default {} as { kind: 'none' }", () => {
		const s = scenario({
			days: [
				{
					items: [
						{ k: "a", node: "hands" },
						{ k: "b", node: "loft" },
					],
				},
			],
			legs: [{ from: "a", to: "b" }],
		});
		expect(readDetails(s.graph.legs[0] as never)).toEqual({ kind: "none" });
	});
});

describe("zones and coordinates (§7.4)", () => {
	it("resolves own tz, then the nearest ancestor's, then the trip default, then UTC", () => {
		const s = scenario({
			defaultTz: "Asia/Seoul",
			nodes: [
				{
					key: "orphan",
					parent: null,
					type: "city",
					name: "Orphan",
					at: [0, 0],
				},
				{
					key: "bad",
					parent: "japan",
					type: "place",
					name: "Bad zone",
					tz: "Mars/Base",
				},
			],
			days: [{ items: [] }],
		});
		const ix = indexGraph(s.graph);
		expect(ix.tzOf(N.hands)).toBe("Asia/Tokyo");
		expect(ix.tzOf(N.ewr)).toBe("America/New_York");
		expect(ix.tzOf(s.N.bad)).toBe("Asia/Tokyo");
		expect(ix.tzOf(s.N.orphan)).toBe("Asia/Seoul");
		expect(ix.tzOf(N.usa)).toBe("Asia/Seoul"); // the US country has no single zone
		expect(ix.tzOf("unknown")).toBe("Asia/Seoul");
		const utc = indexGraph(
			scenario({ defaultTz: "Nope/Nope", days: [] }).graph,
		);
		expect(utc.defaultTz).toBe("UTC");
	});

	it("uses a node's own coordinates, else the centre of its located descendants", () => {
		const s = scenario({
			nodes: [
				{ key: "area", parent: "tokyo", type: "area", name: "No coords" },
				{ key: "p", parent: "area", type: "place", name: "P", at: [35, 139] },
				{ key: "q", parent: "area", type: "place", name: "Q", at: [36, 140] },
			],
			days: [],
		});
		const ix = indexGraph(s.graph);
		expect(ix.coordOf(N.hands)).toEqual([139.6989, 35.6617]);
		expect(ix.coordOf(s.N.area)).toEqual([139.5, 35.5]);
		expect(ix.coordOf("unknown")).toBeNull();
	});
});

describe("settings", () => {
	it("applies the TripSettings defaults", () => {
		const ix = indexGraph(scenario({ days: [] }).graph);
		expect(ix.settings).toEqual({
			defaultDayStart: "09:00",
			currency: "USD",
			walkSpeedKmh: 4.5,
			compact: false,
			autofillLegs: true,
			dayCapacityMin: 840,
		});
	});
});
