import { describe, expect, it } from "vitest";
import {
	EMPTY_FILTER,
	isEmptyFilter,
	parseFilter,
	serializeFilter,
} from "./filter";
import { WorkspaceSearch } from "./search";

const M = "0b8f7c9e-1d2a-4b3c-8d4e-5f6a7b8c9d0e";

describe("the shared filter param (ADDENDUM §10)", () => {
	it("round-trips a full filter canonically", () => {
		const raw = `ns;u:me;p:want;by:${M};g:food_drink,sight`;
		const f = parseFilter(raw);
		expect(f).toEqual({
			groups: ["sight", "food_drink"],
			minPriority: "want",
			priorityOf: M,
			unratedBy: "me",
			notScheduled: true,
		});
		expect(serializeFilter(f)).toBe(
			`g:sight,food_drink;p:want;by:${M};u:me;ns`,
		);
		expect(parseFilter(serializeFilter(f))).toEqual(f);
	});

	it("drops unknown or malformed tokens instead of failing", () => {
		expect(parseFilter("g:nope,bar;p:best;by:someone;u:x;zz:1")).toEqual({
			...EMPTY_FILTER,
			groups: ["bar"],
		});
		expect(parseFilter("G:BAR")).toEqual(EMPTY_FILTER);
		expect(parseFilter(undefined)).toEqual(EMPTY_FILTER);
	});

	it("an empty filter is no param; `by` only matters with a minimum", () => {
		expect(serializeFilter(EMPTY_FILTER)).toBeUndefined();
		expect(isEmptyFilter(parseFilter(`by:${M}`))).toBe(true);
	});

	it("WorkspaceSearch keeps a valid `f` and drops a hostile one", () => {
		expect(WorkspaceSearch.parse({ f: "g:bar;ns" }).f).toBe("g:bar;ns");
		expect(WorkspaceSearch.parse({ f: "<script>" }).f).toBeUndefined();
	});
});
