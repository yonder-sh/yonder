/**
 * The Outline's flattened tree (spikes/dnd "sortable tree" pattern, DESIGN
 * §4.2): the place tree as one list of rows with depths, so the tree shares
 * the workspace's single dnd-kit context with the Plan. Pure: no React.
 *
 * - `buildRows` walks `ix.children` depth-first: open rows show their
 *   children, the level filter (HIER-07) hides finer ranks and counts the
 *   places it hides, the shared `f` filter keeps only matches and their
 *   ancestors, dropped nodes (SPEC §7.1) leave the tree for a collapsed
 *   "Dropped" group at the bottom, and E7 ghosts (proposed places) and origin
 *   rows ("Itoya → Kyoto · Maya") are slotted in under their parents.
 * - `projectDrop` is the flattened tree's projection: where the dragged row
 *   would land (depth from the horizontal offset, clamped by its neighbours),
 *   under which parent, between which siblings, and whether the rank rule
 *   (`canMoveUnder`) allows it.
 */
import { NODE_TYPES } from "@/lib/domain/taxonomy";
import type { GraphIndex } from "@/lib/engine/graph-index";
import { RANK } from "@/lib/engine/lens";
import type { ProposalMark } from "@/lib/engine/proposals";
import { canMoveUnder } from "@/lib/engine/tree";
import type { GraphNode, NodeType } from "@/lib/engine/types";

/** Indentation per level, px (DESIGN §4.2). */
export const INDENT = 16;

/** HIER-07: how deep the tree shows (`city` = countries, regions and cities). */
export type OutlineLevel = "all" | "area" | "city";
export const LEVEL_MAX_RANK: Record<OutlineLevel, number> = {
	all: RANK.place,
	area: RANK.area,
	city: RANK.city,
};
export const LEVEL_LABEL: Record<OutlineLevel, string> = {
	all: "Everything",
	area: "Areas",
	city: "Cities",
};

export type NodeRow = {
	kind: "node";
	id: string;
	node: GraphNode;
	depth: number;
	parentId: string | null;
	hasChildren: boolean;
	open: boolean;
	/** Places inside that the level filter hides ("Tokyo · 12 places"). */
	hiddenPlaces: number;
	section: "tree" | "dropped";
};

/** A proposed place that isn't in the graph yet (E7 create, mark-only overlay). */
export type GhostRow = {
	kind: "ghost";
	id: string;
	proposalId: string;
	node: GraphNode;
	depth: number;
	parentId: string | null;
	section: "tree";
};

/** EXTENSIONS §3.7: a dashed trace at the old parent of a proposed move. */
export type OriginRow = {
	kind: "origin";
	id: string;
	mark: ProposalMark;
	depth: number;
	/** The old parent; null for a move out of the top level (`from:node:root`). */
	parentId: string | null;
	section: "tree";
};

export type DroppedHeaderRow = {
	kind: "dropped-header";
	id: "dropped";
	count: number;
	open: boolean;
	depth: 0;
	section: "dropped";
};

export type OutlineRow = NodeRow | GhostRow | OriginRow | DroppedHeaderRow;

export type GhostNode = { node: GraphNode; proposalId: string };

export type BuildRowsInput = {
	ix: GraphIndex;
	isOpen: (id: string) => boolean;
	level: OutlineLevel;
	/** The filter's visible set (matches + ancestors); null = no filter. */
	visible: ReadonlySet<string> | null;
	/** The row being dragged: its children fold while it moves. */
	foldId?: string | null;
	/** Proposed places not in the graph yet, pre-filtered by the caller. */
	ghosts?: readonly GhostNode[];
	/** Old parent id (or `ROOT_ORIGIN`) → its `from:node:` marks (origin rows). */
	origins?: ReadonlyMap<string, readonly ProposalMark[]>;
	droppedOpen: boolean;
};

/** The `from:node:root` key: a move out of the trip's top level. */
export const ROOT_ORIGIN = "root";

/** Live places under each node (for the level filter's counts). */
export function placeCounts(ix: GraphIndex): Map<string, number> {
	const counts = new Map<string, number>();
	for (const n of ix.outline) {
		if (n.type !== "place" || ix.isDropped(n.id)) continue;
		for (const a of ix.path(n.id)) {
			if (a.id === n.id) continue;
			counts.set(a.id, (counts.get(a.id) ?? 0) + 1);
		}
	}
	return counts;
}

export function buildRows(input: BuildRowsInput): OutlineRow[] {
	const { ix, isOpen, level, visible, foldId, droppedOpen } = input;
	const maxRank = LEVEL_MAX_RANK[level];
	const counts = level === "all" ? null : placeCounts(ix);
	const ghostsBy = new Map<string | null, GhostNode[]>();
	for (const g of input.ghosts ?? []) {
		const list = ghostsBy.get(g.node.parentId) ?? [];
		list.push(g);
		ghostsBy.set(g.node.parentId, list);
	}
	const rows: OutlineRow[] = [];
	const dropped: GraphNode[] = [];

	const shown = (n: GraphNode, section: NodeRow["section"]) =>
		RANK[n.type] <= maxRank &&
		(section === "dropped" ||
			(n.status !== "dropped" && (!visible || visible.has(n.id))));

	const walk = (
		parentId: string | null,
		depth: number,
		section: NodeRow["section"],
	) => {
		for (const n of ix.children(parentId)) {
			if (section === "tree" && n.status === "dropped") {
				if (!visible) dropped.push(n);
				continue;
			}
			if (!shown(n, section)) continue;
			const kids = ix.children(n.id).filter((k) => shown(k, section));
			const ghostKids =
				section === "tree" && RANK.place <= maxRank
					? (ghostsBy.get(n.id) ?? [])
					: [];
			const hasChildren = kids.length + ghostKids.length > 0;
			const open = hasChildren && n.id !== foldId && isOpen(n.id);
			rows.push({
				kind: "node",
				id: n.id,
				node: n,
				depth,
				parentId,
				hasChildren,
				open,
				hiddenPlaces:
					counts && RANK[n.type] < RANK.place ? (counts.get(n.id) ?? 0) : 0,
				section,
			});
			if (!open) continue;
			walk(n.id, depth + 1, section);
			if (section !== "tree") continue;
			for (const g of ghostKids)
				rows.push({
					kind: "ghost",
					id: g.node.id,
					proposalId: g.proposalId,
					node: g.node,
					depth: depth + 1,
					parentId: n.id,
					section: "tree",
				});
			if (!visible)
				for (const mark of input.origins?.get(n.id) ?? [])
					rows.push({
						kind: "origin",
						id: `origin:${mark.proposalId}`,
						mark,
						depth: depth + 1,
						parentId: n.id,
						section: "tree",
					});
		}
	};
	walk(null, 0, "tree");
	if (RANK.place <= maxRank)
		for (const g of ghostsBy.get(null) ?? [])
			rows.push({
				kind: "ghost",
				id: g.node.id,
				proposalId: g.proposalId,
				node: g.node,
				depth: 0,
				parentId: null,
				section: "tree",
			});
	// Moves out of the top level leave their trace at the end of it.
	if (!visible)
		for (const mark of input.origins?.get(ROOT_ORIGIN) ?? [])
			rows.push({
				kind: "origin",
				id: `origin:${mark.proposalId}`,
				mark,
				depth: 0,
				parentId: null,
				section: "tree",
			});
	if (dropped.length) {
		rows.push({
			kind: "dropped-header",
			id: "dropped",
			count: dropped.length,
			open: droppedOpen,
			depth: 0,
			section: "dropped",
		});
		if (droppedOpen)
			for (const d of dropped) {
				const kids = ix.children(d.id).filter((k) => shown(k, "dropped"));
				const open = kids.length > 0 && d.id !== foldId && isOpen(d.id);
				rows.push({
					kind: "node",
					id: d.id,
					node: d,
					depth: 1,
					parentId: d.parentId,
					hasChildren: kids.length > 0,
					open,
					hiddenPlaces: 0,
					section: "dropped",
				});
				if (open) walk(d.id, 2, "dropped");
			}
	}
	return rows;
}

// ---------------------------------------------------------------------------
// Rank rule wording
// ---------------------------------------------------------------------------

const TYPE_WORD: Record<NodeType, string> = {
	country: "country",
	region: "region",
	city: "city",
	area: "area",
	place: "place",
};
const article = (w: string) => (/^[aeiou]/.test(w) ? `an ${w}` : `a ${w}`);

/** "A city can't go inside a place" (DESIGN §4.2 invalid target tooltip). */
export function rankReason(child: NodeType, parent: NodeType): string {
	const c = TYPE_WORD[child];
	return `${article(c).replace(/^a/, "A")} can't go inside ${article(TYPE_WORD[parent])}`;
}

/** Why `nodeId` can't move under `parentId`, or null when it can. */
export function moveBlocker(
	ix: GraphIndex,
	nodeId: string,
	parentId: string | null,
): string | null {
	if (canMoveUnder(ix, nodeId, parentId)) return null;
	const node = ix.node(nodeId);
	const parent = parentId ? ix.node(parentId) : undefined;
	if (!node || !parent) return "That place is gone";
	if (
		parentId === nodeId ||
		ix.hierarchy.isInSubtree(parentId as string, nodeId)
	)
		return "A place can't go inside itself";
	return rankReason(node.type, parent.type);
}

export const typeLabel = (t: NodeType) => NODE_TYPES[t].label;

// ---------------------------------------------------------------------------
// Drop projection (dnd-kit sortable tree)
// ---------------------------------------------------------------------------

export type Projection = {
	depth: number;
	parentId: string | null;
	afterId?: string;
	beforeId?: string;
	valid: boolean;
	reason: string | null;
	/** Dropping here changes nothing. */
	noop: boolean;
};

type Sortable = Pick<NodeRow, "id" | "depth" | "parentId">;

function move<T>(list: readonly T[], from: number, to: number): T[] {
	const out = list.slice();
	const [x] = out.splice(from, 1);
	out.splice(to, 0, x as T);
	return out;
}

/**
 * Where `activeId` lands when released over `overId` with a horizontal drag
 * of `offsetX` px. `rows` are the sortable tree rows in order, with the
 * active row's subtree already folded.
 */
export function projectDrop(
	ix: GraphIndex,
	rows: readonly Sortable[],
	activeId: string,
	overId: string,
	offsetX: number,
): Projection | null {
	const from = rows.findIndex((r) => r.id === activeId);
	const to = rows.findIndex((r) => r.id === overId);
	if (from < 0 || to < 0) return null;
	const active = rows[from] as Sortable;
	const moved = move(rows, from, to);
	const prev = moved[to - 1];
	const next = moved[to + 1];
	const projected = active.depth + Math.round(offsetX / INDENT);
	const maxDepth = prev ? prev.depth + 1 : 0;
	const minDepth = next ? next.depth : 0;
	const depth = Math.max(minDepth, Math.min(maxDepth, projected));

	let parentId: string | null = null;
	if (depth > 0 && prev) {
		if (depth === prev.depth) parentId = prev.parentId;
		else if (depth > prev.depth) parentId = prev.id;
		else
			parentId =
				moved
					.slice(0, to)
					.reverse()
					.find((r) => r.depth === depth)?.parentId ?? null;
	}

	// Siblings on either side at the new depth (stop at a shallower row).
	let afterId: string | undefined;
	for (let i = to - 1; i >= 0; i--) {
		const r = moved[i] as Sortable;
		if (r.depth < depth) break;
		if (r.depth === depth && r.parentId === parentId) {
			afterId = r.id;
			break;
		}
	}
	let beforeId: string | undefined;
	for (let i = to + 1; i < moved.length; i++) {
		const r = moved[i] as Sortable;
		if (r.depth < depth) break;
		if (r.depth === depth && r.parentId === parentId) {
			beforeId = r.id;
			break;
		}
	}
	// Right under a collapsed (or filtered) parent: the first child slot.
	if (!afterId && !beforeId) {
		const first = ix
			.children(parentId)
			.find((c) => c.id !== activeId && c.status !== "dropped");
		if (first) beforeId = first.id;
	}

	const reason = moveBlocker(ix, activeId, parentId);
	const node = ix.node(activeId);
	const noop =
		(from === to && depth === active.depth) ||
		(node?.parentId === parentId &&
			siblingsAround(ix, activeId, parentId, afterId, beforeId));
	return {
		depth,
		parentId,
		...(afterId ? { afterId } : {}),
		...(beforeId ? { beforeId } : {}),
		valid: reason === null,
		reason,
		noop,
	};
}

/** Is the node already between `afterId` and `beforeId` under `parentId`? */
function siblingsAround(
	ix: GraphIndex,
	nodeId: string,
	parentId: string | null,
	afterId: string | undefined,
	beforeId: string | undefined,
): boolean {
	const sibs = ix.children(parentId).filter((c) => c.status !== "dropped");
	const i = sibs.findIndex((s) => s.id === nodeId);
	if (i < 0) return false;
	const before = sibs[i - 1]?.id;
	const after = sibs[i + 1]?.id;
	if (afterId) return before === afterId;
	if (beforeId) return after === beforeId;
	return false;
}

// ---------------------------------------------------------------------------
// Typeahead
// ---------------------------------------------------------------------------

/** Lowercase, diacritics stripped ("glänta" → "glanta"). */
export function foldText(s: string): string {
	return s
		.normalize("NFKD")
		.replace(/\p{M}+/gu, "")
		.toLowerCase();
}

/** The next row (after `from`, wrapping) whose name starts with `prefix`. */
export function typeahead(
	names: readonly { id: string; name: string }[],
	fromIndex: number,
	prefix: string,
): string | null {
	const p = foldText(prefix);
	if (!p || !names.length) return null;
	// A repeated single letter cycles; otherwise the current row may match.
	const start = p.length === 1 ? fromIndex + 1 : fromIndex;
	for (let k = 0; k < names.length; k++) {
		const r = names[(start + k) % names.length] as { id: string; name: string };
		if (foldText(r.name).startsWith(p)) return r.id;
	}
	return null;
}
