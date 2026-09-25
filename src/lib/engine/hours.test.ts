import "./__fixtures__/host-tz";
import { describe, expect, it } from "vitest";
import type { OpeningHours } from "@/lib/schemas/hours";
import type { Holiday } from "@/lib/schemas/trips";
import { type ScenarioSpec, scenario } from "./__fixtures__/demo";
import { indexGraph } from "./graph-index";
import {
	type EffectiveHours,
	effectiveHours,
	hoursFixes,
	hoursIssues,
	hoursOnDate,
} from "./hours";
import { computeSchedule } from "./schedule";
import { sunTimes } from "./sun";
import type { GraphNode } from "./types";

const AT = "2026-09-01T00:00:00.000Z";
const manual = (h: Partial<OpeningHours>): OpeningHours => ({
	source: "manual",
	periods: [],
	updatedAt: AT,
	...h,
});
const daily = (
	open: string,
	close: OpeningHours["periods"][number]["close"],
	days = [0, 1, 2, 3, 4, 5, 6],
) => days.map((day) => ({ day, open, close }));

/** Builds a scenario, puts `details` on nodes by key, and returns the issues. */
function run(
	spec: ScenarioSpec,
	details: Record<string, GraphNode["details"]>,
	opts: {
		holidays?: Holiday[];
		sun?: boolean;
		hoursOf?: (n: GraphNode) => EffectiveHours | null;
	} = {},
) {
	const s = scenario(spec);
	for (const [key, d] of Object.entries(details)) {
		const node = s.graph.nodes.find((n) => n.id === s.N[key]);
		if (!node) throw new Error(`no node ${key}`);
		node.details = d;
	}
	const ix = indexGraph(s.graph);
	const schedule = computeSchedule(ix);
	const issues = hoursIssues(ix, schedule, {
		hoursOf: (id) => {
			const n = ix.node(id);
			if (!n) return null;
			return opts.hoursOf
				? opts.hoursOf(n)
				: effectiveHours(n, s.graph.trip.settings);
		},
		holidays: opts.holidays ?? [],
		...(opts.sun
			? {
					sunOf: (dayId: string) => {
						const day = ix.day(dayId);
						return day ? sunTimes(day.date, 35.5, 138.8, "Asia/Tokyo") : null;
					},
				}
			: {}),
	});
	return { s, ix, schedule, issues };
}

const EXTRA: ScenarioSpec["nodes"] = [
	{
		key: "bar",
		parent: "tokyo",
		type: "place",
		category: "bar",
		name: "Bar Albatross",
		at: [35.6938, 139.7034],
	},
	{
		key: "museum",
		parent: "tokyo",
		type: "place",
		category: "museum",
		name: "Ghibli Museum",
		at: [35.6962, 139.5704],
	},
	{
		key: "chureito",
		parent: "kawaguchiko",
		type: "place",
		category: "viewpoint",
		name: "Chureito Pagoda",
		at: [35.5014, 138.8016],
	},
	{
		key: "seoulShop",
		parent: "seoul",
		type: "place",
		category: "shopping",
		name: "Gwangjang Market",
		at: [37.57, 127.0],
	},
];

describe("hoursIssues", () => {
	it("flags a Wednesday closure on the card and the day (HRS-01)", () => {
		// 2027-10-06 is a Wednesday.
		const { s, issues } = run(
			{
				firstDate: "2027-10-06",
				days: [{ items: [{ k: "itoya", node: "itoya", min: 60 }] }],
			},
			{
				itoya: {
					openHoursText: "Earliest tour 9:30–11:40 (reserve); closed Wed & Fri",
				},
			},
		);
		const list = issues.byItem[s.I.itoya ?? ""];
		expect(list).toEqual([
			{
				kind: "closed",
				severity: "warn",
				label: "Closed Wed",
				source: "sheet",
			},
		]);
		expect(issues.byDay[s.D.d1 ?? ""]).toEqual({ warn: 1, info: 0 });
	});

	it("doesn't flag a bar at 01:00 after an 18:00–03:00 night (HRS-05)", () => {
		const { s, issues } = run(
			{
				firstDate: "2027-10-05",
				days: [{ items: [{ k: "bar", node: "bar", min: 60, pin: "01:00" }] }],
				nodes: EXTRA,
			},
			{ bar: { openingHours: manual({ periods: daily("18:00", "03:00") }) } },
		);
		expect(issues.byItem[s.I.bar ?? ""]).toBeUndefined();
	});

	it("warns when the visit starts after the last entry", () => {
		const { s, issues } = run(
			{
				firstDate: "2027-10-05",
				days: [{ items: [{ k: "m", node: "museum", min: 60, pin: "21:30" }] }],
				nodes: EXTRA,
			},
			{ museum: { openHoursText: "10:00–22:30 (last adm 21:20)" } },
		);
		expect(issues.byItem[s.I.m ?? ""]).toEqual([
			{
				kind: "after_close",
				severity: "warn",
				label: "Last entry 21:20",
				close: "22:30",
				source: "sheet",
			},
		]);
	});

	it("reads the 2nd Tuesday: 2027-10-12 is closed, 2027-10-05 isn't", () => {
		const { s, issues } = run(
			{
				firstDate: "2027-10-05",
				days: [
					{ items: [{ k: "a", node: "museum", min: 60, pin: "11:00" }] },
					...Array.from({ length: 6 }, () => ({ items: [] })),
					{ items: [{ k: "b", node: "museum", min: 60, pin: "11:00" }] },
				],
				nodes: EXTRA,
			},
			{ museum: { openHoursText: "10:30–19:00; closed 2nd Tue" } },
		);
		expect(issues.byItem[s.I.a ?? ""]).toBeUndefined();
		expect(issues.byItem[s.I.b ?? ""]?.[0]?.label).toBe("Closed 2nd Tue");
	});

	it("uses a holiday exception, and day-7 hours only in the holiday's country (HRS-06)", () => {
		const holidays: Holiday[] = [
			{ date: "2027-10-11", name: "Sports Day", countryCode: "JP" },
		];
		const closed = run(
			{
				firstDate: "2027-10-11",
				days: [{ items: [{ k: "m", node: "museum", min: 60, pin: "11:00" }] }],
				nodes: EXTRA,
			},
			{
				museum: {
					openingHours: manual({
						periods: daily("10:00", "18:00"),
						exceptions: [
							{ date: "2027-10-11", closed: true, label: "Sports Day" },
						],
					}),
				},
			},
			{ holidays },
		);
		expect(closed.issues.byItem[closed.s.I.m ?? ""]?.[0]).toMatchObject({
			kind: "closed",
			label: "Closed · Sports Day",
		});

		const sunday = { openHoursText: "Mon–Sat 10:00–20:00; Sun/hol to 19:00" };
		const jp = run(
			{
				firstDate: "2027-10-11",
				days: [{ items: [{ k: "m", node: "museum", min: 30, pin: "19:15" }] }],
				nodes: EXTRA,
			},
			{ museum: sunday },
			{ holidays },
		);
		expect(jp.issues.byItem[jp.s.I.m ?? ""]?.[0]).toMatchObject({
			kind: "after_close",
			label: "Closes 19:00",
		});
		const kr = run(
			{
				firstDate: "2027-10-11",
				days: [
					{ items: [{ k: "m", node: "seoulShop", min: 30, pin: "19:15" }] },
				],
				nodes: EXTRA,
			},
			{ seoulShop: sunday },
			{ holidays },
		);
		expect(kr.issues.byItem[kr.s.I.m ?? ""]).toBeUndefined();
	});

	it("reads the weekday in the node's zone, not UTC or the host's", () => {
		// 08:30 KST on Tue 5 Oct is still Monday in UTC; the shop is closed on Mondays.
		const { s, issues } = run(
			{
				firstDate: "2027-10-05",
				defaultTz: "Asia/Seoul",
				days: [
					{
						start: "08:00",
						items: [{ k: "g", node: "seoulShop", min: 60, pin: "08:30" }],
					},
				],
				nodes: EXTRA,
			},
			{
				seoulShop: {
					openingHours: manual({
						periods: daily("08:00", "20:00", [0, 2, 3, 4, 5, 6]),
					}),
				},
			},
		);
		expect(issues.byItem[s.I.g ?? ""]).toBeUndefined();
	});

	it("stays silent at low confidence except for explicit closures", () => {
		const low = (n: GraphNode): EffectiveHours | null =>
			n.name === "Ghibli Museum"
				? {
						hours: manual({
							periods: daily("10:00", "17:00", [0, 1, 2, 4, 5, 6]),
						}),
						source: "sheet",
						confidence: "low",
					}
				: null;
		const { s, issues } = run(
			{
				firstDate: "2027-10-05",
				days: [
					{ items: [{ k: "late", node: "museum", min: 60, pin: "18:00" }] },
					{ items: [{ k: "wed", node: "museum", min: 60, pin: "11:00" }] },
				],
				nodes: EXTRA,
			},
			{},
			{ hoursOf: low },
		);
		expect(issues.byItem[s.I.late ?? ""]).toBeUndefined();
		expect(issues.byItem[s.I.wed ?? ""]).toBeUndefined();
	});

	it("marks a viewpoint after dark as info: Chureito at 17:30 in mid-October (SUN-03)", () => {
		const { s, issues } = run(
			{
				firstDate: "2027-10-15",
				days: [
					{ items: [{ k: "c", node: "chureito", min: 60, pin: "17:30" }] },
				],
				nodes: EXTRA,
			},
			{},
			{ sun: true },
		);
		const [issue] = issues.byItem[s.I.c ?? ""] ?? [];
		expect(issue?.kind).toBe("after_dark");
		expect(issue?.severity).toBe("info");
		expect(issue?.label).toMatch(/^After dark · sunset 17:\d\d$/);
		expect(issues.byDay[s.D.d1 ?? ""]).toEqual({ warn: 0, info: 1 });
	});

	it("keeps the hedge at medium confidence", () => {
		const { s, issues } = run(
			{
				firstDate: "2027-10-05",
				days: [
					{ items: [{ k: "k", node: "knifeShop", min: 60, pin: "16:30" }] },
				],
			},
			{ knifeShop: { openHoursText: "shops ~10:00–17:00; many closed Sun" } },
		);
		expect(issues.byItem[s.I.k ?? ""]).toEqual([
			{
				kind: "closes_during",
				severity: "warn",
				label: "Closes ~17:00 · 30m short",
				close: "17:00",
				source: "sheet",
				hedged: true,
			},
		]);
	});

	it("marks an approximate closure and an early arrival as info only", () => {
		const { s, issues } = run(
			{
				firstDate: "2027-10-03",
				days: [
					{
						start: "08:00",
						items: [{ k: "k", node: "knifeShop", min: 90, pin: "09:30" }],
					},
				],
			},
			{ knifeShop: { openHoursText: "shops ~10:00–17:00; many closed Sun" } },
		);
		const list = issues.byItem[s.I.k ?? ""] ?? [];
		expect(list.map((i) => [i.kind, i.severity, i.label])).toEqual([
			["maybe_closed", "info", "May be closed Sun"],
			["before_open", "info", "Opens ~10:00"],
		]);
		expect(issues.byDay[s.D.d1 ?? ""]).toEqual({ warn: 0, info: 1 });
	});

	it("skips unlocated items, lodging and always-open places", () => {
		const { issues } = run(
			{
				firstDate: "2027-10-06",
				days: [
					{
						night: "ryokan",
						items: [
							{ k: "lunch", title: "Lunch", min: 60 },
							{ k: "sensoji", node: "sensoji", min: 60, pin: "23:00" },
							{ k: "bags", node: "ryokan", min: 30 },
						],
					},
				],
			},
			{
				sensoji: { openHoursText: "Main hall 06:30–17:00 (Oct); grounds 24h" },
				ryokan: { openingHours: manual({ closedDays: [3] }) },
			},
		);
		expect(issues.byItem).toEqual({});
	});

	it("manual hours beat the sheet (HRS-03)", () => {
		const { s, issues } = run(
			{
				firstDate: "2027-10-06",
				days: [
					{ items: [{ k: "itoya", node: "itoya", min: 60, pin: "11:00" }] },
				],
			},
			{
				itoya: {
					openHoursText: "closed Wed",
					openingHours: manual({ periods: daily("10:00", "20:00") }),
				},
			},
		);
		expect(issues.byItem[s.I.itoya ?? ""]).toBeUndefined();
	});
});

describe("effectiveHours", () => {
	const node = (details: GraphNode["details"]) => ({ details }) as GraphNode;
	const noteOnly: OpeningHours = {
		source: "osm",
		periods: [],
		note: "Mo-Fr 09:00-18:00; SH off",
		updatedAt: AT,
	};
	it("stored OSM hours beat the sheet, like Google's", () => {
		const osm = { ...noteOnly, periods: daily("09:00", "18:00") };
		expect(
			effectiveHours(
				node({ openingHours: osm, openHoursText: "10:00–20:00" }),
				{},
			),
		).toMatchObject({ source: "osm", hours: osm });
	});
	it("a note-only OSM record (a tag the model can't say) gives way to the sheet", () => {
		expect(
			effectiveHours(
				node({ openingHours: noteOnly, openHoursText: "10:00–20:00" }),
				{},
			)?.source,
		).toBe("sheet");
		expect(effectiveHours(node({ openingHours: noteOnly }), {})).toMatchObject({
			source: "osm",
			hours: noteOnly,
		});
		expect(
			effectiveHours(
				node({ openingHours: noteOnly, openHoursText: "ask at the desk" }),
				{},
			)?.source,
		).toBe("osm");
	});
});

describe("hoursOnDate", () => {
	it("closes on holidays with closedOnHolidays (OSM `PH off`), after exceptions", () => {
		const holiday: Holiday = { date: "2027-10-11", name: "Sports Day" };
		const h = manual({
			source: "osm",
			periods: daily("10:00", "19:00"),
			closedOnHolidays: true,
		});
		expect(hoursOnDate(h, "2027-10-11", holiday)).toEqual({
			state: "closed",
			label: "Closed · Sports Day",
			why: "holiday",
		});
		expect(hoursOnDate(h, "2027-10-12", null)).toMatchObject({
			state: "open",
		});
		// A 24h place can close on holidays too.
		expect(
			hoursOnDate(
				manual({ alwaysOpen: true, closedOnHolidays: true }),
				"2027-10-11",
				holiday,
			),
		).toMatchObject({ state: "closed", why: "holiday" });
		// A special date still wins.
		expect(
			hoursOnDate(
				{
					...h,
					exceptions: [
						{
							date: "2027-10-11",
							closed: false,
							periods: [{ open: "12:00", close: "15:00" }],
						},
					],
				},
				"2027-10-11",
				holiday,
			),
		).toMatchObject({ state: "open" });
	});

	it("orders exceptions > closedNth > closed days > weekday periods", () => {
		const h = manual({
			periods: daily("10:00", "19:00"),
			closedNth: [{ day: 2, nth: -1 }],
			exceptions: [
				{
					date: "2027-10-26",
					closed: false,
					periods: [{ open: "12:00", close: "15:00" }],
					label: "Short day",
				},
			],
		});
		expect(hoursOnDate(h, "2027-10-26", null)).toMatchObject({
			state: "open",
			exception: "Short day",
		});
		expect(hoursOnDate(h, "2027-10-19", null)).toMatchObject({ state: "open" });
		expect(
			hoursOnDate(manual({ ...h, exceptions: [] }), "2027-10-26", null),
		).toMatchObject({
			state: "closed",
			label: "Closed last Tue",
		});
		expect(
			hoursOnDate(manual({ closedDays: [3] }), "2027-10-06", null),
		).toMatchObject({ state: "closed" });
		expect(
			hoursOnDate(manual({ closedDays: [3] }), "2027-10-07", null),
		).toEqual({ state: "unknown" });
	});
});

describe("hoursFixes", () => {
	it("offers the nearest open day of the same visit, then Unschedule (HRS-02)", () => {
		const { s, ix, schedule, issues } = run(
			{
				firstDate: "2027-10-05",
				days: [
					{ items: [{ k: "senso", node: "sensoji", min: 60 }] },
					{ items: [{ k: "itoya", node: "itoya", min: 60 }] },
					{
						items: [
							{ k: "hands", node: "hands", min: 60 },
							{ k: "loft", node: "loft", min: 60 },
						],
					},
				],
			},
			{ itoya: { openHoursText: "10:00–20:00; closed Wed" } },
		);
		const itemId = s.I.itoya ?? "";
		const issue = issues.byItem[itemId]?.[0];
		expect(issue?.label).toBe("Closed Wed");
		if (!issue) return;
		const fixes = hoursFixes(ix, schedule, itemId, issue);
		expect(fixes).toEqual([
			{
				kind: "move",
				label: "Move to Thu 7 Oct",
				dayId: s.D.d3,
				afterItemId: s.I.hands,
			},
			{ kind: "unschedule", label: "Unschedule" },
		]);
	});

	it("never moves outside the visit, and has nothing for info issues", () => {
		const { s, ix, schedule, issues } = run(
			{
				firstDate: "2027-10-05",
				days: [
					{ items: [{ k: "kiyomizu", node: "kiyomizu", min: 60 }] },
					{ items: [{ k: "itoya", node: "itoya", min: 60 }] },
					{ items: [{ k: "kix", node: "kix", min: 60 }] },
				],
			},
			{ itoya: { openHoursText: "10:00–20:00; closed Wed" } },
		);
		const issue = issues.byItem[s.I.itoya ?? ""]?.[0];
		if (!issue) throw new Error("expected an issue");
		expect(hoursFixes(ix, schedule, s.I.itoya ?? "", issue)).toEqual([
			{ kind: "unschedule", label: "Unschedule" },
		]);
		expect(
			hoursFixes(ix, schedule, s.I.itoya ?? "", { ...issue, severity: "info" }),
		).toEqual([]);
	});
});
