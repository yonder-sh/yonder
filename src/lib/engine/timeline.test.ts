import "./__fixtures__/host-tz";
import { Temporal } from "temporal-polyfill";
import { describe, expect, it } from "vitest";
import { nodes, timeline } from "./__fixtures__/asia-trip";
import { createHierarchy } from "./hierarchy";
import {
	type ComputedItem,
	type ComputedLeg,
	computeTimeline,
	type TimelineInput,
	TimelineInputError,
	type TimelineIssue,
	type TimelineOptions,
	type TimelineResult,
} from "./timeline";

const h = createHierarchy(nodes);
const real = computeTimeline(timeline, h);

const itemOf = (r: TimelineResult, id: string): ComputedItem => {
	const found = r.items.find((i) => i.id === id);
	if (!found) throw new Error(`no item ${id}`);
	return found;
};
const legOf = (r: TimelineResult, id: string): ComputedLeg => {
	const found = r.legs.find((l) => l.id === id);
	if (!found) throw new Error(`no leg ${id}`);
	return found;
};
const dayOf = (r: TimelineResult, id: string) => {
	const found = r.days.find((d) => d.id === id);
	if (!found) throw new Error(`no day ${id}`);
	return found;
};
const span = (i: ComputedItem) => `${i.start.time}-${i.end.time}`;
const codes = (issues: TimelineIssue[]) => issues.map((i) => i.code);
const run = (input: TimelineInput, options?: TimelineOptions) =>
	computeTimeline(input, h, options);

describe("real trip: whole-timeline invariants", () => {
	it("has no conflicts: one warning (Golden Gai past midnight) and one info (early start for the train)", () => {
		expect(real.issues).toEqual([
			expect.objectContaining({
				code: "overflows-midnight",
				severity: "warning",
				dayId: "d3",
				itemId: "golden-gai",
				minutes: 45,
			}),
			expect.objectContaining({
				code: "day-start-moved-earlier",
				severity: "info",
				dayId: "d5",
			}),
		]);
		expect(real.issues[1]?.message).toContain("08:00");
		expect(real.issues[1]?.message).toContain("Fuji Excursion 7");
	});

	it("keeps sequence order and wires legs to items", () => {
		expect(real.items.map((i) => i.sequence)).toEqual(
			real.items.map((_, n) => n),
		);
		expect(real.legs).toHaveLength(timeline.legs?.length ?? 0);
		expect(itemOf(real, "ewr-checkin").outgoingLegId).toBe("L-ewr-hnd");
		expect(itemOf(real, "hnd-arrival").incomingLegId).toBe("L-ewr-hnd");
		expect(itemOf(real, "d3-lunch").incomingLegId).toBeNull(); // no leg from Nakano to lunch
		for (let n = 1; n < real.items.length; n++) {
			const prev = real.items[n - 1] as ComputedItem;
			const cur = real.items[n] as ComputedItem;
			expect(cur.start.epochMs).toBeGreaterThanOrEqual(prev.end.epochMs);
		}
	});

	it("is plain JSON-serializable data", () => {
		expect(JSON.parse(JSON.stringify(real))).toEqual(real);
	});

	it("does not depend on the host time zone", () => {
		// __fixtures__/host-tz sets the process zone to UTC+14 on purpose.
		expect(process.env.TZ).toBe("Pacific/Kiritimati");
		expect(new Date(Date.UTC(2027, 9, 8)).getTimezoneOffset()).toBe(-840);
		expect(itemOf(real, "hnd-arrival").start.local).toBe("2027-10-08T13:55");
	});
});

describe("real trip: flights across time zones", () => {
	it("EWR -> HND: departs in EDT, lands the next local date in JST", () => {
		const l = legOf(real, "L-ewr-hnd");
		expect(l.depart.local).toBe("2027-10-07T10:55");
		expect(l.depart.offset).toBe("-04:00");
		expect(l.depart.timezone).toBe("America/New_York");
		expect(l.arrive.local).toBe("2027-10-08T13:55");
		expect(l.arrive.timezone).toBe("Asia/Tokyo");
		expect(l.arrive.dayOffset).toBe(1);
		expect(l.durationMin).toBe(14 * 60);
		expect(l.timezoneShiftMin).toBe(13 * 60);
		expect(l.waitBeforeMin).toBe(25); // check-in 08:30-10:30, departs 10:55
		expect(l.scheduled).toBe(true);
		expect(l.crossesDays).toBe(true);
		expect([l.fromDayId, l.toDayId]).toEqual(["d0", "d1"]);
	});

	it("KIX -> ICN: same UTC offset, different zone", () => {
		const l = legOf(real, "L-kix-icn");
		expect(l.depart.local).toBe("2027-10-17T10:05");
		expect(l.depart.timezone).toBe("Asia/Tokyo");
		expect(l.arrive.local).toBe("2027-10-17T12:05");
		expect(l.arrive.timezone).toBe("Asia/Seoul");
		expect(l.timezoneShiftMin).toBe(0);
		expect(l.durationMin).toBe(120);
		expect(itemOf(real, "icn-arrival").timezone).toBe("Asia/Seoul");
		expect(span(itemOf(real, "icn-arrival"))).toBe("12:05-13:05");
	});

	it("PUS -> SGN: Korea (+9) to Vietnam (+7) is -2h", () => {
		const l = legOf(real, "L-pus-sgn");
		expect(`${l.depart.time}${l.depart.offset}`).toBe("10:25+09:00");
		expect(`${l.arrive.time}${l.arrive.offset}`).toBe("13:20+07:00");
		expect(l.durationMin).toBe(4 * 60 + 55);
		expect(l.timezoneShiftMin).toBe(-120);
		expect(itemOf(real, "sgn-arrival").start.local).toBe("2027-10-22T13:20");
		expect(itemOf(real, "ben-thanh").timezone).toBe("Asia/Ho_Chi_Minh");
		expect(span(itemOf(real, "ben-thanh"))).toBe("14:50-16:20");
	});

	it("HAN -> TPE: +1h", () => {
		const l = legOf(real, "L-han-tpe");
		expect(l.durationMin).toBe(175);
		expect(l.timezoneShiftMin).toBe(60);
		expect(l.waitBeforeMin).toBe(100);
		expect(span(itemOf(real, "ximending-dinner"))).toBe("19:55-21:25");
	});

	it("TPE -> EWR lands after the US DST change (EST, not EDT)", () => {
		const l = legOf(real, "L-tpe-ewr");
		expect(l.depart.local).toBe("2027-11-06T22:30");
		expect(l.arrive.local).toBe("2027-11-07T13:40");
		expect(l.arrive.offset).toBe("-05:00");
		expect(l.durationMin).toBe(28 * 60 + 10);
		expect(l.timezoneShiftMin).toBe(-13 * 60);
		expect(itemOf(real, "ewr-checkin").start.offset).toBe("-04:00");
		expect(itemOf(real, "ewr-arrival").start.offset).toBe("-05:00");
	});

	it("Seoul -> Ho Chi Minh with departure + duration only (arrival derived in the destination zone)", () => {
		const r = run({
			days: [
				{
					id: "d",
					date: "2027-10-22",
					items: [
						{
							id: "icn",
							nodeId: "icn",
							title: "ICN",
							durationMin: 60,
							pinnedStart: "07:30",
						},
						{ id: "sgn", nodeId: "sgn", title: "SGN", durationMin: 30 },
					],
				},
			],
			legs: [
				{
					id: "f",
					fromItemId: "icn",
					toItemId: "sgn",
					mode: "flight",
					durationMin: 330,
					departure: { at: "09:00" },
				},
			],
		});
		const l = legOf(r, "f");
		expect(`${l.depart.time} ${l.depart.timezone}`).toBe("09:00 Asia/Seoul");
		expect(`${l.arrive.time} ${l.arrive.timezone}`).toBe(
			"12:30 Asia/Ho_Chi_Minh",
		);
		expect(l.timezoneShiftMin).toBe(-120);
		expect(r.issues).toEqual([]);
	});

	it("honours explicit endpoint zones on the leg (nodeless airport items)", () => {
		const r = run({
			days: [
				{
					id: "d",
					date: "2027-10-17",
					timezone: "Asia/Tokyo",
					items: [
						{ id: "a", title: "Lounge", durationMin: 60, pinnedStart: "08:00" },
						{ id: "b", title: "Taxi queue", durationMin: 30 },
					],
				},
			],
			legs: [
				{
					id: "f",
					fromItemId: "a",
					toItemId: "b",
					mode: "flight",
					departure: { at: "10:05", timezone: "Asia/Tokyo" },
					arrival: { at: "12:05", timezone: "Asia/Seoul" },
				},
			],
		});
		const b = itemOf(r, "b");
		expect(b.timezone).toBe("Asia/Seoul");
		expect(b.timezoneSource).toBe("leg");
		expect(span(b)).toBe("12:05-12:35");
		expect(itemOf(r, "a").timezoneSource).toBe("day");
	});
});

describe("real trip: day scheduling", () => {
	it("day 1 is anchored by the arrival, not by 09:00", () => {
		const d1 = dayOf(real, "d1");
		expect(d1.plannedStart).toBeNull();
		expect(d1.start?.local).toBe("2027-10-08T13:55");
		expect(d1.items.map(span)).toEqual([
			"13:55-14:55",
			"15:05-15:50",
			"16:40-17:10",
			"17:30-18:30",
			"18:35-20:05",
			"20:25-20:55",
		]);
	});

	it("a pinned item after a walk opens a gap (Shibuya Sky sunset slot)", () => {
		const sky = itemOf(real, "sky");
		expect(sky.pinned).toBe(true);
		expect(sky.gapBeforeMin).toBe(15);
		expect(legOf(real, "L-crossing-sky").arrive.time).toBe("17:15");
	});

	it("nodeless items inherit the carried zone", () => {
		const dinner = itemOf(real, "d1-dinner");
		expect(dinner.timezone).toBe("Asia/Tokyo");
		expect(dinner.timezoneSource).toBe("carried");
		expect(itemOf(real, "drive-home").timezone).toBe("America/New_York");
		expect(itemOf(real, "d3-breakfast").timezoneSource).toBe("carried");
	});

	it("summarizes days (activity / transit / idle), overnight legs belong to the departure day", () => {
		const d1 = dayOf(real, "d1");
		expect(d1.activityMin).toBe(315);
		expect(d1.transitMin).toBe(90);
		expect(d1.idleMin).toBe(15);
		expect(d1.legs.map((l) => l.id)).not.toContain("L-ewr-hnd");
		expect(dayOf(real, "d0").legs.map((l) => l.id)).toEqual(["L-ewr-hnd"]);
		expect(dayOf(real, "d22").legs.map((l) => l.id)).toEqual([
			"L-dinner-station",
			"L-night-train",
		]);
		expect(dayOf(real, "d22").transitMin).toBe(20); // the night train is not counted as the day's transit
		expect(dayOf(real, "d23").legs.map((l) => l.id)).toEqual(["L-laocai-sapa"]);
	});

	it("day 3 (Nakano + Shinjuku): pinned dinner and bar, then Golden Gai past midnight", () => {
		const d3 = dayOf(real, "d3");
		expect(d3.items.map(span)).toEqual([
			"09:00-09:30",
			"09:45-12:15",
			"12:15-13:15",
			"13:35-15:35",
			"18:30-20:00",
			"21:00-22:00",
			"22:15-00:45",
		]);
		expect(itemOf(real, "omoide").gapBeforeMin).toBe(165);
		expect(itemOf(real, "benfiddich").gapBeforeMin).toBe(50);
		const gg = itemOf(real, "golden-gai");
		expect(gg.crossesMidnight).toBe(true);
		expect(gg.end.local).toBe("2027-10-11T00:45");
		expect(gg.end.dayOffset).toBe(1);
		expect(d3.overflowsMidnight).toBe(true);
		expect(d3.overflowMin).toBe(45);
		expect(d3.idleMin).toBe(165 + 50);
		expect(codes(d3.issues)).toEqual(["overflows-midnight"]);
		expect(dayOf(real, "d1").overflowsMidnight).toBe(false);
	});

	it("day 5: breakfast is back-scheduled before the 08:30 Fuji Excursion", () => {
		const d5 = dayOf(real, "d5");
		expect(d5.plannedStart?.time).toBe("08:00");
		expect(span(itemOf(real, "d5-breakfast"))).toBe("08:00-08:30");
		const train = legOf(real, "L-fuji-excursion");
		expect(train.scheduled).toBe(true);
		expect(`${train.depart.time}-${train.arrive.time}`).toBe("08:30-10:26");
		expect(train.durationMin).toBe(116);
		expect(train.waitBeforeMin).toBe(0);
		expect(span(itemOf(real, "kaiseki"))).toBe("18:00-20:00");
		expect(codes(d5.issues)).toEqual(["day-start-moved-earlier"]);
	});

	it("day 6: a pinned sunrise first item starts the day early without conflict", () => {
		const d6 = dayOf(real, "d6");
		expect(d6.plannedStart?.time).toBe("05:30");
		expect(span(itemOf(real, "chureito"))).toBe("05:30-07:00");
		expect(itemOf(real, "chureito").gapBeforeMin).toBe(0);
		expect(d6.issues).toEqual([]);
	});

	it("explicit day start times are used", () => {
		expect(dayOf(real, "d10").plannedStart?.local).toBe("2027-10-17T06:45");
		expect(span(itemOf(real, "namba-checkout"))).toBe("06:45-07:15");
		expect(span(itemOf(real, "busan-checkout"))).toBe("07:00-07:30");
	});

	it("a pinned first item (evening) does not create a phantom gap from 09:00", () => {
		const d22 = dayOf(real, "d22");
		expect(d22.plannedStart?.time).toBe("19:00");
		expect(itemOf(real, "hanoi-dinner").gapBeforeMin).toBe(0);
		// No phantom 09:00-19:00 gap; the only idle time is the 20 min wait for the night train.
		expect(d22.idleMin).toBe(20);
	});

	it("overnight train: departs 21:40, arrival '05:30' resolves to the next date and anchors day 23", () => {
		const train = legOf(real, "L-night-train");
		expect(train.depart.local).toBe("2027-10-29T21:40");
		expect(train.arrive.local).toBe("2027-10-30T05:30");
		expect(train.durationMin).toBe(7 * 60 + 50);
		expect(train.waitBeforeMin).toBe(20);
		expect(train.crossesDays).toBe(true);
		expect(dayOf(real, "d22").overflowsMidnight).toBe(false); // being on a night train is not an overflow
		const d23 = dayOf(real, "d23");
		expect(d23.plannedStart).toBeNull();
		expect(d23.items.map(span)).toEqual(["05:30-06:00", "07:00-08:00"]);
	});

	it("flight departure wait: 09:50 check-in end to 10:25 departure", () => {
		expect(legOf(real, "L-pus-sgn").waitBeforeMin).toBe(35);
		expect(dayOf(real, "d15").idleMin).toBe(35);
	});
});

// ---------------------------------------------------------------------------
// Synthetic edge cases (on the real hierarchy)
// ---------------------------------------------------------------------------

describe("pins: gaps and conflicts", () => {
	it("reports an overlap when a pin is earlier than the previous item ends; later items don't cascade", () => {
		const r = run({
			days: [
				{
					id: "d",
					date: "2027-10-09",
					startTime: "09:00", // explicit: no back-scheduling to make room
					items: [
						{
							id: "a",
							nodeId: "kappabashi",
							title: "Kappabashi",
							durationMin: 180,
						},
						{
							id: "b",
							nodeId: "sensoji",
							title: "Senso-ji",
							durationMin: 60,
							pinnedStart: "10:00",
						},
						{
							id: "c",
							nodeId: "sensoji",
							title: "Nakamise snacks",
							durationMin: 30,
						},
					],
				},
			],
		});
		expect(span(itemOf(r, "a"))).toBe("09:00-12:00");
		expect(span(itemOf(r, "b"))).toBe("10:00-11:00");
		expect(itemOf(r, "b").overlapMin).toBe(120);
		expect(span(itemOf(r, "c"))).toBe("12:00-12:30");
		expect(r.issues).toEqual([
			expect.objectContaining({
				code: "overlap",
				severity: "conflict",
				itemId: "b",
				minutes: 120,
			}),
		]);
		expect(r.issues[0]?.message).toContain("Kappabashi");
	});

	it("reports an overlap when an incoming leg arrives after the pinned start", () => {
		const r = run({
			days: [
				{
					id: "d",
					date: "2027-10-09",
					items: [
						{
							id: "a",
							nodeId: "sensoji",
							title: "Senso-ji",
							durationMin: 60,
							pinnedStart: "09:00",
						},
						{
							id: "b",
							nodeId: "shibuya-sky",
							title: "Shibuya Sky",
							durationMin: 60,
							pinnedStart: "10:00",
						},
					],
				},
			],
			legs: [
				{
					id: "l",
					fromItemId: "a",
					toItemId: "b",
					mode: "transit",
					durationMin: 40,
					label: "Ginza line",
				},
			],
		});
		expect(itemOf(r, "b").overlapMin).toBe(40);
		expect(r.issues[0]).toMatchObject({ code: "overlap", minutes: 40 });
		expect(r.issues[0]?.message).toContain("Ginza line");
	});

	it("accepts full-datetime pins after midnight", () => {
		const r = run({
			days: [
				{
					id: "d",
					date: "2027-10-10",
					items: [
						{
							id: "a",
							nodeId: "golden-gai",
							title: "Golden Gai",
							durationMin: 120,
							pinnedStart: "22:00",
						},
						{
							id: "b",
							nodeId: "omoide-yokocho",
							title: "Late ramen",
							durationMin: 45,
							pinnedStart: "2027-10-11T00:30",
						},
					],
				},
			],
		});
		const b = itemOf(r, "b");
		expect(b.start.local).toBe("2027-10-11T00:30");
		expect(b.start.dayOffset).toBe(1);
		expect(b.gapBeforeMin).toBe(30);
		expect(b.crossesMidnight).toBe(false); // starts after midnight
		expect(dayOf(r, "d").overflowMin).toBe(75);
	});

	it("slack 'before-leg' leaves late instead of waiting at the destination", () => {
		const r = computeTimeline(timeline, h, { slack: "before-leg" });
		const l = legOf(r, "L-crossing-sky");
		expect(`${l.depart.time}-${l.arrive.time}`).toBe("17:25-17:30");
		expect(l.waitBeforeMin).toBe(15);
		expect(itemOf(r, "sky").gapBeforeMin).toBe(0);
		expect(dayOf(r, "d1").idleMin).toBe(15); // idle time moves, it doesn't vanish
		expect(legOf(r, "L-yodobashi-omoide").depart.time).toBe("18:20");
	});

	it("an ending exactly at midnight is not an overflow", () => {
		const r = run({
			days: [
				{
					id: "d",
					date: "2027-10-10",
					items: [
						{
							id: "a",
							nodeId: "golden-gai",
							title: "Golden Gai",
							durationMin: 120,
							pinnedStart: "22:00",
						},
					],
				},
			],
		});
		expect(itemOf(r, "a").end.local).toBe("2027-10-11T00:00");
		expect(itemOf(r, "a").crossesMidnight).toBe(false);
		expect(dayOf(r, "d").overflowsMidnight).toBe(false);
		expect(r.issues).toEqual([]);
	});
});

describe("day start rules", () => {
	it("back-schedules leading items before a pinned tour (default start only)", () => {
		const r = run({
			days: [
				{
					id: "d",
					date: "2027-10-09",
					items: [
						{
							id: "bf",
							title: "Breakfast",
							durationMin: 60,
							timezone: "Asia/Tokyo",
						},
						{
							id: "tour",
							nodeId: "jal-sky-museum",
							title: "JAL Sky Museum tour",
							durationMin: 120,
							pinnedStart: "08:00",
						},
					],
				},
			],
			legs: [
				{
					id: "l",
					fromItemId: "bf",
					toItemId: "tour",
					mode: "walk",
					durationMin: 10,
				},
			],
		});
		expect(dayOf(r, "d").plannedStart?.time).toBe("06:50");
		expect(span(itemOf(r, "bf"))).toBe("06:50-07:50");
		expect(itemOf(r, "tour").gapBeforeMin).toBe(0);
		expect(r.issues).toEqual([
			expect.objectContaining({
				code: "day-start-moved-earlier",
				severity: "info",
			}),
		]);
		expect(r.issues[0]?.message).toContain("JAL Sky Museum tour");
	});

	it("without explicit start, a long first item before a pin moves the day earlier instead of conflicting", () => {
		const r = run({
			days: [
				{
					id: "d",
					date: "2027-10-09",
					items: [
						{
							id: "a",
							nodeId: "kappabashi",
							title: "Kappabashi",
							durationMin: 180,
						},
						{
							id: "b",
							nodeId: "sensoji",
							title: "Senso-ji",
							durationMin: 60,
							pinnedStart: "10:00",
						},
					],
				},
			],
		});
		expect(span(itemOf(r, "a"))).toBe("07:00-10:00");
		expect(codes(r.issues)).toEqual(["day-start-moved-earlier"]);
	});

	it("does not move the day when leading items fit after 09:00 (gap before the pin instead)", () => {
		const r = run({
			days: [
				{
					id: "d",
					date: "2027-10-09",
					items: [
						{
							id: "a",
							nodeId: "kappabashi",
							title: "Kappabashi",
							durationMin: 60,
						},
						{
							id: "b",
							nodeId: "sensoji",
							title: "Senso-ji",
							durationMin: 60,
							pinnedStart: "11:00",
						},
					],
				},
			],
		});
		expect(span(itemOf(r, "a"))).toBe("09:00-10:00");
		expect(itemOf(r, "b").gapBeforeMin).toBe(60);
		expect(r.issues).toEqual([]);
	});

	it("does not back-schedule when the start time is explicit: the collision is a conflict", () => {
		const r = run({
			days: [
				{
					id: "d",
					date: "2027-10-09",
					startTime: "07:30",
					items: [
						{ id: "bf", nodeId: "haneda", title: "Breakfast", durationMin: 60 },
						{
							id: "tour",
							nodeId: "jal-sky-museum",
							title: "JAL Sky Museum tour",
							durationMin: 120,
							pinnedStart: "08:00",
						},
					],
				},
			],
		});
		expect(span(itemOf(r, "bf"))).toBe("07:30-08:30");
		expect(r.issues).toEqual([
			expect.objectContaining({ code: "overlap", itemId: "tour", minutes: 30 }),
		]);
	});

	it("warns when a pinned first item is before an explicit start (not a conflict)", () => {
		const r = run({
			days: [
				{
					id: "d",
					date: "2027-10-13",
					startTime: "09:00",
					items: [
						{
							id: "a",
							nodeId: "chureito",
							title: "Sunrise",
							durationMin: 60,
							pinnedStart: "05:30",
						},
					],
				},
			],
		});
		expect(span(itemOf(r, "a"))).toBe("05:30-06:30");
		expect(r.issues).toEqual([
			expect.objectContaining({
				code: "before-day-start",
				severity: "warning",
				minutes: 210,
			}),
		]);
	});

	it("pushes the next day's start when the previous day overflows past it", () => {
		const r = run({
			days: [
				{
					id: "d1",
					date: "2027-10-10",
					items: [
						{
							id: "karaoke",
							nodeId: "shinjuku",
							title: "All-night karaoke",
							durationMin: 720,
							pinnedStart: "22:00",
						},
					],
				},
				{
					id: "d2",
					date: "2027-10-11",
					items: [{ id: "bf", title: "Breakfast", durationMin: 30 }],
				},
			],
		});
		expect(dayOf(r, "d1").overflowMin).toBe(600);
		expect(itemOf(r, "bf").start.local).toBe("2027-10-11T10:00");
		expect(codes(r.issues)).toEqual(["overflows-midnight", "day-start-pushed"]);
		expect(dayOf(r, "d2").issues).toEqual([
			expect.objectContaining({ code: "day-start-pushed", minutes: 60 }),
		]);
	});

	it("back-scheduling never goes before the previous activity's end", () => {
		const r = run({
			days: [
				{
					id: "d1",
					date: "2027-10-10",
					items: [
						{
							id: "late",
							nodeId: "shinjuku",
							title: "Late night",
							durationMin: 570,
							pinnedStart: "22:00",
						},
					], // until 07:30
				},
				{
					id: "d2",
					date: "2027-10-11",
					items: [
						{ id: "bf", title: "Breakfast", durationMin: 60 },
						{
							id: "tour",
							nodeId: "jal-sky-museum",
							title: "Tour",
							durationMin: 60,
							pinnedStart: "08:00",
						},
					],
				},
			],
		});
		expect(dayOf(r, "d2").plannedStart?.time).toBe("07:00");
		expect(span(itemOf(r, "bf"))).toBe("07:30-08:30");
		expect(itemOf(r, "tour").overlapMin).toBe(30);
		expect(codes(dayOf(r, "d2").issues)).toEqual([
			"day-start-moved-earlier",
			"day-start-pushed",
			"overlap",
		]);
	});

	it("explicit start after an overnight arrival leaves a gap; a late arrival pushes the start", () => {
		const base = (startTime: string, arrival: string): TimelineInput => ({
			days: [
				{
					id: "d1",
					date: "2027-10-29",
					items: [
						{
							id: "st",
							nodeId: "hanoi-station",
							title: "Station",
							durationMin: 30,
							pinnedStart: "21:00",
						},
					],
				},
				{
					id: "d2",
					date: "2027-10-30",
					startTime,
					items: [
						{
							id: "arr",
							nodeId: "lao-cai-station",
							title: "Arrive",
							durationMin: 30,
						},
					],
				},
			],
			legs: [
				{
					id: "t",
					fromItemId: "st",
					toItemId: "arr",
					mode: "transit",
					departure: { at: "21:40" },
					arrival: { at: arrival },
				},
			],
		});
		const early = run(base("07:00", "05:30"));
		expect(span(itemOf(early, "arr"))).toBe("07:00-07:30");
		expect(itemOf(early, "arr").gapBeforeMin).toBe(90);
		expect(early.issues).toEqual([]);
		const late = run(base("07:00", "08:15"));
		expect(span(itemOf(late, "arr"))).toBe("08:15-08:45");
		expect(late.issues).toEqual([
			expect.objectContaining({ code: "day-start-pushed", minutes: 75 }),
		]);
		expect(late.issues[0]?.message).toContain("arrives 08:15");
	});

	it("supports a custom default start time", () => {
		const r = run(
			{
				days: [
					{
						id: "d",
						date: "2027-10-09",
						items: [
							{
								id: "a",
								nodeId: "sensoji",
								title: "Senso-ji",
								durationMin: 60,
							},
						],
					},
				],
			},
			{ defaultStartTime: "7:15" },
		);
		expect(itemOf(r, "a").start.time).toBe("07:15");
	});

	it("handles empty days, including an overnight flight spanning one", () => {
		const r = run({
			days: [
				{
					id: "d1",
					date: "2027-10-06",
					items: [
						{
							id: "ewr",
							nodeId: "ewr",
							title: "EWR",
							durationMin: 120,
							pinnedStart: "22:00",
						},
					],
				},
				{ id: "air", date: "2027-10-07", items: [] },
				{
					id: "d3",
					date: "2027-10-08",
					items: [{ id: "hnd", nodeId: "hnd", title: "HND", durationMin: 60 }],
				},
			],
			legs: [
				{
					id: "f",
					fromItemId: "ewr",
					toItemId: "hnd",
					mode: "flight",
					departure: { at: "2027-10-07T01:00" },
					arrival: { at: "05:00" },
				},
			],
		});
		const air = dayOf(r, "air");
		expect(air.items).toEqual([]);
		expect(air.start).toBeNull();
		expect(air.end).toBeNull();
		expect(air.timezone).toBe("America/New_York"); // carried
		expect(air.plannedStart?.local).toBe("2027-10-07T09:00");
		const f = legOf(r, "f");
		expect(f.arrive.local).toBe("2027-10-08T05:00");
		expect(f.durationMin).toBe(15 * 60);
		expect(dayOf(r, "d1").legs.map((l) => l.id)).toEqual(["f"]);
		expect(air.legs).toEqual([]);
		expect(span(itemOf(r, "hnd"))).toBe("05:00-06:00");
	});
});

describe("time zones", () => {
	it("warns about a zone change without a transit leg (and still renders in the new zone)", () => {
		const r = run({
			days: [
				{
					id: "d",
					date: "2027-10-17",
					items: [
						{
							id: "osaka",
							nodeId: "dotonbori",
							title: "Dotonbori",
							durationMin: 60,
						},
						{
							id: "taipei",
							nodeId: "ximending",
							title: "Ximending",
							durationMin: 60,
						},
					],
				},
			],
		});
		const t = itemOf(r, "taipei");
		expect(t.timezone).toBe("Asia/Taipei");
		expect(t.start.local).toBe("2027-10-17T09:00"); // 10:00 JST == 09:00 CST
		expect(r.issues).toEqual([
			expect.objectContaining({
				code: "implicit-timezone-change",
				itemId: "taipei",
			}),
		]);
	});

	it("falls back to UTC with a warning when nothing has a zone; defaultTimezone silences it", () => {
		const input: TimelineInput = {
			days: [
				{
					id: "d",
					date: "2027-10-07",
					items: [
						{
							id: "a",
							nodeId: "us",
							title: "Somewhere in the US",
							durationMin: 60,
						},
					],
				},
			],
		};
		const r = run(input);
		expect(itemOf(r, "a").timezone).toBe("UTC");
		expect(itemOf(r, "a").timezoneSource).toBe("default");
		expect(codes(r.issues)).toEqual(["unknown-timezone"]);
		const r2 = run(input, { defaultTimezone: "America/Chicago" });
		expect(itemOf(r2, "a").timezone).toBe("America/Chicago");
		expect(r2.issues).toEqual([]);
	});

	it("looks ahead in the day when the first items have no zone and nothing is carried", () => {
		const r = run({
			days: [
				{
					id: "d",
					date: "2027-10-09",
					items: [
						{ id: "bf", title: "Breakfast", durationMin: 30 },
						{ id: "s", nodeId: "sensoji", title: "Senso-ji", durationMin: 60 },
					],
				},
			],
		});
		expect(itemOf(r, "bf").timezone).toBe("Asia/Tokyo");
		expect(r.issues).toEqual([]);
	});

	it("uses item and day overrides, and reports invalid zones", () => {
		const r = run({
			days: [
				{
					id: "d",
					date: "2027-10-09",
					timezone: "Asia/Seoul",
					items: [
						{ id: "a", title: "Nodeless", durationMin: 30 },
						{
							id: "b",
							title: "Override",
							durationMin: 30,
							timezone: "asia/tokyo",
						},
						{
							id: "c",
							nodeId: "sensoji",
							title: "Bad override",
							durationMin: 30,
							timezone: "Nowhere/Land",
						},
					],
				},
				{ id: "d2", date: "2027-10-10", timezone: "Bad/Zone", items: [] },
			],
		});
		expect(itemOf(r, "a").timezone).toBe("Asia/Seoul");
		expect(itemOf(r, "a").timezoneSource).toBe("day");
		expect(itemOf(r, "b").timezone).toBe("Asia/Tokyo");
		expect(itemOf(r, "b").timezoneSource).toBe("item");
		expect(itemOf(r, "c").timezoneSource).toBe("node");
		expect(
			codes(r.issues).filter((c) => c === "invalid-timezone"),
		).toHaveLength(2);
	});

	it("reports unknown nodes and carries the zone", () => {
		const r = run({
			days: [
				{
					id: "d",
					date: "2027-10-09",
					items: [
						{ id: "a", nodeId: "sensoji", title: "Senso-ji", durationMin: 30 },
						{
							id: "b",
							nodeId: "ghost",
							title: "Deleted place",
							durationMin: 30,
						},
					],
				},
			],
		});
		expect(itemOf(r, "b").timezone).toBe("Asia/Tokyo");
		expect(r.issues).toEqual([
			expect.objectContaining({ code: "unknown-node", itemId: "b" }),
		]);
	});
});

describe("DST (the US legs of the trip)", () => {
	it("an item across the fall-back hour keeps exact elapsed time", () => {
		const r = run({
			days: [
				{
					id: "d",
					date: "2027-11-07",
					items: [
						{
							id: "a",
							nodeId: "ewr",
							title: "Red-eye wait",
							durationMin: 120,
							pinnedStart: "00:30",
						},
					],
				},
			],
		});
		const a = itemOf(r, "a");
		expect(a.start.offset).toBe("-04:00");
		expect(a.end.offset).toBe("-05:00");
		expect(span(a)).toBe("00:30-01:30"); // two real hours, one repeated wall-clock hour
		expect(a.end.epochMs - a.start.epochMs).toBe(120 * 60_000);
	});

	it("flags an ambiguous pinned time (uses the earlier) and a nonexistent one (shifts forward)", () => {
		const r = run({
			days: [
				{
					id: "fall",
					date: "2027-11-07",
					items: [
						{
							id: "a",
							nodeId: "ewr",
							title: "a",
							durationMin: 10,
							pinnedStart: "01:30",
						},
					],
				},
				{
					id: "spring",
					date: "2028-03-12",
					items: [
						{
							id: "b",
							nodeId: "ewr",
							title: "b",
							durationMin: 10,
							pinnedStart: "02:30",
						},
					],
				},
			],
		});
		expect(itemOf(r, "a").start.offset).toBe("-04:00");
		expect(itemOf(r, "b").start.time).toBe("03:30");
		expect(r.issues.map((i) => `${i.code}:${i.severity}`)).toEqual([
			"ambiguous-local-time:info",
			"nonexistent-local-time:warning",
		]);
	});
});

describe("legs: validation and scheduling", () => {
	const twoItems = (
		legs: TimelineInput["legs"],
		pinned = "09:00",
	): TimelineInput => ({
		days: [
			{
				id: "d",
				date: "2027-10-17",
				items: [
					{
						id: "kix",
						nodeId: "kix",
						title: "KIX check-in",
						durationMin: 90,
						pinnedStart: pinned,
					},
					{ id: "icn", nodeId: "icn", title: "ICN arrival", durationMin: 60 },
				],
			},
		],
		legs,
	});

	it("reports a missed departure and continues from the scheduled arrival", () => {
		const r = run(
			twoItems(
				[
					{
						id: "f",
						fromItemId: "kix",
						toItemId: "icn",
						mode: "flight",
						departure: { at: "10:05" },
						arrival: { at: "12:05" },
						label: "KIX→ICN",
					},
				],
				"09:30",
			),
		);
		expect(r.issues).toEqual([
			expect.objectContaining({
				code: "missed-departure",
				severity: "conflict",
				legId: "f",
				itemId: "kix",
				minutes: 55,
			}),
		]);
		expect(legOf(r, "f").waitBeforeMin).toBe(0);
		expect(span(itemOf(r, "icn"))).toBe("12:05-13:05");
	});

	it("FB-19a: a 2 h JFK stop pinned 00:00 makes a 02:00 departure (no double buffer)", () => {
		// The owner's test trip: JFK 00:00 for 2 h on Sat 12 Dec 2026, the
		// flight to HND at 02:00. The timeline counts no airport buffer of its
		// own, so the stop ending at 02:00 is exactly in time.
		const r = run({
			days: [
				{
					id: "d1",
					date: "2026-12-12",
					startTime: "00:00",
					items: [
						{
							id: "jfk",
							title: "JFK",
							durationMin: 120,
							pinnedStart: "00:00",
							timezone: "America/New_York",
						},
					],
				},
				{
					id: "d2",
					date: "2026-12-13",
					items: [
						{
							id: "hnd",
							title: "HND",
							durationMin: 60,
							timezone: "Asia/Tokyo",
						},
					],
				},
			],
			legs: [
				{
					id: "nh",
					fromItemId: "jfk",
					toItemId: "hnd",
					mode: "flight",
					departure: { at: "02:00", timezone: "America/New_York" },
					arrival: { at: "2026-12-13T05:25", timezone: "Asia/Tokyo" },
					label: "NH 744",
				},
			],
		});
		expect(codes(r.issues)).not.toContain("missed-departure");
		expect(legOf(r, "nh").depart.offset).toBe("-05:00"); // EST in December
		expect(legOf(r, "nh").waitBeforeMin).toBe(0);
		expect(span(itemOf(r, "hnd"))).toBe("05:25-06:25");
	});

	it("warns on a duration that disagrees with the schedule (times win)", () => {
		const r = run(
			twoItems([
				{
					id: "f",
					fromItemId: "kix",
					toItemId: "icn",
					mode: "flight",
					durationMin: 90,
					departure: { at: "11:00" },
					arrival: { at: "13:00" },
				},
			]),
		);
		expect(legOf(r, "f").durationMin).toBe(120);
		expect(r.issues).toEqual([
			expect.objectContaining({ code: "duration-mismatch", minutes: 30 }),
		]);
		const ok = run(
			twoItems([
				{
					id: "f",
					fromItemId: "kix",
					toItemId: "icn",
					mode: "flight",
					durationMin: 117,
					departure: { at: "11:00" },
					arrival: { at: "13:00" },
				},
			]),
		);
		expect(ok.issues).toEqual([]);
	});

	it("reports an arrival before departure and falls back to the duration", () => {
		const r = run(
			twoItems([
				{
					id: "f",
					fromItemId: "kix",
					toItemId: "icn",
					mode: "flight",
					durationMin: 120,
					departure: { at: "11:00" },
					arrival: { at: "2027-10-17T10:00" },
				},
			]),
		);
		expect(codes(r.issues)).toEqual(["arrival-before-departure"]);
		expect(legOf(r, "f").arrive.time).toBe("13:00");
	});

	it("ignores an arrival without a departure", () => {
		const r = run(
			twoItems([
				{
					id: "f",
					fromItemId: "kix",
					toItemId: "icn",
					mode: "flight",
					durationMin: 120,
					arrival: { at: "13:00" },
				},
			]),
		);
		expect(codes(r.issues)).toEqual(["ignored-arrival"]);
		expect(legOf(r, "f").scheduled).toBe(false);
		expect(legOf(r, "f").depart.time).toBe("10:30");
	});

	it("reports missing / invalid durations and invalid times", () => {
		const r = run({
			days: [
				{
					id: "d",
					date: "2027-10-09",
					startTime: "25:00",
					items: [
						{ id: "a", nodeId: "sensoji", title: "a", durationMin: -5 },
						{
							id: "b",
							nodeId: "kappabashi",
							title: "b",
							durationMin: 30,
							pinnedStart: "lunchtime",
						},
						{ id: "c", nodeId: "kappabashi", title: "c", durationMin: 30 },
						{ id: "e", nodeId: "kappabashi", title: "e", durationMin: 89.6 },
					],
				},
			],
			legs: [
				{ id: "l1", fromItemId: "a", toItemId: "b", mode: "walk" },
				{
					id: "l2",
					fromItemId: "b",
					toItemId: "c",
					mode: "transit",
					departure: { at: "soon" },
					durationMin: 10,
				},
				{
					id: "l3",
					fromItemId: "c",
					toItemId: "e",
					mode: "walk",
					durationMin: 5,
					departure: { at: "11:00" },
					arrival: { at: "whenever" },
				},
			],
		});
		expect(codes(r.issues).sort()).toEqual(
			[
				"invalid-duration",
				"invalid-time",
				"invalid-time",
				"invalid-time",
				"invalid-time",
				"missing-duration",
			].sort(),
		);
		expect(itemOf(r, "a").durationMin).toBe(0);
		expect(itemOf(r, "b").pinned).toBe(false);
		expect(itemOf(r, "e").durationMin).toBe(90); // rounded to whole minutes
		expect(legOf(r, "l2").scheduled).toBe(false);
		expect(legOf(r, "l3").durationMin).toBe(5);
	});

	it("ignores legs that reference unknown or non-consecutive items, and duplicates", () => {
		const r = run({
			days: [
				{
					id: "d",
					date: "2027-10-09",
					items: [
						{ id: "a", nodeId: "sensoji", title: "a", durationMin: 30 },
						{ id: "b", nodeId: "kappabashi", title: "b", durationMin: 30 },
						{ id: "c", nodeId: "kappabashi", title: "c", durationMin: 30 },
					],
				},
			],
			legs: [
				{
					id: "ok",
					fromItemId: "a",
					toItemId: "b",
					mode: "walk",
					durationMin: 15,
				},
				{
					id: "dup",
					fromItemId: "a",
					toItemId: "b",
					mode: "transit",
					durationMin: 5,
				},
				{
					id: "skip",
					fromItemId: "a",
					toItemId: "c",
					mode: "walk",
					durationMin: 5,
				},
				{
					id: "back",
					fromItemId: "c",
					toItemId: "b",
					mode: "walk",
					durationMin: 5,
				},
				{
					id: "ghost",
					fromItemId: "a",
					toItemId: "zzz",
					mode: "walk",
					durationMin: 5,
				},
			],
		});
		expect(r.legs.map((l) => l.id)).toEqual(["ok"]);
		expect(r.issues.map((i) => `${i.code}:${i.legId}`)).toEqual([
			"duplicate-leg:dup",
			"leg-not-consecutive:skip",
			"leg-not-consecutive:back",
			"leg-unknown-item:ghost",
		]);
		expect(span(itemOf(r, "b"))).toBe("09:45-10:15");
	});

	it("zero-minute legs are fine", () => {
		expect(legOf(real, "L-ewr-home").durationMin).toBe(0);
		expect(span(itemOf(real, "drive-home"))).toBe("14:40-16:40");
	});
});

describe("input errors", () => {
	it("throws on duplicate ids and invalid dates/options", () => {
		const day = (
			id: string,
			items: TimelineInput["days"][number]["items"] = [],
		) => ({ id, date: "2027-10-09", items });
		expect(() => run({ days: [day("a"), day("a")] })).toThrow(
			TimelineInputError,
		);
		expect(() =>
			run({
				days: [
					day("a", [{ id: "x", title: "x", durationMin: 1 }]),
					day("b", [{ id: "x", title: "x", durationMin: 1 }]),
				],
			}),
		).toThrow(/duplicate item/);
		expect(() =>
			run({
				days: [
					day("a", [
						{ id: "x", title: "x", durationMin: 1 },
						{ id: "y", title: "y", durationMin: 1 },
					]),
				],
				legs: [
					{
						id: "l",
						fromItemId: "x",
						toItemId: "y",
						mode: "walk",
						durationMin: 1,
					},
					{
						id: "l",
						fromItemId: "x",
						toItemId: "y",
						mode: "walk",
						durationMin: 1,
					},
				],
			}),
		).toThrow(/duplicate leg/);
		expect(() =>
			run({ days: [{ id: "a", date: "2027-02-30", items: [] }] }),
		).toThrow(/invalid date/);
		expect(() => run({ days: [] }, { defaultStartTime: "9am" })).toThrow(
			/defaultStartTime/,
		);
		expect(() => run({ days: [] }, { defaultTimezone: "Mars/Base" })).toThrow(
			/defaultTimezone/,
		);
	});

	it("an empty timeline is fine", () => {
		expect(run({ days: [] })).toEqual({
			days: [],
			items: [],
			legs: [],
			issues: [],
		});
	});

	it("works with any resolver, not only a Hierarchy", () => {
		const r = computeTimeline(
			{
				days: [
					{
						id: "d",
						date: "2027-10-22",
						items: [{ id: "a", nodeId: "x", title: "x", durationMin: 60 }],
					},
				],
			},
			{
				resolveTimezone: (id) => (id === "x" ? "Asia/Ho_Chi_Minh" : undefined),
			},
		);
		expect(itemOf(r, "a").start.iso).toBe(
			"2027-10-22T09:00+07:00[Asia/Ho_Chi_Minh]",
		);
		expect(Temporal.ZonedDateTime.from(itemOf(r, "a").start.iso).hour).toBe(9);
	});
});

// ---------------------------------------------------------------------------
// Added during independent verification
// ---------------------------------------------------------------------------

describe("idle time before overnight legs", () => {
	it("the wait for a scheduled overnight leg is the departure day's idle time", () => {
		expect(dayOf(real, "d0").idleMin).toBe(25); // check-in ends 10:30, EWR→HND departs 10:55
		expect(dayOf(real, "d22").idleMin).toBe(20); // station 20:50-21:20, night train 21:40
		expect(dayOf(real, "d31").idleMin).toBe(30); // TPE check-in ends 22:00, departs 22:30
		expect(dayOf(real, "d23").idleMin).toBe(0); // not double-counted on the arrival day
		expect(dayOf(real, "d0").transitMin).toBe(0); // the flight itself is still not the day's transit
	});
});

describe("unscheduled legs between days (hotel -> breakfast)", () => {
	const input = (
		opts: { startTime?: string; pinned?: string; hotelMin?: number } = {},
	): TimelineInput => ({
		days: [
			{
				id: "a",
				date: "2027-10-09",
				items: [
					{
						id: "hotel",
						nodeId: "hotel-gracery",
						title: "Hotel",
						durationMin: opts.hotelMin ?? 30,
						pinnedStart: "20:00",
					},
				],
			},
			{
				id: "b",
				date: "2027-10-10",
				startTime: opts.startTime ?? null,
				items: [
					{
						id: "bf",
						nodeId: "omoide-yokocho",
						title: "Breakfast",
						durationMin: 30,
						pinnedStart: opts.pinned ?? null,
					},
					{
						id: "shop",
						nodeId: "yodobashi-shinjuku",
						title: "Yodobashi",
						durationMin: 60,
					},
				],
			},
		],
		legs: [
			{
				id: "walk",
				fromItemId: "hotel",
				toItemId: "bf",
				mode: "walk",
				durationMin: 10,
			},
		],
	});

	it("departs at the next day's planned start, not right after the previous evening", () => {
		const r = run(input());
		const walk = legOf(r, "walk");
		expect(`${walk.depart.local}-${walk.arrive.time}`).toBe(
			"2027-10-10T09:00-09:10",
		);
		expect(walk.crossesDays).toBe(true);
		expect(walk.scheduled).toBe(false);
		expect(itemOf(r, "bf").start.local).toBe("2027-10-10T09:10");
		expect(itemOf(r, "bf").start.dayOffset).toBe(0);
		expect(dayOf(r, "b").plannedStart?.local).toBe("2027-10-10T09:00");
		// It is the morning's walk: listed and counted on day b, not day a.
		expect(dayOf(r, "b").legs.map((l) => l.id)).toEqual(["walk"]);
		expect(dayOf(r, "b").transitMin).toBe(10);
		expect(dayOf(r, "a").legs).toEqual([]);
		expect(dayOf(r, "a").idleMin).toBe(0);
		expect(r.issues).toEqual([]);
	});

	it("honours an explicit start time", () => {
		const r = run(input({ startTime: "07:30" }));
		expect(legOf(r, "walk").depart.local).toBe("2027-10-10T07:30");
		expect(span(itemOf(r, "bf"))).toBe("07:40-08:10");
		expect(r.issues).toEqual([]);
	});

	it("leaves just in time for a pinned first item (no phantom gap)", () => {
		const r = run(input({ pinned: "10:00" }));
		expect(
			`${legOf(r, "walk").depart.time}-${legOf(r, "walk").arrive.time}`,
		).toBe("09:50-10:00");
		expect(itemOf(r, "bf").gapBeforeMin).toBe(0);
		expect(dayOf(r, "b").plannedStart?.time).toBe("09:50");
		expect(r.issues).toEqual([]);
		// An early pin moves the departure before an explicit start (warning, not a conflict).
		const early = run(input({ startTime: "09:00", pinned: "07:00" }));
		expect(legOf(early, "walk").depart.time).toBe("06:50");
		expect(codes(early.issues)).toEqual(["before-day-start"]);
	});

	it("is pushed (with a warning) when the previous day runs past the planned start", () => {
		const r = run(input({ hotelMin: 900 })); // 20:00 -> 11:00 next day
		expect(legOf(r, "walk").depart.local).toBe("2027-10-10T11:00");
		expect(codes(r.issues)).toEqual(["overflows-midnight", "day-start-pushed"]);
		expect(dayOf(r, "b").issues[0]).toMatchObject({
			code: "day-start-pushed",
			minutes: 120,
		});
	});
});

describe("time zone crossing: more cases", () => {
	it("measures midnight overflow in the zone where the day ends (east: HAN -> TPE is +1h)", () => {
		const r = run({
			days: [
				{
					id: "d",
					date: "2027-11-04",
					items: [
						{
							id: "han",
							nodeId: "han",
							title: "HAN check-in",
							durationMin: 60,
							pinnedStart: "20:00",
						},
						{ id: "tpe", nodeId: "tpe", title: "Arrive TPE", durationMin: 30 },
					],
				},
			],
			legs: [
				{
					id: "f",
					fromItemId: "han",
					toItemId: "tpe",
					mode: "flight",
					departure: { at: "21:00" },
					arrival: { at: "00:20" },
				},
			],
		});
		expect(legOf(r, "f").arrive.local).toBe("2027-11-05T00:20");
		expect(legOf(r, "f").durationMin).toBe(140);
		const tpe = itemOf(r, "tpe");
		expect(tpe.end.local).toBe("2027-11-05T00:50"); // 23:50 in Hanoi, but the day ends in Taipei
		expect(tpe.start.dayOffset).toBe(1);
		expect(dayOf(r, "d").overflowMin).toBe(50);
	});

	it("measures midnight overflow in the zone where the day ends (west: TPE -> HAN is -1h)", () => {
		const r = run({
			days: [
				{
					id: "d",
					date: "2027-11-04",
					items: [
						{
							id: "tpe",
							nodeId: "tpe",
							title: "TPE check-in",
							durationMin: 60,
							pinnedStart: "21:00",
						},
						{ id: "han", nodeId: "han", title: "Arrive HAN", durationMin: 45 },
					],
				},
			],
			legs: [
				{
					id: "f",
					fromItemId: "tpe",
					toItemId: "han",
					mode: "flight",
					departure: { at: "22:00" },
					arrival: { at: "23:10" },
				},
			],
		});
		expect(legOf(r, "f").durationMin).toBe(130);
		expect(legOf(r, "f").timezoneShiftMin).toBe(-60);
		expect(itemOf(r, "han").end.local).toBe("2027-11-04T23:55"); // 00:55 in Taipei, but the day ends in Hanoi
		expect(dayOf(r, "d").overflowsMidnight).toBe(false);
		expect(r.issues).toEqual([]);
	});

	it("flags an arrival in the repeated fall-back hour at EWR (2027-11-07 01:30) and uses the earlier one", () => {
		const r = run({
			days: [
				{
					id: "a",
					date: "2027-11-06",
					items: [
						{
							id: "tpe",
							nodeId: "tpe",
							title: "TPE",
							durationMin: 60,
							pinnedStart: "22:00",
						},
					],
				},
				{
					id: "b",
					date: "2027-11-07",
					items: [{ id: "ewr", nodeId: "ewr", title: "EWR", durationMin: 60 }],
				},
			],
			legs: [
				{
					id: "f",
					fromItemId: "tpe",
					toItemId: "ewr",
					mode: "flight",
					departure: { at: "23:55" },
					arrival: { at: "01:30" },
				},
			],
		});
		const f = legOf(r, "f");
		expect(`${f.arrive.local}${f.arrive.offset}`).toBe(
			"2027-11-07T01:30-04:00",
		);
		expect(f.durationMin).toBe(13 * 60 + 35);
		expect(r.issues).toEqual([
			expect.objectContaining({
				code: "ambiguous-local-time",
				severity: "info",
				legId: "f",
				dayId: "a",
			}),
		]);
		// The arrival item runs through the repeated hour: 01:30 EDT -> 01:30 EST.
		expect(span(itemOf(r, "ewr"))).toBe("01:30-01:30");
		expect(itemOf(r, "ewr").end.offset).toBe("-05:00");
	});

	it("flags an arrival in the skipped spring-forward hour and shifts it forward", () => {
		const r = run({
			days: [
				{
					id: "a",
					date: "2028-03-11",
					items: [
						{
							id: "tpe",
							nodeId: "tpe",
							title: "TPE",
							durationMin: 60,
							pinnedStart: "18:00",
						},
					],
				},
				{
					id: "b",
					date: "2028-03-12",
					items: [{ id: "ewr", nodeId: "ewr", title: "EWR", durationMin: 60 }],
				},
			],
			legs: [
				{
					id: "f",
					fromItemId: "tpe",
					toItemId: "ewr",
					mode: "flight",
					departure: { at: "20:00" },
					arrival: { at: "2028-03-12T02:30" },
				},
			],
		});
		expect(`${legOf(r, "f").arrive.time}${legOf(r, "f").arrive.offset}`).toBe(
			"03:30-04:00",
		);
		expect(codes(r.issues)).toEqual(["nonexistent-local-time"]);
	});

	it("an 'HH:mm' arrival is the FIRST occurrence after departure: a >24h itinerary needs a full date", () => {
		const input = (at: string, durationMin?: number): TimelineInput => ({
			days: [
				{
					id: "a",
					date: "2027-11-06",
					items: [
						{
							id: "tpe",
							nodeId: "tpe",
							title: "TPE",
							durationMin: 120,
							pinnedStart: "20:00",
						},
					],
				},
				{
					id: "b",
					date: "2027-11-07",
					items: [{ id: "ewr", nodeId: "ewr", title: "EWR", durationMin: 60 }],
				},
			],
			legs: [
				{
					id: "f",
					fromItemId: "tpe",
					toItemId: "ewr",
					mode: "flight",
					departure: { at: "22:30" },
					arrival: { at },
					durationMin: durationMin ?? null,
				},
			],
		});
		// Bare "13:40" resolves to the same calendar day in New York (a 190 min "flight").
		const bare = run(input("13:40"));
		expect(legOf(bare, "f").arrive.local).toBe("2027-11-06T13:40");
		expect(legOf(bare, "f").durationMin).toBe(190);
		// ...which lands before day b even starts: flagged instead of silently accepted.
		expect(codes(bare.issues)).toEqual(["before-day-date"]);
		// A durationMin also catches it.
		expect(codes(run(input("13:40", 1690)).issues)).toEqual([
			"duration-mismatch",
			"before-day-date",
		]);
		// A full datetime is the fix.
		const dated = run(input("2027-11-07T13:40"));
		expect(legOf(dated, "f").durationMin).toBe(28 * 60 + 10);
		expect(dated.issues).toEqual([]);
	});
});
