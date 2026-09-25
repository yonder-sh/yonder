/**
 * Navigation semantics (SPEC §8.5), as pure functions from the current
 * workspace state to the next URL (scope splat + search). `useWorkspace().nav`
 * wraps them with the router; tests can call them directly.
 *
 * - zoomIn(node): scope = node; lens = the next finer level if usable there,
 *   else the new scope's default; `sel` cleared; `days` kept.
 * - zoomOut(): scope = parent (or root); lens = the next coarser level if
 *   usable, else the default.
 * - Esc: clears `sel`, then `days`, then zooms out.
 * - The tab stays what it was across every step (`withTab`), whatever the
 *   default for the new URL would be (the Overview is the default only at a
 *   bare trip root, `defaultTab`). The Overview is trip-level: zooming into a
 *   place, selecting something or picking days from it opens the Plan.
 */
import type { GraphIndex } from "@/lib/engine/graph-index";
import {
	lensAfterZoomIn,
	lensAfterZoomOut,
	resolveLens,
	stepLens as stepLensPure,
} from "@/lib/engine/lens";
import { slugPath } from "@/lib/engine/tree";
import type { DayRange, Lens } from "@/lib/engine/types";
import { serializeFilter, type WorkspaceFilter } from "./filter";
import {
	extendRange,
	type InspectorTabParam,
	type Sel,
	serializeDays,
	serializeSel,
	type Tab,
	tabOf,
	tabParam,
	type WorkspaceSearch,
} from "./search";

export type NavTarget = { splat: string; search: WorkspaceSearch };

/**
 * Which nav actions REPLACE the current history entry (view tweaks) instead of
 * pushing one. Scope changes, day ranges and tabs push, so browser Back walks
 * back through them without leaving the trip (QA MOB-02).
 */
export const REPLACES_HISTORY = {
	zoomIn: false,
	zoomOut: false,
	zoomTo: false,
	setTab: false,
	setDays: false,
	extendDays: false,
	escape: false,
	setLens: true,
	stepLens: true,
	select: true,
	setOnly: true,
	setWho: true,
	setFilter: true,
	setMediaFilter: true,
	setList: true,
	setInspectorTab: true,
	setPlaces: true,
	openPlaces: false,
} as const;

export type NavState = {
	ix: GraphIndex;
	scopeId: string | null;
	lens: Lens;
	search: WorkspaceSearch;
	days: DayRange | null;
};

/** The URL tail for a scope (`japan/tokyo`), '' for the root. */
export function splatFor(ix: GraphIndex, nodeId: string | null): string {
	return nodeId ? slugPath(ix, nodeId).join("/") : "";
}

/** Drops undefined keys so URLs stay short (`?lens=area`, not `?lens=area&tab=`). */
export function cleanSearch(s: WorkspaceSearch): WorkspaceSearch {
	return Object.fromEntries(
		Object.entries(s).filter(([, v]) => v !== undefined),
	) as WorkspaceSearch;
}

/** The tab the current URL shows. */
const tabNow = (s: NavState): Tab => tabOf(s.scopeId, s.search);

/** `t` showing `tab` at `scopeId` (the `tab` param only when it isn't the default there). */
function withTab(t: NavTarget, scopeId: string | null, tab: Tab): NavTarget {
	const rest = { ...t.search, tab: undefined };
	return {
		splat: t.splat,
		search: cleanSearch({ ...rest, tab: tabParam(scopeId, tab, rest) }),
	};
}

/** The Overview is trip-level: going somewhere specific from it opens the Plan. */
const fromOverview = (tab: Tab, specific: boolean): Tab =>
	tab === "overview" && specific ? "plan" : tab;

export function zoomIn(s: NavState, nodeId: string): NavTarget {
	return withTab(
		{
			splat: splatFor(s.ix, nodeId),
			search: cleanSearch({
				...s.search,
				lens: lensAfterZoomIn(s.ix, s.lens, nodeId),
				sel: undefined,
				itab: undefined,
			}),
		},
		nodeId,
		fromOverview(tabNow(s), true),
	);
}

/** Null at the trip root (nothing to zoom out to). */
export function zoomOut(s: NavState): NavTarget | null {
	if (!s.scopeId) return null;
	const parentId = s.ix.node(s.scopeId)?.parentId ?? null;
	return withTab(
		{
			splat: splatFor(s.ix, parentId),
			search: cleanSearch({
				...s.search,
				lens: lensAfterZoomOut(s.ix, s.lens, parentId),
				sel: undefined,
				itab: undefined,
			}),
		},
		parentId,
		fromOverview(tabNow(s), parentId !== null),
	);
}

export function zoomTo(
	s: NavState,
	nodeId: string | null,
	opts: { lens?: Lens } = {},
): NavTarget {
	return withTab(
		{
			splat: splatFor(s.ix, nodeId),
			search: cleanSearch({
				...s.search,
				lens: resolveLens(s.ix, nodeId, opts.lens ?? null),
				sel: undefined,
				itab: undefined,
			}),
		},
		nodeId,
		fromOverview(tabNow(s), nodeId !== null),
	);
}

/**
 * The current scope with `patch`, on the same tab (or the Plan, when the
 * patch goes somewhere specific from the Overview: `toPlan`).
 */
const here = (
	s: NavState,
	patch: Partial<WorkspaceSearch>,
	toPlan = false,
): NavTarget =>
	withTab(
		{
			splat: splatFor(s.ix, s.scopeId),
			search: cleanSearch({ ...s.search, ...patch }),
		},
		s.scopeId,
		patch.tab ?? fromOverview(tabNow(s), toPlan),
	);

export const setLens = (s: NavState, lens: Lens) => here(s, { lens });

export const stepLens = (s: NavState, dir: 1 | -1) =>
	here(s, { lens: stepLensPure(s.ix, s.scopeId, s.lens, dir) });

/**
 * A new selection opens on its Overview (FB-21b: `itab` goes with the old
 * one). Selecting something from the trip Overview opens it in the Plan.
 */
export const select = (s: NavState, sel: Sel | null) => {
	const next = serializeSel(sel);
	return here(
		s,
		{
			sel: next,
			itab: next === s.search.sel ? s.search.itab : undefined,
		},
		next !== undefined,
	);
};

/** The inspector's tab (`itab`, FB-21b; replace navigation). Overview drops it. */
export const setInspectorTab = (s: NavState, tab: InspectorTabParam) =>
	here(s, { itab: tab === "overview" ? undefined : tab });

/**
 * A centre tab. The Overview is the whole trip's: from a place it goes to
 * the trip root, and it drops the selection and the day range.
 */
export function setTab(s: NavState, tab: Tab): NavTarget {
	if (tab !== "overview") return here(s, { tab });
	const base = s.scopeId
		? zoomTo(s, null)
		: here(s, { sel: undefined, itab: undefined });
	const search = { ...base.search, days: undefined, sel: undefined };
	return withTab({ splat: base.splat, search }, null, "overview");
}

export const setDays = (s: NavState, range: DayRange | null) =>
	here(s, { days: serializeDays(range) }, range !== null);

export const extendDays = (s: NavState, date: string) =>
	here(s, { days: serializeDays(extendRange(s.days, date)) }, true);

export const setOnly = (s: NavState, only: boolean) =>
	here(s, { only: only ? 1 : undefined });

export const setWho = (s: NavState, memberId: string | null) =>
	here(s, { who: memberId ?? undefined });

/** The shared place filter (`f`, ADDENDUM §10); an empty filter drops the param. */
export const setFilter = (s: NavState, f: WorkspaceFilter | null) =>
	here(s, { f: serializeFilter(f) });

/** The media filter (`mf`, WP-Media); null shows everything. */
export const setMediaFilter = (s: NavState, mf: WorkspaceSearch["mf"] | null) =>
	here(s, { mf: mf ?? undefined });

/** The Lists tab's list (`list`); null = the default (to-dos). */
export const setList = (s: NavState, list: WorkspaceSearch["list"] | null) =>
	here(s, { list: list ?? undefined });

/** The Esc chain: selection, then the day range, then zoom out. Null = nothing to do. */
export function escapeChain(s: NavState): NavTarget | null {
	if (s.search.sel) return here(s, { sel: undefined, itab: undefined });
	if (s.search.days) return here(s, { days: undefined });
	return zoomOut(s);
}

// ---------------------------------------------------------------------------
// The Places tab (docs/PLACES.md §1)
// ---------------------------------------------------------------------------

/** The Places tab's own URL state (plus the shared filter and the drawer). */
export type PlacesPatch = Partial<
	Pick<
		WorkspaceSearch,
		"pv" | "pg" | "ps" | "pst" | "talk" | "po" | "f" | "sel"
	>
>;

const PLACES_DEFAULTS = {
	pv: "table",
	pg: "city",
	ps: "priority",
	po: "mixed",
} as const;

/** Defaults are left out of the URL (`?tab=places`, not `&pv=table&pg=city`). */
function placesSearch(patch: PlacesPatch): PlacesPatch {
	const out: PlacesPatch = { ...patch };
	for (const [k, d] of Object.entries(PLACES_DEFAULTS))
		if (out[k as keyof typeof PLACES_DEFAULTS] === d)
			out[k as keyof typeof PLACES_DEFAULTS] = undefined;
	return out;
}

/** Change the Places view state in place (replace navigation). */
export const setPlaces = (s: NavState, patch: PlacesPatch) =>
	here(s, { ...placesSearch(patch), tab: "places" });

/**
 * Open the Places tab (push): at another scope (`scopeId`, null = the whole
 * trip), with a view and filters. Other Places state is kept unless the
 * patch changes it; `sel` is cleared unless given.
 */
export function openPlaces(
	s: NavState,
	opts: { scopeId?: string | null; patch?: PlacesPatch } = {},
): NavTarget {
	const stay = opts.scopeId === undefined || opts.scopeId === s.scopeId;
	const base = stay
		? here(s, { sel: undefined, itab: undefined })
		: zoomTo(s, opts.scopeId ?? null);
	return withTab(
		{
			splat: base.splat,
			search: cleanSearch({
				...base.search,
				...placesSearch(opts.patch ?? {}),
			}),
		},
		stay ? s.scopeId : (opts.scopeId ?? null),
		"places",
	);
}
