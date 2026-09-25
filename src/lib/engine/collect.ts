/**
 * Collects entity-attached things (todos, shopping, attachments, notes) within
 * a scope: a node subtree, a day or days, an item, a leg or the whole trip.
 *
 * Ported from `spikes/core/src/rollups.ts` (renamed so it is not confused with
 * `rollup.ts`, the grouped inspector rollup of SPEC §8.4). Use `entityOf` to turn
 * a database row's target columns (`nodeId`/`legId`/`itemId`/`dayId`, all null
 * = the trip root) into the `EntityRef` this module expects.
 *
 * `ScopeMembers` holds `Set`s: convert with `[...set]` before sending a result
 * over the wire.
 */
import type { NodeType } from "@/lib/schemas/enums";
import type { Hierarchy, HierarchyNode } from "./hierarchy";

export type EntityType = "node" | "item" | "leg" | "day" | "trip";

export interface EntityRef {
	type: EntityType;
	id: string;
}

/**
 * A row's bundle target columns → `EntityRef`. All null means the trip root,
 * whose id is `tripId`. The DB CHECK guarantees at most one column is set.
 */
export function entityOf(
	row: {
		nodeId?: string | null;
		legId?: string | null;
		itemId?: string | null;
		dayId?: string | null;
	},
	tripId: string,
): EntityRef {
	if (row.nodeId) return { type: "node", id: row.nodeId };
	if (row.legId) return { type: "leg", id: row.legId };
	if (row.itemId) return { type: "item", id: row.itemId };
	if (row.dayId) return { type: "day", id: row.dayId };
	return { type: "trip", id: tripId };
}

/** Anything attached to an entity: todos, shopping entries, attachments... */
export interface Attachable {
	entity: EntityRef;
}

/** Minimal timeline shape needed for rollups (a `TimelineInput` fits). */
export interface RollupTimeline {
	days: ReadonlyArray<{
		id: string;
		items: ReadonlyArray<{ id: string; nodeId?: string | null }>;
	}>;
	legs?: ReadonlyArray<{
		id: string;
		fromItemId: string;
		toItemId: string;
		/** Optional explicit endpoint nodes (e.g. airports) that override the items' nodes. */
		fromNodeId?: string | null;
		toNodeId?: string | null;
	}>;
}

export interface RollupContext {
	hierarchy: Hierarchy;
	timeline?: RollupTimeline | null;
	/** When set, trip-entity attachments with a different id are "unresolved". */
	tripId?: string | null;
}

export interface NodeScope {
	type: "node";
	id: string;
	/**
	 * Which legs count as "in" the subtree:
	 * "either" (default) = at least one endpoint in the subtree (a Tokyo -> Fuji train is in both),
	 * "both" = both endpoints inside.
	 */
	legMatch?: "either" | "both";
	/**
	 * Which days count as "in" the subtree:
	 * "any" (default) = at least one item of the day is in the subtree,
	 * "all" = every item with a node is in the subtree (days without nodes never match),
	 * "none" = never include day attachments.
	 */
	dayMatch?: "any" | "all" | "none";
	/** Also include attachments on ancestors (e.g. "get IC card" on Tokyo when viewing Shinjuku). Default false. */
	includeAncestors?: boolean;
	/** Also include trip-level attachments. Default false. */
	includeTrip?: boolean;
}

export interface DayScope {
	type: "day";
	/** One day or several (e.g. a date range already resolved to ids). */
	id: string | readonly string[];
	/** Node attachments: "exact" (default) = nodes of the day's items; "subtree" = those nodes and their descendants. */
	nodeMatch?: "exact" | "subtree";
	/** Legs: "touching" (default) = either endpoint on the day(s); "departing" = from-item on the day(s). */
	legMatch?: "touching" | "departing";
	includeTrip?: boolean;
}

export interface ItemScope {
	type: "item";
	id: string;
	/** Include attachments on the item's node. Default true. */
	includeNode?: boolean;
}

export interface LegScope {
	type: "leg";
	id: string;
}

export interface TripScope {
	type: "trip";
}

export type RollupScope =
	| NodeScope
	| DayScope
	| ItemScope
	| LegScope
	| TripScope;

/** The concrete entity ids a scope covers. */
export interface ScopeMembers {
	nodeIds: ReadonlySet<string>;
	itemIds: ReadonlySet<string>;
	legIds: ReadonlySet<string>;
	dayIds: ReadonlySet<string>;
	trip: boolean;
}

export interface RollupMatch<T> {
	attachment: T;
	/** The node the attachment relates to (node itself, item's node, leg endpoint in scope). Null for day/trip or nodeless items. */
	nodeId: string | null;
}

export interface RollupResult<T> {
	/** Input order. */
	matches: RollupMatch<T>[];
	attachments: T[];
	/** Attachments whose entity does not exist in the context (never in `matches`). */
	unresolved: T[];
	members: ScopeMembers;
	countsByEntityType: Record<EntityType, number>;
}

interface TimelineIndex {
	itemNode: Map<string, string | null>;
	dayItems: Map<string, string[]>;
	legEnds: Map<
		string,
		{
			fromItemId: string;
			toItemId: string;
			fromNodeId: string | null;
			toNodeId: string | null;
		}
	>;
}

/** Rebuilt on every call (cheap, O(items + legs)) so mutated inputs are never served stale. */
function indexTimeline(
	timeline: RollupTimeline | null | undefined,
): TimelineIndex {
	const idx: TimelineIndex = {
		itemNode: new Map(),
		dayItems: new Map(),
		legEnds: new Map(),
	};
	if (!timeline) return idx;
	for (const day of timeline.days) {
		idx.dayItems.set(
			day.id,
			day.items.map((i) => i.id),
		);
		for (const item of day.items) {
			idx.itemNode.set(item.id, item.nodeId ?? null);
		}
	}
	for (const leg of timeline.legs ?? []) {
		idx.legEnds.set(leg.id, {
			fromItemId: leg.fromItemId,
			toItemId: leg.toItemId,
			fromNodeId: leg.fromNodeId ?? idx.itemNode.get(leg.fromItemId) ?? null,
			toNodeId: leg.toNodeId ?? idx.itemNode.get(leg.toItemId) ?? null,
		});
	}
	return idx;
}

/** Resolves a scope to the concrete node/item/leg/day ids it covers. */
export function resolveScope(
	scope: RollupScope,
	ctx: RollupContext,
): ScopeMembers {
	return resolveWith(scope, ctx, indexTimeline(ctx.timeline));
}

function resolveWith(
	scope: RollupScope,
	ctx: RollupContext,
	idx: TimelineIndex,
): ScopeMembers {
	const { hierarchy } = ctx;
	const nodeIds = new Set<string>();
	const itemIds = new Set<string>();
	const legIds = new Set<string>();
	const dayIds = new Set<string>();
	let trip = false;

	switch (scope.type) {
		case "trip": {
			for (const n of hierarchy.nodes()) nodeIds.add(n.id);
			for (const id of idx.itemNode.keys()) itemIds.add(id);
			for (const id of idx.legEnds.keys()) legIds.add(id);
			for (const id of idx.dayItems.keys()) dayIds.add(id);
			trip = true;
			break;
		}
		case "node": {
			const subtree = hierarchy.subtreeIds(scope.id);
			for (const id of subtree) nodeIds.add(id);
			if (scope.includeAncestors)
				for (const a of hierarchy.ancestors(scope.id)) nodeIds.add(a.id);
			const inSubtree = (nodeId: string | null | undefined) =>
				!!nodeId && subtree.has(nodeId);
			for (const [itemId, nodeId] of idx.itemNode)
				if (inSubtree(nodeId)) itemIds.add(itemId);
			const legMatch = scope.legMatch ?? "either";
			for (const [legId, ends] of idx.legEnds) {
				const a = inSubtree(ends.fromNodeId);
				const b = inSubtree(ends.toNodeId);
				if (legMatch === "both" ? a && b : a || b) legIds.add(legId);
			}
			const dayMatch = scope.dayMatch ?? "any";
			if (dayMatch !== "none") {
				for (const [dayId, items] of idx.dayItems) {
					const withNode = items
						.map((i) => idx.itemNode.get(i))
						.filter((n): n is string => !!n);
					const hit =
						dayMatch === "any"
							? withNode.some(inSubtree)
							: withNode.length > 0 && withNode.every(inSubtree);
					if (hit) dayIds.add(dayId);
				}
			}
			trip = scope.includeTrip ?? false;
			break;
		}
		case "day": {
			const ids = typeof scope.id === "string" ? [scope.id] : scope.id;
			for (const id of ids) if (idx.dayItems.has(id)) dayIds.add(id);
			for (const dayId of dayIds) {
				for (const itemId of idx.dayItems.get(dayId) ?? []) {
					itemIds.add(itemId);
					const nodeId = idx.itemNode.get(itemId);
					if (nodeId && hierarchy.has(nodeId)) {
						if (scope.nodeMatch === "subtree")
							for (const d of hierarchy.subtreeIds(nodeId)) nodeIds.add(d);
						else nodeIds.add(nodeId);
					}
				}
			}
			const legMatch = scope.legMatch ?? "touching";
			for (const [legId, ends] of idx.legEnds) {
				const a = itemIds.has(ends.fromItemId);
				const b = itemIds.has(ends.toItemId);
				if (legMatch === "departing" ? a : a || b) legIds.add(legId);
			}
			trip = scope.includeTrip ?? false;
			break;
		}
		case "item": {
			if (idx.itemNode.has(scope.id)) {
				itemIds.add(scope.id);
				const nodeId = idx.itemNode.get(scope.id);
				if (nodeId && (scope.includeNode ?? true)) nodeIds.add(nodeId);
			}
			break;
		}
		case "leg": {
			if (idx.legEnds.has(scope.id)) legIds.add(scope.id);
			break;
		}
	}
	return { nodeIds, itemIds, legIds, dayIds, trip };
}

function entityExists(
	ref: EntityRef,
	ctx: RollupContext,
	idx: TimelineIndex,
): boolean {
	switch (ref.type) {
		case "node":
			return ctx.hierarchy.has(ref.id);
		case "item":
			return idx.itemNode.has(ref.id);
		case "leg":
			return idx.legEnds.has(ref.id);
		case "day":
			return idx.dayItems.has(ref.id);
		case "trip":
			return !ctx.tripId || ctx.tripId === ref.id;
		default:
			return false;
	}
}

/**
 * Collects every attachment within a scope. For a node scope that means: the
 * node subtree, timeline items whose node is in the subtree, legs touching it,
 * and days that visit it (see `NodeScope` for the knobs).
 */
export function collectInScope<T extends Attachable>(
	attachments: readonly T[],
	scope: RollupScope,
	ctx: RollupContext,
): RollupResult<T> {
	const idx = indexTimeline(ctx.timeline);
	const members = resolveWith(scope, ctx, idx);
	const matches: RollupMatch<T>[] = [];
	const unresolved: T[] = [];
	const counts: Record<EntityType, number> = {
		node: 0,
		item: 0,
		leg: 0,
		day: 0,
		trip: 0,
	};

	for (const attachment of attachments) {
		const ref = attachment.entity;
		if (!entityExists(ref, ctx, idx)) {
			unresolved.push(attachment);
			continue;
		}
		let hit = false;
		let nodeId: string | null = null;
		switch (ref.type) {
			case "node":
				hit = members.nodeIds.has(ref.id);
				nodeId = ref.id;
				break;
			case "item":
				hit = members.itemIds.has(ref.id);
				nodeId = idx.itemNode.get(ref.id) ?? null;
				break;
			case "leg": {
				hit = members.legIds.has(ref.id);
				const ends = idx.legEnds.get(ref.id);
				if (ends) {
					// Prefer the endpoint that lies within the scope.
					const inScope = (n: string | null) => !!n && members.nodeIds.has(n);
					nodeId = inScope(ends.fromNodeId)
						? ends.fromNodeId
						: inScope(ends.toNodeId)
							? ends.toNodeId
							: ends.fromNodeId;
				}
				break;
			}
			case "day":
				hit = members.dayIds.has(ref.id);
				break;
			case "trip":
				hit = members.trip;
				break;
		}
		if (hit) {
			matches.push({ attachment, nodeId });
			counts[ref.type] += 1;
		}
	}
	return {
		matches,
		attachments: matches.map((m) => m.attachment),
		unresolved,
		members,
		countsByEntityType: counts,
	};
}

export interface RollupGroup<T> {
	/** Null for matches without a node (day/trip attachments, nodeless items). */
	node: HierarchyNode | null;
	matches: RollupMatch<T>[];
}

/**
 * Groups matches by their node collapsed to a granularity (e.g. a Tokyo rollup
 * grouped by area). Groups are ordered by first appearance; the null group last.
 */
export function groupRollupByNode<T>(
	matches: readonly RollupMatch<T>[],
	hierarchy: Hierarchy,
	granularity: NodeType,
): RollupGroup<T>[] {
	const groups = new Map<string | null, RollupGroup<T>>();
	for (const m of matches) {
		const node = m.nodeId
			? (hierarchy.collapseTo(m.nodeId, granularity) ?? null)
			: null;
		const key = node?.id ?? null;
		let g = groups.get(key);
		if (!g) {
			g = { node, matches: [] };
			groups.set(key, g);
		}
		g.matches.push(m);
	}
	const out = [...groups.values()];
	return [
		...out.filter((g) => g.node !== null),
		...out.filter((g) => g.node === null),
	];
}
