import { afterEach, describe, expect, it, vi } from "vitest";
import {
	DEFAULT_DISPLAY_PREFS,
	flagEmoji,
	formatDateRange,
	formatDayDate,
	formatDistance,
	formatDuration,
	formatTime,
	getDisplayPrefs,
	initials,
	langFor,
	parseDuration,
	setDisplayPrefs,
	subscribeDisplayPrefs,
	to12h,
} from "./format";

describe("parseDuration (QA A-23)", () => {
	it.each([
		["90", 90],
		["90m", 90],
		["45 min", 45],
		["1h30", 90],
		["1h 30m", 90],
		["1.5h", 90],
		["2h", 120],
		["1:30", 90],
		["0:45", 45],
	])("%s → %i", (input, minutes) => {
		expect(parseDuration(input)).toBe(minutes);
	});

	it.each(["0", "0m", "-5", "abc", "", "1:75", "4321", "1h99x"])(
		"rejects %j",
		(input) => {
			expect(parseDuration(input)).toBeNull();
		},
	);
});

describe("formatDuration", () => {
	it("formats minutes, hours and both", () => {
		expect(formatDuration(45)).toBe("45m");
		expect(formatDuration(120)).toBe("2h");
		expect(formatDuration(90)).toBe("1h 30m");
		expect(formatDuration(95, { compact: true })).toBe("1h35");
		expect(formatDuration(65, { compact: true })).toBe("1h05");
		expect(formatDuration(null)).toBe("–");
	});

	it("round-trips through parseDuration", () => {
		for (const m of [15, 45, 60, 90, 135, 600])
			expect(parseDuration(formatDuration(m, { compact: true }))).toBe(m);
	});
});

describe("dates", () => {
	it("never shifts calendar dates by the host zone", () => {
		expect(formatDayDate("2027-04-15")).toBe("Thu 15 Apr");
		expect(formatDayDate("2027-10-02", { year: true })).toBe("Sat 2 Oct 2027");
	});

	it("formats ranges like DESIGN §12", () => {
		expect(formatDateRange("2027-10-05", "2027-10-07")).toBe("5–7 Oct");
		expect(formatDateRange("2027-09-30", "2027-10-02")).toBe("30 Sep – 2 Oct");
		expect(formatDateRange("2027-10-02", "2027-11-05", { year: true })).toBe(
			"2 Oct – 5 Nov 2027",
		);
		expect(formatDateRange("2027-10-05", "2027-10-05")).toBe("5 Oct");
	});
});

describe("people and places", () => {
	it("initials", () => {
		expect(initials("Maya Chen")).toBe("MC");
		expect(initials("Sam")).toBe("S");
		expect(initials("Thảo Nguyễn-O'Brien")).toBe("TN");
	});

	it("lang and flags", () => {
		expect(langFor("TW")).toBe("zh-Hant");
		expect(langFor("jp")).toBe("ja");
		expect(langFor(null)).toBeUndefined();
		expect(flagEmoji("JP")).toBe("🇯🇵");
		expect(flagEmoji("x")).toBe("");
	});
});

describe("display prefs (ADDENDUM §7.2: 12/24 h, km/mi)", () => {
	afterEach(() => setDisplayPrefs(DEFAULT_DISPLAY_PREFS));
	const at = Date.UTC(2027, 9, 5, 8, 5); // 17:05 in Tokyo

	it("defaults to 24 h and km", () => {
		expect(getDisplayPrefs()).toEqual({ clock: "24h", units: "km" });
		expect(formatTime(at, "Asia/Tokyo")).toBe("17:05");
		expect(formatDistance(850)).toBe("850 m");
		expect(formatDistance(12_400)).toBe("12 km");
	});

	it("switches times to 12-hour and distances to miles, and notifies", () => {
		const fn = vi.fn();
		const off = subscribeDisplayPrefs(fn);
		setDisplayPrefs({ clock: "12h", units: "mi" });
		expect(fn).toHaveBeenCalledTimes(1);
		setDisplayPrefs({ clock: "12h" });
		expect(fn).toHaveBeenCalledTimes(1);
		off();
		expect(formatTime(at, "Asia/Tokyo")).toBe("5:05pm");
		expect(formatDistance(100)).toBe("328 ft");
		expect(formatDistance(1609.344 * 2.5)).toBe("2.5 mi");
		expect(formatDistance(1609.344 * 12.4)).toBe("12 mi");
	});

	it("to12h covers midnight and noon", () => {
		expect(to12h("00:30")).toBe("12:30am");
		expect(to12h("12:00")).toBe("12:00pm");
		expect(to12h("09:15")).toBe("9:15am");
	});
});
