/**
 * The day split (Schedule step, before any day has a city): what each city's
 * shortlist needs, fitting the trip's length, the order with the least
 * travel, − / + on the suggestion, the split the days hold now, and what
 * applying a changed split writes and moves off a day.
 */
import { describe, expect, it } from "vitest";
import { cityDayTable } from "@/features/places/lib/days";
import { raters } from "@/features/places/lib/rate";
import type { DaySpec, LegSpec } from "@/lib/engine/__fixtures__/demo";
import { scenario } from "@/lib/engine/__fixtures__/demo";
import { haversineKm, type LngLat } from "@/lib/engine/geo";
import { indexGraph } from "@/lib/engine/graph-index";
import { computeSchedule } from "@/lib/engine/schedule";
import type { GraphNode, Priority, TripGraph } from "@/lib/engine/types";
import { DEMO_MEMBERS } from "@/lib/fixtures/demo";
import {
	applyPlan,
	arrivalCity,
	type DaySplit,
	dayCityIds,
	daysNeeded,
	displacedText,
	fitDays,
	layoutDays,
	leftToRate,
	leftToRateText,
	overText,
	routeOrder,
	runsOf,
	type SplitCity,
	splitCities,
	splitText,
	stepCity,
	stepEntry,
	suggestSplit,
	unusedText,
	withOverrides,
} from "../day-split";
import { buildRows, placesInScope } from "../model";

const D = DEMO_MEMBERS.dennis;
const A = DEMO_MEMBERS.audrey;

const day = (night?: string, items: DaySpec["items"] = []): DaySpec => ({
	...(night ? { night } : {}),
	items,
});
const empty = (n: number) => Array.from({ length: n }, () => day());

/**
 * Tokyo (four 12-hour places shortlisted: 4 days), Kyoto (three: 3 days),
 * Hiroshima (one hour: 1 day), Osaka (three places nobody rated), and a
 * Nara day trip; the demo's own places are unrated ideas.
 */
function world(days: DaySpec[], legs: LegSpec[] = []) {
	const place = (
		key: string,
		parent: string,
		at: [number, number],
		min = 720,
	) => ({
		key,
		parent,
		type: "place" as const,
		category: "sight" as const,
		name: key,
		at,
		timeNeededMin: min,
	});
	const s = scenario({
		firstDate: "2027-10-02",
		days,
		legs,
		nodes: [
			place("t1", "tokyo", [35.66, 139.7]),
			place("t2", "tokyo", [35.67, 139.71]),
			place("t3", "tokyo", [35.68, 139.72]),
			place("t4", "tokyo", [35.69, 139.73]),
			{
				key: "hotelT",
				parent: "tokyo",
				type: "place",
				category: "lodging",
				name: "Hotel Tokyo",
				at: [35.68, 139.76],
			},
			{
				key: "hnd",
				parent: "tokyo",
				type: "place",
				category: "airport",
				name: "Haneda",
				at: [35.55, 139.78],
			},
			place("k1", "kyoto", [35.0, 135.77]),
			place("k2", "kyoto", [35.01, 135.78]),
			place("k3", "kyoto", [35.02, 135.79]),
			place("o1", "osaka", [34.69, 135.5]),
			place("o2", "osaka", [34.7, 135.51]),
			place("o3", "osaka", [34.71, 135.52]),
			{
				key: "hiroshima",
				parent: "japan",
				type: "city",
				name: "Hiroshima",
				at: [34.3853, 132.4553],
			},
			place("h1", "hiroshima", [34.39, 132.45], 60),
			{
				key: "nara",
				parent: "japan",
				type: "city",
				name: "Nara",
				at: [34.6851, 135.8048],
			},
			place("todaiji", "nara", [34.689, 135.8398], 600),
		],
	});
	const rate: Record<string, Record<string, Priority>> = {};
	for (const k of ["t1", "t2", "t3", "t4", "k1", "k2", "k3"])
		rate[k] = { [D]: "must", [A]: "want" };
	rate.h1 = { [D]: "must", [A]: "must" };
	rate.todaiji = { [D]: "nah", [A]: "nah" };
	const nodes: GraphNode[] = s.graph.nodes.map((n) => {
		const key = Object.keys(s.N).find((k) => s.N[k] === n.id) ?? "";
		return rate[key] ? { ...n, priorities: rate[key] } : n;
	});
	const graph: TripGraph = { ...s.graph, nodes };
	const ix = indexGraph(graph);
	const schedule = computeSchedule(ix);
	const cityDays = cityDayTable(ix, schedule, null);
	const places = placesInScope(ix, null);
	const members = raters(graph.members, places);
	const rows = buildRows(ix, places, {
		memberIds: members.map((m) => m.id),
		threshold: 3,
		cityDays,
	});
	const cities = splitCities(ix, rows, cityDays, {
		raterIds: members.map((m) => m.id),
		capacityMin: ix.settings.dayCapacityMin,
	});
	return { s, ix, cityDays, rows, members, cities };
}

const names = (split: DaySplit) =>
	split.rows.map((r) => [r.name, r.days] as const);

describe("what each city's shortlist needs", () => {
	it("the sights estimate in whole days, rounded up", () => {
		// 12h30 a day: an hour is half a day (1), 1.4 days reads 1.5 (2).
		expect(daysNeeded(60, 750)).toBe(1);
		expect(daysNeeded(750, 750)).toBe(1);
		expect(daysNeeded(750 * 1.4, 750)).toBe(2);
		expect(daysNeeded(2880, 750)).toBe(4);
	});

	it("every city with places, shortlisted or not, with what's left to rate", () => {
		const { cities } = world(empty(14));
		const by = Object.fromEntries(cities.map((c) => [c.name, c]));
		expect(by.Tokyo).toMatchObject({ shortlisted: 4, need: 4, minutes: 2880 });
		expect(by.Kyoto).toMatchObject({ shortlisted: 3, need: 3 });
		expect(by.Hiroshima).toMatchObject({
			shortlisted: 1,
			need: 1,
			notRated: 0,
		});
		// Nothing shortlisted: listed, needing no days.
		expect(by.Osaka).toMatchObject({ shortlisted: 0, need: 0, notRated: 3 });
		// The demo's seven Tokyo places and Kiyomizu-dera are unrated.
		expect(by.Tokyo?.notRated).toBe(7);
		expect(by.Kyoto?.notRated).toBe(1);
		// Everyone said Nah to Tōdai-ji: Nara has nothing that isn't dropped.
		expect(by.Nara).toBeUndefined();
	});
});

describe("fitting the trip's length", () => {
	it("everything fits: as needed", () => {
		expect(fitDays([4, 3, 1, 0], 14)).toEqual([4, 3, 1, 0]);
	});
	it("too long: scaled down, at least 1 each", () => {
		expect(fitDays([4, 3, 1, 0], 7)).toEqual([3, 3, 1, 0]);
		const days = fitDays([5, 4, 4, 3], 14);
		expect(days).toEqual([4, 4, 3, 3]);
		expect(days.reduce((s, n) => s + n, 0)).toBe(14);
		expect(fitDays([9, 1, 1], 4)).toEqual([2, 1, 1]);
	});
	it("more cities than days: a day each for those that need the most", () => {
		expect(fitDays([1, 3, 2, 1], 2)).toEqual([0, 1, 1, 0]);
		expect(fitDays([2, 2], 0)).toEqual([0, 0]);
	});
});

describe("the suggestion", () => {
	it("fits: the rest is unused", () => {
		const { ix, cities } = world(empty(14));
		const split = suggestSplit(ix, cities, 14);
		expect(split.need).toBe(8);
		expect(split.unused).toBe(6);
		// Nothing located: from the city with the most days, the least travel;
		// Osaka (no days) after the route.
		expect(names(split)).toEqual([
			["Tokyo", 4],
			["Kyoto", 3],
			["Hiroshima", 1],
			["Osaka", 0],
		]);
		expect(unusedText(split.unused)).toBe("6 days not used");
		expect(unusedText(1)).toBe("1 day not used");
	});

	it("doesn't fit: scaled down, with the numbers for the message", () => {
		const { ix, cities } = world(empty(7));
		const split = suggestSplit(ix, cities, 7);
		expect(names(split)).toEqual([
			["Tokyo", 3],
			["Kyoto", 3],
			["Hiroshima", 1],
			["Osaka", 0],
		]);
		expect(split.unused).toBe(0);
		expect(overText(split.need, split.tripDays)).toBe(
			"Your shortlist needs about 8 days, and you have 7. Remove a city or some places.",
		);
	});

	it("starts where the trip arrives: a first flight's landing, or the first stop's city", () => {
		// Newark → Haneda (Tokyo): from Tokyo.
		const flight = world(
			[
				day(undefined, [
					{ k: "ewr", node: "ewr" },
					{ k: "hnd", node: "hnd" },
				]),
				...empty(9),
			],
			[
				{
					from: "ewr",
					to: "hnd",
					mode: "flight",
					dep: ["2027-10-02T10:00", "America/New_York"],
					arr: ["2027-10-03T14:00", "Asia/Tokyo"],
				},
			],
		);
		expect(arrivalCity(flight.ix, flight.cities)).toBe(flight.s.N.tokyo);
		// The first stop in Kyoto: from Kyoto, then the nearest (Hiroshima).
		const kyoto = world([
			day(undefined, [{ k: "k", node: "kiyomizu" }]),
			...empty(9),
		]);
		const split = suggestSplit(kyoto.ix, kyoto.cities, 10);
		expect(split.rows.map((r) => r.name)).toEqual([
			"Kyoto",
			"Hiroshima",
			"Tokyo",
			"Osaka",
		]);
		// Landing in Osaka (no days there): the nearest city with days, Kyoto.
		const kix = world([day(undefined, [{ k: "x", node: "kix" }]), ...empty(9)]);
		const on = kix.cities.filter((c) => c.need > 0);
		expect(arrivalCity(kix.ix, on)).toBe(kix.s.N.kyoto);
	});
});

describe("the order with the least travel", () => {
	const pts = (xs: [string, number, number][]) =>
		xs.map(([id, lng, lat]) => ({ id, at: [lng, lat] as LngLat }));
	const length = (order: string[], p: { id: string; at: LngLat }[]) => {
		const at = (id: string) => p.find((x) => x.id === id)?.at as LngLat;
		let km = 0;
		for (let i = 1; i < order.length; i++)
			km += haversineKm(at(order[i - 1] as string), at(order[i] as string));
		return km;
	};

	it("from the start, along the way; places without coordinates last", () => {
		const p = pts([
			["osaka", 135.5, 34.69],
			["tokyo", 139.65, 35.68],
			["hiroshima", 132.46, 34.39],
			["kyoto", 135.77, 35.01],
		]);
		expect(routeOrder(p, "tokyo")).toEqual([
			"tokyo",
			"kyoto",
			"osaka",
			"hiroshima",
		]);
		expect(
			routeOrder([...p, { id: "nowhere", at: null }], "hiroshima"),
		).toEqual(["hiroshima", "osaka", "kyoto", "tokyo", "nowhere"]);
	});

	it("2-opt: never longer than nearest neighbour alone, the start kept first", () => {
		let seed = 7;
		const rnd = () => {
			seed = (seed * 16807) % 2147483647;
			return seed / 2147483647;
		};
		for (let t = 0; t < 30; t++) {
			const p = Array.from({ length: 7 }, (_, i) => ({
				id: `c${i}`,
				at: [130 + rnd() * 10, 31 + rnd() * 10] as LngLat,
			}));
			// Nearest neighbour alone, for comparison.
			const nn = ["c0"];
			const todo = p.slice(1).map((x) => x.id);
			while (todo.length) {
				const last = p.find((x) => x.id === nn.at(-1))?.at as LngLat;
				todo.sort(
					(a, b) =>
						haversineKm(last, p.find((x) => x.id === a)?.at as LngLat) -
						haversineKm(last, p.find((x) => x.id === b)?.at as LngLat),
				);
				nn.push(todo.shift() as string);
			}
			const route = routeOrder(p, "c0");
			expect(route[0]).toBe("c0");
			expect([...route].sort()).toEqual(p.map((x) => x.id).sort());
			expect(length(route, p)).toBeLessThanOrEqual(length(nn, p) + 1e-6);
		}
	});
});

describe("− / + on the suggestion", () => {
	const split = (days: number) => {
		const { ix, cities } = world(empty(days));
		return suggestSplit(ix, cities, days);
	};
	const idOf = (s: DaySplit, name: string) =>
		s.rows.find((r) => r.name === name)?.id as string;

	it("+ takes an unused day; − gives one back", () => {
		const s = split(14);
		const plus = stepCity(s, {}, idOf(s, "Osaka"), 1) ?? {};
		const a = withOverrides(s, plus);
		expect(names(a).at(-1)).toEqual(["Osaka", 1]);
		expect(a.unused).toBe(5);
		const minus = stepCity(a, plus, idOf(s, "Tokyo"), -1) ?? {};
		expect(withOverrides(s, minus).unused).toBe(6);
		// Not below 0.
		expect(stepCity(s, {}, idOf(s, "Osaka"), -1)).toBeNull();
	});

	it("too long: − frees a day (the others keep theirs); + needs an unused one", () => {
		const s = split(7);
		expect(stepCity(s, {}, idOf(s, "Osaka"), 1)).toBeNull();
		const o = stepCity(s, {}, idOf(s, "Tokyo"), -1) ?? {};
		const a = withOverrides(s, o);
		expect(names(a)).toEqual([
			["Tokyo", 2],
			["Kyoto", 3],
			["Hiroshima", 1],
			["Osaka", 0],
		]);
		expect(a.unused).toBe(1);
		const b = withOverrides(s, stepCity(a, o, idOf(s, "Hiroshima"), 1) ?? {});
		expect(b.unused).toBe(0);
		expect(names(b)[2]).toEqual(["Hiroshima", 2]);
	});

	it("a new suggestion never takes a day you set", () => {
		const s = split(14);
		const o = { [idOf(s, "Hiroshima")]: 5 };
		const cities: SplitCity[] = s.rows.map((r) =>
			r.name === "Tokyo" ? { ...r, need: 12 } : r,
		);
		const { ix } = world(empty(14));
		const next = withOverrides(suggestSplit(ix, cities, 14), o);
		expect(Object.fromEntries(names(next)).Hiroshima).toBe(5);
		expect(next.rows.reduce((s, r) => s + r.days, 0)).toBe(14);
		expect(next.unused).toBe(0);
	});
});

describe("the split the days hold", () => {
	it("runs of nights in one city; a day trip stays a day of where you sleep; the last day follows the night before", () => {
		const w = world([
			day("hotelT"),
			day("tokyo"),
			day("kyoto", [{ k: "nara", node: "todaiji", min: 600 }]),
			day("kyoto"),
			day(),
		]);
		const N = w.s.N;
		const cities = dayCityIds(w.ix, w.cityDays);
		expect(cities).toEqual([N.tokyo, N.tokyo, N.kyoto, N.kyoto, N.kyoto]);
		const { entries, unused } = runsOf(cities);
		expect(entries).toEqual([
			{ cityId: N.tokyo, days: 2 },
			{ cityId: N.kyoto, days: 3 },
		]);
		expect(unused).toBe(0);
		const name = (id: string) => w.ix.node(id)?.name ?? "";
		expect(splitText(entries, name)).toBe("Tokyo 2 · Kyoto 3");
	});

	it("days with no night and nothing on them are unused; runs split around them", () => {
		const w = world([day("tokyo"), day(), day("kyoto"), day(), day()]);
		const N = w.s.N;
		expect(runsOf(dayCityIds(w.ix, w.cityDays))).toEqual({
			entries: [
				{ cityId: N.tokyo, days: 1 },
				{ cityId: N.kyoto, days: 1 },
			],
			unused: 3,
		});
	});

	it("laid on the days in order; − moves the later cities up and frees the last day", () => {
		const e = [
			{ cityId: "t", days: 2 },
			{ cityId: "k", days: 2 },
		];
		expect(layoutDays(e, 5)).toEqual(["t", "t", "k", "k", null]);
		const less = stepEntry(e, 0, -1, 5) ?? [];
		expect(layoutDays(less, 5)).toEqual(["t", "k", "k", null, null]);
		const more = stepEntry(e, 1, 1, 5) ?? [];
		expect(layoutDays(more, 5)).toEqual(["t", "t", "k", "k", "k"]);
		// No free day left: + can't; − not below 0.
		expect(stepEntry(more, 0, 1, 5)).toBeNull();
		expect(stepEntry([{ cityId: "t", days: 0 }], 0, -1, 5)).toBeNull();
	});
});

describe("applying a split", () => {
	it("the first split: each city's nights in ranges; unused days get none; the last day none when it's the day before's city", () => {
		const w = world(empty(8));
		const N = w.s.N;
		const D8 = w.s.D;
		const next = layoutDays(
			[
				{ cityId: N.tokyo as string, days: 4 },
				{ cityId: N.kyoto as string, days: 3 },
			],
			8,
		);
		const plan = applyPlan(w.ix, next, dayCityIds(w.ix, w.cityDays));
		expect(plan.stays).toEqual([
			{ fromDayId: D8.d1, toDayId: D8.d4, nodeId: N.tokyo },
			{ fromDayId: D8.d5, toDayId: D8.d7, nodeId: N.kyoto },
		]);
		expect(plan.displaced).toEqual([]);
		// Every day used: the last day is the day you leave Kyoto.
		const all = layoutDays(
			[
				{ cityId: N.tokyo as string, days: 4 },
				{ cityId: N.kyoto as string, days: 4 },
			],
			8,
		);
		expect(applyPlan(w.ix, all, dayCityIds(w.ix, w.cityDays)).stays).toEqual([
			{ fromDayId: D8.d1, toDayId: D8.d4, nodeId: N.tokyo },
			{ fromDayId: D8.d5, toDayId: D8.d7, nodeId: N.kyoto },
		]);
		// A last day in another city gets that city's night.
		const hop = layoutDays(
			[
				{ cityId: N.tokyo as string, days: 7 },
				{ cityId: N.hiroshima as string, days: 1 },
			],
			8,
		);
		expect(applyPlan(w.ix, hop, dayCityIds(w.ix, w.cityDays)).stays).toEqual([
			{ fromDayId: D8.d1, toDayId: D8.d7, nodeId: N.tokyo },
			{ fromDayId: D8.d8, toDayId: D8.d8, nodeId: N.hiroshima },
		]);
	});

	it("a change: hotels in the right city stay; places on days that change city go back", () => {
		const w = world([
			day("hotelT", [{ k: "a", node: "t1" }]),
			day("tokyo", [
				{ k: "b", node: "t2" },
				{ k: "hndStop", node: "hnd" },
			]),
			day("kyoto", [{ k: "nara", node: "todaiji", min: 600 }]),
			day("kyoto", [{ k: "c", node: "k1" }]),
			day(),
		]);
		const { N, D: DD, I } = w.s;
		const current = dayCityIds(w.ix, w.cityDays);
		const { entries } = runsOf(current);
		// − on Tokyo: Kyoto moves up a day, the last day is freed.
		const next = layoutDays(stepEntry(entries, 0, -1, 5) ?? [], 5);
		expect(next).toEqual([N.tokyo, N.kyoto, N.kyoto, N.kyoto, null]);
		const plan = applyPlan(w.ix, next, current);
		// Day 1 keeps its Tokyo hotel; day 2 sleeps in Kyoto; days 3–4 already do.
		expect(plan.stays).toEqual([
			{ fromDayId: DD.d2, toDayId: DD.d2, nodeId: N.kyoto },
		]);
		// Tokyo's t2 leaves day 2 (the airport isn't a place to schedule); the
		// Nara day trip stays on a day that stays Kyoto's.
		expect(plan.displaced.map((it) => it.id)).toEqual([I.b]);
		expect(displacedText(plan.displaced.length)).toBe(
			"1 place is on a day that moves to another city. It'll go back to your list to schedule again.",
		);
		expect(displacedText(3)).toBe(
			"3 places are on days that move to another city. They'll go back to your list to schedule again.",
		);
		// Freeing a day with a place on it sends it back too.
		const shorter = layoutDays(
			[
				{ cityId: N.tokyo as string, days: 2 },
				{ cityId: N.kyoto as string, days: 1 },
			],
			5,
		);
		const p2 = applyPlan(w.ix, shorter, current);
		expect(p2.displaced.map((it) => it.id)).toEqual([I.c]);
		expect(p2.stays).toEqual([
			{ fromDayId: DD.d4, toDayId: DD.d4, nodeId: null },
		]);
	});
});

describe("who still has places to rate", () => {
	it("you first, then the others with their own counts", () => {
		const { rows, members } = world(empty(3));
		const left = leftToRate(rows, members, A);
		expect(left.map((x) => [x.name, x.you])).toEqual([
			["Audrey", true],
			["Dennis", false],
		]);
		expect(left[0]?.count).toBe(left[1]?.count);
	});

	it("reads as one sentence", () => {
		const x = (name: string, count: number, you = false) => ({
			memberId: name,
			name,
			you,
			count,
		});
		expect(leftToRateText([x("You", 40, true), x("Audrey", 12)])).toBe(
			"You have 40 places to rate and Audrey 12. These days will change as you rate.",
		);
		expect(leftToRateText([x("You", 40, true)])).toBe(
			"You have 40 places to rate. These days will change as you rate.",
		);
		expect(
			leftToRateText([x("You", 3, true), x("Audrey", 2), x("Maya", 1)]),
		).toBe(
			"You have 3 places to rate, Audrey 2 and Maya 1. These days will change as you rate.",
		);
		expect(leftToRateText([x("Audrey", 1)])).toBe(
			"Audrey has 1 place to rate. These days will change as they rate.",
		);
		expect(leftToRateText([])).toBeNull();
	});
});
