/** Today's words and its Directions links (One Yonder phase 5). */
import { describe, expect, it } from "vitest";
import { directionsUrl, isAppleDevice, travelBy } from "../lib/directions";
import { fixLabel, paceLabel, spokenMin } from "../lib/words";

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
