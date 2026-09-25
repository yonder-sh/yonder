/**
 * Which bundle (media, lists, notes) the inspector shows for a selection
 * (SPEC §8.4). A leg only has a bundle once its row exists; `ensureLeg`
 * creates it on the first attach.
 */
import type { GraphIndex } from "@/lib/engine/graph-index";
import type { BundleTarget } from "@/lib/schemas/targets";
import type { Sel } from "@/lib/workspace/search";

export function bundleTargetForSel(
	ix: GraphIndex,
	sel: Sel | null,
): BundleTarget | null {
	if (!sel) return { kind: "trip" };
	switch (sel.kind) {
		case "root":
			return { kind: "trip" };
		case "node":
			return { kind: "node", nodeId: sel.id };
		case "item": {
			// A located item shows its node's bundle by default (DESIGN §4.4).
			const item = ix.item(sel.id);
			return item?.nodeId
				? { kind: "node", nodeId: item.nodeId }
				: { kind: "item", itemId: sel.id };
		}
		case "day":
			return { kind: "day", dayId: sel.id };
		case "leg": {
			const t = sel.target;
			const leg =
				t.kind === "pair"
					? ix.legByPair.get(`${t.fromItemId}>${t.toItemId}`)
					: ix.legByStay.get(`${t.dayId}:${t.end}`);
			return leg ? { kind: "leg", legId: leg.id } : null;
		}
		case "edge":
		case "proposal":
			return null;
	}
}

/**
 * Whether a node (null = the trip root) has anything inside it: a child
 * place, area, city… (FB-12). Proposal ghosts count, dropped children too
 * (they are still in the Outline).
 */
export function hasChildNodes(ix: GraphIndex, nodeId: string | null): boolean {
	if (nodeId !== null && !ix.node(nodeId)) return false;
	return ix.children(nodeId).length > 0;
}

/**
 * FB-12 (owner feedback): "Everything inside" vs "Only <node>" is a choice
 * only when the node has children. A node with none (a place, an empty area
 * or city, a trip with no places yet) offers no toggle anywhere — the center
 * tabs' RollupToggle, the inspector's Media and Lists tabs — and shows
 * everything (its own entries and its visits'). A day's "This day /
 * Everything that day" and a visit's "This visit only" are other choices and
 * stay (`true` for every target that isn't a node or the trip).
 */
export function offersRollupChoice(
	ix: GraphIndex,
	target: BundleTarget,
): boolean {
	if (target.kind === "node") return hasChildNodes(ix, target.nodeId);
	if (target.kind === "trip") return hasChildNodes(ix, null);
	return true;
}

/**
 * Where the phone FAB's quick expense hangs (MONEY-QA-05): the selected item,
 * place, day or leg; else the current scope, the same as the desktop Money
 * tab's "+ Expense" (so the cost rolls up into Kyoto and Japan); the trip
 * only at the root.
 */
export function quickExpenseTarget(
	ix: GraphIndex,
	sel: Sel | null,
	scopeId: string | null,
): BundleTarget {
	const fallback: BundleTarget = scopeId
		? { kind: "node", nodeId: scopeId }
		: { kind: "trip" };
	switch (sel?.kind) {
		case "item":
			return { kind: "item", itemId: sel.id };
		case "node":
			return { kind: "node", nodeId: sel.id };
		case "day":
			return { kind: "day", dayId: sel.id };
		case "leg": {
			const t = sel.target;
			const leg =
				t.kind === "pair"
					? ix.legByPair.get(`${t.fromItemId}>${t.toItemId}`)
					: ix.legByStay.get(`${t.dayId}:${t.end}`);
			return leg ? { kind: "leg", legId: leg.id } : fallback;
		}
		default:
			return fallback;
	}
}
