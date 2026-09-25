/**
 * Marker stacking (QA MAP-03): integer z-indices, visited pins over ideas,
 * low numbers on top, clusters over pins, hover and selection over all.
 */
import { describe, expect, it } from "vitest";
import { MARKER_Z, pinZIndex } from "../marker-z";

describe("pinZIndex", () => {
	it("is always an integer CSS accepts (10.99 is dropped, MT-02)", () => {
		for (const number of [1, 2, 7.5, 42, 99, 100, 250, 5000, null])
			for (const hollow of [false, true])
				for (const selected of [false, true])
					for (const hovered of [false, true])
						expect(
							Number.isInteger(
								pinZIndex({ hollow, number }, selected, hovered),
							),
						).toBe(true);
	});

	it("puts every visited pin above every idea, and pin 1 above pin 2", () => {
		const idea = pinZIndex({ hollow: true, number: null }, false, false);
		const last = pinZIndex({ hollow: false, number: 5000 }, false, false);
		const one = pinZIndex({ hollow: false, number: 1 }, false, false);
		const two = pinZIndex({ hollow: false, number: 2 }, false, false);
		expect(last).toBeGreaterThan(idea);
		expect(one).toBeGreaterThan(two);
		expect(MARKER_Z.cluster).toBeGreaterThan(one);
		expect(pinZIndex({ hollow: true, number: null }, false, true)).toBe(
			MARKER_Z.hovered,
		);
		expect(pinZIndex({ hollow: false, number: 9 }, true, true)).toBe(
			MARKER_Z.selected,
		);
		expect(MARKER_Z.selected).toBeGreaterThan(MARKER_Z.cluster);
	});
});
