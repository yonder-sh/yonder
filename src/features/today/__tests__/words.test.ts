/** Today's words and its Directions links (One Yonder phase 5). */
import { describe, expect, it } from "vitest";
import { zonedEpoch } from "@/lib/engine/time";
import type { TodayLeave, TodayRisk, TodayStop } from "@/lib/engine/today";
import {
	directionsUrl,
	isAppleDevice,
	travelBy,
	travelTo,
} from "../lib/directions";
import {
	fixLabel,
	lateArrival,
	leaveLine,
	paceLabel,
	riskTitle,
	spokenMin,
	travelLine,
	travelWords,
} from "../lib/words";

describe("directions", () => {
	const nakano: [number, number] = [139.665512, 35.709031];

	it("opens Apple Maps on Apple devices, walking or by transit", () => {
		expect(directionsUrl(nakano, "walking", true)).toBe(
			"https://maps.apple.com/?daddr=35.70903,139.66551&dirflg=w",
		);
		expect(directionsUrl(nakano, "transit", true)).toBe(
			"https://maps.apple.com/?daddr=35.70903,139.66551&dirflg=r",
		);
	});

	it("opens Google Maps elsewhere", () => {
		expect(directionsUrl(nakano, "transit", false)).toBe(
			"https://www.google.com/maps/dir/?api=1&destination=35.70903,139.66551&travelmode=transit",
		);
	});

	it("goes the way the plan travels (on foot when unknown)", () => {
		expect(travelBy("walk")).toBe("walking");
		expect(travelBy(null)).toBe("walking");
		expect(travelBy("transit")).toBe("transit");
		expect(travelBy("other")).toBe("driving");
		// A train or a flight takes you there: by transit.
		expect(travelTo({ mode: null, departure: { name: "Nozomi 7" } })).toBe(
			"transit",
		);
		expect(travelTo({ mode: "walk", departure: null })).toBe("walking");
	});

	it("knows an iPhone, an iPad and a Mac", () => {
		expect(
			isAppleDevice(
				"Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15",
			),
		).toBe(true);
		expect(
			isAppleDevice("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)"),
		).toBe(true);
		expect(
			isAppleDevice("Mozilla/5.0 (Linux; Android 15; Pixel 9) Chrome/129"),
		).toBe(false);
	});
});

describe("words", () => {
	it("durations the way the boards say them", () => {
		expect(spokenMin(35)).toBe("35 min");
		expect(spokenMin(60)).toBe("1 h");
		expect(spokenMin(160)).toBe("2 h 40");
		expect(spokenMin(65)).toBe("1 h 05");
	});

	it("the pace", () => {
		expect(paceLabel({ kind: "behind", minutes: 35 })).toBe("35 min behind");
		expect(paceLabel({ kind: "ahead", minutes: 30 })).toBe("30 min ahead");
		expect(paceLabel({ kind: "on_time", minutes: 0 })).toBe("On time");
	});

	it("the travel, and a departure's time where you board", () => {
		expect(travelWords(5, "walk")).toBe("5 min walk");
		expect(travelWords(20, "transit")).toBe("20 min by transit");
		expect(travelWords(15, "other")).toBe("15 min by car");
		// CI 157 leaves Osaka at 16:00 for Taipei, an hour behind.
		const departure = {
			legId: "l",
			name: "CI 157",
			readyBy: zonedEpoch("2027-10-05", "14:00", "Asia/Tokyo"),
			depMs: zonedEpoch("2027-10-05", "16:00", "Asia/Tokyo"),
			flight: true,
			tz: "Asia/Tokyo",
		};
		expect(
			travelLine({
				departure,
				tz: "Asia/Taipei",
				travelMin: 0,
				mode: null,
			} as unknown as TodayStop),
		).toBe("CI 157 at 16:00");
		const risk = {
			late: false,
			departure,
			name: "CI 157",
			at: departure.readyBy,
			tz: "Asia/Tokyo",
			booked: false,
		} as unknown as TodayRisk;
		expect(riskTitle(risk)).toBe("Tight before CI 157 · leaves 16:00");
	});

	it("when to leave for the next fixed stop; now once that's past", () => {
		const at = (time: string) => zonedEpoch("2027-10-05", time, "Asia/Tokyo");
		const bar: TodayLeave = {
			before: at("19:50"),
			itemId: "b",
			name: "Bar Benfiddich",
			at: at("20:00"),
			tz: "Asia/Tokyo",
			booked: true,
			travelMin: 10,
			mode: "walk",
			departure: null,
		};
		expect(leaveLine(bar, at("17:10"))).toBe(
			"Leave for Bar Benfiddich by 19:50 (booked for 20:00, 10 min walk)",
		);
		expect(leaveLine({ ...bar, booked: false }, at("19:50"))).toBe(
			"Leave for Bar Benfiddich now (at 20:00, 10 min walk)",
		);
		const nh9 = {
			...bar,
			name: "NH 9",
			travelMin: 0,
			departure: { name: "NH 9" },
		} as unknown as TodayLeave;
		expect(leaveLine(nh9, at("17:10"))).toBe("Leave for NH 9 by 19:50");
	});

	it("a fixed stop reached late says when you'd arrive; on time or early, nothing", () => {
		const at = (time: string) => zonedEpoch("2027-10-05", time, "Asia/Tokyo");
		const bar = {
			start: at("20:00"),
			arrive: at("20:25"),
			tz: "Asia/Tokyo",
		} as TodayStop;
		expect(lateArrival(bar)).toBe("You'd arrive 20:25");
		expect(lateArrival({ ...bar, arrive: at("19:55") })).toBeNull();
		expect(lateArrival({ ...bar, arrive: at("20:00") + 20_000 })).toBeNull();
	});

	it("a custom stop reads as a word in the fix; a place keeps its name", () => {
		expect(
			fixLabel(
				{
					kind: "shorten",
					itemId: "x",
					name: "Dinner",
					toMin: 60,
					recoverMin: 30,
				},
				false,
			),
		).toBe("Shorten dinner to 1 h");
		expect(
			fixLabel(
				{ kind: "skip", itemId: "y", name: "Bic Camera", recoverMin: 90 },
				true,
			),
		).toBe("Skip Bic Camera");
	});
});
