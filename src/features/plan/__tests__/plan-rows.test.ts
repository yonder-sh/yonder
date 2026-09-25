import "@/lib/engine/__fixtures__/host-tz";
import { describe, expect, it } from "vitest";
import {
	demo,
	demoProposals,
	flightDetails,
	N,
	scenario,
} from "@/lib/engine/__fixtures__/demo";
import { indexGraph } from "@/lib/engine/graph-index";
import { defaultLens } from "@/lib/engine/lens";
import { applyProposals } from "@/lib/engine/proposals";
import { computeSchedule } from "@/lib/engine/schedule";
import { hhmm } from "@/lib/engine/time";
import type { DayRange, Lens, TripGraph } from "@/lib/engine/types";
import { buildModel } from "@/lib/engine/visits";
import { planDrop, planStep } from "../plan-drop";
import {
	bandDays,
	bandSummary,
	buildDaySection,
	buildPlanEntries,
	dayEnd,
	dayEndTz,
	hiddenByWho,
	isLayover,
	nothingFor,
	ORIGIN_START,
	originAnchors,
	type PlanContext,
	type PlanRow,
} from "../plan-rows";

function ctxOf(
	graph: TripGraph,
	opts: {
		scope?: string | null;
		lens?: Lens;
		days?: DayRange | null;
		who?: string | null;
	} = {},
): PlanContext {
	const ix = indexGraph(graph);
	const scopeId = opts.scope ?? null;
	const lens = opts.lens ?? (scopeId ? defaultLens(ix, scopeId) : "place");
	const days = opts.days ?? null;
	return {
		ix,
		model: buildModel(ix, scopeId, lens, days),
		schedule: computeSchedule(ix),
		scopeId,
		lens,
		days,
		who: opts.who ?? null,
	};
}

const items = (rows: PlanRow[]) =>
	rows.flatMap((r) => (r.kind === "item" ? [r.itemId] : []));
const I = demo.I;
const D = demo.D;

describe("buildDaySection (root, place lens)", () => {
	const ctx = ctxOf(demo.graph);

	it("lists a day's cards in order with their incoming legs", () => {
		const s = buildDaySection(ctx, D.d1 as string);
		expect(items(s.rows)).toEqual([I.hands, I.loft, I.lunch1, I.meiji, I.sky]);
		const loft = s.rows.find((r) => r.kind === "item" && r.itemId === I.loft);
		expect(loft?.kind === "item" && loft.lead).toEqual([
			{
				kind: "leg",
				key: `${I.hands}>${I.loft}`,
				fromItemId: I.hands,
				toItemId: I.loft,
				crossDay: false,
			},
		]);
		// Lunch is unlocated: no leg into it; Meiji's leg comes from Loft.
		const lunch = s.rows.find(
			(r) => r.kind === "item" && r.itemId === I.lunch1,
		);
		expect(lunch?.kind === "item" && lunch.lead).toEqual([]);
		const meiji = s.rows.find((r) => r.kind === "item" && r.itemId === I.meiji);
		expect(meiji?.kind === "item" && meiji.lead[0]).toMatchObject({
			kind: "leg",
			fromItemId: I.loft,
		});
	});

	it("puts a free-time gap before a pinned card", () => {
		const s = buildDaySection(ctx, D.d1 as string);
		const sky = s.rows.find((r) => r.kind === "item" && r.itemId === I.sky);
		const gap =
			sky?.kind === "item" ? sky.lead.find((l) => l.kind === "gap") : undefined;
		expect(gap?.kind === "gap" && gap.minutes).toBeGreaterThan(0);
	});

	it("draws an overnight connector at the top of a day with no stay", () => {
		const s = buildDaySection(ctx, D.d2 as string);
		expect(s.rows[0]).toMatchObject({
			kind: "overnight",
			fromItemId: I.sky,
			toItemId: I.sensoji,
		});
	});

	it("gives a cross-day leg with a mode to the arriving card", () => {
		const s = buildDaySection(ctx, D.d3 as string);
		const drop = s.rows.find(
			(r) => r.kind === "item" && r.itemId === I.dropBags,
		);
		expect(drop?.kind === "item" && drop.lead[0]).toMatchObject({
			kind: "leg",
			fromItemId: I.itoya,
			crossDay: true,
		});
	});

	it("routes a same-day flight into the arrival card's lead", () => {
		const s = buildDaySection(ctx, D.d5 as string);
		const icn = s.rows.find((r) => r.kind === "item" && r.itemId === I.icn);
		expect(icn?.kind === "item" && icn.lead[0]).toMatchObject({
			kind: "leg",
			key: `${I.kix}>${I.icn}`,
		});
	});

	it("the person filter keeps only that person's cards and counts the rest (QA TAG-01)", () => {
		const g = structuredClone(demo.graph);
		const hands = g.items.find((i) => i.id === I.hands);
		const loft = g.items.find((i) => i.id === I.loft);
		if (hands) hands.assigneeIds = ["someone-else"];
		if (loft) loft.assigneeIds = ["me", "someone-else"];
		const s = buildDaySection(ctxOf(g, { who: "me" }), D.d1 as string);
		// Unassigned cards (Lunch, Meiji Jingu, Shibuya Sky) hide too.
		expect(items(s.rows)).toEqual([I.loft]);
		expect(s.hidden).toBe(4);
		expect(hiddenByWho({ ...(hands as NonNullable<typeof hands>) }, null)).toBe(
			false,
		);
		const unassigned = g.items.find((i) => i.id === I.meiji);
		expect(
			hiddenByWho(unassigned as NonNullable<typeof unassigned>, "me"),
		).toBe(true);
	});

	it("nothingFor: true only when the filter hides every shown card and idea", () => {
		const g = structuredClone(demo.graph);
		const none = ctxOf(g, { who: "me" });
		expect(
			nothingFor(none.ix, buildPlanEntries(none), none.model.unscheduled, "me"),
		).toBe(true);
		expect(
			nothingFor(none.ix, buildPlanEntries(none), none.model.unscheduled, null),
		).toBe(false);
		const backup = g.items.find((i) => i.id === I.backup);
		if (backup) backup.assigneeIds = ["me"];
		const idea = ctxOf(g, { who: "me" });
		expect(
			nothingFor(idea.ix, buildPlanEntries(idea), idea.model.unscheduled, "me"),
		).toBe(false);
	});

	it("dayEndTz: the day ends in its last stop's zone (QA TZ-04)", () => {
		const TPE = {
			iata: "TPE",
			tz: "Asia/Taipei",
			country: "TW",
			at: [25.08, 121.23] as [number, number],
		};
		const KIX = {
			iata: "KIX",
			tz: "Asia/Tokyo",
			country: "JP",
			at: [34.43, 135.23] as [number, number],
		};
		const sc = scenario({
			days: [
				{
					items: [
						{ k: "kix", node: "kix", min: 120 },
						{ k: "tpe", node: "tpe", min: 60 },
					],
				},
			],
			legs: [
				{
					from: "kix",
					to: "tpe",
					mode: "flight",
					dep: ["2027-10-03T14:00", "Asia/Tokyo"],
					arr: ["2027-10-03T16:30", "Asia/Taipei"],
					details: flightDetails({
						number: "CI 157",
						from: KIX,
						to: TPE,
						dep: "2027-10-03T14:00",
						arr: "2027-10-03T16:30",
					}),
				},
			],
		});
		const ctx = ctxOf(sc.graph);
		const dayId = sc.D.d1 as string;
		const sd = ctx.schedule.days[dayId];
		expect(sd?.tz).toBe("Asia/Tokyo");
		expect(dayEndTz(ctx.ix, ctx.schedule, dayId)).toBe("Asia/Taipei");
		const tpe = ctx.schedule.items[sc.I.tpe as string];
		expect(sd?.end.getTime()).toBe(tpe?.end.getTime());
		// 16:30 CST, then the 60 min stop at TPE (flights have no airport
		// buffers): ends 17:30 CST.
		expect(hhmm(sd?.end as Date, "Asia/Taipei")).toBe("17:30");
	});
});

describe("scopes, folds and ghosts", () => {
	it("folds whole days elsewhere and stretches outside the scope", () => {
		const ctx = ctxOf(demo.graph, { scope: N.tokyo, lens: "place" });
		const entries = buildPlanEntries(ctx);
		const kinds = entries.map((e) => e.kind);
		expect(kinds).toContain("days-fold");
		const d3 = buildDaySection(ctx, D.d3 as string);
		// Breakfast (effective node Itoya, Tokyo) stays; the ryokan drop folds away.
		expect(items(d3.rows)).toEqual([I.breakfast3]);
		expect(d3.rows.some((r) => r.kind === "fold")).toBe(true);
		expect(d3.rows.some((r) => r.kind === "ghost")).toBe(true);
	});

	it("folds the days outside a day range before and after", () => {
		const d2 = demo.graph.days[1]?.date as string;
		const ctx = ctxOf(demo.graph, { days: { from: d2, to: d2 } });
		const entries = buildPlanEntries(ctx);
		expect(entries[0]).toMatchObject({ kind: "days-fold", reason: "before" });
		expect(entries.at(-1)).toMatchObject({
			kind: "days-fold",
			reason: "after",
		});
		expect(entries.filter((e) => e.kind === "day")).toHaveLength(1);
	});
});

describe("coarse lenses", () => {
	it("groups the area lens under block headers", () => {
		const ctx = ctxOf(demo.graph, { scope: N.tokyo, lens: "area" });
		const s = buildDaySection(ctx, D.d1 as string);
		const blocks = s.rows.filter((r) => r.kind === "block");
		expect(blocks.map((b) => b.kind === "block" && b.repId)).toEqual([
			N.shibuya,
			N.harajuku,
			N.shibuya,
		]);
		const first = blocks[0];
		expect(first?.kind === "block" && first.itemIds).toEqual([
			I.hands,
			I.loft,
			I.lunch1,
		]);
		// Every card still renders, tagged with its block.
		expect(items(s.rows)).toEqual([I.hands, I.loft, I.lunch1, I.meiji, I.sky]);
	});

	it("shows bands at the city lens, linked by transitions", () => {
		const ctx = ctxOf(demo.graph, { lens: "city" });
		const entries = buildPlanEntries(ctx);
		const bands = entries.filter((e) => e.kind === "band");
		expect(bands.length).toBeGreaterThan(2);
		expect(entries.some((e) => e.kind === "band-link")).toBe(true);
		const tokyo = bands[0];
		if (tokyo?.kind !== "band") throw new Error("no band");
		expect(tokyo.visit.repId).toBe(N.tokyo);
		const s = bandSummary(ctx.ix, tokyo.visit);
		expect(s.stops).toBeGreaterThan(3);
		expect(bandDays(ctx.ix, tokyo.visit).map((d) => d.dayId)[0]).toBe(D.d1);
	});
});

describe("flights and layovers", () => {
	const TPE = {
		iata: "TPE",
		tz: "Asia/Taipei",
		country: "TW",
		at: [25.08, 121.23] as [number, number],
	};
	const IST = {
		iata: "IST",
		tz: "Europe/Istanbul",
		country: "TR",
		at: [41.28, 28.75] as [number, number],
	};
	const EWR = {
		iata: "EWR",
		tz: "America/New_York",
		country: "US",
		at: [40.69, -74.17] as [number, number],
	};
	const s = scenario({
		firstDate: "2027-11-04",
		days: [
			{
				items: [
					{ k: "tpe", node: "tpe", min: 30 },
					{ k: "ist", node: "ist", title: "Layover", min: 140 },
				],
			},
			{ items: [{ k: "ewr", node: "ewr", min: 60 }] },
		],
		legs: [
			{
				k: "tk25",
				from: "tpe",
				to: "ist",
				mode: "flight",
				dep: ["2027-11-04T23:25", "Asia/Taipei"],
				arr: ["2027-11-05T07:35", "Europe/Istanbul"],
				details: flightDetails({
					number: "TK25",
					from: TPE,
					to: IST,
					dep: "2027-11-04T23:25",
					arr: "2027-11-05T07:35",
				}),
			},
			{
				k: "tk11",
				from: "ist",
				to: "ewr",
				mode: "flight",
				dep: ["2027-11-05T09:55", "Europe/Istanbul"],
				arr: ["2027-11-05T13:40", "America/New_York"],
				details: flightDetails({
					number: "TK11",
					from: IST,
					to: EWR,
					dep: "2027-11-05T09:55",
					arr: "2027-11-05T13:40",
				}),
			},
		],
	});

	it("marks the middle of a flight chain as a layover", () => {
		const ix = indexGraph(s.graph);
		expect(isLayover(ix, s.I.ist as string)).toBe(true);
		expect(isLayover(ix, s.I.tpe as string)).toBe(false);
	});

	it("refuses a drop between two items of a flight block", () => {
		const ix = indexGraph(s.graph);
		const d1 = s.D.d1 as string;
		// A new place dropped onto the layover (before it) would sit inside the block.
		expect(
			planDrop(ix, null, { panel: "plan", dayId: d1, itemId: s.I.ist }),
		).toEqual({
			ok: false,
			reason: "flight",
		});
		// A block item can't change day.
		expect(
			planDrop(ix, s.I.tpe as string, { panel: "plan", dayId: s.D.d2 }),
		).toEqual({
			ok: false,
			reason: "flight",
		});
	});
});

describe("planDrop", () => {
	const ix = indexGraph(demo.graph);
	const d1 = D.d1 as string;
	it("moving down lands after the card you're over; moving up before it", () => {
		expect(
			planDrop(ix, I.hands as string, {
				panel: "plan",
				dayId: d1,
				itemId: I.lunch1,
			}),
		).toEqual({
			ok: true,
			dayId: d1,
			afterItemId: I.lunch1,
		});
		expect(
			planDrop(ix, I.meiji as string, {
				panel: "plan",
				dayId: d1,
				itemId: I.loft,
			}),
		).toEqual({
			ok: true,
			dayId: d1,
			afterItemId: I.hands,
		});
	});
	it("a drop on a day goes to its end; on Unscheduled it unschedules", () => {
		expect(
			planDrop(ix, I.hands as string, { panel: "plan", dayId: D.d2 }),
		).toEqual({
			ok: true,
			dayId: D.d2,
			afterItemId: I.itoya,
		});
		expect(
			planDrop(ix, I.hands as string, {
				panel: "plan",
				unscheduled: true,
				dayId: null,
			}),
		).toMatchObject({
			ok: true,
			dayId: null,
		});
	});
	it("ignores drops outside the Plan and drops back in place", () => {
		expect(planDrop(ix, I.hands as string, { panel: "outline" })).toEqual({
			ok: false,
			reason: "outside",
		});
		expect(
			planDrop(ix, I.loft as string, {
				panel: "plan",
				dayId: d1,
				itemId: I.loft,
			}),
		).toEqual({
			ok: false,
			reason: "noop",
		});
	});
});

describe("I2 regressions", () => {
	const KIX = {
		iata: "KIX",
		tz: "Asia/Tokyo",
		country: "JP",
		at: [34.43, 135.23] as [number, number],
	};
	const ICN = {
		iata: "ICN",
		tz: "Asia/Seoul",
		country: "KR",
		at: [37.46, 126.44] as [number, number],
	};

	it("TL-01: free days run in date order inside and between the country bands", () => {
		const sc = scenario({
			days: [
				{ items: [{ k: "hands", node: "hands" }] },
				{ items: [] },
				{ items: [] },
				{
					items: [
						{ k: "kix", node: "kix", min: 120 },
						{ k: "icn", node: "icn" },
					],
				},
				{ items: [] },
				{ items: [{ k: "hotel", node: "icn", title: "Airport hotel" }] },
				{ items: [] },
			],
		});
		const ctx = ctxOf(sc.graph, { lens: "country" });
		const entries = buildPlanEntries(ctx);
		const order = entries.flatMap((e) =>
			e.kind === "day"
				? [e.dayId]
				: e.kind === "band"
					? e.days.map((d) => d.dayId)
					: [],
		);
		const dates = order.map((id) => ctx.ix.day(id)?.date ?? "");
		expect(dates).toEqual([...dates].sort());
		expect(new Set(order)).toEqual(new Set(sc.graph.days.map((d) => d.id)));
		const bands = entries.filter((e) => e.kind === "band");
		const japan = bands[0];
		const korea = bands[1];
		if (japan?.kind !== "band" || korea?.kind !== "band")
			throw new Error("no bands");
		// Japan: Day 1, the free days 2–3, then the KIX stop on Day 4.
		expect(japan.days.map((d) => d.dayId)).toEqual([
			sc.D.d1,
			sc.D.d2,
			sc.D.d3,
			sc.D.d4,
		]);
		expect(japan.days[1]?.only).toBeNull();
		expect(korea.days.map((d) => d.dayId)).toEqual([sc.D.d4, sc.D.d5, sc.D.d6]);
		// The last free day follows the last band.
		expect(entries.at(-1)).toMatchObject({ kind: "day", dayId: sc.D.d7 });
	});

	it("FB-17: a day in two bands names each drawing by its first card; other days stay plain", () => {
		const sc = scenario({
			days: [
				{ items: [{ k: "hands", node: "hands" }] },
				{
					items: [
						{ k: "loft", node: "loft", min: 60 },
						{ k: "kix", node: "kix", min: 120 },
						{ k: "icn", node: "icn" },
						{ k: "hotel", node: "icn", title: "Airport hotel" },
					],
				},
				{ items: [{ k: "late", node: "icn", title: "Late check-out" }] },
			],
		});
		const entries = buildPlanEntries(ctxOf(sc.graph, { lens: "country" }));
		const drawings = entries.flatMap((e) =>
			e.kind === "band" ? e.days.map((d) => [d.dayId, d.copy]) : [],
		);
		expect(drawings).toEqual([
			[sc.D.d1, undefined],
			[sc.D.d2, sc.I.loft],
			[sc.D.d2, sc.I.icn],
			[sc.D.d3, undefined],
		]);
		// The place lens draws every day once: no bands, nothing to name.
		const place = buildPlanEntries(ctxOf(sc.graph, { lens: "place" }));
		expect(place.every((e) => e.kind === "day")).toBe(true);
	});

	it("MT-11: with a day range the morning stay leg still shows after the ghost", () => {
		const sc = scenario({
			days: [
				{
					night: "ryokan",
					items: [
						{ k: "dropBags", node: "ryokan", title: "Drop bags" },
						{ k: "dinner", node: "ryokan", title: "Dinner" },
					],
				},
				{ items: [{ k: "meiji", node: "meijiJingu" }] },
			],
		});
		const d2 = sc.graph.days[1]?.date as string;
		const lead = (days: DayRange | null) => {
			const s = buildDaySection(ctxOf(sc.graph, { days }), sc.D.d2 as string);
			const row = s.rows.find(
				(r) => r.kind === "item" && r.itemId === sc.I.meiji,
			);
			return row?.kind === "item" ? row.lead.map((l) => l.kind) : [];
		};
		expect(lead(null)).toContain("stay");
		expect(lead({ from: d2, to: d2 })).toEqual(["ghost", "stay"]);
	});

	it("VIS-22: a day range of the departure day keeps the overnight flight stub", () => {
		const sc = scenario({
			days: [
				{ items: [{ k: "kix", node: "kix", min: 120 }] },
				{ items: [{ k: "icn", node: "icn" }] },
			],
			legs: [
				{
					from: "kix",
					to: "icn",
					mode: "flight",
					dep: ["2027-10-03T23:30", "Asia/Tokyo"],
					arr: ["2027-10-04T01:30", "Asia/Seoul"],
					details: flightDetails({
						number: "KE 2118",
						from: KIX,
						to: ICN,
						dep: "2027-10-03T23:30",
						arr: "2027-10-04T01:30",
					}),
				},
			],
		});
		const d1 = sc.graph.days[0]?.date as string;
		const kinds = (days: DayRange | null) =>
			buildDaySection(ctxOf(sc.graph, { days }), sc.D.d1 as string).rows.map(
				(r) => r.kind,
			);
		expect(kinds(null)).toEqual(["item", "leg-out"]);
		// The stub stays; the ghost to the (folded) arrival day follows it.
		expect(kinds({ from: d1, to: d1 })).toEqual(["item", "leg-out", "ghost"]);
	});
});

describe("PLAN-I2-18: fewer dashes (ADDENDUM §10)", () => {
	it("known flight and 'other' rails are not dashed; estimates still are", async () => {
		const { readFileSync } = await import("node:fs");
		const css = readFileSync(
			new URL("../plan.css", import.meta.url),
			"utf8",
		).replace(/\/\*[\s\S]*?\*\//g, "");
		const rule = (mode: string) => {
			const re = new RegExp(
				`\\.plan-rail\\[data-mode="${mode}"\\]\\s*\\{([^}]*)\\}`,
				"g",
			);
			return [...css.matchAll(re)].map((m) => m[1] ?? "").join("\n");
		};
		expect(rule("flight")).not.toMatch(/repeating-linear-gradient/);
		expect(rule("other")).not.toMatch(/repeating-linear-gradient/);
		expect(css).toMatch(
			/\.plan-rail\[data-mode="unset"\][^{]*\{[^}]*repeating-linear-gradient/,
		);
	});
});

describe("QA round 2 (WP-Plan)", () => {
	/** The demo's Fuji Excursion as the SP3 night train: 21:35 Mon 4 Oct → 05:30 Tue 5 Oct. */
	const nightTrain = (): TripGraph => {
		const g = structuredClone(demo.graph);
		const leg = g.legs.find((l) => l.id === demo.L.fuji);
		if (!leg) throw new Error("no leg");
		leg.depAt = "2027-10-04T12:35:00.000Z";
		leg.arrAt = "2027-10-04T20:30:00.000Z";
		leg.details = {
			kind: "transit",
			fixed: {
				departLocal: "2027-10-04T21:35",
				arriveLocal: "2027-10-05T05:30",
				fromTz: "Asia/Tokyo",
				toTz: "Asia/Tokyo",
				accessMin: 10,
				egressMin: 0,
			},
			booking: { trainNumber: "SP3", seats: [] },
		};
		return g;
	};

	it("VIS2-06: a day that leaves on a night train ends when the train leaves, not at the boarding stop", () => {
		const g = nightTrain();
		const ix = indexGraph(g);
		const schedule = computeSchedule(ix);
		const d2 = D.d2 as string;
		const end = dayEnd(ix, schedule, d2);
		expect(end?.at.toISOString()).toBe("2027-10-04T12:35:00.000Z");
		expect(end && hhmm(end.at, end.tz)).toBe("21:35");
		expect(end?.plusDays).toBe(0);
		// …even when the schedule says the day ended at its last stop (13:00 JST).
		const early = {
			...schedule,
			days: {
				...schedule.days,
				[d2]: {
					...(schedule.days[d2] as NonNullable<(typeof schedule.days)[string]>),
					end: new Date("2027-10-04T04:00:00.000Z"),
				},
			},
		};
		expect(dayEnd(ix, early, d2)?.at.toISOString()).toBe(
			"2027-10-04T12:35:00.000Z",
		);
		// An ordinary day keeps the end of its last stop.
		const d1 = D.d1 as string;
		expect(dayEnd(ix, schedule, d1)).toEqual({
			at: schedule.days[d1]?.end,
			tz: "Asia/Tokyo",
			plusDays: 0,
		});
	});

	it("VIS2-06: an overnight flight's day ends at take-off, in the departure's zone", () => {
		const JFK = {
			iata: "JFK",
			tz: "America/New_York",
			country: "US",
			at: [40.64, -73.78] as [number, number],
		};
		const HND = {
			iata: "HND",
			tz: "Asia/Tokyo",
			country: "JP",
			at: [35.55, 139.78] as [number, number],
		};
		const sc = scenario({
			firstDate: "2027-10-02",
			nodes: [
				{
					key: "jfk",
					parent: "newark",
					type: "place",
					category: "airport",
					name: "JFK",
				},
				{
					key: "hnd",
					parent: "tokyo",
					type: "place",
					category: "airport",
					name: "Haneda",
				},
			],
			days: [
				{ start: "00:00", items: [{ k: "jfk", node: "jfk", min: 0 }] },
				{ items: [{ k: "hnd", node: "hnd", min: 60 }] },
			],
			legs: [
				{
					from: "jfk",
					to: "hnd",
					mode: "flight",
					dep: ["2027-10-02T02:00", "America/New_York"],
					arr: ["2027-10-03T05:00", "Asia/Tokyo"],
					details: flightDetails({
						number: "NH9",
						from: JFK,
						to: HND,
						dep: "2027-10-02T02:00",
						arr: "2027-10-03T05:00",
					}),
				},
			],
		});
		const ix = indexGraph(sc.graph);
		const schedule = computeSchedule(ix);
		const end = dayEnd(ix, schedule, sc.D.d1 as string);
		expect(end && hhmm(end.at, end.tz)).toBe("02:00");
		expect(end?.tz).toBe("America/New_York");
		expect(end?.plusDays).toBe(0);
	});

	it("COLLAB-R2-01: a suggested move draws no amber 'Unlinked transit' for the real leg", () => {
		// Maya suggests moving Itoya Ginza to Day 1: in the simulation, the
		// Fuji Excursion (Itoya → Drop bags) loses its pair.
		const move = demoProposals.find((p) => p.op === "item.move");
		if (!move) throw new Error("fixture: no move proposal");
		const overlay = applyProposals(demo.graph, [move]);
		const ix = indexGraph(overlay.graph);
		expect(ix.detachedLegs.map((d) => d.legId)).toEqual([demo.L.fuji]);
		const base = {
			ix,
			model: buildModel(ix, null, "place", null),
			schedule: computeSchedule(ix),
			scopeId: null,
			lens: "place" as const,
			days: null,
			who: null,
		};
		const unlinked = (ctx: PlanContext) =>
			ix.days.flatMap((d) =>
				buildDaySection(ctx, d.id).rows.filter((r) => r.kind === "unlinked"),
			);
		// Without the server's view the simulation's break looks real…
		expect(unlinked(base)).toHaveLength(1);
		// …with it, only legs detached on the server get the row.
		const real = new Set(
			indexGraph(demo.graph).detachedLegs.map((d) => d.legId),
		);
		expect(unlinked({ ...base, realDetached: real })).toEqual([]);
		// A leg that really is detached keeps its row.
		expect(
			unlinked({ ...base, realDetached: new Set([demo.L.fuji as string]) }),
		).toHaveLength(1);
	});

	it("COLLAB-R3-02: a suggested move's origin row sits at the item's old slot", () => {
		// Maya suggests moving Itoya Ginza (Day 2, after Kama-asa) to Day 1.
		const move = demoProposals.find((p) => p.op === "item.move");
		if (!move) throw new Error("fixture: no move proposal");
		const real = indexGraph(demo.graph);
		const itoya = I.itoya as string;
		const oldDay = real.item(itoya)?.dayId as string;
		const order = (real.itemsByDay.get(oldDay) ?? []).map((i) => i.id);
		const at = order.indexOf(itoya);
		expect(at).toBeGreaterThan(0);
		const before = order[at - 1] as string;
		const overlay = applyProposals(demo.graph, [move]);
		const marks = overlay.marks.get(`from:day:${oldDay}`) ?? [];
		expect(marks).toHaveLength(1);
		// The simulated day no longer holds Itoya.
		const shown = (indexGraph(overlay.graph).itemsByDay.get(oldDay) ?? []).map(
			(i) => i.id,
		);
		expect(shown).not.toContain(itoya);
		const a = originAnchors(real, oldDay, shown, marks);
		expect([...a.at.keys()]).toEqual([before]);
		expect(a.rest).toEqual([]);
		// The card before it is hidden (a person filter): the next one back.
		const b = originAnchors(
			real,
			oldDay,
			shown.filter((id) => id !== before),
			marks,
		);
		expect([...b.at.keys()]).toEqual([
			at >= 2 ? (order[at - 2] as string) : ORIGIN_START,
		]);
		// Nothing shown before it: the row opens the day.
		expect([
			...originAnchors(real, oldDay, shown.slice(at), marks).at.keys(),
		]).toEqual([ORIGIN_START]);
		// The engine's own anchor wins when it names a shown card.
		const last = shown.at(-1) as string;
		const withAfter = marks.map((m) => ({
			...m,
			origin: { ...(m.origin as NonNullable<typeof m.origin>), afterId: last },
		}));
		expect([
			...originAnchors(real, oldDay, shown, withAfter).at.keys(),
		]).toEqual([last]);
		// An item that isn't on that day in the server's order: drawn at the end.
		expect(originAnchors(real, D.d1 as string, [], marks).rest).toHaveLength(1);
	});

	it("MOB-04: Move up / Move down swap a card with its neighbour", () => {
		const ix = indexGraph(demo.graph);
		const d1 = D.d1 as string;
		expect(planStep(ix, I.loft as string, "up")).toEqual({
			ok: true,
			dayId: d1,
			beforeItemId: I.hands,
		});
		expect(planStep(ix, I.loft as string, "down")).toEqual({
			ok: true,
			dayId: d1,
			afterItemId: I.lunch1,
		});
		expect(planStep(ix, I.hands as string, "up")).toEqual({
			ok: false,
			reason: "noop",
		});
		expect(planStep(ix, I.sky as string, "down")).toEqual({
			ok: false,
			reason: "noop",
		});
		// Unscheduled reorders too (one idea: nothing to swap with).
		expect(planStep(ix, I.backup as string, "up")).toEqual({
			ok: false,
			reason: "noop",
		});
	});

	it("MOB-04: a step over a flight block moves past the whole block, never into it", () => {
		const KIX = {
			iata: "KIX",
			tz: "Asia/Tokyo",
			country: "JP",
			at: [34.43, 135.23] as [number, number],
		};
		const ICN = {
			iata: "ICN",
			tz: "Asia/Seoul",
			country: "KR",
			at: [37.46, 126.44] as [number, number],
		};
		const sc = scenario({
			days: [
				{
					items: [
						{ k: "before", title: "Breakfast", min: 30 },
						{ k: "kix", node: "kix", min: 120 },
						{ k: "icn", node: "icn", min: 60 },
						{ k: "after", title: "Dinner", min: 60 },
					],
				},
			],
			legs: [
				{
					from: "kix",
					to: "icn",
					mode: "flight",
					dep: ["2027-10-03T13:05", "Asia/Tokyo"],
					arr: ["2027-10-03T15:05", "Asia/Seoul"],
					details: flightDetails({
						number: "KE724",
						from: KIX,
						to: ICN,
						dep: "2027-10-03T13:05",
						arr: "2027-10-03T15:05",
					}),
				},
			],
		});
		const ix = indexGraph(sc.graph);
		const d1 = sc.D.d1 as string;
		expect(planStep(ix, sc.I.after as string, "up")).toEqual({
			ok: true,
			dayId: d1,
			afterItemId: sc.I.before,
		});
		expect(planStep(ix, sc.I.before as string, "down")).toEqual({
			ok: true,
			dayId: d1,
			afterItemId: sc.I.icn,
		});
		// The block itself moves as one.
		expect(planStep(ix, sc.I.kix as string, "down")).toEqual({
			ok: true,
			dayId: d1,
			afterItemId: sc.I.after,
		});
		expect(planStep(ix, sc.I.icn as string, "up")).toEqual({
			ok: true,
			dayId: d1,
			beforeItemId: sc.I.before,
		});
	});
});
