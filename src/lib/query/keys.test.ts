import { describe, expect, it } from "vitest";
import { keysToInvalidate, meKeys, TRIP_KEYS, tripKeys } from "./keys";

const T = "t1";

describe("tripKeys", () => {
	it("nests every trip query under ['trip', id, key]", () => {
		for (const k of TRIP_KEYS)
			expect(tripKeys.byKey(T, k)).toEqual(["trip", T, k]);
		expect(tripKeys.graph(T)).toEqual(["trip", T, "graph"]);
		expect(tripKeys.activity(T, "n.x")).toEqual(["trip", T, "activity", "n.x"]);
		expect(tripKeys.leg(T, "l.a.b").slice(0, 3)).toEqual(tripKeys.legs(T));
		expect(tripKeys.graph(T).slice(0, 2)).toEqual(tripKeys.trip(T));
	});

	it("maps graph to legs too, and lists to the dashboard deadlines", () => {
		expect(keysToInvalidate(T, "graph")).toEqual([
			tripKeys.graph(T),
			tripKeys.legs(T),
		]);
		expect(keysToInvalidate(T, "lists")).toEqual([
			tripKeys.lists(T),
			meKeys.deadlines,
			meKeys.inbox,
		]);
		expect(keysToInvalidate(T, "media")).toEqual([tripKeys.media(T)]);
	});

	it("refreshes the one inbox on proposals and money (ADDENDUM §10)", () => {
		expect(keysToInvalidate(T, "proposals")).toEqual([
			tripKeys.proposals(T),
			meKeys.inbox,
		]);
		expect(keysToInvalidate(T, "money")).toEqual([
			tripKeys.money(T),
			meKeys.inbox,
		]);
	});
});
