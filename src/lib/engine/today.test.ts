import "./__fixtures__/host-tz";
import { describe, expect, it } from "vitest";
import {
	DEMO_MEMBERS,
	flightDetails,
	type LocalAt,
	type Scenario,
	scenario,
} from "./__fixtures__/demo";
import { NODES, tokyoDay } from "./__fixtures__/today";
import { indexGraph } from "./graph-index";
import { computeSchedule } from "./schedule";
import { hhmm, zonedEpoch } from "./time";
import {
	computeToday,
	stopHere,
	type TodayOptions,
	type TodayStop,
	todayDayId,
} from "./today";
import type { GraphNode } from "./types";

const TOKYO = "Asia/Tokyo";
const DAY = "2027-10-05";
const at = (time: string, date = DAY) => zonedEpoch(date, time, TOKYO);
const t = (ms: number) => hhmm(ms, TOKYO);
const done = (time: string, date = DAY): LocalAt => [`${date}T${time}`, TOKYO];
const names = (list: readonly TodayStop[]) => list.map((s) => s.name);

function view(s: Scenario, now: number, opts?: TodayOptions, day = "d1") {
	const ix = indexGraph(s.graph);
	const schedule = computeSchedule(ix);
	return {
		ix,
		schedule,
		v: computeToday(ix, schedule, s.D[day] as string, now, opts),
	};
}

describe("computeToday: before the day starts", () => {
	it("the first stop is next, with when to leave the hotel; on time", () => {
		const { v } = view(tokyoDay(), at("08:00"));
		expect(v.starting).toBe(true);
		expect(v.current).toBeNull();
		expect(v.next?.name).toBe("Cha no Ikedaya");
		expect(t(v.next?.start as number)).toBe("09:10");
		expect(t(v.next?.leaveBy as number)).toBe("09:00");
		expect(v.next).toMatchObject({ travelMin: 10, mode: "walk", fixed: false });
		expect(v.pace).toEqual({ kind: "on_time", minutes: 0 });
		expect(v.risks).toEqual([]);
		expect(names(v.rest)).toEqual([
			"Nakano Broadway",
			"Yodobashi Camera",
			"Bic Camera",
			"Dinner",
			"Bar Benfiddich",
			"Golden Gai",
		]);
	});

	it("names where you sleep tonight, with the walk back", () => {
		const s = tokyoDay();
		const { v } = view(s, at("08:00"));
		expect(v.tonight).toEqual({
			nodeId: s.N.gracery,
			name: "Hotel Gracery",
			coord: [139.702, 35.6955],
			travelMin: 8,
			mode: "walk",
		});
		expect(v.tomorrow).toBeNull();
	});
});

describe("computeToday: running late (board P15)", () => {
	const s = tokyoDay({ cha: done("09:50"), broadway: done("14:30") });
	const { v } = view(s, at("16:40"));

	it("Done moves you on: now at Yodobashi since 14:40, the rest re-timed from there", () => {
		expect(names(v.done)).toEqual(["Cha no Ikedaya", "Nakano Broadway"]);
		expect(t(v.done[1]?.end as number)).toBe("14:30");
		expect(v.current?.name).toBe("Yodobashi Camera");
		expect(t(v.current?.start as number)).toBe("14:40");
		expect(v.next?.name).toBe("Bic Camera");
		expect(t(v.next?.start as number)).toBe("16:45");
		expect(t(v.next?.plannedStart as number)).toBe("16:10");
		expect(v.rest.map((r) => `${t(r.start)} ${r.name}`)).toEqual([
			"18:15 Dinner",
			"20:00 Bar Benfiddich",
			"21:05 Golden Gai",
		]);
		expect(v.starting).toBe(false);
		expect(v.ended).toBe(false);
	});

	it("is 35 min behind", () => {
		expect(v.pace).toEqual({ kind: "behind", minutes: 35 });
	});

	it("the booking holds: Bar Benfiddich stays at 20:00, fixed and booked", () => {
		const bar = v.rest[1];
		expect(bar).toMatchObject({ fixed: true, booked: true });
		expect(t(bar?.arrive as number)).toBe("19:55");
		expect(t(bar?.leaveBy as number)).toBe("19:50");
	});

	it("Tight before Bar Benfiddich: 5 min spare instead of 40, with Shorten dinner to 1 h and Skip Bic Camera", () => {
		expect(v.risks).toHaveLength(1);
		const r = v.risks[0];
		expect(r).toMatchObject({
			itemId: s.I.bar,
			name: "Bar Benfiddich",
			booked: true,
			spareMin: 5,
			plannedSpareMin: 40,
			late: false,
			departure: null,
		});
		expect(t(r?.at as number)).toBe("20:00");
		expect(t(r?.arrive as number)).toBe("19:55");
		expect(r?.fixes).toEqual([
			{
				kind: "shorten",
				itemId: s.I.dinner,
				name: "Dinner",
				toMin: 60,
				recoverMin: 30,
			},
			expect.objectContaining({
				kind: "skip",
				itemId: s.I.bic,
				name: "Bic Camera",
			}),
		]);
		expect(r?.fixes[1]?.recoverMin).toBeGreaterThanOrEqual(90);
		expect(v.free).toBeNull();
		expect(v.ideas).toEqual([]);
	});
});

describe("computeToday: running early (board P18)", () => {
	const marks = {
		cha: done("09:50"),
		broadway: done("13:30"),
		yodobashi: done("15:20"),
		bic: done("17:10"),
	};
	const s = tokyoDay(marks);
	const { v } = view(s, at("17:10"));

	it("Bic Camera is done at 17:10; Dinner starts right away and the bar is next, 30 min ahead", () => {
		expect(v.done.map((d) => `${d.name} ${t(d.doneAt as number)}`).at(-1)).toBe(
			"Bic Camera 17:10",
		);
		expect(v.current?.name).toBe("Dinner");
		expect(v.next?.name).toBe("Bar Benfiddich");
		expect(v.pace).toEqual({ kind: "ahead", minutes: 30 });
		expect(v.risks).toEqual([]);
	});

	it("1 h 10 free before 19:50: leave for Bar Benfiddich by 19:50 (booked for 20:00, 10 min walk)", () => {
		expect(v.free).toMatchObject({
			minutes: 70,
			itemId: s.I.bar,
			name: "Bar Benfiddich",
			booked: true,
			travelMin: 10,
			mode: "walk",
			departure: null,
		});
		expect(t(v.free?.from as number)).toBe("18:40");
		expect(t(v.free?.before as number)).toBe("19:50");
		expect(t(v.free?.at as number)).toBe("20:00");
	});

	it("ideas nearby: open then, a short walk, the group's favourites first, at most three", () => {
		expect(v.ideas.map((i) => i.name)).toEqual([
			"Fuunji",
			"Omoide Yokocho",
			"Don Quijote",
		]);
		const [ramen, omoide, donki] = v.ideas;
		// The stop waiting in Ideas comes along, so + puts it back on the day.
		expect(ramen).toMatchObject({
			itemId: s.I.ramenStop,
			score: 4,
			hours: "open till 21:00",
		});
		expect(omoide).toMatchObject({
			itemId: null,
			score: 1,
			hours: "open till late",
		});
		expect(donki).toMatchObject({ score: 0, hours: "open 24 h" });
		for (const i of v.ideas) expect(i.walkMin).toBeLessThanOrEqual(15);
		// Closed by then (the museum), where you sleep, not going, too far (Shibuya): never.
		const all = v.ideas.map((i) => i.nodeId);
		for (const k of ["museum", "sunroute", "notGoing", "shibuyaSky", "gracery"])
			expect(all).not.toContain(s.N[k]);
	});

	it("unknown hours count as open (Karaoke Kan, fourth by score, is next in line)", () => {
		const s2 = tokyoDay(marks);
		s2.graph.nodes = s2.graph.nodes.map((n) =>
			n.id === s2.N.donki ? { ...n, status: "dropped" as const } : n,
		);
		const { v: v2 } = view(s2, at("17:10"));
		expect(v2.ideas.map((i) => i.name)).toEqual([
			"Fuunji",
			"Omoide Yokocho",
			"Karaoke Kan",
		]);
		expect(v2.ideas[2]?.hours).toBeNull();
	});

	it("with my location, the ideas are near me, wherever the plan is", () => {
		const s2 = tokyoDay(marks);
		const sensoji = s2.graph.nodes.find(
			(n) => n.id === s2.N.sensoji,
		) as GraphNode;
		const { v: v2 } = view(s2, at("17:10"), {
			here: [sensoji.lng as number, sensoji.lat as number],
		});
		expect(v2.ideas.map((i) => i.name)).toContain("Senso-ji");
		expect(v2.ideas.map((i) => i.name)).not.toContain("Fuunji");
	});

	it("the counted raters decide the score", () => {
		const { v: v2 } = view(tokyoDay(marks), at("17:10"), {
			raterIds: [DEMO_MEMBERS.audrey],
		});
		// Only Audrey's rating of Fuunji counts; the rest tie at 0, nearest first.
		expect(v2.ideas[0]).toMatchObject({ name: "Fuunji", score: 1 });
		expect(v2.ideas.slice(1).map((i) => i.score)).toEqual([0, 0]);
		const walks = v2.ideas.slice(1).map((i) => i.walkMin);
		expect(walks).toEqual([...walks].sort((a, b) => a - b));
	});
});

describe("computeToday: following your pace, not the clock", () => {
	it("a stop not marked Done runs until now: you're still there", () => {
		const { v } = view(tokyoDay(), at("11:00"));
		expect(v.current?.name).toBe("Cha no Ikedaya");
		expect(t(v.current?.start as number)).toBe("09:10");
		expect(t(v.current?.end as number)).toBe("11:00");
		expect(t(v.next?.start as number)).toBe("11:20");
		expect(v.pace).toEqual({ kind: "behind", minutes: 65 });
		expect(v.starting).toBe(false);
	});

	it("a later stop marked Done passes over the ones before it", () => {
		const { v } = view(tokyoDay({ broadway: done("13:00") }), at("13:00"));
		expect(names(v.passed)).toEqual(["Cha no Ikedaya"]);
		expect(names(v.done)).toEqual(["Nakano Broadway"]);
		expect(v.next?.name).toBe("Yodobashi Camera");
		expect(t(v.next?.start as number)).toBe("13:10");
		expect(v.pace).toEqual({ kind: "ahead", minutes: 55 });
	});

	it("within 5 min of the plan is on time", () => {
		const { v } = view(tokyoDay({ cha: done("09:59") }), at("10:00"));
		expect(t(v.next?.start as number)).toBe("10:19");
		expect(v.pace).toEqual({ kind: "on_time", minutes: 0 });
		const { v: v2 } = view(tokyoDay({ cha: done("10:00") }), at("10:00"));
		expect(v2.pace).toEqual({ kind: "behind", minutes: 5 });
	});

	it("a Done stamp from outside the day (a demo's asOf) reads as now", () => {
		const s = tokyoDay({ cha: ["2026-09-28T10:00", TOKYO] });
		const { v } = view(s, at("10:30"));
		expect(t(v.done[0]?.doneAt as number)).toBe("10:30");
		expect(t(v.next?.start as number)).toBe("10:50");
	});

	it("reaching a booking late: a late risk; the only fix left is to shorten the dinner you're at", () => {
		const s = tokyoDay({
			cha: done("09:50"),
			broadway: done("14:00"),
			yodobashi: done("16:00"),
			bic: done("19:00"),
		});
		const { v } = view(s, at("19:30"));
		expect(v.current?.name).toBe("Dinner");
		const r = v.risks[0];
		expect(r).toMatchObject({
			name: "Bar Benfiddich",
			spareMin: -40,
			plannedSpareMin: 40,
			late: true,
		});
		expect(t(r?.arrive as number)).toBe("20:40");
		// Dinner (19:00–20:30) can end now at the earliest: 60 min back.
		expect(r?.fixes).toEqual([
			{
				kind: "shorten",
				itemId: s.I.dinner,
				name: "Dinner",
				toMin: 30,
				recoverMin: 60,
			},
		]);
	});

	it("a booking whose time has come while you're still at dinner is late, not gone", () => {
		const s = tokyoDay({
			cha: done("09:50"),
			broadway: done("14:00"),
			yodobashi: done("16:00"),
			bic: done("17:10"),
		});
		const { v } = view(s, at("20:05"));
		expect(v.current?.name).toBe("Dinner");
		expect(v.next?.name).toBe("Bar Benfiddich");
		expect(v.risks[0]).toMatchObject({
			name: "Bar Benfiddich",
			late: true,
			spareMin: -15,
		});
		expect(v.free).toBeNull();
	});

	it("a booking whose time has come while you walk there is Next and late, with its Directions", () => {
		const s = tokyoDay({
			cha: done("09:50"),
			broadway: done("14:00"),
			yodobashi: done("16:00"),
			bic: done("17:30"),
			dinner: done("20:00"),
		});
		const { v } = view(s, at("20:05"));
		expect(v.current).toBeNull();
		expect(v.next?.name).toBe("Bar Benfiddich");
		expect(t(v.next?.arrive as number)).toBe("20:10");
		expect(v.risks[0]).toMatchObject({
			name: "Bar Benfiddich",
			late: true,
			spareMin: -10,
		});
		// Once there, it's Now since you arrived.
		const { v: v2 } = view(s, at("20:15"));
		expect(v2.current?.name).toBe("Bar Benfiddich");
		expect(v2.risks).toEqual([]);
	});

	it("a shorten is offered only if it gives back enough, and never below 30 min", () => {
		const shortDay = (bicMin: number, chaDone = "10:00") =>
			scenario({
				firstDate: DAY,
				nodes: NODES,
				days: [
					{
						items: [
							{ k: "cha", node: "cha", min: 40, done: done(chaDone) },
							{ k: "bic", node: "bic", min: bicMin },
							{ k: "bar", node: "benfiddich", min: 60, pin: "11:00" },
						],
					},
				],
				legs: [
					{ from: "cha", to: "bic", mode: "walk", min: 5 },
					{ from: "bic", to: "bar", mode: "walk", min: 10 },
				],
			});
		// Planned: Cha 09:00–09:40, Bic 09:45–10:25, at the bar 10:35 (25 min spare).
		// Cha done 10:00: Bic 10:05–10:45, at the bar 10:55: 5 min spare.
		const s = shortDay(40);
		const r = view(s, at("10:00"), {}, "d1").v.risks[0];
		expect(r).toMatchObject({ spareMin: 5, plannedSpareMin: 25 });
		// Bic 40 → 30 gives back 10: 15 min spare, enough. Skipping it gives back more.
		expect(r?.fixes[0]).toEqual({
			kind: "shorten",
			itemId: s.I.bic,
			name: "Bic Camera",
			toMin: 30,
			recoverMin: 10,
		});
		expect(r?.fixes[1]).toMatchObject({ kind: "skip", itemId: s.I.bic });
		expect(r?.fixes[1]?.recoverMin).toBeGreaterThan(40);
		// A 35 min Bic can't go below 30: 5 min back isn't the 10 needed, so only the skip.
		const s2 = shortDay(35, "10:05");
		const r2 = view(s2, at("10:05"), {}, "d1").v.risks[0];
		expect(r2).toMatchObject({ spareMin: 5, plannedSpareMin: 30 });
		expect(r2?.fixes.map((f) => f.kind)).toEqual(["skip"]);
	});

	it("within 5 min of the plan's own room is on time, not a risk", () => {
		// Planned: Cha 09:00–09:40, Bic 09:45–10:25, at the bar 10:35 for 10:50 (15 min spare).
		const tight = (chaDone: string) =>
			scenario({
				firstDate: DAY,
				nodes: NODES,
				days: [
					{
						items: [
							{ k: "cha", node: "cha", min: 40, done: done(chaDone) },
							{ k: "bic", node: "bic", min: 40 },
							{ k: "bar", node: "benfiddich", min: 60, pin: "10:50" },
						],
					},
				],
				legs: [
					{ from: "cha", to: "bic", mode: "walk", min: 5 },
					{ from: "bic", to: "bar", mode: "walk", min: 10 },
				],
			});
		// 3 min later than the plan: 12 min spare instead of 15.
		const { v } = view(tight("09:43"), at("09:43"), {}, "d1");
		expect(v.risks).toEqual([]);
		expect(v.pace).toEqual({ kind: "on_time", minutes: 0 });
		// 5 min later: 10 instead of 15, a risk.
		const { v: v2 } = view(tight("09:45"), at("09:45"), {}, "d1");
		expect(v2.risks[0]).toMatchObject({ spareMin: 10, plannedSpareMin: 15 });
	});

	it("a stop without a place is shortened, never skipped: Skip takes the nearest place", () => {
		// Planned: Cha 09:00–09:40, Lunch 09:40–10:40, Bic 10:45–11:30, the bar at 12:30 (50 min spare).
		const s = scenario({
			firstDate: DAY,
			nodes: NODES,
			days: [
				{
					items: [
						{ k: "cha", node: "cha", min: 40, done: done("10:30") },
						{ k: "lunch", title: "Lunch", min: 60 },
						{ k: "bic", node: "bic", min: 45 },
						{ k: "bar", node: "benfiddich", min: 60, pin: "12:30" },
					],
				},
			],
			legs: [
				{ from: "cha", to: "bic", mode: "walk", min: 5 },
				{ from: "bic", to: "bar", mode: "walk", min: 10 },
			],
		});
		const r = view(s, at("10:30"), {}, "d1").v.risks[0];
		expect(r).toMatchObject({ spareMin: 0, plannedSpareMin: 50 });
		expect(r?.fixes).toEqual([
			{
				kind: "shorten",
				itemId: s.I.lunch,
				name: "Lunch",
				toMin: 30,
				recoverMin: 30,
			},
			expect.objectContaining({ kind: "skip", itemId: s.I.bic }),
		]);
	});

	it("a booked stop is never shortened or skipped", () => {
		const s = tokyoDay({ cha: done("09:50"), broadway: done("14:30") });
		s.graph.items = s.graph.items.map((i) =>
			i.id === s.I.bic || i.id === s.I.dinner ? { ...i, fixedDate: true } : i,
		);
		const { v } = view(s, at("16:40"));
		expect(v.risks[0]?.fixes).toEqual([]);
	});
});

describe("computeToday: timed departures", () => {
	const fuji = {
		kind: "transit" as const,
		route: {
			id: "n7",
			source: "manual" as const,
			durationMin: 135,
			walkMin: 0,
			transfers: 0,
			segments: [],
			label: "Nozomi 7",
		},
		fixed: {
			departLocal: `${DAY}T12:00`,
			arriveLocal: `${DAY}T14:15`,
			fromTz: TOKYO,
			toTz: TOKYO,
			accessMin: 10,
			egressMin: 10,
		},
	};
	const trainDay = (chaDone?: LocalAt) =>
		scenario({
			firstDate: DAY,
			nodes: [
				...NODES,
				{
					key: "tokyoSt",
					parent: "tokyo",
					type: "place" as const,
					category: "station" as const,
					name: "Tokyo Station",
					at: [35.6812, 139.7671] as [number, number],
				},
			],
			days: [
				{
					items: [
						{ k: "cha", node: "cha", min: 60, done: chaDone },
						{ k: "station", node: "tokyoSt", min: 15 },
						{ k: "kiyomizu", node: "kiyomizu", min: 60 },
					],
				},
			],
			legs: [
				{ from: "cha", to: "station", mode: "transit", min: 15 },
				{
					k: "train",
					from: "station",
					to: "kiyomizu",
					mode: "transit",
					dep: [`${DAY}T12:00`, TOKYO],
					arr: [`${DAY}T14:15`, TOKYO],
					details: fuji,
				},
			],
		});

	it("the stop after a train holds its time; the train is a risk when the flow gets tight", () => {
		const s = trainDay(done("11:20"));
		const { v } = view(s, at("11:20"), {}, "d1");
		expect(v.next?.name).toBe("Tokyo Station");
		expect(t(v.next?.start as number)).toBe("11:35");
		const kyoto = v.rest[0];
		expect(kyoto).toMatchObject({ name: "Kiyomizu-dera", fixed: true });
		expect(t(kyoto?.start as number)).toBe("14:25");
		expect(kyoto?.departure).toMatchObject({
			legId: s.L.train,
			name: "Nozomi 7",
			flight: false,
		});
		expect(t(kyoto?.departure?.readyBy as number)).toBe("11:50");
		expect(v.risks).toHaveLength(1);
		// Planned: Cha 09:00–10:00, the station 10:15–10:30, the train at 11:50 (80 min spare).
		expect(v.risks[0]).toMatchObject({
			itemId: s.I.kiyomizu,
			name: "Nozomi 7",
			spareMin: 0,
			plannedSpareMin: 80,
			late: false,
		});
		// The station is where you board: never skipped, and too short to shorten.
		expect(v.risks[0]?.fixes).toEqual([]);
		expect(v.pace).toEqual({ kind: "behind", minutes: 80 });
	});

	it("before the day, the train leaves room: free time before it, no walk", () => {
		const { v } = view(trainDay(), at("08:00"), {}, "d1");
		expect(v.free).toMatchObject({
			minutes: 80,
			name: "Nozomi 7",
			travelMin: 0,
		});
		expect(t(v.free?.before as number)).toBe("11:50");
	});

	/** Itoya, then KIX for NH 9 at 23:30, landing at Incheon 01:50 the next day. */
	const redEye = (itoyaDone?: LocalAt) =>
		scenario({
			firstDate: DAY,
			days: [
				{
					items: [
						{ k: "itoya", node: "itoya", min: 60, done: itoyaDone },
						{ k: "kix", node: "kix", min: 60 },
					],
				},
				{ items: [{ k: "icn", node: "icn", min: 30 }] },
			],
			legs: [
				{ from: "itoya", to: "kix", mode: "transit", min: 60 },
				{
					k: "flight",
					from: "kix",
					to: "icn",
					mode: "flight",
					dep: [`${DAY}T23:30`, TOKYO],
					arr: ["2027-10-06T01:50", "Asia/Seoul"],
					details: flightDetails({
						number: "NH9",
						from: {
							iata: "KIX",
							tz: TOKYO,
							country: "JP",
							at: [34.432, 135.2304],
						},
						to: {
							iata: "ICN",
							tz: "Asia/Seoul",
							country: "KR",
							at: [37.4602, 126.4407],
						},
						dep: `${DAY}T23:30`,
						arr: "2027-10-06T01:50",
					}),
				},
			],
		});

	it("an overnight flight from the day's last stop is a departure too", () => {
		const s = redEye(done("22:10"));
		const { v } = view(s, at("22:10"), {}, "d1");
		expect(v.next?.name).toBe("Kansai Airport (KIX)");
		const r = v.risks[0];
		expect(r).toMatchObject({
			itemId: s.I.icn,
			name: "NH 9",
			late: true,
			spareMin: -40,
			tz: TOKYO,
		});
		expect(r?.departure).toMatchObject({
			legId: s.L.flight,
			flight: true,
			tz: TOKYO,
		});
		// Shorten the airport stop to 30: back to 10 min short; not enough to clear it, so no fix; the airport is where you board.
		expect(r?.fixes).toEqual([]);
	});

	it("the morning after, the landing holds its time with nothing to leave for", () => {
		const s = redEye();
		const { v } = view(
			s,
			zonedEpoch("2027-10-06", "01:00", "Asia/Seoul"),
			{},
			"d2",
		);
		expect(v.starting).toBe(true);
		expect(v.next).toMatchObject({
			name: "Incheon (ICN)",
			fixed: true,
			departure: null,
			travelMin: 0,
		});
		expect(v.next?.leaveBy).toBe(v.next?.start);
		expect(v.next?.start).toBeGreaterThanOrEqual(
			zonedEpoch("2027-10-06", "01:50", "Asia/Seoul"),
		);
		expect(v.risks).toEqual([]);
		expect(v.free).toBeNull();
	});

	it("a departure's times read where you board, not where you land", () => {
		// Itoya, then KIX, for CI 157 to Taipei (an hour behind Tokyo) at 16:00.
		const s = scenario({
			firstDate: DAY,
			days: [
				{
					items: [
						{ k: "itoya", node: "itoya", min: 60, done: done("13:00") },
						{ k: "kix", node: "kix", min: 30 },
						{ k: "tpe", node: "tpe", min: 30 },
					],
				},
			],
			legs: [
				{ from: "itoya", to: "kix", mode: "transit", min: 60 },
				{
					k: "flight",
					from: "kix",
					to: "tpe",
					mode: "flight",
					dep: [`${DAY}T16:00`, TOKYO],
					arr: [`${DAY}T18:00`, "Asia/Taipei"],
					details: flightDetails({
						number: "CI157",
						from: {
							iata: "KIX",
							tz: TOKYO,
							country: "JP",
							at: [34.432, 135.2304],
						},
						to: {
							iata: "TPE",
							tz: "Asia/Taipei",
							country: "TW",
							at: [25.0797, 121.2342],
						},
						dep: `${DAY}T16:00`,
						arr: `${DAY}T18:00`,
					}),
				},
			],
		});
		const { v } = view(s, at("13:00"), {}, "d1");
		const tpe = v.rest[0];
		expect(tpe).toMatchObject({ name: "Taoyuan (TPE)", tz: "Asia/Taipei" });
		expect(tpe?.departure?.tz).toBe(TOKYO);
		expect(hhmm(tpe?.departure?.depMs as number, TOKYO)).toBe("16:00");
		// The free time before boarding is in Tokyo's time, like the risk would be.
		expect(v.free).toMatchObject({ name: "CI 157", tz: TOKYO });
		expect(hhmm(v.free?.before as number, v.free?.tz as string)).toBe(
			t(tpe?.departure?.readyBy as number),
		);
	});
});

describe("computeToday: the end of the day", () => {
	it("nothing left: tomorrow's first stop, and where you sleep", () => {
		const all = Object.fromEntries(
			["cha", "broadway", "yodobashi", "bic", "dinner", "bar", "gai"].map(
				(k, i) => [k, done(`1${i}:00`)],
			),
		);
		const s = tokyoDay({ ...all, gai: done("22:40") });
		const { v } = view(s, at("22:45"));
		expect(v.ended).toBe(true);
		expect(v.current).toBeNull();
		expect(v.next).toBeNull();
		expect(v.done).toHaveLength(7);
		expect(v.tonight?.name).toBe("Hotel Gracery");
		expect(v.tomorrow).toMatchObject({
			dayId: s.D.d2,
			date: "2027-10-06",
			itemId: s.I.meiji,
			name: "Meiji Jingu",
		});
		expect(t(v.tomorrow?.start as number)).toBe("09:25");
		expect(t(v.tomorrow?.leaveBy as number)).toBe("09:00");
	});
});

describe("todayDayId", () => {
	it("the trip day whose date it is there; none outside the trip", () => {
		const s = tokyoDay();
		const ix = indexGraph(s.graph);
		const schedule = computeSchedule(ix);
		expect(todayDayId(ix, schedule, at("12:00"))).toBe(s.D.d1);
		expect(todayDayId(ix, schedule, at("00:30", "2027-10-06"))).toBe(s.D.d2);
		expect(todayDayId(ix, schedule, at("12:00", "2027-09-01"))).toBeNull();
	});

	it("stays on yesterday while its plan runs past midnight", () => {
		const s = scenario({
			firstDate: DAY,
			days: [
				{ items: [{ k: "late", node: "itoya", pin: "23:30", min: 90 }] },
				{ items: [{ k: "next", node: "sensoji", min: 60 }] },
			],
		});
		const ix = indexGraph(s.graph);
		const schedule = computeSchedule(ix);
		expect(todayDayId(ix, schedule, at("00:40", "2027-10-06"))).toBe(s.D.d1);
		expect(todayDayId(ix, schedule, at("01:10", "2027-10-06"))).toBe(s.D.d2);
	});

	it("past midnight the day runs on: still there, and a Done after midnight is its own time", () => {
		const late = (mark?: LocalAt) =>
			scenario({
				firstDate: DAY,
				days: [
					{
						items: [
							{ k: "sensoji", node: "sensoji", min: 60, done: done("22:50") },
							{ k: "late", node: "itoya", pin: "23:30", min: 90, done: mark },
						],
					},
					{ items: [{ k: "next", node: "sensoji", min: 60 }] },
				],
			});
		const { v } = view(late(), at("00:40", "2027-10-06"));
		expect(t(v.done[0]?.doneAt as number)).toBe("22:50");
		expect(v.current?.name).toBe("Itoya Ginza");
		expect(t(v.current?.start as number)).toBe("23:30");
		expect(t(v.current?.end as number)).toBe("01:00");
		const { v: v2 } = view(
			late(done("00:20", "2027-10-06")),
			at("00:40", "2027-10-06"),
		);
		expect(t(v2.done[1]?.doneAt as number)).toBe("00:20");
		expect(v2.ended).toBe(true);
	});
});

describe("stopHere", () => {
	it("“Looks like you're at Bic Camera?” while Yodobashi isn't Done", () => {
		const s = tokyoDay({ cha: done("09:50"), broadway: done("14:30") });
		const { ix, v } = view(s, at("16:40"));
		expect(stopHere(ix, v, [139.7006, 35.6918])?.name).toBe("Bic Camera");
		// Still at Yodobashi, or nowhere on the plan: nothing to ask.
		expect(stopHere(ix, v, [139.6975, 35.6905])).toBeNull();
		expect(stopHere(ix, v, [139.8, 35.6])).toBeNull();
	});

	it("Yes: Yodobashi Done as you left it, the walk ago, makes Bic Camera Now at once", () => {
		const s = tokyoDay({
			cha: done("09:50"),
			broadway: done("14:30"),
			yodobashi: done("16:35"),
		});
		const { v } = view(s, at("16:40"));
		expect(v.current?.name).toBe("Bic Camera");
		expect(t(v.current?.start as number)).toBe("16:40");
	});
});
