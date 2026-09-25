import { describe, expect, it } from "vitest";
import type { OpeningHours } from "@/lib/schemas/hours";
import {
	hoursDiff,
	hoursDiffText,
	sourceLabel,
	weekRows,
	weekRunRows,
	weekSummary,
} from "./hours-format";

const at = "2026-09-01T00:00:00.000Z";
const h = (x: Partial<OpeningHours>): OpeningHours => ({
	source: "manual",
	periods: [],
	updatedAt: at,
	...x,
});
const days = (ds: number[], open: string, close: string) =>
	ds.map((day) => ({ day, open, close }));

describe("weekSummary", () => {
	it("joins runs of equal days, Monday first", () => {
		expect(
			weekSummary(
				h({
					periods: [
						...days([1, 2, 3, 4, 5, 6], "10:00", "20:00"),
						...days([0, 7], "10:00", "19:00"),
					],
				}),
			),
		).toBe("Mon–Sat 10:00–20:00 · Sun 10:00–19:00");
	});
	it("says Daily for one run, and names closed days", () => {
		expect(
			weekSummary(
				h({ periods: days([0, 1, 2, 3, 4, 5, 6], "11:00", "21:00") }),
			),
		).toBe("Daily 11:00–21:00");
		expect(
			weekSummary(h({ periods: days([1, 2, 4, 5, 6, 0], "09:00", "17:00") })),
		).toBe("Mon–Tue 09:00–17:00 · Closed Wed · Thu–Sun 09:00–17:00");
	});
	it("covers 24h and unknown hours", () => {
		expect(weekSummary(h({ alwaysOpen: true }))).toBe("Open 24h");
		expect(weekSummary(h({}))).toBe("Hours unknown");
		expect(weekSummary(h({ closedDays: [3] }))).toBe("Closed Wed");
	});
	it("keeps days and times apart for the suggestion grid", () => {
		expect(
			weekRunRows(
				h({ periods: days([1, 2, 3, 4, 5, 6, 0], "10:00", "20:00") }),
			),
		).toEqual([{ days: "Daily", text: "10:00–20:00", state: "open" }]);
	});
});

describe("hoursDiff (COLLAB-R2-08: a suggestion names what it changes)", () => {
	const sunClosed = h({ closedDays: [0] });
	it("a closed special date on unchanged hours reads 'Closed Tue 5 Oct 2027', no week", () => {
		const d = hoursDiff(
			sunClosed,
			h({
				closedDays: [0],
				exceptions: [{ date: "2027-10-05", closed: true }],
			}),
		);
		expect(d.week).toBeNull();
		expect(d.changes).toEqual([{ text: "Closed Tue 5 Oct 2027" }]);
		expect(hoursDiffText(d)).toBe("Closed Tue 5 Oct 2027");
	});
	it("names changed, opened and removed dates in date order, with labels", () => {
		const week = days([1, 2, 3, 4, 5, 6, 0], "10:00", "20:00");
		const d = hoursDiff(
			h({
				periods: week,
				exceptions: [
					{ date: "2027-10-10", closed: true, label: "Festival" },
					{ date: "2027-10-01", closed: true },
				],
			}),
			h({
				periods: week,
				exceptions: [
					{
						date: "2027-10-01",
						closed: false,
						periods: [{ open: "12:00", close: "15:00" }],
					},
					{ date: "2027-10-10", closed: true, label: "Festival" },
				],
			}),
		);
		expect(d.week).toBeNull();
		expect(d.changes).toEqual([{ text: "Fri 1 Oct 2027 12:00–15:00" }]);
		const gone = hoursDiff(
			h({
				periods: week,
				exceptions: [{ date: "2027-10-10", closed: true, label: "Festival" }],
			}),
			h({ periods: week }),
		);
		expect(gone.changes).toEqual([
			{ text: "Closed Sun 10 Oct 2027 · Festival", removed: true },
		]);
		expect(hoursDiffText(gone)).toBe(
			"Removes “Closed Sun 10 Oct 2027 · Festival”",
		);
	});
	it("names new and dropped rules, holiday hours and the note", () => {
		const week = days([1, 2, 3, 4, 5, 6, 0], "10:00", "20:00");
		const d = hoursDiff(
			h({ periods: week, lastEntryBeforeCloseMin: 30, note: "Cash only" }),
			h({
				periods: [...week, { day: 7, open: "10:00", close: "17:00" }],
				closedNth: [{ day: 2, nth: 2 }],
			}),
		);
		expect(d.week).toBeNull();
		expect(d.changes).toEqual([
			{ text: "Holidays 10:00–17:00" },
			{ text: "Closed 2nd Tue" },
			{ text: "Last entry 30 min before close", removed: true },
			{ text: "Note: Cash only", removed: true },
		]);
	});
	it("shows the week when it changes, or when there were no hours, or nothing else changed", () => {
		const before = h({
			periods: days([1, 2, 3, 4, 5, 6, 0], "10:00", "20:00"),
		});
		const after = h({ periods: days([1, 2, 3, 4, 5, 6], "10:00", "20:00") });
		expect(hoursDiffText(hoursDiff(before, after))).toBe(
			"Mon–Sat 10:00–20:00 · Closed Sun",
		);
		expect(hoursDiffText(hoursDiff(null, after))).toBe(
			"Mon–Sat 10:00–20:00 · Closed Sun",
		);
		// Confirming the same hours (sheet → manual): the whole week.
		expect(hoursDiff(after, { ...after }).week).toEqual(weekRunRows(after));
		expect(hoursDiff(after, { ...after }).changes).toEqual([]);
	});
});

describe("holidays closed and the OpenStreetMap source", () => {
	it("shows a Closed holidays row (OSM `PH off`), also next to 24h days", () => {
		const rows = weekRows(
			h({
				periods: days([1, 2, 3, 4, 5], "09:00", "18:00"),
				closedOnHolidays: true,
			}),
		);
		expect(rows.at(-1)).toEqual({
			day: 7,
			label: "Holidays",
			text: "Closed",
			state: "closed",
		});
		expect(
			weekRows(h({ alwaysOpen: true, closedOnHolidays: true })).at(-1),
		).toMatchObject({ day: 7, text: "Closed" });
		expect(weekRows(h({ periods: days([1], "09:00", "18:00") }))).toHaveLength(
			7,
		);
	});

	it("names OpenStreetMap hours in the source line", () => {
		const hours = h({ source: "osm", periods: days([1], "09:00", "18:00") });
		expect(sourceLabel({ hours, source: "osm", confidence: "high" })).toBe(
			"OpenStreetMap · 1 Sep",
		);
	});

	it("a suggestion that closes on holidays says so", () => {
		const before = h({ periods: days([1, 2, 3, 4, 5], "09:00", "18:00") });
		const d = hoursDiff(before, { ...before, closedOnHolidays: true });
		expect(d.week).toBeNull();
		expect(d.changes).toEqual([{ text: "Holidays Closed" }]);
	});
});
