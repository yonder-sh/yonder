/**
 * Matching for the shared place filter (ADDENDUM §10 "Filters"; the URL format
 * is `./filter.ts`). One filter drives the Outline, Ideas, the map and the Rate
 * screen, so the rules live here, once (moved from WP-Outline's
 * `features/outline/filter-match.ts` unchanged, CONTRACT_REQUESTS WP-Outline #2).
 *
 * Rules:
 * - **Category groups** (`g:`) only ever match places (a city has no category).
 * - **Minimum priority** (`p:` + `by:`) reads either the highest rating of any
 *   member (`max`, the owner's ranking rule, SPEC §7.3) or one member's. An
 *   unrated node never passes a priority floor ("absent, not 0").
 * - **Unrated by** (`u:`) keeps nodes that member hasn't rated; `me` resolves to
 *   the viewer's member id (a link guest has none, so it is ignored).
 * - **Not scheduled** (`ns`) keeps nodes with no live item on a day
 *   (`ix.scheduledNodeIds`: stays and ancestors of scheduled places count as
 *   scheduled, like the map's dots).
 *
 * Pure: no React. `filterContextOf(ix, memberId)` builds the usual context.
 */
import {
	PLACE_CATEGORIES,
	PLACE_GROUPS,
	type PlaceGroup,
	PRIORITIES,
} from "@/lib/domain/taxonomy";
import type { GraphIndex } from "@/lib/engine/graph-index";
import type { GraphMember, GraphNode, Priority } from "@/lib/engine/types";
import type { WorkspaceFilter } from "./filter";

export type FilterContext = {
	/** The viewer's member id (`u:me`); null for link guests. */
	meMemberId: string | null;
	/** Node ids with a scheduled item (and stays, and their ancestors). */
	scheduled: ReadonlySet<string>;
};

/** The context every surface uses: the viewer and `ix.scheduledNodeIds`. */
export function filterContextOf(
	ix: Pick<GraphIndex, "scheduledNodeIds">,
	meMemberId: string | null,
): FilterContext {
	return { meMemberId, scheduled: ix.scheduledNodeIds };
}

/** The filter group of a place (null for non-places and `other`). */
export function groupOf(
	node: Pick<GraphNode, "type" | "category">,
): PlaceGroup | null {
	if (node.type !== "place" || !node.category) return null;
	return PLACE_CATEGORIES[node.category]?.group ?? null;
}

/** The rating the filter reads: the max over members, or one member's. */
export function ratingOf(
	node: Pick<GraphNode, "priorities">,
	priorityOf: "max" | string,
): Priority | null {
	if (priorityOf !== "max") return node.priorities[priorityOf] ?? null;
	let best: Priority | null = null;
	for (const p of Object.values(node.priorities)) {
		if (!p || !(p in PRIORITIES)) continue;
		if (best === null || PRIORITIES[p].score > PRIORITIES[best].score) best = p;
	}
	return best;
}

/** The member `u:` refers to, or null when it doesn't apply. */
export function unratedMember(
	f: WorkspaceFilter,
	meMemberId: string | null,
): string | null {
	if (!f.unratedBy) return null;
	return f.unratedBy === "me" ? meMemberId : f.unratedBy;
}

/** Does anything in the filter restrict nodes? (`u:me` for a guest does not.) */
export function isActiveFilter(
	f: WorkspaceFilter,
	meMemberId: string | null,
): boolean {
	return (
		f.groups.length > 0 ||
		f.minPriority !== null ||
		unratedMember(f, meMemberId) !== null ||
		f.notScheduled
	);
}

export function matchesFilter(
	node: Pick<GraphNode, "id" | "type" | "category" | "priorities">,
	f: WorkspaceFilter,
	ctx: FilterContext,
): boolean {
	if (f.groups.length) {
		const g = groupOf(node);
		if (!g || !f.groups.includes(g)) return false;
	}
	if (f.minPriority) {
		const r = ratingOf(node, f.priorityOf);
		if (!r || PRIORITIES[r].score < PRIORITIES[f.minPriority].score)
			return false;
	}
	const unrated = unratedMember(f, ctx.meMemberId);
	if (unrated && node.priorities[unrated]) return false;
	if (f.notScheduled && ctx.scheduled.has(node.id)) return false;
	return true;
}

/**
 * The Outline's visible set under a filter: every live, non-dropped node that
 * matches, plus its ancestors (so a match is always reachable in the tree).
 * `null` when the filter is inactive (everything is visible).
 */
export function visibleUnderFilter(
	ix: GraphIndex,
	f: WorkspaceFilter,
	ctx: FilterContext,
): { visible: Set<string>; matched: Set<string> } | null {
	if (!isActiveFilter(f, ctx.meMemberId)) return null;
	const visible = new Set<string>();
	const matched = new Set<string>();
	for (const n of ix.outline) {
		if (n.status === "dropped" || ix.isDropped(n.id)) continue;
		if (!matchesFilter(n, f, ctx)) continue;
		matched.add(n.id);
		for (const a of ix.path(n.id)) visible.add(a.id);
	}
	return { visible, matched };
}

const PRIORITY_SHORT: Record<Priority, string> = {
	must: "Must",
	really_want: "Really want",
	want: "Want",
	sure_why_not: "Sure, why not",
	meh: "Meh",
	nah: "Nah",
};

/**
 * One short line for the active filter ("Food/Drink, Bar · Want or higher ·
 * Unrated by me · Not scheduled"), or null when inactive.
 */
export function describeFilter(
	f: WorkspaceFilter,
	opts: { meMemberId: string | null; members: readonly GraphMember[] },
): string | null {
	if (!isActiveFilter(f, opts.meMemberId)) return null;
	const nameOf = (id: string) =>
		id === opts.meMemberId
			? "me"
			: (opts.members.find((m) => m.id === id)?.name ?? "a member");
	const parts: string[] = [];
	if (f.groups.length)
		parts.push(f.groups.map((g) => PLACE_GROUPS[g]).join(", "));
	if (f.minPriority) {
		const floor =
			f.minPriority === "must"
				? "Must"
				: `${PRIORITY_SHORT[f.minPriority]} or higher`;
		parts.push(
			f.priorityOf === "max" ? floor : `${floor} (${nameOf(f.priorityOf)})`,
		);
	}
	const unrated = unratedMember(f, opts.meMemberId);
	if (unrated) parts.push(`Unrated by ${nameOf(unrated)}`);
	if (f.notScheduled) parts.push("Not scheduled");
	return parts.join(" · ");
}
