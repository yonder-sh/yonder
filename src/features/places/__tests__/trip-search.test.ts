import { describe, expect, it } from "vitest";
import { indexGraph } from "@/lib/engine/graph-index";
import type { GraphLeg, GraphNode } from "@/lib/engine/types";
import { demoGraph } from "@/lib/fixtures/demo";
import {
	fold,
	isPlaceSearch,
	legSearchText,
	legTargetOf,
	matchesRateCommand,
	matchTripLegs,
	matchTripNodes,
	parseDayQuery,
	parseLatLngQuery,
} from "../lib/trip-search";

const base = demoGraph.nodes[0] as GraphNode;
const named = (name: string, localName: string | null = null): GraphNode => ({
	...base,
	id: `id-${name}`,
	name,
	localName,
});

describe("matchTripNodes (HIER-11)", () => {
	const nodes = [
		named("Da'an District"),
		named("Daan Forest Park"),
		named("Lào Cai"),
		named("Mt. Fuji"),
		named("Kiyomizu-dera"),
		named("Gamla stan", "Glanta"),
	];
	const names = (q: string) => matchTripNodes(nodes, q).map((n) => n.name);

	it("ignores apostrophes: 'daan' finds Da'an District", () => {
		expect(names("daan")).toEqual(["Da'an District", "Daan Forest Park"]);
		expect(names("da'an")).toEqual(["Da'an District", "Daan Forest Park"]);
		expect(names("Da’an district")).toEqual(["Da'an District"]);
	});
	it("still folds accents and case, and treats other punctuation as spaces", () => {
		expect(names("lao cai")).toEqual(["Lào Cai"]);
		expect(names("mt fuji")).toEqual(["Mt. Fuji"]);
		expect(names("mtfuji")).toEqual(["Mt. Fuji"]);
		expect(names("kiyomizu dera")).toEqual(["Kiyomizu-dera"]);
		expect(names("kiyomizudera")).toEqual(["Kiyomizu-dera"]);
		expect(names("glanta")).toEqual(["Gamla stan"]);
		expect(names("   ")).toEqual([]);
	});
	it("fold", () => {
		expect(fold("Da'an")).toBe("daan");
		expect(fold("Mt. Fuji")).toBe("mt fuji");
		expect(fold(null)).toBe("");
	});
});

describe("parseLatLngQuery (HIER-12)", () => {
	it("reads a pasted pair", () => {
		expect(parseLatLngQuery("35.6941, 139.7045")).toEqual({
			ok: true,
			lat: 35.6941,
			lng: 139.7045,
		});
		expect(parseLatLngQuery(" 35.6941 139.7045 ")).toEqual({
			ok: true,
			lat: 35.6941,
			lng: 139.7045,
		});
		expect(parseLatLngQuery("-33.8568,151.2153")).toEqual({
			ok: true,
			lat: -33.8568,
			lng: 151.2153,
		});
		expect(parseLatLngQuery("35.6941° N, 139.7045° E")).toEqual({
			ok: true,
			lat: 35.6941,
			lng: 139.7045,
		});
		expect(parseLatLngQuery("33.8568 S, 151.2153 E")).toEqual({
			ok: true,
			lat: -33.8568,
			lng: 151.2153,
		});
	});
	it("refuses an out-of-range pair", () => {
		const r = parseLatLngQuery("135, 500");
		expect(r?.ok).toBe(false);
		expect(r && !r.ok ? r.error : "").toMatch(/out of range/);
		expect(parseLatLngQuery("35.1, 181")?.ok).toBe(false);
	});
	it("leaves ordinary searches alone", () => {
		expect(parseLatLngQuery("Bar Kuro")).toBeNull();
		expect(parseLatLngQuery("12 34")).toBeNull();
		expect(parseLatLngQuery("Day 4")).toBeNull();
		expect(parseLatLngQuery("7-Eleven 2")).toBeNull();
		expect(parseDayQuery("Day 4")).toBe(4);
	});
});

describe("isPlaceSearch (HIER-12: no stale results under coordinates)", () => {
	it("a name is a search; coordinates, links and one letter are not", () => {
		expect(isPlaceSearch("Bar Kuro")).toBe(true);
		expect(isPlaceSearch("35.6941, 139.7045")).toBe(false);
		// Out of range is still a coordinate pair, not a name to search.
		expect(isPlaceSearch("135, 500")).toBe(false);
		expect(isPlaceSearch("https://maps.app.goo.gl/abc")).toBe(false);
		expect(isPlaceSearch("B")).toBe(false);
		expect(isPlaceSearch("  ")).toBe(false);
		// "Where to first?" searches countries and cities only: no coordinates.
		expect(isPlaceSearch("35.6941, 139.7045", false)).toBe(true);
	});
});

describe("matchTripLegs (HIER-10)", () => {
	const ix = indexGraph(demoGraph);
	const legs = demoGraph.legs;
	const fujiLeg = legs.find((l) => l.mode === "transit") as GraphLeg;
	const withFuji: GraphLeg[] = legs.map((l) =>
		l.id === fujiLeg.id
			? {
					...l,
					details: {
						kind: "transit",
						route: {
							id: "sheet",
							label: "Fuji Excursion (Shinjuku → Kawaguchiko)",
							source: "manual",
							durationMin: 120,
							walkMin: 0,
							transfers: 0,
							segments: [
								{
									mode: "rail",
									lineName: "Fuji Excursion",
									durationMin: 120,
									from: { name: "Shinjuku Station" },
									to: { name: "Kawaguchiko Station" },
								},
							],
						},
						chosenId: "sheet",
					},
				}
			: l,
	);
	const details = (l: GraphLeg) => ix.legDetails(l);
	const titles = (q: string) =>
		matchTripLegs(withFuji, details, q).map((h) => h.title);

	it("finds a named train by its label, line or stops", () => {
		expect(titles("Shinjuku")).toEqual([
			"Fuji Excursion (Shinjuku → Kawaguchiko)",
		]);
		expect(titles("fuji excursion")).toEqual([
			"Fuji Excursion (Shinjuku → Kawaguchiko)",
		]);
		expect(titles("kawaguchiko station")).toEqual([
			"Fuji Excursion (Shinjuku → Kawaguchiko)",
		]);
		const [hit] = matchTripLegs(withFuji, details, "shinjuku");
		expect(hit?.target).toEqual({
			kind: "pair",
			fromItemId: fujiLeg.fromItemId,
			toItemId: fujiLeg.toItemId,
		});
	});
	it("booked legs outrank autofilled estimates (three estimated metro rides can't push the Fuji Excursion out)", () => {
		const estimate = (n: number): GraphLeg => ({
			...fujiLeg,
			id: `est-${n}`,
			source: "estimate",
			isEdited: false,
			depAt: null,
			details: {
				kind: "transit",
				route: {
					id: `est-${n}`,
					label: `Toei Oedo Line ${n} (Shinjuku)`,
					source: "estimate",
					durationMin: 20,
					walkMin: 5,
					transfers: 0,
					segments: [
						{
							mode: "rail",
							lineName: `Toei Oedo Line ${n}`,
							durationMin: 20,
							from: { name: "Shinjuku Station" },
							to: { name: "Tochomae Station" },
						},
					],
				},
				chosenId: `est-${n}`,
			},
		});
		const fuji = withFuji.find((l) => l.id === fujiLeg.id) as GraphLeg;
		const booked = { ...fuji, source: "manual" as const, isEdited: true };
		const legs = [estimate(1), estimate(2), estimate(3), booked];
		const hits = matchTripLegs(legs, details, "Shinjuku").map((h) => h.title);
		expect(hits).toHaveLength(3);
		expect(hits[0]).toBe("Fuji Excursion (Shinjuku → Kawaguchiko)");
	});
	it("finds a flight by its number, airline or airport", () => {
		expect(titles("KE724")).toEqual(["KE 724 (KIX → ICN)"]);
		expect(titles("ke 724")).toEqual(["KE 724 (KIX → ICN)"]);
		expect(titles("icn")).toEqual(["KE 724 (KIX → ICN)"]);
	});
	it("nameless legs (a walk, an unset leg) never match", () => {
		expect(titles("walk")).toEqual([]);
		expect(titles("hands")).toEqual([]);
		expect(titles("")).toEqual([]);
		expect(legSearchText({ kind: "none" })).toBeNull();
		expect(
			legSearchText({
				kind: "other",
				otherKind: "bus",
				label: "Bus → Shiraito Falls",
			})?.title,
		).toBe("Bus → Shiraito Falls");
	});
	it("a stay leg targets its day's end", () => {
		const stay = {
			...fujiLeg,
			kind: "stay_end" as const,
			fromItemId: null,
			toItemId: null,
			stayDayId: "d1",
		};
		expect(legTargetOf(stay)).toEqual({
			kind: "stay",
			dayId: "d1",
			end: "end",
		});
	});
});

describe("matchesRateCommand (FB-05: ⌘K finds the rate screen)", () => {
	it("takes the words for rating, ranking and ideas", () => {
		for (const q of [
			"rat",
			"rate",
			"Rate places",
			"rate tokyo",
			"rating",
			"Ratings",
			"rank",
			"ranking",
			"compare",
			"ideas",
			"IDEA",
			"triage",
		])
			expect(matchesRateCommand(q), q).toBe(true);
	});
	it("leaves places and short text alone", () => {
		for (const q of ["", "ra", "Senso-ji", "ratatouille", "Shibuya", "Day 4"])
			expect(matchesRateCommand(q), q).toBe(false);
	});
});
