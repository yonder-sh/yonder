/**
 * The place tree: country → region → city → area → place, nested to any depth.
 * Ancestors, descendants, subtree membership, collapse-to-granularity (with a
 * fallback for missing levels) and time zone inheritance.
 *
 * Ported from `spikes/core/src/hierarchy.ts`. Adapted to the app's node shape
 * (SPEC §6.3/§6.6): the zone field is `tz`, coordinates are nullable, and the
 * API is generic so `get()` returns the full graph node you passed in.
 */
import type { NodeType } from "@/lib/schemas/enums";
import { normalizeTimeZone } from "./time";

/** Coarse → fine. */
export const NODE_TYPE_ORDER: readonly NodeType[] = [
	"country",
	"region",
	"city",
	"area",
	"place",
];

/** Lower rank = coarser. country 0 … place 4. */
export const NODE_TYPE_RANK: Readonly<Record<NodeType, number>> = {
	country: 0,
	region: 1,
	city: 2,
	area: 3,
	place: 4,
};

/** The fields the hierarchy reads. A graph node (`GraphNode`) satisfies it. */
export interface HierarchyNode {
	id: string;
	parentId: string | null;
	type: NodeType;
	name: string;
	/** Both null (not located) or both set. */
	lat?: number | null;
	lng?: number | null;
	/** IANA zone. Optional: inherited from the nearest ancestor that has one. */
	tz?: string | null;
}

/** Negative when `a` is coarser than `b`. */
export function compareGranularity(a: NodeType, b: NodeType): number {
	return NODE_TYPE_RANK[a] - NODE_TYPE_RANK[b];
}

export function isNodeType(value: unknown): value is NodeType {
	return typeof value === "string" && Object.hasOwn(NODE_TYPE_RANK, value);
}

export type HierarchyIssueCode =
	| "duplicate-id"
	| "missing-parent"
	| "cycle"
	| "invalid-type"
	| "rank-inversion"
	| "invalid-timezone"
	| "no-timezone"
	| "invalid-coordinates";

export interface HierarchyIssue {
	code: HierarchyIssueCode;
	/** "error" = structural (breaks traversal), "warning" = data quality. */
	severity: "error" | "warning";
	nodeId: string;
	message: string;
}

const STRUCTURAL: ReadonlySet<HierarchyIssueCode> = new Set([
	"duplicate-id",
	"missing-parent",
	"cycle",
	"invalid-type",
]);

export class HierarchyError extends Error {
	readonly issues: HierarchyIssue[];
	constructor(issues: HierarchyIssue[]) {
		super(`Invalid hierarchy: ${issues.map((i) => i.message).join("; ")}`);
		this.name = "HierarchyError";
		this.issues = issues;
	}
}

export interface TraversalOptions {
	includeSelf?: boolean;
}

export interface Hierarchy<N extends HierarchyNode = HierarchyNode> {
	readonly size: number;
	/** All nodes in input order (first occurrence wins on duplicate ids). */
	nodes(): readonly N[];
	get(id: string): N | undefined;
	/** Like `get` but throws on unknown ids. */
	require(id: string): N;
	has(id: string): boolean;
	roots(): N[];
	parent(id: string): N | undefined;
	/** Direct children, input order. */
	children(id: string): N[];
	/** Nearest first: parent, grandparent, ..., root. `includeSelf` prepends the node. */
	ancestors(id: string, opts?: TraversalOptions): N[];
	/** Root first, ending with the node itself (breadcrumbs). */
	path(id: string): N[];
	/** Depth-first pre-order, children in input order. Excludes self unless `includeSelf`. */
	descendants(id: string, opts?: TraversalOptions): N[];
	/** Ids of the node and all its descendants (cached). Empty for unknown ids. */
	subtreeIds(id: string): ReadonlySet<string>;
	/** True when `id` is `rootId` or a descendant of it. */
	isInSubtree(id: string, rootId: string): boolean;
	/** 0 for roots. -1 for unknown ids. */
	depth(id: string): number;
	/** Nearest ancestor-or-self with exactly this type (no fallback). */
	nearestOfType(id: string, type: NodeType): N | undefined;
	/**
	 * Nearest ancestor-or-self whose type is AT OR COARSER than `granularity`.
	 * Handles missing levels: a place directly under a city collapses to the city
	 * at granularity "area"; a node already coarser than `granularity` is returned as is.
	 */
	collapseTo(id: string, granularity: NodeType): N | undefined;
	/**
	 * Nearest ancestor-or-self with a valid IANA zone (canonical id), or undefined
	 * (SPEC §7.4 steps 1–2; the caller falls back to `trip.defaultTz`).
	 */
	resolveTimezone(id: string): string | undefined;
	/** Lowest common ancestor-or-self of two nodes. */
	commonAncestor(a: string, b: string): N | undefined;
}

const hasCoords = (n: HierarchyNode) => n.lat != null || n.lng != null;

/**
 * Checks structure and data quality without throwing. Structural problems
 * (duplicate ids, missing parents, cycles, unknown types) have severity "error".
 */
export function validateHierarchy(
	nodes: readonly HierarchyNode[],
): HierarchyIssue[] {
	const issues: HierarchyIssue[] = [];
	const byId = new Map<string, HierarchyNode>();
	for (const node of nodes) {
		if (byId.has(node.id)) {
			issues.push({
				code: "duplicate-id",
				severity: "error",
				nodeId: node.id,
				message: `duplicate node id "${node.id}"`,
			});
			continue;
		}
		byId.set(node.id, node);
	}
	for (const node of byId.values()) {
		if (!isNodeType(node.type)) {
			issues.push({
				code: "invalid-type",
				severity: "error",
				nodeId: node.id,
				message: `node "${node.id}" has unknown type "${String(node.type)}"`,
			});
		}
		if (node.parentId != null && !byId.has(node.parentId)) {
			issues.push({
				code: "missing-parent",
				severity: "error",
				nodeId: node.id,
				message: `node "${node.id}" references missing parent "${node.parentId}"`,
			});
		}
		const parent = node.parentId != null ? byId.get(node.parentId) : undefined;
		if (
			parent &&
			isNodeType(parent.type) &&
			isNodeType(node.type) &&
			NODE_TYPE_RANK[node.type] < NODE_TYPE_RANK[parent.type]
		) {
			issues.push({
				code: "rank-inversion",
				severity: "warning",
				nodeId: node.id,
				message: `${node.type} "${node.id}" is nested under the finer ${parent.type} "${parent.id}"`,
			});
		}
		if (node.tz && !normalizeTimeZone(node.tz)) {
			issues.push({
				code: "invalid-timezone",
				severity: "warning",
				nodeId: node.id,
				message: `node "${node.id}" has unknown time zone "${node.tz}"`,
			});
		}
		if (hasCoords(node)) {
			const { lat, lng } = node;
			if (
				lat == null ||
				lng == null ||
				!Number.isFinite(lat) ||
				!Number.isFinite(lng) ||
				Math.abs(lat) > 90 ||
				Math.abs(lng) > 180
			) {
				issues.push({
					code: "invalid-coordinates",
					severity: "warning",
					nodeId: node.id,
					message: `node "${node.id}" has invalid coordinates (${lat}, ${lng})`,
				});
			}
		}
	}
	// Cycles: walk up from every node; report each cycle once (on its smallest id).
	const reported = new Set<string>();
	for (const node of byId.values()) {
		const seen: string[] = [];
		const onPath = new Set<string>();
		let cur: HierarchyNode | undefined = node;
		while (cur && !onPath.has(cur.id)) {
			onPath.add(cur.id);
			seen.push(cur.id);
			cur = cur.parentId != null ? byId.get(cur.parentId) : undefined;
		}
		if (cur) {
			const cycle = seen.slice(seen.indexOf(cur.id));
			const key = [...cycle].sort()[0] as string;
			if (!reported.has(key)) {
				reported.add(key);
				issues.push({
					code: "cycle",
					severity: "error",
					nodeId: key,
					message: `parent cycle: ${cycle.join(" -> ")} -> ${cur.id}`,
				});
			}
		}
	}
	// Time zones: every node should resolve one (itself or an ancestor).
	for (const node of byId.values()) {
		let cur: HierarchyNode | undefined = node;
		const guard = new Set<string>();
		let found = false;
		while (cur && !guard.has(cur.id)) {
			guard.add(cur.id);
			if (normalizeTimeZone(cur.tz)) {
				found = true;
				break;
			}
			cur = cur.parentId != null ? byId.get(cur.parentId) : undefined;
		}
		if (!found) {
			issues.push({
				code: "no-timezone",
				severity: "warning",
				nodeId: node.id,
				message: `node "${node.id}" has no time zone on itself or any ancestor`,
			});
		}
	}
	return issues;
}

export interface CreateHierarchyOptions {
	/**
	 * Default true: throw `HierarchyError` on structural issues.
	 * When false, duplicates keep the first node, nodes with missing parents act as
	 * roots, and traversal is cycle-safe (a cycle simply ends the ancestor walk).
	 * The app graph uses `strict: false`: one bad row must never break a trip.
	 */
	strict?: boolean;
}

export function createHierarchy<N extends HierarchyNode>(
	input: readonly N[],
	options: CreateHierarchyOptions = {},
): Hierarchy<N> {
	const strict = options.strict ?? true;
	if (strict) {
		const structural = validateHierarchy(input).filter((i) =>
			STRUCTURAL.has(i.code),
		);
		if (structural.length > 0) throw new HierarchyError(structural);
	}

	const byId = new Map<string, N>();
	const ordered: N[] = [];
	for (const node of input) {
		if (byId.has(node.id)) continue;
		byId.set(node.id, node);
		ordered.push(node);
	}
	const childIds = new Map<string, string[]>();
	const rootNodes: N[] = [];
	for (const node of ordered) {
		if (
			node.parentId != null &&
			byId.has(node.parentId) &&
			node.parentId !== node.id
		) {
			let list = childIds.get(node.parentId);
			if (!list) {
				list = [];
				childIds.set(node.parentId, list);
			}
			list.push(node.id);
		} else {
			rootNodes.push(node);
		}
	}

	const subtreeCache = new Map<string, ReadonlySet<string>>();
	const tzCache = new Map<string, string | undefined>();
	const EMPTY: ReadonlySet<string> = new Set();

	function get(id: string): N | undefined {
		return byId.get(id);
	}

	function ancestors(id: string, opts: TraversalOptions = {}): N[] {
		const self = byId.get(id);
		if (!self) return [];
		const out: N[] = opts.includeSelf ? [self] : [];
		const seen = new Set<string>([self.id]);
		let cur = self.parentId != null ? byId.get(self.parentId) : undefined;
		while (cur && !seen.has(cur.id)) {
			seen.add(cur.id);
			out.push(cur);
			cur = cur.parentId != null ? byId.get(cur.parentId) : undefined;
		}
		return out;
	}

	function descendants(id: string, opts: TraversalOptions = {}): N[] {
		const self = byId.get(id);
		if (!self) return [];
		const out: N[] = [];
		const seen = new Set<string>();
		const visit = (nodeId: string, include: boolean) => {
			if (seen.has(nodeId)) return;
			seen.add(nodeId);
			const node = byId.get(nodeId);
			if (!node) return;
			if (include) out.push(node);
			for (const child of childIds.get(nodeId) ?? []) visit(child, true);
		};
		visit(id, opts.includeSelf ?? false);
		return out;
	}

	function subtreeIds(id: string): ReadonlySet<string> {
		if (!byId.has(id)) return EMPTY;
		let cached = subtreeCache.get(id);
		if (!cached) {
			cached = new Set(descendants(id, { includeSelf: true }).map((n) => n.id));
			subtreeCache.set(id, cached);
		}
		return cached;
	}

	function isInSubtree(id: string, rootId: string): boolean {
		if (!byId.has(id) || !byId.has(rootId)) return false;
		if (id === rootId) return true;
		return ancestors(id).some((a) => a.id === rootId);
	}

	function collapseTo(id: string, granularity: NodeType): N | undefined {
		const limit = NODE_TYPE_RANK[granularity];
		for (const node of ancestors(id, { includeSelf: true })) {
			if (NODE_TYPE_RANK[node.type] <= limit) return node;
		}
		return undefined;
	}

	function resolveTimezone(id: string): string | undefined {
		if (tzCache.has(id)) return tzCache.get(id);
		let result: string | undefined;
		for (const node of ancestors(id, { includeSelf: true })) {
			const tz = normalizeTimeZone(node.tz);
			if (tz) {
				result = tz;
				break;
			}
		}
		tzCache.set(id, result);
		return result;
	}

	return {
		size: ordered.length,
		nodes: () => ordered,
		get,
		require(id) {
			const node = byId.get(id);
			if (!node) throw new RangeError(`unknown node id "${id}"`);
			return node;
		},
		has: (id) => byId.has(id),
		roots: () => [...rootNodes],
		parent(id) {
			const node = byId.get(id);
			return node?.parentId != null && node.parentId !== node.id
				? byId.get(node.parentId)
				: undefined;
		},
		children: (id) => (childIds.get(id) ?? []).map((c) => byId.get(c) as N),
		ancestors,
		path: (id) => ancestors(id, { includeSelf: true }).reverse(),
		descendants,
		subtreeIds,
		isInSubtree,
		depth: (id) => (byId.has(id) ? ancestors(id).length : -1),
		nearestOfType: (id, type) =>
			ancestors(id, { includeSelf: true }).find((n) => n.type === type),
		collapseTo,
		resolveTimezone,
		commonAncestor(a, b) {
			const chainA = ancestors(a, { includeSelf: true });
			if (chainA.length === 0 || !byId.has(b)) return undefined;
			const inB = new Set(ancestors(b, { includeSelf: true }).map((n) => n.id));
			return chainA.find((n) => inB.has(n.id));
		},
	};
}
