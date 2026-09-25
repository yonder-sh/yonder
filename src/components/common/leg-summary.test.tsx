/**
 * QA VIS3-05: a flight's one-line summary names its own time (the ticket's
 * 14h), never the plan's total with the airport time around it (16h).
 */
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { GraphLeg } from "@/lib/engine/types";
import { flightOwnMinutes, LegSummary } from "./leg-summary";

const airport = (iata: string, tz: string) => ({
	iata,
	name: iata,
	tz,
	lat: 0,
	lng: 0,
});
const nh9 = {
	flightNumber: "NH9",
	from: airport("JFK", "America/New_York"),
	to: airport("HND", "Asia/Tokyo"),
	depLocal: "2027-10-02T11:00",
	arrLocal: "2027-10-03T14:00",
	seats: [],
};
const leg = {
	id: "l1",
	kind: "pair",
	fromItemId: "a",
	toItemId: "b",
	stayDayId: null,
	anchorItemId: null,
	mode: "flight",
	durationMin: 960,
	distanceM: null,
	source: "manual",
	estimateMin: null,
	isEdited: true,
	depAt: null,
	arrAt: null,
	details: { kind: "flight", flight: nh9 },
	queriedFor: null,
	assigneeIds: [],
	hasContent: false,
	updatedAt: "2026-09-23T00:00:00Z",
} as unknown as GraphLeg;

describe("LegSummary (flights)", () => {
	it("NH 9 JFK→HND reads 14h (its flight), not the plan's 16h", () => {
		expect(flightOwnMinutes(nh9)).toBe(14 * 60);
		render(
			<LegSummary
				leg={leg}
				schedule={{ minutes: 960, estimate: false } as never}
			/>,
		);
		expect(screen.getByText("NH 9 JFK→HND")).toBeTruthy();
		expect(screen.getByText("14h")).toBeTruthy();
		expect(screen.queryByText(/16h/)).toBeNull();
	});

	it("an invalid flight time falls back to the plan's minutes", () => {
		expect(
			flightOwnMinutes({ ...nh9, arrLocal: "2027-10-01T10:00" }),
		).toBeNull();
	});
});
