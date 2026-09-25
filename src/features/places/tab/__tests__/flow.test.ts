/**
 * The planning flow (owner, 2026-09-25): rate → review → schedule. The step a
 * URL names and the one Places picks without it, the counts on the steps,
 * the Overview's next-step card, and Schedule next (docs/PLACES.md §4):
 * stay windows, fit hints (closed days, free time, distance), can't-fit
 * reasons and where on a day a place goes.
 */
import { describe, expect, it } from "vitest";
import { cityDayTable } from "@/features/places/lib/days";
import { raters } from "@/features/places/lib/rate";
import { scenario } from "@/lib/engine/__fixtures__/demo";
import { indexGraph } from "@/lib/engine/graph-index";
import { computeSchedule } from "@/lib/engine/schedule";
import type { GraphNode, Priority, TripGraph } from "@/lib/engine/types";
import { DEMO_MEMBERS } from "@/lib/fixtures/demo";
import type { OpeningHours } from "@/lib/schemas/hours";
import {
	type FlowTally,
	flowTally,
	nextStep,
	pickStep,
	reviewViewOf,
	stepCounts,
	stepOfView,
	viewOfStep,
} from "../flow";
import { buildRows, placesInScope } from "../model";
import {
	bestSpot,
	cityRowOf,
	compareFits,
	freeTimeOf,
	scheduleNext,
	stayWindows,
} from "../schedule-next";

const D = DEMO_MEMBERS.dennis;
const A = DEMO_MEMBERS.audrey;

describe("the step in the URL", () => {
	it("table / board / map are Review, rate is Rate, schedule is Schedule, none is picked", () => {
		expect(stepOfView("table")).toBe("review");
		expect(stepOfView("board")).toBe("review");
		expect(stepOfView("map")).toBe("review");
		expect(stepOfView("rate")).toBe("rate");
		expect(stepOfView("schedule")).toBe("schedule");
		expect(stepOfView(undefined)).toBeNull();
	});
	it("the Review step keeps its view; other steps open theirs", () => {
		expect(reviewViewOf("board")).toBe("board");
		expect(reviewViewOf("rate", "map")).toBe("map");
		expect(reviewViewOf(undefined)).toBe("table");
		expect(viewOfStep("review", "board")).toBe("board");
		expect(viewOfStep("rate", "board")).toBe("rate");
		expect(viewOfStep("schedule")).toBe("schedule");
	});
});

const tally = (t: Partial<FlowTally>): FlowTally => ({
	ideas: 10,
	toRate: 0,
	shortlisted: 0,
	notOnDay: 0,
	...t,
});
const EDIT = { canEdit: true, hasDays: true };

describe("which step Places opens on", () => {
	const at = (
		t: Partial<FlowTally>,
		c: Partial<Parameters<typeof pickStep>[1]> = {},
	) => pickStep(tally(t), { ...EDIT, phone: false, focus: false, ...c });
	it("Rate when you have places to rate", () => {
		expect(at({ toRate: 4, notOnDay: 2 })).toBe("rate");
	});
	it("then Schedule for shortlisted places not on a day (editors, with days)", () => {
		expect(at({ toRate: 0, notOnDay: 2 })).toBe("schedule");
		expect(at({ notOnDay: 2 }, { canEdit: false })).toBe("review");
		expect(at({ notOnDay: 2 }, { hasDays: false })).toBe("review");
	});
	it("else Review (nothing to rate, an empty trip, a viewer)", () => {
		expect(at({})).toBe("review");
		expect(at({ ideas: 0, toRate: 0 })).toBe("review");
		expect(at({ toRate: null })).toBe("review");
	});
	it("a link to one place or a status filter opens the list", () => {
		expect(at({ toRate: 4 }, { focus: true })).toBe("review");
	});
	it("a phone never opens the full-screen feed by itself", () => {
		expect(at({ toRate: 4 }, { phone: true })).toBe("review");
		expect(at({ toRate: 4, notOnDay: 1 }, { phone: true })).toBe("schedule");
	});
	it("the dot: the step with work waiting for you (never Review)", () => {
		expect(nextStep(tally({ toRate: 3, notOnDay: 2 }), EDIT)).toBe("rate");
		expect(nextStep(tally({ notOnDay: 2 }), EDIT)).toBe("schedule");
		expect(nextStep(tally({ ideas: 0 }), EDIT)).toBeNull();
		expect(nextStep(tally({}), EDIT)).toBeNull();
	});
});

describe("the steps' counts", () => {
	it('"12 to rate", "48 places", "9 shortlisted · 4 not on a day"', () => {
		const c = stepCounts(
			tally({ ideas: 48, toRate: 12, shortlisted: 9, notOnDay: 4 }),
		);
		expect(c).toEqual({
			rate: "12 to rate",
			review: "48 places",
			schedule: "9 shortlisted · 4 not on a day",
		});
		expect(
			stepCounts(tally({ shortlisted: 9, notOnDay: 4 }), { short: true })
				.schedule,
		).toBe("4 not on a day");
	});
	it("edge cases read as words", () => {
		expect(stepCounts(tally({ ideas: 1 })).review).toBe("1 place");
		expect(stepCounts(tally({ ideas: 0 }))).toEqual({
			rate: "Nothing to rate",
			review: "No places yet",
			schedule: "Nothing shortlisted",
		});
		expect(stepCounts(tally({ toRate: null })).rate).toBe("View only");
		expect(stepCounts(tally({ toRate: 0 })).rate).toBe("All rated");
		expect(stepCounts(tally({ shortlisted: 3 })).schedule).toBe(
			"3 shortlisted · all on a day",
		);
	});
});

// ---------------------------------------------------------------------------
// A trip for the counts and Schedule next
// ---------------------------------------------------------------------------

const HOURS = (p: Partial<OpeningHours>): OpeningHours => ({
	source: "manual",
	periods: [0, 1, 2, 3, 4, 5, 6].map((day) => ({
		day,
		open: "09:00",
		close: "17:00",
	})),
	updatedAt: "2026-09-22T00:00:00.000Z",
	...p,
});

/**
 * Tokyo Sun 3 – Mon 4 Oct, Kyoto Tue 5 – Wed 6, Tokyo again Thu 7. Nara has
 * shortlisted places and no days.
 */
function trip() {
	const s = scenario({
		nodes: [
			{
				key: "gion",
				parent: "kyoto",
				type: "area",
				name: "Gion",
				at: [35.0037, 135.7788],
			},
			{
				key: "yasaka",
				parent: "gion",
				type: "place",
				category: "temple_shrine",
				name: "Yasaka Shrine",
				at: [35.0036, 135.7785],
				timeNeededMin: 60,
			},
			{
				key: "museum",
				parent: "kyoto",
				type: "place",
				category: "museum",
				name: "Kyoto Museum",
				at: [34.99, 135.773],
				timeNeededMin: 120,
			},
			{
				key: "nishiki",
				parent: "kyoto",
				type: "place",
				category: "food_drink",
				name: "Nishiki Market",
				at: [35.005, 135.7649],
				timeNeededMin: 90,
			},
			{
				key: "fushimi",
				parent: "kyoto",
				type: "place",
				category: "temple_shrine",
				name: "Fushimi Inari",
				at: [34.9671, 135.7727],
			},
			{
				key: "longHike",
				parent: "kyoto",
				type: "place",
				category: "other",
				name: "Kyoto Trail",
				at: [35.02, 135.8],
				timeNeededMin: 720,
			},
			{
				key: "nara",
				parent: "japan",
				type: "city",
				name: "Nara",
				at: [34.6851, 135.8048],
			},
			{
				key: "todaiji",
				parent: "nara",
				type: "place",
				category: "temple_shrine",
				name: "Tōdai-ji",
				at: [34.689, 135.8398],
				timeNeededMin: 120,
			},
			{
				key: "naraPark",
				parent: "nara",
				type: "place",
				category: "park",
				name: "Nara Park",
				at: [34.685, 135.843],
				timeNeededMin: 90,
			},
			{
				key: "tower",
				parent: "tokyo",
				type: "place",
				category: "viewpoint",
				name: "Tokyo Tower",
				at: [35.6586, 139.7454],
				timeNeededMin: 60,
			},
			{
				key: "idea",
				parent: "tokyo",
				type: "place",
				category: "shopping",
				name: "Just an idea",
				at: [35.67, 139.76],
			},
		],
		days: [
			{
				items: [
					{ k: "hands", node: "hands", min: 45 },
					{ k: "sky", node: "shibuyaSky", min: 60 },
				],
			},
			{ items: [{ k: "sensoji", node: "sensoji", min: 60 }] },
			{ items: [{ k: "kiyomizu", node: "kiyomizu", min: 90 }] },
			{ items: [{ k: "fushimiVisit", node: "fushimi", min: 600 }] },
			{ items: [{ k: "itoya", node: "itoya", min: 60 }] },
		],
	});
	const rate: Record<string, Partial<Record<string, Priority>>> = {
		yasaka: { [D]: "must" },
		nishiki: { [D]: "must", [A]: "want" },
		longHike: { [D]: "must" },
		todaiji: { [D]: "must" },
		tower: { [D]: "really_want", [A]: "want" },
		kiyomizu: { [D]: "must" },
	};
	const nodes: GraphNode[] = s.graph.nodes.map((n) => {
		const key = Object.keys(s.N).find((k) => s.N[k] === n.id) ?? "";
		const out: GraphNode = {
			...n,
			priorities: (rate[key] ?? {}) as Record<string, Priority>,
		};
		if (key === "museum")
			return {
				...out,
				shortlistPin: "pinned",
				// Closed Tuesdays and Wednesdays: every Kyoto day.
				details: { openingHours: HOURS({ closedDays: [2, 3] }) },
			};
		if (key === "nishiki")
			return { ...out, details: { openingHours: HOURS({ closedDays: [3] }) } };
		if (key === "naraPark") return { ...out, shortlistPin: "pinned" };
		return out;
	});
	const graph: TripGraph = { ...s.graph, nodes };
	const ix = indexGraph(graph);
	const schedule = computeSchedule(ix);
	const cityDays = cityDayTable(ix, schedule, null);
	const places = placesInScope(ix, null);
	const memberIds = raters(graph.members, places).map((m) => m.id);
	const rows = buildRows(ix, places, { memberIds, threshold: 3, cityDays });
	return { s, ix, schedule, cityDays, rows };
}

describe("the counts from the rows", () => {
	it("ideas, unrated by you, shortlisted and not on a day", () => {
		const { rows, s } = trip();
		const t = flowTally(rows, { me: D, canRate: true });
		const byName = (n: string) => rows.find((r) => r.name === n);
		expect(byName("Kiyomizu-dera")?.status).toBe("scheduled");
		expect(byName("Tokyo Tower")?.status).toBe("shortlist");
		// Shortlisted: Yasaka, Nishiki, Kyoto Trail, Tōdai-ji, Tokyo Tower,
		// the pinned Museum and Nara Park; scheduled: Kiyomizu and the demo's.
		expect(t.notOnDay).toBe(7);
		const scheduled = rows.filter((r) => r.status === "scheduled").length;
		expect(t.shortlisted).toBe(7 + scheduled);
		expect(t.ideas).toBe(rows.filter((r) => r.status !== "dropped").length);
		const rated = rows.filter(
			(r) => r.status !== "dropped" && r.node.priorities[D],
		).length;
		expect(t.toRate).toBe(t.ideas - rated);
		// Audrey rated two; a viewer (can't rate) gets no count.
		expect(flowTally(rows, { me: A, canRate: true }).toRate).toBe(t.ideas - 2);
		expect(flowTally(rows, { me: D, canRate: false }).toRate).toBeNull();
		expect(s.N.tower).toBeDefined();
	});
});

describe("Schedule next (docs/PLACES.md §4)", () => {
	it("stay windows: runs of consecutive days in one city", () => {
		const { ix, cityDays, s } = trip();
		const w = stayWindows(ix, cityDays);
		expect(w.map((x) => [x.cityName, x.dayIds])).toEqual([
			["Tokyo", [s.D.d1, s.D.d2]],
			["Kyoto", [s.D.d3, s.D.d4]],
			["Tokyo", [s.D.d5]],
		]);
		expect(cityRowOf(ix, cityDays, s.N.yasaka as string)?.name).toBe("Kyoto");
	});

	it("per window: the city's shortlisted places, grouped by area, in both Tokyo windows", () => {
		const { ix, schedule, cityDays, rows, s } = trip();
		const plan = scheduleNext(ix, schedule, rows, cityDays);
		expect(plan.waiting).toBe(7);
		const kyoto = plan.windows.find((w) => w.cityName === "Kyoto");
		expect(
			kyoto?.groups.map((g) => [g.label, g.items.map((c) => c.row.name)]),
		).toEqual([
			["Gion", ["Yasaka Shrine"]],
			["", ["Nishiki Market", "Kyoto Trail"]],
		]);
		const tokyo = plan.windows.filter((w) => w.cityName === "Tokyo");
		expect(
			tokyo.map((w) => w.groups.flatMap((g) => g.items.map((c) => c.row.name))),
		).toEqual([["Tokyo Tower"], ["Tokyo Tower"]]);
		expect(tokyo[1]?.dayIds).toEqual([s.D.d5]);
	});

	it("fit hints: closed days struck, time needed against free time, the nearest stop", () => {
		const { ix, schedule, cityDays, rows, s } = trip();
		const plan = scheduleNext(ix, schedule, rows, cityDays);
		const kyoto = plan.windows.find((w) => w.cityName === "Kyoto");
		const items = kyoto?.groups.flatMap((g) => g.items) ?? [];
		const nishiki = items.find((c) => c.row.name === "Nishiki Market");
		// Closed Wednesdays: Wed 6 is struck, Tue 5 is the day.
		expect(nishiki?.days.map((d) => [d.date, d.closed, d.hoursKnown])).toEqual([
			["2027-10-05", null, true],
			["2027-10-06", "Closed Wed", true],
		]);
		expect(nishiki?.best.dayId).toBe(s.D.d3);
		// Free time: the capacity (12h30) less the day's stops and travel.
		expect(freeTimeOf(schedule, s.D.d3 as string, 750)).toBe(750 - 90);
		expect(nishiki?.best.freeMin).toBe(660);
		expect(nishiki?.best.fits).toBe(true);
		// Nearest stop that day: Kiyomizu-dera, a few km away.
		expect(nishiki?.best.near?.name).toBe("Kiyomizu-dera");
		expect(nishiki?.best.near?.km).toBeGreaterThan(1);
		expect(nishiki?.best.near?.km).toBeLessThan(3);
		// Yasaka is a short walk from Kiyomizu-dera; no hours known.
		const yasaka = items.find((c) => c.row.name === "Yasaka Shrine");
		expect(yasaka?.best.near?.walkMin).toBeLessThanOrEqual(30);
		expect(yasaka?.best.hoursKnown).toBe(false);
		// 12 hours don't fit a day that has 2h30 free (Fushimi takes 10h on Wed).
		const trail = items.find((c) => c.row.name === "Kyoto Trail");
		expect(trail?.days.map((d) => d.fits)).toEqual([false, false]);
		expect(trail?.best.dayId).toBe(s.D.d3);
		// Unset time needed falls back to the category's usual time.
		const tower = plan.windows[0]?.groups[0]?.items[0];
		expect(tower?.needSet).toBe(true);
		expect(tower?.needMin).toBe(60);
	});

	it("the best day: it fits, then nearest, then the most free, then earliest", () => {
		const day = (o: Partial<Parameters<typeof compareFits>[0]>) => ({
			dayId: "x",
			date: "2027-10-05",
			closed: null,
			hoursKnown: true,
			freeMin: 120,
			fits: true,
			near: null,
			...o,
		});
		const near = (km: number) => ({ nodeId: "n", name: "n", km, walkMin: 1 });
		const sorted = [
			day({ dayId: "far", near: near(5) }),
			day({ dayId: "tight", fits: false, near: near(0.1) }),
			day({ dayId: "close", near: near(1) }),
			day({ dayId: "close-later", date: "2027-10-06", near: near(1) }),
		].sort(compareFits);
		expect(sorted.map((d) => d.dayId)).toEqual([
			"close",
			"close-later",
			"far",
			"tight",
		]);
	});

	it("cities with shortlisted places but no days, with the time they need", () => {
		const { ix, schedule, cityDays, rows } = trip();
		const plan = scheduleNext(ix, schedule, rows, cityDays);
		expect(plan.noDays).toHaveLength(1);
		const nara = plan.noDays[0];
		expect(nara?.name).toBe("Nara");
		expect(nara?.rows.map((r) => r.name)).toEqual(["Tōdai-ji", "Nara Park"]);
		expect(nara?.minutes).toBe(210);
		// 3h30 of a 12h30 day: about half a day.
		expect(nara?.days).toBe(0.5);
	});

	it("can't fit: closed every day you're there, a Must in a city with no days", () => {
		const { ix, schedule, cityDays, rows } = trip();
		const plan = scheduleNext(ix, schedule, rows, cityDays);
		expect(plan.cantFit.map((c) => [c.row.name, c.kind, c.reason])).toEqual([
			["Tōdai-ji", "no_days", "Must, but no days in Nara"],
			["Kyoto Museum", "closed", "Closed every day you're in Kyoto"],
		]);
		expect(plan.cantFit[1]?.detail).toBe("Tue 5 Oct, Wed 6 Oct");
		// The museum isn't offered on any Kyoto day.
		const names = plan.windows.flatMap((w) =>
			w.groups.flatMap((g) => g.items.map((c) => c.row.name)),
		);
		expect(names).not.toContain("Kyoto Museum");
		// Nara Park (no Must) waits in the no-days list only.
		expect(plan.cantFit.map((c) => c.row.name)).not.toContain("Nara Park");
	});

	it("no trip days: nothing can't fit for lack of days", () => {
		const { ix, schedule, rows } = trip();
		const plan = scheduleNext(ix, schedule, rows, { rows: [] });
		expect(plan.windows).toEqual([]);
		expect(
			plan.cantFit.filter((c) => c.kind === "no_days").map((c) => c.row.name),
		).toContain("Tōdai-ji");
		const empty = scenario({ days: [] });
		const eix = indexGraph(empty.graph);
		const erows = buildRows(eix, placesInScope(eix, null), {
			memberIds: [D],
			threshold: 3,
		}).map((r) => ({
			...r,
			status: "shortlist" as const,
			must: true,
		}));
		const eplan = scheduleNext(
			eix,
			computeSchedule(eix),
			erows,
			cityDayTable(eix, null, null),
		);
		expect(eplan.cantFit).toEqual([]);
		expect(eplan.noDays.length).toBeGreaterThan(0);
	});
});

describe("where on a day a place goes (bestSpot)", () => {
	// Three stops along a line, about 10 km apart (0.09° of latitude ≈ 10 km).
	function line(pin?: string) {
		const s = scenario({
			nodes: [
				{
					key: "a",
					parent: "kyoto",
					type: "place",
					name: "A",
					at: [35.0, 135.7],
				},
				{
					key: "b",
					parent: "kyoto",
					type: "place",
					name: "B",
					at: [35.09, 135.7],
				},
				{
					key: "p",
					parent: "kyoto",
					type: "place",
					name: "Near B",
					at: [35.085, 135.7],
				},
				{
					key: "q",
					parent: "kyoto",
					type: "place",
					name: "Past B",
					at: [35.11, 135.7],
				},
				{
					key: "r",
					parent: "kyoto",
					type: "place",
					name: "Before A",
					at: [34.99, 135.7],
				},
			],
			days: [
				{
					items: [
						{ k: "a", node: "a", min: 60 },
						{ k: "b", node: "b", min: 60, ...(pin ? { pin } : {}) },
					],
				},
			],
		});
		const ix = indexGraph(s.graph);
		return { s, ix, schedule: computeSchedule(ix), day: s.D.d1 as string };
	}

	it("the cheapest detour: between A and B, after B, before A", () => {
		const { s, ix, day } = line();
		expect(bestSpot(ix, day, s.N.p as string)).toEqual({
			dayId: day,
			afterItemId: s.I.a,
			label: "after A",
		});
		expect(bestSpot(ix, day, s.N.q as string)).toMatchObject({
			afterItemId: s.I.b,
			label: "after B",
		});
		expect(bestSpot(ix, day, s.N.r as string)).toMatchObject({
			beforeItemId: s.I.a,
			label: "before A",
		});
	});

	it("never pushes a pinned stop late", () => {
		// B is pinned right after A: no room before it for an hour's visit.
		const { s, ix, schedule, day } = line("10:05");
		expect(
			bestSpot(ix, day, s.N.p as string, { schedule, needMin: 60 }),
		).toMatchObject({
			afterItemId: s.I.b,
		});
	});

	it("never inside a flight; an empty day or no coordinates: the end of the day", () => {
		// The demo's last day: KIX → ICN by air.
		const d = scenario({
			nodes: [
				{
					key: "rinku",
					parent: "osaka",
					type: "place",
					name: "Rinku Outlets",
					at: [34.405, 135.296],
				},
			],
			days: [
				{
					items: [
						{ k: "kix", node: "kix", min: 120 },
						{ k: "icn", node: "icn", min: 60 },
					],
				},
				{ items: [] },
			],
			legs: [
				{
					k: "f",
					from: "kix",
					to: "icn",
					mode: "flight",
					dep: ["2027-10-03T13:05", "Asia/Tokyo"],
					arr: ["2027-10-03T15:05", "Asia/Seoul"],
				},
			],
		});
		const ix = indexGraph(d.graph);
		expect(ix.blockOf(d.I.kix as string)).not.toBeNull();
		expect(bestSpot(ix, d.D.d1 as string, d.N.rinku as string)).toMatchObject({
			beforeItemId: d.I.kix,
			label: "before Kansai Airport (KIX)",
		});
		expect(bestSpot(ix, d.D.d2 as string, d.N.rinku as string)).toEqual({
			dayId: d.D.d2,
			label: "",
		});
	});
});
