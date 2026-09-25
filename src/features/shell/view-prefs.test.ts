import { describe, expect, it } from "vitest";
import { combinePatches, mergePrefs } from "./view-prefs";

describe("view prefs helpers", () => {
	it("merges a patch like the server: null resets a key", () => {
		expect(
			mergePrefs({ clock: "24h", compact: true }, { clock: "12h" }),
		).toEqual({ clock: "12h", compact: true });
		expect(
			mergePrefs(
				{ displayCurrency: "JPY", defaultLens: "city" },
				{ displayCurrency: null, defaultLens: null },
			),
		).toEqual({});
	});

	it("merges the tree expand state per trip", () => {
		expect(
			mergePrefs(
				{ treeExpanded: { a: ["1"], b: ["2"] } },
				{ treeExpanded: { b: ["3"] } },
			),
		).toEqual({ treeExpanded: { a: ["1"], b: ["3"] } });
	});

	it("combines pending patches without losing a reset", () => {
		expect(
			combinePatches(
				{ defaultLens: "city", treeExpanded: { a: ["1"] } },
				{ defaultLens: null, treeExpanded: { b: ["2"] } },
			),
		).toEqual({ defaultLens: null, treeExpanded: { a: ["1"], b: ["2"] } });
	});
});
