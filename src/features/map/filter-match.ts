/**
 * The shared place filter on the map (ADDENDUM §10 "Filters"; the `f` URL
 * param, `@/lib/workspace/filter`). The per-node rules are F's shared matcher
 * (`@/lib/workspace/filter-match`, the same one the Outline, Ideas and the
 * Rate screen use). The map adds how a filter reads on pins:
 *
 * - a **place** pin matches when the place itself matches;
 * - a **coarser pin** (a city, an area…) matches when any live place inside it
 *   matches, so a city stays lit while it holds something you asked for.
 */
import type { GraphIndex } from "@/lib/engine/graph-index";
import type { WorkspaceFilter } from "@/lib/workspace/filter";
import {
	type FilterContext,
	filterContextOf,
	isActiveFilter,
	matchesFilter,
} from "@/lib/workspace/filter-match";

export type MapFilterContext = {
	ix: GraphIndex;
	/** The viewer's member id (`u:me`); null for link guests, who can't rate. */
	meMemberId: string | null;
};

const ctxOf = (c: MapFilterContext): FilterContext =>
	filterContextOf(c.ix, c.meMemberId);

/** Does the filter restrict anything for this viewer? */
export const filterActive = (f: WorkspaceFilter, c: MapFilterContext) =>
	isActiveFilter(f, c.meMemberId);

/**
 * A matcher for pins: `repId → boolean`, memoising the subtree walk. Coarser
 * reps match when the rep itself or any live, active descendant matches.
 * Always `true` for an inactive filter.
 */
export function pinMatcher(
	f: WorkspaceFilter,
	c: MapFilterContext,
): (repId: string) => boolean {
	if (!filterActive(f, c)) return () => true;
	const ctx = ctxOf(c);
	const memo = new Map<string, boolean>();
	const test = (id: string): boolean => {
		const hit = memo.get(id);
		if (hit !== undefined) return hit;
		const node = c.ix.node(id);
		let ok = false;
		if (node) {
			if (node.status === "active" && matchesFilter(node, f, ctx)) ok = true;
			else if (node.type !== "place" || f.groups.length === 0) {
				for (const child of c.ix.children(id)) {
					if (child.status !== "active") continue;
					if (test(child.id)) {
						ok = true;
						break;
					}
				}
			}
		}
		memo.set(id, ok);
		return ok;
	};
	return test;
}

/** How many places in the scope match (for the "4 of 7 places" chip). */
export function countMatchingPlaces(
	f: WorkspaceFilter,
	c: MapFilterContext,
	scopeId: string | null,
): { match: number; total: number } {
	const ctx = ctxOf(c);
	const nodes = scopeId ? c.ix.hierarchy.descendants(scopeId) : c.ix.outline;
	let match = 0;
	let total = 0;
	for (const n of nodes) {
		if (n.type !== "place" || n.status !== "active" || c.ix.isDropped(n.id))
			continue;
		total += 1;
		if (matchesFilter(n, f, ctx)) match += 1;
	}
	return { match, total };
}
