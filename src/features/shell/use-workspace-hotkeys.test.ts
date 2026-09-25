import { describe, expect, it } from "vitest";
import { indexGraph } from "@/lib/engine/graph-index";
import { demo, N } from "@/lib/fixtures/demo";
import { planStops, stepStop } from "./use-workspace-hotkeys";

const ix = indexGraph(demo.graph);
const I = demo.I as Record<string, string>;

describe("J / K through the plan", () => {
	it("steps through the scope's stops in trip order", () => {
		const kyoto = planStops(ix, N.kyoto ?? null, null);
		expect(kyoto).toEqual([I.kiyomizu]);
		const all = planStops(ix, null, null);
		expect(all.slice(0, 3)).toEqual([I.hands, I.loft, I.lunch1]);
		expect(stepStop(all, null, 1)).toBe(I.hands);
		expect(stepStop(all, null, -1)).toBe(all.at(-1));
		expect(stepStop(all, { kind: "item", id: I.hands ?? "" }, 1)).toBe(I.loft);
		expect(stepStop(all, { kind: "item", id: I.hands ?? "" }, -1)).toBeNull();
	});

	it("a day range narrows the stops", () => {
		const d2 = planStops(ix, null, { from: "2027-10-04", to: "2027-10-04" });
		expect(d2).toEqual([I.sensoji, I.knives, I.itoya]);
		expect(stepStop([], null, 1)).toBeNull();
	});
});
