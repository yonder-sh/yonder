/** Delete… lists what goes with a place in plain words: stops, not items. */
import { describe, expect, it } from "vitest";
import { impactLines } from "../OutlineDialogs";

describe("impactLines", () => {
	it("names places inside, stops on the plan, notes, photos and list items", () => {
		expect(
			impactLines({ places: 3, items: 2, notes: 2, media: 1, lists: 4 }),
		).toEqual([
			"3 places inside",
			"2 stops on the plan",
			"Notes on 2 places",
			"1 photo or link",
			"4 list items",
		]);
	});

	it("says one stop in the singular and leaves out what's empty", () => {
		expect(
			impactLines({ places: 0, items: 1, notes: 1, media: 0, lists: 0 }),
		).toEqual(["1 stop on the plan", "Notes"]);
	});
});
