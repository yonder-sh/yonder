/**
 * Node rules (SPEC §7.1): nesting by rank, type changes, slugs and scope URLs.
 * Pure helpers shared by the server functions (which enforce the rules) and the
 * client (which disables what the server would refuse).
 */
import type { GraphIndex } from "./graph-index";
import { RANK } from "./lens";
import type { GraphNode, NodeType, PlaceCategory } from "./types";

/** A child's rank must be ≥ its parent's; children of the root can be any type. */
export function canNest(
	parentType: NodeType | null,
	childType: NodeType,
): boolean {
	return parentType === null || RANK[childType] >= RANK[parentType];
}

/**
 * The types a node may change to: rank ≥ the parent's and ≤ the lowest rank
 * among its children. Includes the current type.
 */
export function allowedTypes(ix: GraphIndex, nodeId: string): NodeType[] {
	const node = ix.node(nodeId);
	if (!node) return [];
	const parent = node.parentId ? ix.node(node.parentId) : undefined;
	const min = parent ? RANK[parent.type] : 0;
	const kids = ix.children(nodeId);
	const max = kids.length
		? Math.min(...kids.map((k) => RANK[k.type]))
		: RANK.place;
	return (Object.keys(RANK) as NodeType[]).filter(
		(t) => RANK[t] >= min && RANK[t] <= max,
	);
}

/** Types a new child of `parentId` may have (`null` = the trip root). */
export function allowedChildTypes(
	ix: GraphIndex,
	parentId: string | null,
): NodeType[] {
	const parent = parentId ? ix.node(parentId) : undefined;
	return (Object.keys(RANK) as NodeType[]).filter((t) =>
		canNest(parent?.type ?? null, t),
	);
}

/** Can `nodeId` move under `newParentId` (`null` = root)? Checks rank and cycles. */
export function canMoveUnder(
	ix: GraphIndex,
	nodeId: string,
	newParentId: string | null,
): boolean {
	const node = ix.node(nodeId);
	if (!node) return false;
	if (newParentId === null) return true;
	const parent = ix.node(newParentId);
	if (!parent || ix.hierarchy.isInSubtree(newParentId, nodeId)) return false;
	return canNest(parent.type, node.type);
}

/** `category` after a type change: cleared off `place`, defaulted to `other` onto it. */
export function categoryForType(
	newType: NodeType,
	current: PlaceCategory | null | undefined,
): PlaceCategory | null {
	if (newType !== "place") return null;
	return current ?? "other";
}

/** A dropped node (or one under a dropped node) can't be scheduled until restored. */
export function isSchedulable(ix: GraphIndex, nodeId: string): boolean {
	return !!ix.node(nodeId) && !ix.isDropped(nodeId);
}

const SLUG_MAX = 60;

/**
 * NFKD-normalise, strip diacritics, lowercase, replace each run of
 * non-`[a-z0-9]` with `-`, trim to 60 characters. Pure CJK (nothing left)
 * gives `n-<first 6 of id>`.
 */
export function slugify(name: string, id: string): string {
	const base = name
		.normalize("NFKD")
		.replace(/\p{M}+/gu, "")
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, SLUG_MAX)
		.replace(/-+$/g, "");
	return base || `n-${id.replace(/-/g, "").slice(0, 6)}`;
}

/**
 * Top-level slugs a place can't take: they are app routes under `/t/<trip>/`
 * (the rate screen, ADDENDUM §10), which outrank the scope splat.
 */
export const ROOT_RESERVED_SLUGS = ["rate"] as const;

/** `base`, else `base-2`, `base-3`… (a clash is with a LIVE sibling's slug). */
export function uniqueSlug(base: string, taken: Iterable<string>): string {
	const used = new Set(taken);
	if (!used.has(base)) return base;
	for (let n = 2; ; n++) {
		const candidate = `${base}-${n}`;
		if (!used.has(candidate)) return candidate;
	}
}

/** The slugs of a node's live siblings (excluding the node itself), for `uniqueSlug`. */
export function siblingSlugs(
	ix: GraphIndex,
	parentId: string | null,
	exceptId?: string,
): string[] {
	const slugs = ix
		.children(parentId)
		.filter((n) => n.id !== exceptId)
		.map((n) => n.slug);
	return parentId === null ? [...slugs, ...ROOT_RESERVED_SLUGS] : slugs;
}

/** Root → node slugs: the scope URL tail (`japan/tokyo/shibuya`). */
export function slugPath(ix: GraphIndex, nodeId: string): string[] {
	return ix.path(nodeId).map((n) => n.slug);
}

export interface ResolvedScope {
	/** The deepest node that resolved, or null (the root). */
	node: GraphNode | null;
	/** The path of resolved nodes, root first. */
	path: GraphNode[];
	/** False when a segment didn't resolve: replace the URL and toast "That place was renamed or removed". */
	complete: boolean;
}

/** Resolves a scope URL's slug segments, stopping at the deepest one that resolves (§7.1). */
export function resolveSlugPath(
	ix: GraphIndex,
	slugs: readonly string[],
): ResolvedScope {
	const path: GraphNode[] = [];
	let parentId: string | null = null;
	for (const slug of slugs) {
		const next: GraphNode | undefined = ix
			.children(parentId)
			.find((n) => n.slug === slug);
		if (!next) return { node: path.at(-1) ?? null, path, complete: false };
		path.push(next);
		parentId = next.id;
	}
	return { node: path.at(-1) ?? null, path, complete: true };
}
