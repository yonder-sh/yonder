/**
 * The Ideas bin's rows (DESIGN §4.2, SPEC §7.3): live places in the scope that
 * aren't on the plan yet, narrowed by the shared filter and sorted by the
 * owner's ranking rule (max over members, then sum, then name), by name, or by
 * most recently added (node ids are UUIDv7, so they sort by creation time).
 * Proposed places (E7 creates not in the graph yet) sort in like any other.
 * Pure: no React.
 */
import { compareByPriority } from "@/lib/domain/taxonomy";
import type { GraphIndex } from "@/lib/engine/graph-index";
import type { GraphNode } from "@/lib/engine/types";
import { serializeFilter, type WorkspaceFilter } from "@/lib/workspace/filter";
import {
	type FilterContext,
	matchesFilter,
} from "@/lib/workspace/filter-match";
import { isIdea } from "@/lib/workspace/ideas";
import type { GhostNode } from "./tree-rows";

export const IDEAS_SORTS = ["priority", "name", "recent"] as const;
export type IdeasSort = (typeof IDEAS_SORTS)[number];
export const IDEAS_SORT_LABEL: Record<IdeasSort, string> = {
	priority: "Priority",
	name: "Name",
	recent: "Recently added",
};

export type IdeaEntry = {
	node: GraphNode;
	/** Set for a proposed place (drawn as a ghost). */
	proposalId?: string;
};

/** One definition, shared with the Rate screen's "ideas" set (FB-05). */
export { isIdea };

export function sortIdeas(list: IdeaEntry[], sort: IdeasSort): IdeaEntry[] {
	const out = list.slice();
	if (sort === "name")
		out.sort((a, b) => a.node.name.localeCompare(b.node.name));
	else if (sort === "recent")
		out.sort((a, b) =>
			a.node.id < b.node.id ? 1 : a.node.id > b.node.id ? -1 : 0,
		);
	else out.sort((a, b) => compareByPriority(a.node, b.node));
	return out;
}

export function ideasFor(input: {
	ix: GraphIndex;
	scopeId: string | null;
	filter: WorkspaceFilter;
	ctx: FilterContext;
	sort: IdeasSort;
	ghosts?: readonly GhostNode[];
}): { ideas: IdeaEntry[]; total: number } {
	const { ix, scopeId, filter, ctx } = input;
	const all: IdeaEntry[] = ix.outline
		.filter((n) => isIdea(ix, n, scopeId))
		.map((node) => ({ node }));
	for (const g of input.ghosts ?? []) {
		if (g.node.type !== "place") continue;
		const parentOk =
			scopeId === null ||
			g.node.parentId === scopeId ||
			(g.node.parentId !== null && ix.isWithin(g.node.parentId, scopeId));
		if (parentOk) all.push({ node: g.node, proposalId: g.proposalId });
	}
	const kept = all.filter((e) => matchesFilter(e.node, filter, ctx));
	return { ideas: sortIdeas(kept, input.sort), total: all.length };
}

/**
 * The Rate screen's search for "Rate ideas →" (FB-05): exactly the Ideas
 * list. `set: "ideas"` makes the Rate screen rate the ideas themselves
 * (`isIdea`: live places not on the plan, the airports and areas included or
 * left out just as here) instead of its own "rateable" set, which added
 * neighbourhoods and dropped logistics (18 ideas became 20 cards on the full
 * draft). The shared filter goes along unchanged plus "not scheduled" (what
 * an idea is, so the filter reads the same there), inside the current scope
 * (`in`; none at the trip root).
 */
export function rateIdeasSearch(
	filter: WorkspaceFilter,
	scopeId: string | null,
): { f: string; in?: string; set: "ideas" } {
	const f = serializeFilter({ ...filter, notScheduled: true }) ?? "ns";
	return scopeId ? { f, in: scopeId, set: "ideas" } : { f, set: "ideas" };
}
