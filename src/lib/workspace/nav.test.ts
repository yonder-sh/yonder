import { describe, expect, it } from "vitest";
import { indexGraph } from "@/lib/engine/graph-index";
import { resolveLens } from "@/lib/engine/lens";
import { demoGraph, N } from "@/lib/fixtures/demo";
import { EMPTY_FILTER, parseFilter } from "./filter";
import * as nav from "./nav";
import { parseDays, tabOf, type WorkspaceSearch } from "./search";

const ix = indexGraph(demoGraph);
const state = (
	scopeId: string | null,
	search: WorkspaceSearch = {},
): nav.NavState => ({
	ix,
	scopeId,
	lens: resolveLens(ix, scopeId, search.lens),
	search,
	days: parseDays(search.days),
});

describe("navigation semantics (SPEC §8.5)", () => {
	it("zoomIn: scope = node, next finer lens, sel cleared, days kept", () => {
		const t = nav.zoomIn(
			state(N.japan ?? null, {
				lens: "city",
				sel: `n.${N.tokyo}`,
				days: "2027-10-03",
			}),
			N.tokyo as string,
		);
		expect(t.splat).toBe("japan/tokyo");
		expect(t.search).toEqual({ lens: "area", days: "2027-10-03" });
	});

	it("zoomOut: parent scope, next coarser lens", () => {
		const t = nav.zoomOut(state(N.tokyo ?? null, { lens: "area" }));
		expect(t?.splat).toBe("japan");
		expect(t?.search.lens).toBe("city");
		expect(nav.zoomOut(state(null))).toBeNull();
	});

	it("Esc clears sel, then days, then zooms out", () => {
		const s0 = state(N.tokyo ?? null, {
			lens: "area",
			sel: "root",
			days: "2027-10-03",
		});
		const s1 = nav.escapeChain(s0);
		expect(s1?.search).toEqual({ lens: "area", days: "2027-10-03" });
		const s2 = nav.escapeChain(state(N.tokyo ?? null, s1?.search));
		expect(s2?.search).toEqual({ lens: "area" });
		const s3 = nav.escapeChain(state(N.tokyo ?? null, s2?.search));
		expect(s3?.splat).toBe("japan");
	});

	it("stepLens skips levels that aren't usable and stays at the ends", () => {
		expect(
			nav.stepLens(state(N.tokyo ?? null, { lens: "area" }), 1).search.lens,
		).toBe("place");
		expect(
			nav.stepLens(state(N.tokyo ?? null, { lens: "place" }), 1).search.lens,
		).toBe("place");
	});

	it("setTab omits the default; setOnly writes 1 or nothing", () => {
		// The Plan is the default inside a place…
		expect(
			nav.setTab(state(N.tokyo ?? null, { tab: "media" }), "plan").search.tab,
		).toBeUndefined();
		// …the Overview at a bare trip root (docs/OVERVIEW.md).
		expect(nav.setTab(state(null, { tab: "media" }), "plan").search.tab).toBe(
			"plan",
		);
		expect(nav.setTab(state(null, { tab: "plan" }), "overview").search).toEqual(
			{},
		);
		expect(nav.setOnly(state(null), true).search.only).toBe(1);
		expect(
			nav.setOnly(state(null, { only: 1 }), false).search.only,
		).toBeUndefined();
	});

	it("setFilter keeps scope, lens, days and sel; an empty filter drops f", () => {
		const s0 = state(N.tokyo ?? null, {
			lens: "area",
			days: "2027-10-03",
			sel: "root",
			f: "ns",
		});
		const t = nav.setFilter(s0, parseFilter("g:food_drink;p:want"));
		expect(t.splat).toBe("japan/tokyo");
		expect(t.search).toEqual({
			lens: "area",
			days: "2027-10-03",
			sel: "root",
			f: "g:food_drink;p:want",
		});
		expect(nav.setFilter(s0, EMPTY_FILTER).search.f).toBeUndefined();
		expect(nav.setFilter(s0, null).search.f).toBeUndefined();
	});

	it("setMediaFilter and setList write or drop their params", () => {
		expect(nav.setMediaFilter(state(null), "documents").search.mf).toBe(
			"documents",
		);
		expect(
			nav.setMediaFilter(state(null, { mf: "photos" }), null).search.mf,
		).toBeUndefined();
		expect(nav.setList(state(null), "shopping").search.list).toBe("shopping");
		expect(
			nav.setList(state(null, { list: "shopping" }), null).search.list,
		).toBeUndefined();
	});
});

describe("history (QA MOB-02)", () => {
	it("tabs, scopes and day ranges push; view tweaks replace", () => {
		const push = Object.entries(nav.REPLACES_HISTORY)
			.filter(([, replace]) => !replace)
			.map(([k]) => k)
			.sort();
		expect(push).toEqual([
			"escape",
			"extendDays",
			"openPlaces",
			"setDays",
			"setTab",
			"zoomIn",
			"zoomOut",
			"zoomTo",
		]);
	});
});

describe("the Overview tab (docs/OVERVIEW.md)", () => {
	const tab = (t: nav.NavTarget, scopeId: string | null) =>
		tabOf(scopeId, t.search);

	it("is the default only at a bare trip root; Plan links keep opening the Plan", () => {
		expect(tabOf(null, {})).toBe("overview");
		expect(tabOf(null, { tab: "plan" })).toBe("plan");
		// A day, a selection or a lens is the Plan's own view state.
		expect(tabOf(null, { days: "2027-10-05" })).toBe("plan");
		expect(tabOf(null, { sel: "root" })).toBe("plan");
		expect(tabOf(null, { lens: "city" })).toBe("plan");
		expect(tabOf(N.tokyo ?? null, {})).toBe("plan");
	});

	it("going somewhere specific from it opens the Plan", () => {
		const s0 = state(null);
		const tokyo = N.tokyo ?? "";
		expect(tab(nav.zoomIn(s0, tokyo), tokyo)).toBe("plan");
		expect(tab(nav.select(s0, { kind: "node", id: tokyo }), null)).toBe("plan");
		expect(
			tab(nav.setDays(s0, { from: "2027-10-05", to: "2027-10-06" }), null),
		).toBe("plan");
		// The account's default lens applies on open: the Overview stays.
		const lensed = nav.setLens(s0, "city");
		expect(lensed.search).toMatchObject({ lens: "city", tab: "overview" });
	});

	it("the tab stays put when a step would change the default", () => {
		// The Plan at the root with a day range: clearing the days stays on the Plan.
		const t = nav.escapeChain(state(null, { days: "2027-10-05" }));
		expect(t?.search).toEqual({ tab: "plan" });
		// Zooming out to the root from a place's Plan stays on the Plan.
		const out = nav.zoomOut(state(N.tokyo ?? null));
		expect(out && tab(out, null)).toBe("plan");
	});

	it("opening it from a place goes to the trip root, without a selection or days", () => {
		const t = nav.setTab(
			state(N.tokyo ?? null, { sel: "root", days: "2027-10-05" }),
			"overview",
		);
		expect(t.splat).toBe("");
		expect(t.search.sel).toBeUndefined();
		expect(t.search.days).toBeUndefined();
		expect(tab(t, null)).toBe("overview");
	});
});
