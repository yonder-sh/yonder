import { describe, expect, it } from "vitest";
import {
	MAX_TREE_EXPANDED_TRIPS,
	mergeUserPrefs,
	readUserPrefs,
	UserPrefs,
} from "./misc";

const T = (n: number) =>
	`00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

describe("user prefs (ADDENDUM §7.2)", () => {
	it("defaultLens: null parses, and removes the stored key (back to Automatic)", () => {
		expect(UserPrefs.safeParse({ defaultLens: null }).success).toBe(true);
		const next = mergeUserPrefs(
			{ defaultLens: "city", compact: true },
			{ defaultLens: null },
		);
		expect(next).toEqual({ compact: true });
	});

	it("keeps keys the patch doesn't send and replaces the ones it does", () => {
		expect(
			mergeUserPrefs({ clock: "24h", units: "km" }, { units: "mi" }),
		).toEqual({ clock: "24h", units: "mi" });
	});

	it("merges treeExpanded per trip (another device's trips survive)", () => {
		const next = mergeUserPrefs(
			{ treeExpanded: { [T(1)]: [T(10)], [T(2)]: [T(20)] } },
			{ treeExpanded: { [T(2)]: [T(21)], [T(3)]: [] } },
		);
		expect(next.treeExpanded).toEqual({
			[T(1)]: [T(10)],
			[T(2)]: [T(21)],
			[T(3)]: [],
		});
	});

	it("caps treeExpanded at 50 trips, keeping the patch's", () => {
		const stored = Object.fromEntries(
			Array.from({ length: MAX_TREE_EXPANDED_TRIPS }, (_, i) => [T(i), []]),
		);
		const next = mergeUserPrefs(
			{ treeExpanded: stored },
			{ treeExpanded: { [T(999)]: [T(1)] } },
		);
		const keys = Object.keys(next.treeExpanded ?? {});
		expect(keys).toHaveLength(MAX_TREE_EXPANDED_TRIPS);
		expect(keys).toContain(T(999));
		expect(UserPrefs.safeParse(next).success).toBe(true);
	});

	it("reads stored prefs leniently: one bad key doesn't lose the rest", () => {
		expect(readUserPrefs({ compact: true, clock: "13h" })).toEqual({
			compact: true,
		});
		expect(readUserPrefs(null)).toEqual({});
		expect(readUserPrefs("nope")).toEqual({});
	});
});
