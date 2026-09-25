import { describe, expect, it } from "vitest";
import { fromGooglePeriods, parseOpeningHours } from "./hours-parse";

/** "0-6 11:00-21:00" style summary: each distinct (open, close, lastEntry) with its days. */
function summary(text: string): string[] {
	const p = parseOpeningHours(text);
	if (!p.hours) return [];
	const groups = new Map<string, number[]>();
	for (const x of p.hours.periods) {
		const k = `${x.open}-${x.close}${x.lastEntry ? ` le${x.lastEntry}` : ""}`;
		groups.set(k, [...(groups.get(k) ?? []), x.day]);
	}
	return [...groups.entries()].map(([k, days]) => `${days.join(",")} ${k}`);
}

describe("parseOpeningHours: the EXTENSIONS §4.2 table", () => {
	it("11:00–21:00 daily", () => {
		const p = parseOpeningHours("11:00–21:00 daily");
		expect(summary("11:00–21:00 daily")).toEqual(["0,1,2,3,4,5,6 11:00-21:00"]);
		expect(p.confidence).toBe("high");
		expect(p.hours?.source).toBe("manual");
	});

	it("Mon–Sat 10:00–20:00; Sun/hol to 19:00", () => {
		const t = "Mon–Sat 10:00–20:00; Sun/hol to 19:00";
		expect(summary(t)).toEqual(["0,7 10:00-19:00", "1,2,3,4,5,6 10:00-20:00"]);
		expect(parseOpeningHours(t).confidence).toBe("high");
	});

	it("10:30–19:00; closed 2nd Tue", () => {
		const t = "10:30–19:00; closed 2nd Tue";
		const p = parseOpeningHours(t);
		expect(summary(t)).toEqual(["0,1,2,3,4,5,6 10:30-19:00"]);
		expect(p.hours?.closedNth).toEqual([{ day: 2, nth: 2 }]);
		expect(p.confidence).toBe("high");
	});

	it("11:00–20:00 (wknd/hol from 10:00); last entry 19:00", () => {
		const t = "11:00–20:00 (wknd/hol from 10:00); last entry 19:00";
		expect(summary(t)).toEqual([
			"0,6,7 10:00-20:00 le19:00",
			"1,2,3,4,5 11:00-20:00 le19:00",
		]);
		expect(parseOpeningHours(t).confidence).toBe("high");
	});

	it("9:00–22:00 (last entry −60 min); timed", () => {
		const t = "9:00–22:00 (last entry −60 min); timed";
		const p = parseOpeningHours(t);
		expect(summary(t)).toEqual(["0,1,2,3,4,5,6 09:00-22:00"]);
		expect(p.hours?.lastEntryBeforeCloseMin).toBe(60);
		expect(p.confidence).toBe("high");
	});

	it("11:00–21:00 (Fri–Sat to 22:00)", () => {
		const t = "11:00–21:00 (Fri–Sat to 22:00)";
		expect(summary(t)).toEqual(["0,1,2,3,4 11:00-21:00", "5,6 11:00-22:00"]);
		expect(parseOpeningHours(t).confidence).toBe("high");
	});

	it("18:00–03:00 (some sources list closed Wed — confirm)", () => {
		const t = "18:00–03:00 (some sources list closed Wed — confirm)";
		const p = parseOpeningHours(t);
		expect(summary(t)).toEqual(["0,1,2,3,4,5,6 18:00-03:00"]);
		expect(p.approxClosures).toEqual([3]);
		expect(p.hours?.closedDays).toBeUndefined();
		expect(p.confidence).toBe("medium");
	});

	it("~10–17, many closed Sun", () => {
		const t = "~10–17, many closed Sun";
		const p = parseOpeningHours(t);
		expect(summary(t)).toEqual(["0,1,2,3,4,5,6 10:00-17:00"]);
		expect(p.approxClosures).toEqual([0]);
		expect(p.confidence).toBe("medium");
	});

	it("Earliest tour 9:30–11:40 (reserve); closed Wed & Fri", () => {
		const p = parseOpeningHours(
			"Earliest tour 9:30–11:40 (reserve); closed Wed & Fri",
		);
		expect(p.hours?.periods).toEqual([]);
		expect(p.hours?.closedDays).toEqual([3, 5]);
		expect(p.confidence).toBe("high");
		expect(p.unparsed).toContain("Earliest tour 9:30–11:40");
	});

	it("Grounds 24h; prayers 9:00–16:00", () => {
		const p = parseOpeningHours("Grounds 24h; prayers 9:00–16:00");
		expect(p.hours?.alwaysOpen).toBe(true);
		expect(p.hours?.periods).toEqual([]);
		expect(p.confidence).toBe("medium");
		expect(p.unparsed).toBe("prayers 9:00–16:00");
	});

	it.each(["Outdoor park", "Check-in usually ~15:00"])("%s → null", (t) => {
		const p = parseOpeningHours(t);
		expect(p.hours).toBeNull();
		expect(p.confidence).toBe("low");
	});
});

describe("parseOpeningHours: every other string of the Asia 2027 itinerary", () => {
	const cases: [
		string,
		string[],
		"high" | "medium" | "low",
		Partial<{
			always: boolean;
			closedDays: number[];
			approx: number[];
			lastEntry: string;
		}>?,
	][] = [
		["06:00–17:00 daily", ["0,1,2,3,4,5,6 06:00-17:00"], "high"],
		["24h (busiest ~18:00–22:00)", [], "high", { always: true }],
		["10:00–21:00 daily", ["0,1,2,3,4,5,6 10:00-21:00"], "high"],
		[
			"10:00–22:30 (last adm 21:20)",
			["0,1,2,3,4,5,6 10:00-22:30 le21:20"],
			"high",
		],
		[
			"Main hall 06:30–17:00 (Oct); grounds 24h",
			[],
			"medium",
			{ always: true },
		],
		[
			"shops ~10:00–17:00; many closed Sun",
			["0,1,2,3,4,5,6 10:00-17:00"],
			"medium",
			{ approx: [0] },
		],
		[
			'11:00–20:00 — ⚠ COREDO Nihonbashi closes ~Oct 2026 for redevelopment, reopens as Tokyo Midtown Nihonbashi "autumn 2027" (timing vs trip uncertain). Fitting also at Hiroo (Tokyo) & Daimaru Shinsaibashi (Osaka)',
			["0,1,2,3,4,5,6 11:00-20:00"],
			"medium",
		],
		["11:00–21:00 (diner to 22:00)", ["0,1,2,3,4,5,6 11:00-21:00"], "high"],
		["10:00–21:30 daily", ["0,1,2,3,4,5,6 10:00-21:30"], "high"],
		[
			"shops ~12:00–20:00 (some closed Wed)",
			["0,1,2,3,4,5,6 12:00-20:00"],
			"medium",
			{ approx: [3] },
		],
		["09:30–22:00 daily", ["0,1,2,3,4,5,6 09:30-22:00"], "high"],
		[
			"from 19:00 (reserved slots); closed Sun",
			[],
			"high",
			{ closedDays: [0] },
		],
		["bars ~20:00–05:00; quieter Sun", ["0,1,2,3,4,5,6 20:00-05:00"], "medium"],
		[
			"Sunrise–sunset (~6:00–17:00 in Oct); free",
			["0,1,2,3,4,5,6 06:00-17:00"],
			"medium",
		],
		["shops ~11:00–20:00", ["0,1,2,3,4,5,6 11:00-20:00"], "medium"],
		["11:00–19:00", ["0,1,2,3,4,5,6 11:00-19:00"], "high"],
		["11:00–20:00 daily", ["0,1,2,3,4,5,6 11:00-20:00"], "high"],
		["12:00–20:00", ["0,1,2,3,4,5,6 12:00-20:00"], "high"],
		["~8:30–9 AM departure (verify timetable)", [], "low"],
		["Outdoor; retro sightseeing bus loops the lake", [], "low"],
		["8:30–17:00 (last descent 17:20)", ["0,1,2,3,4,5,6 08:30-17:00"], "high"],
		["Usually ~18:00–19:00 start", [], "low"],
		["Park 24h; sunrise ~5:50 mid-Oct", [], "medium", { always: true }],
		["Fujikyu bus, only ~3/day (check timetable)", [], "low"],
		["Outdoor", [], "low"],
		["10:30–21:00 daily", ["0,1,2,3,4,5,6 10:30-21:00"], "high"],
		["shops ~10:00–21:00 (verify)", ["0,1,2,3,4,5,6 10:00-21:00"], "medium"],
		[
			"bars ~17:00–24:00+; many closed Sun",
			["0,1,2,3,4,5,6 17:00-24:00"],
			"medium",
			{ approx: [0] },
		],
		["24h", [], "high", { always: true }],
		["24h (public streets)", [], "high", { always: true }],
		["Timed entry 10/12/14/16; closed Tue", [], "high", { closedDays: [2] }],
		[
			"shops ~10:00–20:00; Sun main st pedestrian 13:00–18:00",
			["0,1,2,3,4,5,6 10:00-20:00"],
			"medium",
		],
		["bars ~20:00–05:00; quieter Sun", ["0,1,2,3,4,5,6 20:00-05:00"], "medium"],
	];
	it.each(cases)("%s", (text, periods, confidence, extra = {}) => {
		const p = parseOpeningHours(text);
		expect(summary(text)).toEqual(periods);
		expect(p.confidence).toBe(confidence);
		if (extra.always !== undefined)
			expect(p.hours?.alwaysOpen ?? false).toBe(extra.always);
		if (extra.closedDays) expect(p.hours?.closedDays).toEqual(extra.closedDays);
		if (extra.approx) expect(p.approxClosures).toEqual(extra.approx);
	});

	it("keeps what it couldn't read, as written", () => {
		expect(
			parseOpeningHours("Main hall 06:30–17:00 (Oct); grounds 24h").unparsed,
		).toBe("Main hall 06:30–17:00 (Oct)");
		expect(parseOpeningHours("11:00–21:00 (diner to 22:00)").unparsed).toBe(
			"(diner to 22:00)",
		);
		expect(parseOpeningHours("Outdoor park").unparsed).toBe("Outdoor park");
	});

	it("reads 12-hour times and a closure in the same sentence", () => {
		const p = parseOpeningHours("open about 10 AM–5 PM, closed Thursdays");
		expect(summary("open about 10 AM–5 PM, closed Thursdays")).toEqual([
			"0,1,2,3,5,6 10:00-17:00",
		]);
		expect(p.confidence).toBe("medium");
	});

	it("never reads a duration as hours", () => {
		expect(parseOpeningHours("2–3 hrs").hours).toBeNull();
		expect(parseOpeningHours("").hours).toBeNull();
	});
});

describe("fromGooglePeriods", () => {
	const at = "2026-09-01T00:00:00.000Z";
	it("maps plain days and leaves missing days closed", () => {
		const h = fromGooglePeriods(
			[
				{
					open: { day: 1, hour: 10, minute: 30 },
					close: { day: 1, hour: 19, minute: 0 },
				},
				{ open: { day: 2, hour: 10, minute: 30 }, close: { day: 2, hour: 19 } },
			],
			at,
		);
		expect(h).toEqual({
			source: "google",
			periods: [
				{ day: 1, open: "10:30", close: "19:00" },
				{ day: 2, open: "10:30", close: "19:00" },
			],
			updatedAt: at,
		});
	});
	it("reads open-around-the-clock and past-midnight periods", () => {
		expect(
			fromGooglePeriods([{ open: { day: 0, hour: 0, minute: 0 } }], at)
				.alwaysOpen,
		).toBe(true);
		const bar = fromGooglePeriods(
			[{ open: { day: 5, hour: 18 }, close: { day: 6, hour: 3 } }],
			at,
		);
		expect(bar.periods).toEqual([{ day: 5, open: "18:00", close: "03:00" }]);
		const midnight = fromGooglePeriods(
			[{ open: { day: 6, hour: 18 }, close: { day: 0, hour: 0 } }],
			at,
		);
		expect(midnight.periods).toEqual([
			{ day: 6, open: "18:00", close: "24:00" },
		]);
	});
	it("splits a period longer than a day", () => {
		const h = fromGooglePeriods(
			[{ open: { day: 1, hour: 9 }, close: { day: 3, hour: 12 } }],
			at,
		);
		expect(h.periods).toEqual([
			{ day: 1, open: "09:00", close: "24:00" },
			{ day: 2, open: "00:00", close: "24:00" },
			{ day: 3, open: "00:00", close: "12:00" },
		]);
	});
});
