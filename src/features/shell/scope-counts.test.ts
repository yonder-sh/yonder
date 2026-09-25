import { describe, expect, it } from "vitest";
import { indexGraph } from "@/lib/engine/graph-index";
import type { Counts, TripCounts } from "@/lib/engine/types";
import { demo, N } from "@/lib/fixtures/demo";
import { rollupCounts, targetCounts } from "./scope-counts";

const ix = indexGraph(demo.graph);
const c = (p: Partial<Counts>): Counts => ({
	media: 0,
	links: 0,
	docs: 0,
	todoOpen: 0,
	todo: 0,
	shopOpen: 0,
	shop: 0,
	hasNote: false,
	...p,
});
const counts: TripCounts = {
	root: c({ todoOpen: 1, hasNote: true }),
	byNode: {
		[N.shibuyaSky as string]: c({ media: 2, links: 1 }),
		[N.kiyomizu as string]: c({ media: 5 }),
		[N.tokyo as string]: c({ shopOpen: 1 }),
	},
	byItem: { [demo.I.itoya as string]: c({ docs: 1 }) },
	byLeg: { [demo.L.fuji as string]: c({ todoOpen: 2 }) },
	byDay: { [demo.D.d4 as string]: c({ todoOpen: 3 }) },
};
const opts = {
	lens: "area" as const,
	includeDescendants: true,
	dayRange: null,
};

describe("tab counts follow the rollup rules (SPEC §8.4)", () => {
	it("the root counts everything, the trip itself included", () => {
		expect(rollupCounts(ix, counts, { ...opts, scopeId: null })).toEqual({
			media: 2 + 1 + 5 + 1,
			lists: 1 + 1 + 2 + 3,
			notes: true,
		});
	});

	it("Tokyo counts its places, items, the legs leaving it and its days", () => {
		const r = rollupCounts(ix, counts, { ...opts, scopeId: N.tokyo ?? null });
		// Shibuya Sky (3), Itoya's PDF (1); Tokyo's shopping (1) and the Fuji leg from Itoya (2).
		expect(r).toEqual({ media: 4, lists: 3, notes: false });
	});

	it("Only Tokyo counts Tokyo's own bundle", () => {
		const r = rollupCounts(ix, counts, {
			...opts,
			scopeId: N.tokyo ?? null,
			includeDescendants: false,
		});
		expect(r).toEqual({ media: 0, lists: 1, notes: false });
	});

	it("a day range narrows to that day's targets", () => {
		const r = rollupCounts(ix, counts, {
			...opts,
			scopeId: null,
			dayRange: { from: "2027-10-06", to: "2027-10-06" },
		});
		// Day 4: Kiyomizu (5 photos) and the day's own to-dos (3).
		expect(r).toEqual({ media: 5, lists: 3, notes: false });
	});

	it("one target's own counts", () => {
		expect(
			targetCounts(counts, { kind: "leg", legId: demo.L.fuji ?? "" }),
		).toEqual({
			media: 0,
			lists: 2,
			notes: false,
		});
		expect(targetCounts(undefined, { kind: "trip" }).media).toBe(0);
	});
});
