/**
 * QA COLLAB-R3-06: a link guest's graph hides a flight's booking ref but
 * keeps the fact that it is booked, so the date what-if lists the flight
 * under "Needs rebooking" (without a ref), never "no booking ref". Guest
 * WRITES still carry no ref at all.
 */
import "@/lib/engine/__fixtures__/host-tz";
import { describe, expect, it } from "vitest";
import { flightDetails, scenario } from "@/lib/engine/__fixtures__/demo";
import { dateChangeImpact } from "@/lib/engine/date-impact";
import { type LegDetails, REDACTED_BOOKING_REF } from "@/lib/schemas/legs";
import { guestLegDetails, redactLegDetails } from "./graph.server";

function tripWithBookedFlight() {
	return scenario({
		firstDate: "2027-10-06",
		days: [
			{ items: [{ k: "kix", node: "kix", min: 120 }] },
			{ items: [{ k: "icn", node: "icn", min: 60 }] },
		],
		legs: [
			{
				k: "flight",
				from: "kix",
				to: "icn",
				mode: "flight",
				dep: ["2027-10-06T13:05", "Asia/Tokyo"],
				arr: ["2027-10-06T15:05", "Asia/Seoul"],
				details: {
					...flightDetails({
						number: "KE724",
						from: {
							iata: "KIX",
							tz: "Asia/Tokyo",
							country: "JP",
							at: [34.432, 135.2304],
						},
						to: {
							iata: "ICN",
							tz: "Asia/Seoul",
							country: "KR",
							at: [37.4602, 126.4407],
						},
						dep: "2027-10-06T13:05",
						arr: "2027-10-06T15:05",
					}),
				},
			},
		],
	});
}

describe("guest leg details", () => {
	it("read path: booked, ref hidden; write path: no ref at all", () => {
		const s = tripWithBookedFlight();
		const leg = s.graph.legs.find((l) => l.id === s.L.flight);
		const d = leg?.details as LegDetails;
		if (d.kind !== "flight") throw new Error("no flight");
		d.flight.bookingRef = "ZK4P7Q";
		const read = guestLegDetails(d);
		expect(read.kind === "flight" && read.flight.bookingRef).toBe(
			REDACTED_BOOKING_REF,
		);
		const write = redactLegDetails(d);
		expect(write.kind === "flight" && write.flight.bookingRef).toBeUndefined();
		// An unbooked flight stays unbooked for guests.
		const unbooked = guestLegDetails({
			...d,
			flight: { ...d.flight, bookingRef: undefined },
		});
		expect(
			unbooked.kind === "flight" && unbooked.flight.bookingRef,
		).toBeUndefined();
	});

	it("the guest's what-if puts the booked flight under bookings, without its ref", () => {
		const s = tripWithBookedFlight();
		for (const l of s.graph.legs) {
			const d = l.details as LegDetails;
			if (d.kind === "flight") {
				d.flight.bookingRef = "ZK4P7Q";
				l.details = guestLegDetails(d) as typeof l.details;
			}
		}
		const impact = dateChangeImpact(
			s.graph,
			{ deltaDays: 1 },
			{ hoursOf: () => null, holidays: [], today: "2026-09-23" },
		);
		expect(impact.bookings.map((b) => [b.kind, b.label, b.ref])).toEqual([
			["flight", "Flight KE 724", undefined],
		]);
		expect(impact.timed.filter((t) => t.kind === "flight")).toEqual([]);
		expect(JSON.stringify(impact)).not.toContain("ZK4P7Q");
	});
});
