import "./__fixtures__/host-tz";
import { describe, expect, it } from "vitest";
import { flightDetails, scenario, uuid } from "./__fixtures__/demo";
import { indexGraph } from "./graph-index";
import { computeSchedule, formatFlightNumber, lateGap } from "./schedule";
import { conflictFixes } from "./suggest";
import {
	hhmm,
	localDateOf,
	localDateTimeToEpoch,
	tzLabel,
	tzOffsetMin,
} from "./time";
import type { ScheduleResult } from "./types";

const TOKYO = "Asia/Tokyo";
/** "HH:mm–HH:mm" of an item in its own zone. */
const span = (r: ScheduleResult, id: string | undefined) => {
	const it = r.items[id as string];
	if (!it) throw new Error(`no item ${id}`);
	return `${hhmm(it.start, it.tz)}–${hhmm(it.end, it.tz)}`;
};

/** Shinjuku / Nakano places for the QA F4 fixtures. */
const TOKYO_NODES = [
	{
		key: "shinjuku",
		parent: "tokyo",
		type: "area" as const,
		name: "Shinjuku",
		at: [35.6938, 139.7034] as [number, number],
	},
	{
		key: "gracery",
		parent: "shinjuku",
		type: "place" as const,
		category: "lodging" as const,
		name: "Hotel Gracery",
		at: [35.6955, 139.702] as [number, number],
	},
	{
		key: "cha",
		parent: "shinjuku",
		type: "place" as const,
		category: "cafe" as const,
		name: "Cha no Ikedaya",
		at: [35.6905, 139.7005] as [number, number],
	},
	{
		key: "nakano",
		parent: "tokyo",
		type: "area" as const,
		name: "Nakano",
		at: [35.7074, 139.6638] as [number, number],
	},
	{
		key: "broadway",
		parent: "nakano",
		type: "place" as const,
		category: "shopping" as const,
		name: "Nakano Broadway",
		at: [35.709, 139.6658] as [number, number],
	},
	{
		key: "yodobashi",
		parent: "shinjuku",
		type: "place" as const,
		category: "shopping" as const,
		name: "Yodobashi Camera",
		at: [35.6907, 139.6982] as [number, number],
	},
	{
		key: "bic",
		parent: "shinjuku",
		type: "place" as const,
		category: "shopping" as const,
		name: "Bic Camera",
		at: [35.6918, 139.7009] as [number, number],
	},
	{
		key: "benfiddich",
		parent: "shinjuku",
		type: "place" as const,
		category: "bar" as const,
		name: "Bar Benfiddich",
		at: [35.6897, 139.6961] as [number, number],
	},
	{
		key: "goldenGai",
		parent: "shinjuku",
		type: "place" as const,
		category: "nightlife" as const,
		name: "Golden Gai",
		at: [35.694, 139.7046] as [number, number],
	},
];

describe("SPEC §9.4 schedule tests", () => {
	it("1. 09:00 start, a 2 h item, a 12 min walk, a pin at 11:30: 18 min free; pinned at 11:00: late by 12", () => {
		const build = (pin: string) =>
			scenario({
				days: [
					{
						items: [
							{ k: "a", node: "hands", min: 120 },
							{ k: "b", node: "meijiJingu", min: 60, pin },
						],
					},
				],
				legs: [{ k: "walk", from: "a", to: "b", mode: "walk", min: 12 }],
			});
		const s1 = build("11:30");
		const r1 = computeSchedule(indexGraph(s1.graph));
		expect(span(r1, s1.I.a)).toBe("09:00–11:00");
		expect(r1.items[s1.I.b as string]).toMatchObject({
			freeBeforeMin: 18,
			pinned: true,
		});
		expect(r1.items[s1.I.b as string]?.late).toBeUndefined();
		expect(r1.legs[`${s1.I.a}>${s1.I.b}`]).toMatchObject({
			minutes: 12,
			kind: "pair",
			unset: false,
			estimate: false,
			timed: false,
		});

		const s2 = build("11:00");
		const r2 = computeSchedule(indexGraph(s2.graph));
		expect(r2.items[s2.I.b as string]).toMatchObject({
			freeBeforeMin: 0,
			late: { minutes: 12, cause: "pinned" },
		});
		expect(span(r2, s2.I.b)).toBe("11:00–12:00"); // stays at its pin
		expect(r2.days[s2.D.d1 as string]?.conflicts).toBe(1);
	});

	it("2. an overnight HND 23:40 → BKK 04:15⁺¹ flight: the next day's first item starts at 05:15 ICT", () => {
		const s = scenario({
			firstDate: "2027-10-02",
			nodes: [
				{
					key: "hnd",
					parent: "tokyo",
					type: "place",
					category: "airport",
					name: "Haneda (HND)",
					at: [35.5494, 139.7798],
				},
				{
					key: "thailand",
					parent: null,
					type: "country",
					name: "Thailand",
					at: [15.87, 100.99],
					tz: "Asia/Bangkok",
					countryCode: "TH",
				},
				{
					key: "bangkok",
					parent: "thailand",
					type: "city",
					name: "Bangkok",
					at: [13.7563, 100.5018],
				},
				{
					key: "bkk",
					parent: "bangkok",
					type: "place",
					category: "airport",
					name: "Suvarnabhumi (BKK)",
					at: [13.69, 100.7501],
				},
			],
			days: [
				{
					items: [
						{ k: "dinner", node: "shibuyaSky", min: 150, pin: "18:00" },
						{ k: "hnd", node: "hnd", min: 0 },
					],
				},
				{
					items: [
						{ k: "bkk", node: "bkk", min: 0 },
						{ k: "hotel", node: "bangkok", min: 30 },
					],
				},
			],
			legs: [
				{ k: "toAirport", from: "dinner", to: "hnd", mode: "transit", min: 30 },
				{
					k: "flight",
					from: "hnd",
					to: "bkk",
					mode: "flight",
					dep: ["2027-10-02T23:40", TOKYO],
					arr: ["2027-10-03T04:15", "Asia/Bangkok"],
					details: flightDetails({
						number: "NH849",
						from: {
							iata: "HND",
							tz: TOKYO,
							country: "JP",
							at: [35.5494, 139.7798],
						},
						to: {
							iata: "BKK",
							tz: "Asia/Bangkok",
							country: "TH",
							at: [13.69, 100.7501],
						},
						dep: "2027-10-02T23:40",
						arr: "2027-10-03T04:15",
					}),
				},
				{ k: "taxi", from: "bkk", to: "hotel", mode: "other", min: 45 },
			],
		});
		const r = computeSchedule(indexGraph(s.graph));
		const leg = r.legs[`${s.I.hnd}>${s.I.bkk}`];
		expect(leg).toMatchObject({
			kind: "pair",
			timed: true,
			crossDay: true,
			minutes: 395,
		});
		expect(leg?.late).toBeUndefined(); // at the airport 21:00, departs 23:40
		expect(hhmm(leg?.start as Date, TOKYO)).toBe("23:40");
		const bkk = r.items[s.I.bkk as string];
		expect(bkk?.tz).toBe("Asia/Bangkok");
		expect(hhmm(bkk?.start as Date, "Asia/Bangkok")).toBe("04:15");
		expect(localDateOf(bkk?.start as Date, "Asia/Bangkok")).toBe("2027-10-03");
		expect(span(r, s.I.hotel)).toBe("05:00–05:30"); // before the day's 09:00 start: allowed
		expect(span(r, s.I.dinner)).toBe("18:00–20:30");
		expect(r.items[s.I.dinner as string]?.endsNextDay).toBe(false);
		// The flight counts as travel on its departure day, not the landing day.
		expect(r.days[s.D.d1 as string]?.travelMin).toBe(30 + 395);
		expect(r.days[s.D.d2 as string]?.travelMin).toBe(45);
		expect(r.days[s.D.d2 as string]?.tz).toBe("Asia/Bangkok");
		// The departure day ends when the flight leaves, not at the 21:00
		// arrival at HND (QA TZ-02/05/06: never "ends" before the departure).
		expect(hhmm(r.days[s.D.d1 as string]?.end as Date, TOKYO)).toBe("23:40");
		expect(hhmm(r.days[s.D.d2 as string]?.end as Date, "Asia/Bangkok")).toBe(
			"05:30",
		);

		// Late for the overnight flight: flagged at the end of the departure day.
		const late = scenario({
			...{ firstDate: "2027-10-02" },
			nodes: [
				{
					key: "hnd",
					parent: "tokyo",
					type: "place",
					category: "airport",
					name: "Haneda (HND)",
					at: [35.5494, 139.7798],
				},
				{
					key: "thailand",
					parent: null,
					type: "country",
					name: "Thailand",
					at: [15.87, 100.99],
					tz: "Asia/Bangkok",
				},
				{
					key: "bkk",
					parent: "thailand",
					type: "place",
					category: "airport",
					name: "BKK",
					at: [13.69, 100.7501],
				},
			],
			days: [
				{
					items: [
						{ k: "dinner", node: "shibuyaSky", min: 180, pin: "21:00" },
						{ k: "hnd", node: "hnd", min: 0 },
					],
				},
				{ items: [{ k: "bkk", node: "bkk", min: 0 }] },
			],
			legs: [
				{ k: "toAirport", from: "dinner", to: "hnd", mode: "transit", min: 30 },
				{
					k: "flight",
					from: "hnd",
					to: "bkk",
					mode: "flight",
					dep: ["2027-10-02T23:40", TOKYO],
					arr: ["2027-10-03T04:15", "Asia/Bangkok"],
				},
			],
		});
		const rl = computeSchedule(indexGraph(late.graph));
		expect(rl.legs[`${late.I.hnd}>${late.I.bkk}`]?.late).toEqual({
			minutes: 50,
			cause: "flight",
			label: "Misses the flight (dep 23:40) by 50 min",
		});
		expect(rl.days[late.D.d1 as string]?.conflicts).toBe(1);
		expect(rl.days[late.D.d2 as string]?.conflicts).toBe(0);
	});

	it("3. a Ho Chi Minh → Taipei day has tzChanged; Tokyo → Seoul (both +9) does not", () => {
		const vn = scenario({
			nodes: [
				{
					key: "vietnam",
					parent: null,
					type: "country",
					name: "Vietnam",
					at: [14.06, 108.28],
					tz: "Asia/Ho_Chi_Minh",
				},
				{
					key: "hcmc",
					parent: "vietnam",
					type: "city",
					name: "Ho Chi Minh City",
					at: [10.8231, 106.6297],
				},
			],
			days: [
				{ items: [{ k: "a", node: "hcmc" }] },
				{ items: [{ k: "b", node: "tpe" }] },
			],
		});
		const rv = computeSchedule(indexGraph(vn.graph));
		expect(rv.days[vn.D.d2 as string]).toMatchObject({
			tz: "Asia/Taipei",
			tzChanged: true,
		});

		const kr = scenario({
			days: [
				{ items: [{ k: "a", node: "hands" }] },
				{ items: [{ k: "b", node: "icn" }] },
			],
		});
		const rk = computeSchedule(indexGraph(kr.graph));
		expect(rk.days[kr.D.d1 as string]?.tzChanged).toBe(false);
		expect(rk.days[kr.D.d2 as string]).toMatchObject({
			tz: "Asia/Seoul",
			tzChanged: false,
		});
	});

	it("4. after midnight: a day starting 18:00, a 3 h item, then a pin at 00:30 → 210 min free, no conflict", () => {
		const s = scenario({
			days: [
				{
					start: "18:00",
					items: [
						{ k: "a", node: "hands", min: 180 },
						{ k: "bar", title: "Late bar", min: 60, pin: "00:30" },
					],
				},
			],
		});
		const r = computeSchedule(indexGraph(s.graph));
		const bar = r.items[s.I.bar as string];
		expect(bar).toMatchObject({
			freeBeforeMin: 210,
			pinned: true,
			startsNextDay: true,
			endsNextDay: true,
		});
		expect(bar?.late).toBeUndefined();
		expect(localDateOf(bar?.start as Date, TOKYO)).toBe("2027-10-04");
		expect(r.days[s.D.d1 as string]?.conflicts).toBe(0);
	});

	it("5. an unset leg 0.9 km apart counts 16 min (0.9 × 1.3 / 4.5 h) as an estimate", () => {
		const s = scenario({
			nodes: [
				{
					key: "p1",
					parent: "shibuya",
					type: "place",
					name: "P1",
					at: [35.66, 139.7],
				},
				{
					key: "p2",
					parent: "shibuya",
					type: "place",
					name: "P2",
					at: [35.66 + 0.9 / 111.19508, 139.7],
				},
			],
			days: [
				{
					items: [
						{ k: "a", node: "p1", min: 60 },
						{ k: "b", node: "p2", min: 60 },
					],
				},
			],
		});
		const r = computeSchedule(indexGraph(s.graph));
		const leg = r.legs[`${s.I.a}>${s.I.b}`];
		expect(leg).toMatchObject({
			minutes: 16,
			unset: true,
			estimate: true,
			legId: null,
		});
		expect(leg?.suggestion).toMatchObject({
			mode: "walk",
			estimateMin: 16,
			label: "walk ~16m?",
		});
		expect(leg?.suggestion?.distanceKm).toBeCloseTo(0.9, 3);
		expect(span(r, s.I.b)).toBe("10:16–11:16");
		expect(r.days[s.D.d1 as string]?.unsetLegs).toBe(1);
	});

	it("6. QA F4-b (Tue 5 Oct, manual legs): times, totals and capacity", () => {
		const s = scenario({
			firstDate: "2027-10-04",
			nodes: TOKYO_NODES,
			days: [
				{ items: [{ k: "hotel", node: "gracery", min: 30 }] },
				{
					items: [
						{ k: "breakfast", title: "Breakfast", min: 30 },
						{ k: "cha", node: "cha", min: 30 },
						{ k: "nakano", node: "broadway", min: 150 },
						{ k: "lunch", title: "Lunch", min: 60 },
						{ k: "yodobashi", node: "yodobashi", min: 120 },
						{ k: "bic", node: "bic", min: 90 },
						{ k: "dinner", title: "Dinner", min: 90 },
						{ k: "benfiddich", node: "benfiddich", min: 60, pin: "20:00" },
						{ k: "goldenGai", node: "goldenGai", min: 150 },
					],
				},
			],
			legs: [
				// Legs join located items only (§7.8): a leg into an unlocated block ("Lunch", "Dinner")
				// is folded into the next located item's leg (walk 5 + transit 20; walk 10 + walk 10).
				{ from: "hotel", to: "cha", mode: "walk", min: 10, distanceM: 700 },
				{
					from: "cha",
					to: "nakano",
					mode: "transit",
					min: 15,
					details: {
						kind: "transit",
						route: {
							id: "r",
							source: "manual",
							durationMin: 15,
							walkMin: 0,
							transfers: 0,
							segments: [],
							label: "JR Chuo Rapid",
						},
					},
				},
				{ from: "nakano", to: "yodobashi", mode: "transit", min: 25 },
				{ from: "yodobashi", to: "bic", mode: "walk", min: 5, distanceM: 300 },
				{
					from: "bic",
					to: "benfiddich",
					mode: "walk",
					min: 20,
					distanceM: 1500,
				},
				{
					from: "benfiddich",
					to: "goldenGai",
					mode: "walk",
					min: 5,
					distanceM: 400,
				},
			],
			settings: { dayCapacityMin: 750 },
		});
		const r = computeSchedule(indexGraph(s.graph));
		const table: [string, string][] = [
			["breakfast", "09:00–09:30"],
			["cha", "09:40–10:10"],
			["nakano", "10:25–12:55"],
			["yodobashi", "14:20–16:20"],
			["bic", "16:25–17:55"],
			["benfiddich", "20:00–21:00"],
			["goldenGai", "21:05–23:35"],
		];
		for (const [k, expected] of table)
			expect([k, span(r, s.I[k])]).toEqual([k, expected]);
		// The unlocated blocks carry no legs of their own, so they sit right after the previous stop.
		expect(span(r, s.I.lunch)).toBe("12:55–13:55");
		expect(span(r, s.I.dinner)).toBe("17:55–19:25");
		expect(r.items[s.I.benfiddich as string]?.freeBeforeMin).toBe(15);
		const day = r.days[s.D.d2 as string];
		expect(day).toMatchObject({
			activitiesMin: 13 * 60,
			travelMin: 80,
			freeMin: 15,
			capacityMin: 750,
			// The day counts the travel too: 13h of stops + 1h20 of travel − 12h30.
			overCapacityMin: 110,
			conflicts: 0,
			unsetLegs: 0,
			rides: 2,
		});
		expect(day?.walkKm).toBeCloseTo(2.9, 5);
		expect(hhmm(day?.end as Date, TOKYO)).toBe("23:35");
		expect(hhmm(day?.start as Date, TOKYO)).toBe("09:00");
	});

	describe("7. QA F4-c fixed transit (Fuji Excursion 7)", () => {
		const build = (breakfastMin: number) =>
			scenario({
				firstDate: "2027-10-07",
				nodes: TOKYO_NODES,
				days: [
					{
						start: "07:30",
						items: [
							{
								k: "breakfast",
								node: "gracery",
								title: "Breakfast",
								min: breakfastMin,
							},
							{ k: "drop", node: "ryokan", title: "Drop bags", min: 30 },
						],
					},
				],
				legs: [
					{
						k: "fuji",
						from: "breakfast",
						to: "drop",
						mode: "transit",
						dep: ["2027-10-07T08:30", TOKYO],
						arr: ["2027-10-07T10:26", TOKYO],
						details: {
							kind: "transit",
							route: {
								id: "fx7",
								source: "manual",
								durationMin: 116,
								walkMin: 10,
								transfers: 0,
								segments: [],
								label: "Fuji Excursion 7",
							},
							fixed: {
								departLocal: "2027-10-07T08:30",
								arriveLocal: "2027-10-07T10:26",
								fromTz: TOKYO,
								toTz: TOKYO,
								accessMin: 10,
								egressMin: 10,
							},
							booking: { ref: "E7K2Q9", car: "3", seats: [] },
						},
					},
				],
			});

		it("breakfast 07:30–08:00, the train from 08:20 (access 10) to 10:36 (egress 10), Drop bags 10:36–11:06", () => {
			const s = build(30);
			const r = computeSchedule(indexGraph(s.graph));
			expect(span(r, s.I.breakfast)).toBe("07:30–08:00");
			const leg = r.legs[`${s.I.breakfast}>${s.I.drop}`];
			expect(leg).toMatchObject({
				timed: true,
				crossDay: false,
				estimate: false,
				unset: false,
				legId: s.L.fuji,
				minutes: 136,
			});
			expect(leg?.late).toBeUndefined();
			expect(
				`${hhmm(leg?.start as Date, TOKYO)}–${hhmm(leg?.end as Date, TOKYO)}`,
			).toBe("08:20–10:36");
			expect(span(r, s.I.drop)).toBe("10:36–11:06");
			expect(r.days[s.D.d1 as string]?.rides).toBe(1);
		});

		it("with a 60 min breakfast, the leg is late: “Misses Fuji Excursion 7 (dep 08:30) by 10 min”", () => {
			const s = build(60);
			const ix = indexGraph(s.graph);
			const r = computeSchedule(ix);
			const key = `${s.I.breakfast}>${s.I.drop}`;
			expect(r.legs[key]?.late).toEqual({
				minutes: 10,
				cause: "departure",
				label: "Misses Fuji Excursion 7 (dep 08:30) by 10 min",
			});
			expect(r.days[s.D.d1 as string]?.conflicts).toBe(1);
			// A long miss reads like any other duration, never "by 100 min".
			expect(
				computeSchedule(indexGraph(build(150).graph)).legs[key]?.late?.label,
			).toBe("Misses Fuji Excursion 7 (dep 08:30) by 1h 40m");
			// A departure conflict offers only "shorten the previous item".
			expect(conflictFixes(ix, r, { kind: "leg", key })).toEqual([
				{ kind: "shorten", itemId: s.I.breakfast, durationMin: 50 },
			]);
		});
	});

	describe("8. QA F4-f connection: TK 25 + layover + TK 11", () => {
		const L1 = uuid(0x3000);
		const L2 = uuid(0x3001);
		const TPE = {
			iata: "TPE",
			tz: "Asia/Taipei",
			country: "TW",
			at: [25.0797, 121.2342] as [number, number],
		};
		const IST = {
			iata: "IST",
			tz: "Europe/Istanbul",
			country: "TR",
			at: [41.2753, 28.7519] as [number, number],
		};
		const EWR = {
			iata: "EWR",
			tz: "America/New_York",
			country: "US",
			at: [40.6895, -74.1745] as [number, number],
		};
		const build = (tk11Dep: string, layoverMin: number) =>
			scenario({
				firstDate: "2027-11-04",
				days: [
					{ items: [{ k: "tpe", node: "tpe", min: 0 }] },
					{
						items: [
							{ k: "ist", node: "ist", title: "Layover", min: layoverMin },
							{ k: "ewr", node: "ewr", min: 0 },
						],
					},
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
							connection: { nextLegId: L2 },
						}),
					},
					{
						k: "tk11",
						from: "ist",
						to: "ewr",
						mode: "flight",
						dep: [`2027-11-05T${tk11Dep}`, "Europe/Istanbul"],
						arr: ["2027-11-05T13:40", "America/New_York"],
						details: flightDetails({
							number: "TK11",
							from: IST,
							to: EWR,
							dep: `2027-11-05T${tk11Dep}`,
							arr: "2027-11-05T13:40",
							connection: { prevLegId: L1 },
						}),
					},
				],
			});

		it("2 h 20 layover: no late flags", () => {
			const s = build("09:55", 140);
			expect(s.L.tk25).toBe(L1);
			const r = computeSchedule(indexGraph(s.graph));
			const tk25 = r.legs[`${s.I.tpe}>${s.I.ist}`];
			const tk11 = r.legs[`${s.I.ist}>${s.I.ewr}`];
			expect(Object.values(r.legs).some((l) => l.late)).toBe(false);
			expect(tk25?.warn).toBeUndefined();
			expect(tk11?.warn).toBeUndefined();
			// TK 25 and TK 11 run dep → arr: no airport buffers.
			expect(hhmm(tk25?.start as Date, "Asia/Taipei")).toBe("23:25");
			expect(hhmm(tk25?.end as Date, "Europe/Istanbul")).toBe("07:35");
			expect(span(r, s.I.ist)).toBe("07:35–09:55");
			expect(hhmm(tk11?.start as Date, "Europe/Istanbul")).toBe("09:55");
			expect(hhmm(tk11?.end as Date, "America/New_York")).toBe("13:40");
			expect(r.items[s.I.ewr as string]?.tz).toBe("America/New_York");
		});

		it("a 50 min layover warns tight_connection (international < 60) without a conflict", () => {
			const s = build("08:25", 50);
			const r = computeSchedule(indexGraph(s.graph));
			expect(r.legs[`${s.I.ist}>${s.I.ewr}`]?.warn).toEqual({
				kind: "tight_connection",
				minutes: 50,
			});
			expect(r.legs[`${s.I.ist}>${s.I.ewr}`]?.late).toBeUndefined();
			expect(r.days[s.D.d2 as string]?.conflicts).toBe(0);
		});
	});

	describe("9. stays", () => {
		const build = (withStay: boolean) =>
			scenario({
				days: [
					{
						night: withStay ? "ryokan" : undefined,
						items: [{ k: "itoya", node: "itoya" }],
					},
					{
						items: [
							{ k: "breakfast", title: "Breakfast (ryokan)", min: 45 },
							{ k: "temple", node: "kiyomizu" },
						],
					},
				],
			});

		it("with Kawaguchiko Ryokan as the night, Day 2 has a stay:…:start leg before its first located item", () => {
			const s = build(true);
			const r = computeSchedule(indexGraph(s.graph));
			const stay = r.legs[`stay:${s.D.d2}:start`];
			expect(stay).toMatchObject({
				kind: "stay",
				unset: true,
				estimate: true,
				timed: false,
				legId: null,
			});
			expect(stay?.suggestion?.mode).toBe("transit");
			expect(stay?.minutes).toBe(stay?.suggestion?.estimateMin);
			expect(hhmm(stay?.start as Date, TOKYO)).toBe("09:45"); // after Breakfast
			expect(r.items[s.I.temple as string]?.start.getTime()).toBe(
				stay?.end.getTime(),
			);
			// The evening before: Itoya → ryokan.
			expect(r.legs[`stay:${s.D.d1}:end`]).toMatchObject({
				kind: "stay",
				unset: true,
			});
			expect(r.days[s.D.d2 as string]?.stay).toEqual({
				morning: s.N.ryokan,
				night: null,
			});
			expect(r.days[s.D.d1 as string]?.stay).toEqual({
				morning: null,
				night: s.N.ryokan,
			});
		});

		it("with no stay, the boundary is overnight (0 min) and Day 2's first located item starts at the day start", () => {
			const s = build(false);
			const r = computeSchedule(indexGraph(s.graph));
			expect(r.legs[`${s.I.itoya}>${s.I.temple}`]).toMatchObject({
				kind: "overnight",
				minutes: 0,
				crossDay: true,
			});
			expect(r.legs[`stay:${s.D.d2}:start`]).toBeUndefined();
			expect(span(r, s.I.breakfast)).toBe("09:00–09:45");
			expect(span(r, s.I.temple)).toBe("09:45–10:45");
		});

		it("flags a stored stay leg whose anchor changed as stale, and uses its minutes", () => {
			const s = scenario({
				days: [
					{ night: "ryokan", items: [{ k: "itoya", node: "itoya" }] },
					{
						items: [
							{ k: "temple", node: "kiyomizu" },
							{ k: "old", node: "sensoji" },
						],
					},
				],
				legs: [
					{
						k: "morning",
						stay: { day: "d2", end: "start" },
						anchor: "old",
						mode: "transit",
						min: 200,
						isEdited: true,
					},
				],
			});
			const r = computeSchedule(indexGraph(s.graph));
			expect(r.legs[`stay:${s.D.d2}:start`]).toMatchObject({
				minutes: 200,
				stale: true,
				unset: false,
				estimate: false,
				legId: s.L.morning,
			});
		});
	});
});

describe("computeSchedule details", () => {
	it("a cross-day moded leg departs at the next day's start", () => {
		const s = scenario({
			days: [
				{ items: [{ k: "a", node: "hands" }] },
				{ items: [{ k: "b", node: "sensoji" }] },
			],
			legs: [{ from: "a", to: "b", mode: "transit", min: 35 }],
		});
		const r = computeSchedule(indexGraph(s.graph));
		expect(r.legs[`${s.I.a}>${s.I.b}`]).toMatchObject({
			crossDay: true,
			kind: "pair",
			minutes: 35,
		});
		expect(span(r, s.I.b)).toBe("09:35–10:35");
	});

	it("a moded leg without minutes counts the estimate and says so", () => {
		const s = scenario({
			days: [
				{
					items: [
						{ k: "a", node: "hands" },
						{ k: "b", node: "kiyomizu" },
					],
				},
			],
			legs: [{ from: "a", to: "b", mode: "transit", min: null }],
		});
		const r = computeSchedule(indexGraph(s.graph));
		const leg = r.legs[`${s.I.a}>${s.I.b}`];
		expect(leg).toMatchObject({ unset: false, estimate: true });
		expect(leg?.minutes).toBe(leg?.suggestion?.estimateMin);
		expect(leg?.minutes).toBeGreaterThan(150);
	});

	it("between countries an unset leg suggests a flight and counts 0", () => {
		const s = scenario({
			days: [
				{
					items: [
						{ k: "a", node: "osaka" },
						{ k: "b", node: "seoul" },
					],
				},
			],
		});
		const r = computeSchedule(indexGraph(s.graph));
		expect(r.legs[`${s.I.a}>${s.I.b}`]).toMatchObject({
			minutes: 0,
			unset: true,
			suggestion: { mode: "flight", estimateMin: null, label: "flight?" },
		});
		// Between two airports it counts the great-circle estimate (FB-19).
		const a = scenario({
			days: [
				{
					items: [
						{ k: "a", node: "kix" },
						{ k: "b", node: "icn" },
					],
				},
			],
		});
		const ra = computeSchedule(indexGraph(a.graph));
		expect(ra.legs[`${a.I.a}>${a.I.b}`]).toMatchObject({
			minutes: 95,
			unset: true,
			estimate: true,
			suggestion: { mode: "flight", estimateMin: 95 },
		});
	});

	it("offers shorten, fastest route and unpin for a late pinned item", () => {
		const s = scenario({
			days: [
				{
					items: [
						{ k: "a", node: "hands", min: 120 },
						{ k: "b", node: "sensoji", min: 60, pin: "11:00" },
					],
				},
			],
			legs: [{ k: "t", from: "a", to: "b", mode: "transit", min: 40 }],
		});
		const ix = indexGraph(s.graph);
		const r = computeSchedule(ix);
		expect(r.items[s.I.b as string]?.late?.minutes).toBe(40);
		const alternatives = [
			{
				id: "slow",
				source: "google" as const,
				durationMin: 50,
				walkMin: 0,
				transfers: 1,
				segments: [],
			},
			{
				id: "fast",
				source: "google" as const,
				durationMin: 25,
				walkMin: 5,
				transfers: 0,
				segments: [],
			},
		];
		expect(
			conflictFixes(
				ix,
				r,
				{ kind: "item", itemId: s.I.b as string },
				alternatives,
			),
		).toEqual([
			{ kind: "shorten", itemId: s.I.a, durationMin: 80 },
			{ kind: "fastest-route", legId: s.L.t, routeId: "fast", durationMin: 25 },
			{ kind: "unpin", itemId: s.I.b },
		]);
	});

	it("never throws on bad zones or times; falls back to the trip zone, then UTC", () => {
		const s = scenario({
			defaultTz: "Mars/Olympus_Mons",
			nodes: [
				{
					key: "nowhere",
					parent: null,
					type: "place",
					name: "Nowhere",
					tz: "Not/A_Zone",
				},
			],
			days: [
				{
					start: "25:00",
					items: [
						{ k: "a", node: "nowhere", min: -5, pin: "99:99" },
						{ k: "b", title: "x", min: Number.NaN },
					],
				},
			],
		});
		const r = computeSchedule(indexGraph(s.graph));
		expect(r.items[s.I.a as string]).toMatchObject({
			tz: "UTC",
			pinned: false,
		});
		expect(span(r, s.I.a)).toBe("09:00–09:00");
		expect(r.days[s.D.d1 as string]?.activitiesMin).toBe(0);
	});

	it("covers the whole trip: every scheduled item and every day", () => {
		const s = scenario({
			days: [
				{ items: [{ k: "a", node: "hands" }] },
				{ items: [] },
				{ items: [{ k: "b", node: "sensoji" }] },
			],
			unscheduled: [{ k: "u", node: "itoya" }],
		});
		const r = computeSchedule(indexGraph(s.graph));
		expect(Object.keys(r.days)).toHaveLength(3);
		expect(Object.keys(r.items).sort()).toEqual([s.I.a, s.I.b].sort());
		expect(hhmm(r.days[s.D.d2 as string]?.end as Date, TOKYO)).toBe("09:00");
	});

	it("formats a late gap: minutes under an hour, else hours and minutes", () => {
		expect(lateGap(10)).toBe("10 min");
		expect(lateGap(59)).toBe("59 min");
		expect(lateGap(120)).toBe("2h");
		expect(lateGap(1420)).toBe("23h 40m");
	});

	it("formats flight numbers with a space", () => {
		expect(formatFlightNumber("NH9")).toBe("NH 9");
		expect(formatFlightNumber("tk 11")).toBe("TK 11");
		expect(formatFlightNumber("VN576")).toBe("VN 576");
		expect(formatFlightNumber("charter")).toBe("charter");
		expect(formatFlightNumber(null)).toBeNull();
	});

	it("a stored rail estimate counts as an estimate until someone edits it", () => {
		const build = (isEdited: boolean) =>
			scenario({
				days: [
					{
						items: [
							{ k: "a", node: "hands", min: 60 },
							{ k: "b", node: "meijiJingu", min: 60 },
						],
					},
				],
				legs: [
					{
						k: "rail",
						from: "a",
						to: "b",
						mode: "transit",
						min: 21,
						source: "estimate",
						isEdited,
					},
				],
			});
		const s0 = build(false);
		const r0 = computeSchedule(indexGraph(s0.graph));
		expect(r0.legs[`${s0.I.a}>${s0.I.b}`]).toMatchObject({
			minutes: 21,
			unset: false,
			estimate: true,
		});
		const s1 = build(true);
		const r1 = computeSchedule(indexGraph(s1.graph));
		expect(r1.legs[`${s1.I.a}>${s1.I.b}`]?.estimate).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// FEEDBACK-3: airport stops (FB-19a), flights without times (FB-18), DST (FB-20)
// ---------------------------------------------------------------------------

const NY = "America/New_York";
/** The owner's test trip: JFK is a `place`, Haneda an `area`, no categories. */
const FB_NODES = [
	{
		key: "nyc",
		parent: "usa",
		type: "city" as const,
		name: "New York",
		at: [40.7128, -74.006] as [number, number],
		tz: NY,
	},
	{
		key: "jfkPlace",
		parent: "nyc",
		type: "place" as const,
		name: "John F. Kennedy International Airport",
		at: [40.6413, -73.7781] as [number, number],
	},
	{
		key: "twa",
		parent: "nyc",
		type: "place" as const,
		category: "lodging" as const,
		name: "TWA Hotel",
		at: [40.6457, -73.7771] as [number, number],
	},
	{
		key: "hndArea",
		parent: "tokyo",
		type: "area" as const,
		name: "Haneda Airport",
		at: [35.5494, 139.7798] as [number, number],
	},
];
const JFK_AP = {
	iata: "JFK",
	tz: NY,
	country: "US",
	at: [40.6398, -73.7789] as [number, number],
};
const HND_AP = {
	iata: "HND",
	tz: TOKYO,
	country: "JP",
	at: [35.5523, 139.78] as [number, number],
};

/** JFK (pinned 00:00 for 2 h on Sat 12 Dec 2026) → NH 744 at 02:00 → HND. */
function fb19a(
	opts: {
		from?: string;
		pin?: string | null;
		min?: number;
		dep?: string;
		hndMin?: number;
		start?: string;
	} = {},
) {
	const dep = opts.dep ?? "2026-12-12T02:00";
	return scenario({
		firstDate: "2026-12-12",
		defaultTz: NY,
		nodes: FB_NODES,
		days: [
			{
				start: opts.start ?? "00:00",
				items: [
					{
						k: "jfk",
						node: opts.from ?? "jfkPlace",
						min: opts.min ?? 120,
						...(opts.pin === null ? {} : { pin: opts.pin ?? "00:00" }),
					},
				],
			},
			{ items: [{ k: "hnd", node: "hndArea", min: opts.hndMin ?? 60 }] },
		],
		legs: [
			{
				k: "nh",
				from: "jfk",
				to: "hnd",
				mode: "flight",
				dep: [dep, NY],
				arr: ["2026-12-13T05:25", TOKYO],
				details: flightDetails({
					number: "NH744",
					from: JFK_AP,
					to: HND_AP,
					dep,
					arr: "2026-12-13T05:25",
				}),
			},
		],
	});
}

describe("FB-19a: flights have no built-in airport buffers", () => {
	it("the owner's case: JFK 00:00 for 2 h, NH 744 at 02:00 — no 'Misses … by 2h'", () => {
		const s = fb19a();
		const r = computeSchedule(indexGraph(s.graph));
		const leg = r.legs[`${s.I.jfk}>${s.I.hnd}`];
		expect(leg?.late).toBeUndefined();
		expect(leg?.warn).toBeUndefined();
		expect(r.days[s.D.d1 as string]?.conflicts).toBe(0);
		expect(span(r, s.I.jfk)).toBe("00:00–02:00");
		// The leg runs dep → arr: time at an airport is its stop's own duration.
		expect(leg).toMatchObject({ timed: true, minutes: 805 });
		expect(hhmm(leg?.start as Date, NY)).toBe("02:00"); // EST, December
		expect(hhmm(leg?.end as Date, TOKYO)).toBe("05:25");
		expect(span(r, s.I.hnd)).toBe("05:25–06:25");
	});

	it("the owner's real trip: the day starts 09:00, JFK pinned 00:00 opens it on the same date", () => {
		const s = fb19a({ start: "09:00" });
		const r = computeSchedule(indexGraph(s.graph));
		const leg = r.legs[`${s.I.jfk}>${s.I.hnd}`];
		expect(leg?.late).toBeUndefined();
		expect(span(r, s.I.jfk)).toBe("00:00–02:00");
		expect(r.items[s.I.jfk as string]?.late).toBeUndefined();
		expect(r.days[s.D.d1 as string]?.conflicts).toBe(0);
		expect(hhmm(r.days[s.D.d1 as string]?.start as Date, NY)).toBe("00:00");
	});

	it("from a stop that isn't the airport, nothing is added either: ready by the departure", () => {
		const s = fb19a({ from: "twa" });
		const r = computeSchedule(indexGraph(s.graph));
		const leg = r.legs[`${s.I.jfk}>${s.I.hnd}`];
		expect(leg?.late).toBeUndefined();
		expect(hhmm(leg?.start as Date, NY)).toBe("02:00");
	});

	it("a short airport stop is the owner's call: no warning, no conflict", () => {
		const s = fb19a({ pin: "01:15", min: 45 });
		const r = computeSchedule(indexGraph(s.graph));
		const leg = r.legs[`${s.I.jfk}>${s.I.hnd}`];
		expect(leg?.late).toBeUndefined();
		expect(leg?.warn).toBeUndefined();
		expect(r.days[s.D.d1 as string]?.conflicts).toBe(0);
	});

	it("an unpinned airport stop is placed to end at the departure", () => {
		const s = fb19a({ pin: null, dep: "2026-12-12T14:00" });
		const r = computeSchedule(indexGraph(s.graph));
		expect(span(r, s.I.jfk)).toBe("12:00–14:00");
		expect(r.items[s.I.jfk as string]?.freeBeforeMin).toBe(12 * 60);
		expect(r.legs[`${s.I.jfk}>${s.I.hnd}`]?.late).toBeUndefined();
	});

	it("boarding ends a stop that would run past the departure", () => {
		const s = fb19a({ pin: "01:00", min: 120 });
		const r = computeSchedule(indexGraph(s.graph));
		expect(span(r, s.I.jfk)).toBe("01:00–02:00");
		const leg = r.legs[`${s.I.jfk}>${s.I.hnd}`];
		expect(leg?.late).toBeUndefined();
		expect(leg?.warn).toBeUndefined();
	});

	it("arriving at the stop after the departure is still a real miss", () => {
		const s = fb19a({ pin: "03:00", min: 60 });
		const r = computeSchedule(indexGraph(s.graph));
		expect(r.legs[`${s.I.jfk}>${s.I.hnd}`]?.late).toMatchObject({
			minutes: 60,
			label: "Misses NH 744 (dep 02:00) by 1h",
		});
	});

	it("0-minute airport items plan no airport time: dep and arr only", () => {
		const s = fb19a({ pin: "02:00", min: 0, hndMin: 0 });
		const r = computeSchedule(indexGraph(s.graph));
		const leg = r.legs[`${s.I.jfk}>${s.I.hnd}`];
		expect(leg?.late).toBeUndefined();
		expect(hhmm(leg?.start as Date, NY)).toBe("02:00");
		expect(span(r, s.I.hnd)).toBe("05:25–05:25");
	});
});

describe("FB-18: a flight without times is an estimated untimed leg", () => {
	/** The FB-19 default: JFK Dec 12 → HND Dec 13, airports and dates only. */
	function untimed(
		flight: Record<string, unknown> = {},
		items = { jfk: { pin: "00:00", min: 120 } },
	) {
		return scenario({
			firstDate: "2026-12-12",
			defaultTz: NY,
			nodes: FB_NODES,
			days: [
				{
					start: "00:00",
					items: [{ k: "jfk", node: "jfkPlace", ...items.jfk }],
				},
				{ items: [{ k: "hnd", node: "hndArea", min: 60 }] },
			],
			legs: [
				{
					k: "auto",
					from: "jfk",
					to: "hnd",
					mode: "flight",
					source: "estimate",
					isEdited: false,
					details: {
						kind: "flight",
						flight: {
							from: {
								iata: "JFK",
								name: "JFK",
								tz: NY,
								lat: 40.6398,
								lng: -73.7789,
							},
							to: {
								iata: "HND",
								name: "HND",
								tz: TOKYO,
								lat: 35.5523,
								lng: 139.78,
							},
							depDate: "2026-12-12",
							arrDate: "2026-12-13",
							seats: [],
							...flight,
						},
					},
				},
			],
		});
	}

	it("counts ~14h 5m est. from when the JFK stop ends, and lands in Tokyo", () => {
		const s = untimed();
		const r = computeSchedule(indexGraph(s.graph));
		const leg = r.legs[`${s.I.jfk}>${s.I.hnd}`];
		expect(leg).toMatchObject({
			timed: false,
			estimate: true,
			unset: false,
			crossDay: true,
			minutes: 845,
			flight: { depKnown: false, arrKnown: false },
		});
		expect(leg?.late).toBeUndefined();
		// 02:00 EST + 14h 5m = 16:05 EST = 06:05 JST on Sun 13 Dec.
		const hnd = r.items[s.I.hnd as string];
		expect(hnd?.tz).toBe(TOKYO);
		expect(hhmm(hnd?.start as Date, TOKYO)).toBe("06:05");
		expect(localDateOf(hnd?.start as Date, TOKYO)).toBe("2026-12-13");
		// It counts on its departure day, like an overnight flight.
		expect(r.days[s.D.d1 as string]?.travelMin).toBe(845);
		expect(r.days[s.D.d2 as string]?.travelMin).toBe(0);
	});

	it("a same-day untimed flight counts the estimate right after the stop", () => {
		const s = scenario({
			firstDate: "2027-10-10",
			days: [
				{
					items: [
						{ k: "kix", node: "kix", min: 60 },
						{ k: "icn", node: "icn", min: 60 },
					],
				},
			],
			legs: [
				{
					from: "kix",
					to: "icn",
					mode: "flight",
					isEdited: true,
					details: {
						kind: "flight",
						flight: {
							from: {
								iata: "KIX",
								name: "KIX",
								tz: TOKYO,
								lat: 34.432,
								lng: 135.2304,
							},
							to: {
								iata: "ICN",
								name: "ICN",
								tz: "Asia/Seoul",
								lat: 37.4602,
								lng: 126.4407,
							},
							depDate: "2027-10-10",
							seats: [],
						},
					},
				},
			],
		});
		const r = computeSchedule(indexGraph(s.graph));
		expect(r.legs[`${s.I.kix}>${s.I.icn}`]).toMatchObject({
			minutes: 95,
			estimate: true,
			timed: false,
		});
		expect(span(r, s.I.kix)).toBe("09:00–10:00");
		expect(hhmm(r.items[s.I.icn as string]?.start as Date, "Asia/Seoul")).toBe(
			"11:35",
		);
	});

	it("only a departure time: the stored arrival is the estimate, labelled", () => {
		const dep = "2026-12-12T02:00";
		const depMs = localDateTimeToEpoch(dep, NY) as number;
		const s = untimed({ depLocal: dep });
		const leg = s.graph.legs[0];
		if (!leg) throw new Error("no leg");
		// What the server stores (timedInstants): dep, dep + 845 min.
		leg.depAt = new Date(depMs).toISOString();
		leg.arrAt = new Date(depMs + 845 * 60_000).toISOString();
		const r = computeSchedule(indexGraph(s.graph));
		expect(r.legs[`${s.I.jfk}>${s.I.hnd}`]).toMatchObject({
			timed: true,
			estimate: true,
			flight: { depKnown: true, arrKnown: false },
		});
		expect(r.legs[`${s.I.jfk}>${s.I.hnd}`]?.late).toBeUndefined();
	});

	it("the default flight follows its items: never significant, never a block", () => {
		const s = untimed();
		const ix = indexGraph(s.graph);
		const leg = ix.leg(s.L.auto);
		expect(leg && ix.isSignificant(leg)).toBe(false);
		expect(ix.flightBlocks).toEqual([]);
		// Once a person saves it, it is a booked block like any flight.
		const edited = structuredClone(s.graph);
		const own = edited.legs[0];
		if (!own) throw new Error("no leg");
		own.isEdited = true;
		own.source = "manual";
		const ix2 = indexGraph(edited);
		expect(ix2.isSignificant(own)).toBe(true);
		expect(ix2.flightBlocks).toEqual([[s.I.jfk, s.I.hnd]]);
	});
});

describe("FB-20: EWR on the day US DST ends", () => {
	it("TK 11 lands 01:30 EST (the second 01:30): the arrival reads EST and the day continues", () => {
		const s = scenario({
			firstDate: "2027-11-06",
			nodes: [
				{
					key: "istAp",
					parent: "istanbul",
					type: "place",
					category: "airport",
					name: "Istanbul Airport",
					at: [41.2753, 28.7519],
				},
			],
			days: [
				{ start: "17:00", items: [{ k: "ist", node: "istAp", min: 150 }] },
				{ items: [{ k: "ewr", node: "ewr", min: 60 }] },
			],
			legs: [
				{
					from: "ist",
					to: "ewr",
					mode: "flight",
					dep: ["2027-11-06T19:30", "Europe/Istanbul"],
					arr: ["2027-11-07T06:30", "UTC"], // 01:30 EST
					details: {
						kind: "flight",
						flight: {
							flightNumber: "TK11",
							from: {
								iata: "IST",
								name: "Istanbul Airport",
								tz: "Europe/Istanbul",
								lat: 41.2753,
								lng: 28.7519,
							},
							to: {
								iata: "EWR",
								name: "Newark Liberty International Airport",
								tz: NY,
								lat: 40.6925,
								lng: -74.1687,
							},
							depLocal: "2027-11-06T19:30",
							arrLocal: "2027-11-07T01:30",
							arrFold: "later",
							seats: [],
						},
					},
				},
			],
		});
		const r = computeSchedule(indexGraph(s.graph));
		const leg = r.legs[`${s.I.ist}>${s.I.ewr}`];
		// 19:30 TRT → 01:30 EST: 14 h in the air (not 13: the hour repeats).
		expect(leg?.minutes).toBe(14 * 60);
		const ewr = r.items[s.I.ewr as string];
		expect(ewr?.tz).toBe(NY);
		expect(hhmm(ewr?.start as Date, NY)).toBe("01:30");
		expect(tzOffsetMin(NY, ewr?.start as Date)).toBe(-300);
		expect(tzLabel(NY, ewr?.start as Date)).toBe("EST");
		// The item's hour ends at 02:30 EST, 60 minutes later on the clock.
		expect(hhmm(ewr?.end as Date, NY)).toBe("02:30");
		// An hour earlier on the same wall clock was EDT.
		expect(tzLabel(NY, (ewr?.start.getTime() ?? 0) - 3_600_000)).toBe("EDT");
	});
});
