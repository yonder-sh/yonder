import { describe, expect, it } from "vitest";
import { parseOpeningHours } from "@/lib/engine/hours-parse";
import type { OpeningHours } from "@/lib/schemas/hours";
import { fromDraft, normalizeClock, toDraft } from "./hours-draft";

const AT = "2027-01-01T00:00:00.000Z";
const roundTrip = (h: OpeningHours) => {
	const r = fromDraft(toDraft(h), AT);
	if (!r.ok) throw new Error(r.error);
	return r.hours;
};

describe("hours draft: every OpeningHours field round-trips", () => {
	const cases: [string, OpeningHours][] = [
		[
			"weekly hours, split shifts, last entries, a 24h day, holidays, rules, exceptions and a note",
			{
				source: "manual",
				periods: [
					{ day: 0, open: "00:00", close: "24:00" },
					{ day: 1, open: "10:00", close: "12:00" },
					{ day: 1, open: "13:00", close: "19:00", lastEntry: "18:30" },
					{ day: 2, open: "18:00", close: "03:00" },
					{ day: 5, open: "11:00", close: "22:00" },
					{ day: 6, open: "11:00", close: "22:00" },
					{ day: 7, open: "10:00", close: "19:00" },
				],
				closedNth: [
					{ day: 2, nth: 2 },
					{ day: 4, nth: -1 },
				],
				lastEntryBeforeCloseMin: 60,
				exceptions: [
					{ date: "2027-10-11", closed: true, label: "Sports Day" },
					{
						date: "2027-10-26",
						closed: false,
						periods: [{ open: "12:00", close: "15:00" }],
						label: "Short day",
					},
				],
				note: "Cash only on the 3rd floor",
				updatedAt: AT,
			},
		],
		[
			"open around the clock",
			{ source: "manual", alwaysOpen: true, periods: [], updatedAt: AT },
		],
		[
			"closures known without hours",
			{
				source: "manual",
				periods: [],
				closedDays: [3, 5],
				closedNth: [{ day: 1, nth: 1 }],
				updatedAt: AT,
			},
		],
	];
	it.each(cases)("%s", (_name, h) => {
		expect(roundTrip(h)).toEqual(h);
	});

	it("turns Google or sheet hours into manual ones", () => {
		const parsed = parseOpeningHours("10:30–19:00; closed 2nd Tue").hours;
		if (!parsed) throw new Error("parse");
		const out = roundTrip({ ...parsed, source: "google" });
		expect(out.source).toBe("manual");
		expect(out.closedNth).toEqual([{ day: 2, nth: 2 }]);
		expect(out.periods).toHaveLength(7);
	});
});

describe("hours draft: validation", () => {
	it("asks for times, and for closed days when nothing is open", () => {
		const d = toDraft(null);
		expect(fromDraft(d, AT)).toEqual({
			ok: false,
			error: "Sun: add hours, or mark it closed.",
		});
		for (const day of d.days) day.state = "closed";
		expect(fromDraft(d, AT).ok).toBe(false);
		d.mode = "closedOnly";
		expect(fromDraft(d, AT)).toEqual({
			ok: false,
			error: "Pick the days it's closed.",
		});
		d.closedDays = [3];
		expect(fromDraft(d, AT)).toMatchObject({
			ok: true,
			hours: { periods: [], closedDays: [3] },
		});
	});

	it("rejects bad times and a bad last-entry value", () => {
		const d = toDraft({
			source: "manual",
			periods: [{ day: 1, open: "10:00", close: "19:00" }],
			updatedAt: AT,
		});
		const mon = d.days[1]?.ranges[0];
		if (!mon) throw new Error("no range");
		mon.close = "25:00";
		expect(fromDraft(d, AT).ok).toBe(false);
		mon.close = "1900";
		d.lastEntryMin = "300";
		expect(fromDraft(d, AT)).toEqual({
			ok: false,
			error: "Last entry: minutes before close, 0 to 240.",
		});
	});

	it("normalizes typed times", () => {
		expect(normalizeClock("9")).toBe("09:00");
		expect(normalizeClock("930")).toBe("09:30");
		expect(normalizeClock("21.30")).toBe("21:30");
		expect(normalizeClock("9pm")).toBe("21:00");
		expect(normalizeClock("24:00")).toBeNull();
		expect(normalizeClock("24:00", true)).toBe("24:00");
		expect(normalizeClock("7:75")).toBeNull();
	});
});
