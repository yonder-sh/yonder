/**
 * The shared place filter as React state (ADDENDUM §10): `Workspace.filter`
 * (F parses `?f=`) written back with `nav.setFilter` (a `replace`
 * navigation), so the Outline, Ideas, the map (WP-Map) and the Rate screen
 * stay in step and the view is a deep link. The rules live in
 * `@/lib/workspace/filter-match`.
 */
import { useCallback, useMemo } from "react";
import { EMPTY_FILTER, type WorkspaceFilter } from "@/lib/workspace/filter";
import {
	type FilterContext,
	filterContextOf,
	isActiveFilter,
	visibleUnderFilter,
} from "@/lib/workspace/filter-match";
import { useWorkspace } from "@/lib/workspace/use-workspace";

export function usePlaceFilter(): {
	filter: WorkspaceFilter;
	active: boolean;
	ctx: FilterContext;
	setFilter(next: WorkspaceFilter): void;
	clear(): void;
} {
	const { filter, access, ix, nav } = useWorkspace();
	const ctx = useMemo(
		() => filterContextOf(ix, access.memberId),
		[ix, access.memberId],
	);
	const setFilter = useCallback(
		(next: WorkspaceFilter) => nav.setFilter(next),
		[nav],
	);
	const clear = useCallback(() => nav.setFilter(EMPTY_FILTER), [nav]);
	return {
		filter,
		active: isActiveFilter(filter, access.memberId),
		ctx,
		setFilter,
		clear,
	};
}

/** The Outline's visible set under the filter (memoized per graph + filter). */
export function useFilterVisibility() {
	const { ix } = useWorkspace();
	const pf = usePlaceFilter();
	const vis = useMemo(
		() => visibleUnderFilter(ix, pf.filter, pf.ctx),
		[ix, pf.filter, pf.ctx],
	);
	return { ...pf, vis };
}
