/**
 * QA DASH-HERO-DAY: a trip 20–23 Sep 2026 opened on 23 Sep read "Day -2" in
 * the dashboard hero — the day number was `-(today − start) + 1`. Day 1 is
 * the start date; every later day counts up.
 */
import { describe, expect, it } from "vitest";
import { heroWhen, isRunning, tripDayNumber } from "../hero-when";

describe("tripDayNumber", () => {
	it("is Day 1 on the start date", () => {
		expect(tripDayNumber("2026-09-20", "2026-09-20")).toBe(1);
	});

	it("counts up through the trip (the QA repro: 20–23 Sep on 23 Sep = Day 4)", () => {
		expect(tripDayNumber("2026-09-20", "2026-09-21")).toBe(2);
		expect(tripDayNumber("2026-09-20", "2026-09-22")).toBe(3);
		expect(tripDayNumber("2026-09-20", "2026-09-23")).toBe(4);
	});

	it("counts across month and year ends (Asia 2027: Day 1 = 2 Oct)", () => {
		expect(tripDayNumber("2027-10-02", "2027-11-05")).toBe(35);
		expect(tripDayNumber("2026-12-30", "2027-01-02")).toBe(4);
	});

	it("is unaffected by a DST change inside the trip", () => {
		expect(tripDayNumber("2026-10-30", "2026-11-02")).toBe(4);
		expect(tripDayNumber("2027-03-12", "2027-03-16")).toBe(5);
	});
});

describe("heroWhen", () => {
	it("shows the running day, never a negative one", () => {
		expect(heroWhen("2026-09-20", "2026-09-23", "2026-09-23")).toEqual({
			kind: "day",
			day: 4,
		});
		for (const today of [
			"2026-09-20",
			"2026-09-21",
			"2026-09-22",
			"2026-09-23",
		]) {
			const w = heroWhen("2026-09-20", "2026-09-23", today);
			expect(w?.kind).toBe("day");
			expect(w && w.kind === "day" && w.day).toBeGreaterThanOrEqual(1);
		}
	});

	it("counts down before the trip", () => {
		expect(heroWhen("2026-09-24", "2026-09-30", "2026-09-23")).toEqual({
			kind: "countdown",
			days: 1,
		});
		expect(heroWhen("2027-10-02", "2027-11-05", "2026-09-23")).toEqual({
			kind: "countdown",
			days: 374,
		});
	});

	it("keeps counting days on an open-ended trip", () => {
		expect(heroWhen("2026-09-01", null, "2026-09-23")).toEqual({
			kind: "day",
			day: 23,
		});
	});

	it("shows nothing after the trip, without dates, or before today is known", () => {
		expect(heroWhen("2026-09-01", "2026-09-10", "2026-09-23")).toBeNull();
		expect(heroWhen(null, null, "2026-09-23")).toBeNull();
		expect(heroWhen("2026-09-20", "2026-09-23", null)).toBeNull();
	});
});

describe("isRunning", () => {
	it("includes the start and end dates", () => {
		expect(isRunning("2026-09-20", "2026-09-23", "2026-09-20")).toBe(true);
		expect(isRunning("2026-09-20", "2026-09-23", "2026-09-23")).toBe(true);
		expect(isRunning("2026-09-20", "2026-09-23", "2026-09-24")).toBe(false);
		expect(isRunning("2026-09-20", "2026-09-23", "2026-09-19")).toBe(false);
		expect(isRunning("2026-09-20", "2026-09-23", null)).toBe(false);
	});
});
