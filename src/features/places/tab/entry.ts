/**
 * Ways into the Places tab (docs/PLACES.md §1b; the old Rate screen folded
 * in): the old `/t/<trip>/rate` search → the tab's search, and the shared
 * filters the entry points build. Pure.
 */
import {
	EMPTY_FILTER,
	parseFilter,
	serializeFilter,
} from "@/lib/workspace/filter";
import type { WorkspaceSearch } from "@/lib/workspace/search";

/** The shared filter "unrated by me / by a member" (`f=u:me`). */
export function unratedFilter(by: string): string | undefined {
	return serializeFilter({ ...EMPTY_FILTER, unratedBy: by });
}

/** The old Rate screen's search (`/t/<trip>/rate?view=&f=&n=&in=&set=`). */
export type LegacyRateSearch = {
	view?: "cards" | "table" | "compare";
	f?: string;
	n?: string;
	in?: string;
	set?: "ideas";
};

/**
 * Where `/t/<trip>/rate?…` goes now: the Places tab at the `in` scope, in
 * Rate view (the cards) or the Table (table / compare, by priority), keeping
 * its filter. `n` (a card) opens on that place; `in` a PLACE (its own Rate
 * link) opens its parent's scope on it. `set=ideas` is the Ideas pill.
 */
export function placesFromRate(
	s: LegacyRateSearch,
	parentOf: (
		id: string,
	) => { id: string; type: string; parentId: string | null } | undefined,
): { scopeId: string | null; search: WorkspaceSearch } {
	const inNode = s.in ? parentOf(s.in) : undefined;
	const inPlace = inNode?.type === "place" && s.set !== "ideas";
	const scopeId = inPlace ? (inNode?.parentId ?? null) : (inNode?.id ?? null);
	const focus = s.n ?? (inPlace ? inNode?.id : undefined);
	const table = s.view === "table" || s.view === "compare";
	// "Rate ideas →" sent "not scheduled" along; the Ideas pill says it now.
	const f =
		s.set === "ideas"
			? serializeFilter({ ...parseFilter(s.f), notScheduled: false })
			: s.f;
	const search: WorkspaceSearch = {
		tab: "places",
		...(table ? {} : { pv: "rate" as const }),
		...(f ? { f } : {}),
		...(s.set === "ideas" ? { pst: "idea" as const } : {}),
		...(focus ? { sel: `n.${focus}` } : {}),
	};
	return { scopeId, search };
}
