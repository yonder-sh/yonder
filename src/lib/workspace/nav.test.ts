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
			state(N.japan ?? null, { lens: "city", sel: `n.${N.tokyo}` }),
			N.tokyo as string,
		);
		expect(t.splat).toBe("japan/tokyo");
		// Area is Tokyo's own lens: the URL names only a choice.
		expect(t.search).toEqual({});
		// With a day in view the lens stays as it was (none: the day's place lens).
		const d = nav.zoomIn(
			state(N.japan ?? null, { days: "2027-10-03" }),
			N.tokyo as string,
		);
		expect(d.search).toEqual({ days: "2027-10-03" });
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
		// A chosen lens stays when the day goes.
		const s2 = nav.escapeChain(state(N.tokyo ?? null, s1?.search));
		expect(s2?.search).toEqual({ lens: "area" });
		const s3 = nav.escapeChain(state(N.tokyo ?? null, s2?.search));
		expect(s3?.splat).toBe("japan");
	});

	it("Fill this day opens the day with its ideas; All days closes them (D04)", () => {
		const t = nav.fillDay(state(null), "2027-10-05");
		expect(t.search).toEqual({ days: "2027-10-05", fill: 1 });
		expect(tabOf(null, t.search)).toBe("plan");
		expect(
			nav.fillDay(state(null, t.search), null).search.fill,
		).toBeUndefined();
		const all = nav.setDays(state(null, t.search), null);
		expect(all.search.fill).toBeUndefined();
	});

	it("a change of days keeps the URL's lens (none: the workspace picks the day's, D03)", () => {
		const tokyo = N.tokyo ?? null;
		const day = { from: "2027-10-03", to: "2027-10-03" };
		expect(nav.setDays(state(tokyo), day).search).toEqual({
			days: "2027-10-03",
		});
		expect(nav.setDays(state(tokyo, { lens: "area" }), day).search).toEqual({
			lens: "area",
			days: "2027-10-03",
		});
		expect(
			nav.setDays(state(tokyo, { lens: "place", days: "2027-10-03" }), null)
				.search,
		).toEqual({ lens: "place" });
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
			"fillDay",
			"openPlaces",
			"setDays",
			"setTab",
			"showMedia",
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

describe("Today during the trip (One Yonder phase 5)", () => {
	const on = (scopeId: string | null, search: WorkspaceSearch = {}) => ({
		...state(scopeId, search),
		underway: true,
	});
	const tab = (t: nav.NavTarget, scopeId: string | null) =>
		tabOf(scopeId, t.search, true);

	it("a bare trip link is Today; Overview and Plan links keep working", () => {
		expect(tabOf(null, {}, true)).toBe("today");
		expect(tabOf(null, { tab: "overview" }, true)).toBe("overview");
		expect(tabOf(null, { tab: "plan" }, true)).toBe("plan");
		expect(tabOf(null, { days: "2027-10-05" }, true)).toBe("plan");
		expect(tabOf(N.tokyo ?? null, {}, true)).toBe("plan");
		// Outside the trip a Today link shows the Overview.
		expect(tabOf(null, { tab: "today" })).toBe("overview");
	});

	it("the Overview is named in the URL; Today is the bare link", () => {
		const ov = nav.setTab(on(null), "overview");
		expect(ov.search).toEqual({ tab: "overview" });
		const back = nav.setTab(on(null, ov.search), "today");
		expect(back.search).toEqual({});
		// From a place: the trip root, without a selection or days.
		const t = nav.setTab(
			on(N.tokyo ?? null, { sel: "root", days: "2027-10-05" }),
			"today",
		);
		expect(t.splat).toBe("");
		expect(tab(t, null)).toBe("today");
		expect(t.search.days).toBeUndefined();
	});

	it("a selection opens its details over Today; going somewhere opens the Plan", () => {
		const s0 = on(null);
		const item = demoGraph.items[0]?.id ?? "";
		const picked = nav.select(s0, { kind: "item", id: item });
		expect(picked.search).toEqual({ tab: "today", sel: `i.${item}` });
		expect(tab(picked, null)).toBe("today");
		// Closing the details stays on Today.
		const closed = nav.escapeChain(on(null, picked.search));
		expect(closed && tab(closed, null)).toBe("today");
		const tokyo = N.tokyo ?? "";
		expect(tab(nav.zoomIn(s0, tokyo), tokyo)).toBe("plan");
		expect(
			tab(nav.setDays(s0, { from: "2027-10-05", to: "2027-10-05" }), null),
		).toBe("plan");
	});
});

describe("retired Media and Notes tabs (One Yonder)", () => {
	it("open the scope's details at that section, or the selection's", () => {
		const t = nav.openDetails(
			state(N.tokyo ?? null, { tab: "notes" }),
			"notes",
		);
		expect(t.search.sel).toBe(`n.${N.tokyo}`);
		expect(t.search.itab).toBe("notes");
		expect(t.search.tab).toBeUndefined();
		const root = nav.openDetails(state(null, { tab: "media" }), "media");
		expect(root.search.sel).toBe("root");
		expect(root.search.itab).toBe("media");
		const picked = nav.openDetails(
			state(N.tokyo ?? null, { tab: "media", sel: `n.${N.shibuyaSky}` }),
			"media",
		);
		expect(picked.search.sel).toBe(`n.${N.shibuyaSky}`);
	});
});
