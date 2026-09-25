import { describe, expect, it } from "vitest";
import { indexGraph } from "@/lib/engine/graph-index";
import { demo, N } from "@/lib/fixtures/demo";
import { quickExpenseTarget } from "./bundle-target";

const ix = indexGraph(demo.graph);

describe("quickExpenseTarget (the phone FAB, MONEY-QA-05)", () => {
	it("defaults to the scope, like the desktop Money tab", () => {
		expect(quickExpenseTarget(ix, null, N.kyoto ?? null)).toEqual({
			kind: "node",
			nodeId: N.kyoto,
		});
	});

	it("is trip-wide only at the root", () => {
		expect(quickExpenseTarget(ix, null, null)).toEqual({ kind: "trip" });
		expect(quickExpenseTarget(ix, { kind: "root" }, null)).toEqual({
			kind: "trip",
		});
	});

	it("a selection wins over the scope", () => {
		const day = demo.graph.days[0]?.id ?? "";
		expect(
			quickExpenseTarget(ix, { kind: "day", id: day }, N.kyoto ?? null),
		).toEqual({ kind: "day", dayId: day });
		expect(
			quickExpenseTarget(
				ix,
				{ kind: "node", id: N.kiyomizu ?? "" },
				N.kyoto ?? null,
			),
		).toEqual({ kind: "node", nodeId: N.kiyomizu });
	});

	it("a leg with no row yet falls back to the scope", () => {
		expect(
			quickExpenseTarget(
				ix,
				{
					kind: "leg",
					target: {
						kind: "pair",
						fromItemId: "00000000-0000-7000-8000-00000000aaaa",
						toItemId: "00000000-0000-7000-8000-00000000bbbb",
					},
				},
				N.kyoto ?? null,
			),
		).toEqual({ kind: "node", nodeId: N.kyoto });
	});
});
