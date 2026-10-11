import { describe, expect, it } from "vitest";
import { keysForOp } from "../use-proposal-actions";

describe("keysForOp", () => {
	it("an accepted day removal or new dates refresh what moves with the days", () => {
		for (const op of ["day.delete", "trip.dates"] as const)
			expect(keysForOp(op)).toEqual(
				expect.arrayContaining(["graph", "lists", "media", "notes", "money"]),
			);
		expect(keysForOp("list.update")).toEqual(["lists", "counts", "activity"]);
		expect(keysForOp("item.update")).toEqual(["graph", "counts", "activity"]);
	});
});
