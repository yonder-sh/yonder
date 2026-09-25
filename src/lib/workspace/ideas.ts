/**
 * What an "idea" is (DESIGN §4.2, SPEC §7.3): a live place in the scope that
 * isn't on the plan yet. One definition for the Ideas bin (WP-Outline) and
 * the Rate screen's "ideas" set (WP-Places, FB-05's "Rate ideas →"), so the
 * two always hold the same places. Pure: no React.
 */
import type { GraphIndex } from "@/lib/engine/graph-index";
import type { GraphNode } from "@/lib/engine/types";

export function isIdea(
	ix: Pick<GraphIndex, "isDropped" | "scheduledNodeIds" | "isWithin">,
	n: Pick<GraphNode, "id" | "type" | "status">,
	scopeId: string | null,
): boolean {
	return (
		n.type === "place" &&
		n.status === "active" &&
		!ix.isDropped(n.id) &&
		!ix.scheduledNodeIds.has(n.id) &&
		ix.isWithin(n.id, scopeId)
	);
}

/**
 * The ideas in `scopeId`, in outline order. `liveIds` (the server graph's
 * node ids) leaves out proposal ghosts, which the Ideas bin draws but nobody
 * can rate until the suggestion is reviewed.
 */
export function ideaNodes(
	ix: Pick<
		GraphIndex,
		"outline" | "isDropped" | "scheduledNodeIds" | "isWithin"
	>,
	scopeId: string | null,
	liveIds?: ReadonlySet<string>,
): GraphNode[] {
	return ix.outline.filter(
		(n) => isIdea(ix, n, scopeId) && (!liveIds || liveIds.has(n.id)),
	);
}
