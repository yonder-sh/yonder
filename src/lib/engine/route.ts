/**
 * Granularity collapse of an ordered stop sequence: consecutive stops that map
 * to the same collapsed node merge into one visit; each change of node becomes an
 * edge aggregating the legs travelled in between. Filters (subtree, days, date
 * range) break the chain, so no edge is drawn across a gap.
 *
 * Ported from `spikes/core/src/route.ts` (including the verifier's added
 * checks). It collapses with `Hierarchy.collapseTo` (nearest ancestor at or
 * coarser than the granularity). The workspace map uses `buildModel`
 * (`visits.ts`, SPEC §8.3), whose representative rule is scope-relative and
 * prefers finer nodes when a level is missing (`repAt`).
 */
import type { NodeType } from "@/lib/schemas/enums";
import type { Hierarchy, HierarchyNode } from "./hierarchy";
import type { TimelineResult, TransitMode } from "./timeline";

/** One timeline item in route order. Items without a node are "pass-through" stops. */
export interface RouteStop {
	itemId: string;
	nodeId?: string | null;
	dayId?: string | null;
	/** "YYYY-MM-DD", used by `dateRange`. */
	date?: string | null;
}

export interface RouteLeg {
	id: string;
	fromItemId: string;
	toItemId: string;
	mode: TransitMode;
	durationMin: number;
}

export interface RouteInput {
	/** Ordered. */
	stops: RouteStop[];
	legs: RouteLeg[];
}

/** Builds route input from a computed timeline (uses actual leg durations, e.g. from flight times). */
export function routeFromTimeline(result: TimelineResult): RouteInput {
	const dateByDay = new Map(result.days.map((d) => [d.id, d.date]));
	return {
		stops: result.items.map((i) => ({
			itemId: i.id,
			nodeId: i.nodeId,
			dayId: i.dayId,
			date: dateByDay.get(i.dayId) ?? null,
		})),
		legs: result.legs.map((l) => ({
			id: l.id,
			fromItemId: l.fromItemId,
			toItemId: l.toItemId,
			mode: l.mode,
			durationMin: l.durationMin,
		})),
	};
}

export interface CollapseOptions {
	granularity: NodeType;
	/** Only stops inside this subtree. Leaving the subtree breaks the chain (no edge is drawn across the gap). */
	subtreeRootId?: string | null;
	/** Only stops on these days. */
	dayIds?: readonly string[] | null;
	/** Only stops whose date is within [from, to] (inclusive, "YYYY-MM-DD"; either end optional). */
	dateRange?: { from?: string | null; to?: string | null } | null;
}

export interface MapVisit {
	/** 0-based visit order (the number on the map is usually index + 1). */
	index: number;
	nodeId: string;
	/** Anchor stops (items with a node) merged into this visit. */
	itemIds: string[];
	dayIds: string[];
}

export interface MapPin {
	nodeId: string;
	node: HierarchyNode;
	/** True when the node is coarser than the requested granularity (missing level fallback). */
	isFallback: boolean;
	/** Visit indices, ascending. */
	visitIndices: number[];
	firstVisit: number;
	itemIds: string[];
	dayIds: string[];
	/** Legs that start and end inside this pin (e.g. walks within Shinjuku at area granularity). */
	internalLegIds: string[];
	internalDurationMin: number;
}

export interface MapEdge {
	/** 0-based order along the route. */
	index: number;
	fromNodeId: string;
	toNodeId: string;
	fromVisit: number;
	toVisit: number;
	/** Last stop of the from-visit and first stop of the to-visit. */
	fromItemId: string;
	toItemId: string;
	/** Underlying legs in travel order: what to show when the edge is clicked. */
	legIds: string[];
	totalDurationMin: number;
	/** Distinct modes in first-appearance order. */
	modes: TransitMode[];
	/** Mode with the largest share of the duration (ties: first seen). Null when there are no legs. */
	primaryMode: TransitMode | null;
	durationByMode: Partial<Record<TransitMode, number>>;
	/** Nodeless items passed on the way (e.g. "Lunch"). */
	viaItemIds: string[];
	/** Consecutive-stop hops along this edge that have no transit leg yet. */
	missingLegCount: number;
	dayIds: string[];
	/** Same for A->B and B->A: group traversals of the same pair (e.g. to offset parallel lines). */
	pairKey: string;
}

export type RouteIssueCode =
	| "unknown-node"
	| "leg-unknown-item"
	| "leg-not-consecutive"
	| "unknown-subtree-root";

export interface RouteIssue {
	code: RouteIssueCode;
	message: string;
	itemId?: string;
	legId?: string;
}

export interface MapGraph {
	granularity: NodeType;
	/** Sorted by first visit. */
	pins: MapPin[];
	edges: MapEdge[];
	visits: MapVisit[];
	issues: RouteIssue[];
}

type StopKind =
	| { kind: "break" }
	| { kind: "pass" }
	| { kind: "anchor"; node: HierarchyNode };

interface Acc {
	legIds: string[];
	durationByMode: Map<TransitMode, number>;
	total: number;
	missing: number;
	via: string[];
	days: Set<string>;
}

/** The last anchor stop seen (null right after a chain break). */
interface Cursor {
	visit: MapVisit;
	itemId: string;
	dayId: string | null;
}

const newAcc = (): Acc => ({
	legIds: [],
	durationByMode: new Map(),
	total: 0,
	missing: 0,
	via: [],
	days: new Set(),
});

/**
 * Collapses the ordered stop sequence to a granularity: consecutive stops that map
 * to the same node merge into one visit; each change of node becomes an edge that
 * aggregates every leg travelled in between.
 */
export function collapseRoute(
	route: RouteInput,
	hierarchy: Hierarchy,
	options: CollapseOptions,
): MapGraph {
	const { granularity } = options;
	const issues: RouteIssue[] = [];

	let subtree: ReadonlySet<string> | null = null;
	if (options.subtreeRootId) {
		subtree = hierarchy.subtreeIds(options.subtreeRootId);
		if (subtree.size === 0) {
			issues.push({
				code: "unknown-subtree-root",
				message: `unknown subtree root "${options.subtreeRootId}"`,
			});
		}
	}
	const subtreeRoot = options.subtreeRootId
		? hierarchy.get(options.subtreeRootId)
		: undefined;
	const dayFilter = options.dayIds ? new Set(options.dayIds) : null;
	const from = options.dateRange?.from ?? null;
	const to = options.dateRange?.to ?? null;

	// Legs by position of their to-stop.
	const pos = new Map<string, number>();
	route.stops.forEach((s, i) => {
		pos.set(s.itemId, i);
	});
	const legInto = new Map<number, RouteLeg>();
	for (const leg of route.legs) {
		const a = pos.get(leg.fromItemId);
		const b = pos.get(leg.toItemId);
		if (a === undefined || b === undefined) {
			issues.push({
				code: "leg-unknown-item",
				legId: leg.id,
				message: `leg "${leg.id}" references an item not in the route`,
			});
		} else if (b !== a + 1) {
			issues.push({
				code: "leg-not-consecutive",
				legId: leg.id,
				message: `leg "${leg.id}" does not connect consecutive stops`,
			});
		} else if (!legInto.has(b)) {
			legInto.set(b, leg);
		}
	}

	const classify = (stop: RouteStop): StopKind => {
		if (dayFilter && (!stop.dayId || !dayFilter.has(stop.dayId)))
			return { kind: "break" };
		if (
			(from || to) &&
			(!stop.date || (from && stop.date < from) || (to && stop.date > to))
		)
			return { kind: "break" };
		if (!stop.nodeId) return { kind: "pass" };
		const node = hierarchy.get(stop.nodeId);
		if (!node) {
			issues.push({
				code: "unknown-node",
				itemId: stop.itemId,
				message: `stop "${stop.itemId}" references unknown node "${stop.nodeId}"; treated as pass-through`,
			});
			return { kind: "pass" };
		}
		if (subtree && !subtree.has(node.id)) return { kind: "break" };
		let collapsed = hierarchy.collapseTo(node.id, granularity) ?? node;
		// Never collapse above the selected subtree: at "country" inside Tokyo, everything is Tokyo.
		if (subtree && subtreeRoot && !subtree.has(collapsed.id))
			collapsed = subtreeRoot;
		return { kind: "anchor", node: collapsed };
	};

	const visits: MapVisit[] = [];
	const edges: MapEdge[] = [];
	const pins = new Map<string, MapPin>();
	let last: Cursor | null = null;
	let acc = newAcc();

	route.stops.forEach((stop, i) => {
		const c = classify(stop);
		if (c.kind === "break") {
			last = null;
			acc = newAcc();
			return;
		}
		if (last) {
			const leg = legInto.get(i);
			if (leg) {
				acc.legIds.push(leg.id);
				acc.total += leg.durationMin;
				acc.durationByMode.set(
					leg.mode,
					(acc.durationByMode.get(leg.mode) ?? 0) + leg.durationMin,
				);
			} else {
				acc.missing += 1;
			}
			if (stop.dayId) acc.days.add(stop.dayId);
		}
		if (c.kind === "pass") {
			if (last) acc.via.push(stop.itemId);
			return;
		}

		const node = c.node;
		let pin = pins.get(node.id);
		if (!pin) {
			pin = {
				nodeId: node.id,
				node,
				isFallback: node.type !== granularity,
				visitIndices: [],
				firstVisit: visits.length,
				itemIds: [],
				dayIds: [],
				internalLegIds: [],
				internalDurationMin: 0,
			};
			pins.set(node.id, pin);
		}
		pin.itemIds.push(stop.itemId);
		if (stop.dayId && !pin.dayIds.includes(stop.dayId))
			pin.dayIds.push(stop.dayId);

		const prev = last as Cursor | null;
		if (prev && prev.visit.nodeId === node.id) {
			// Same collapsed node: stay in the visit; the legs were internal.
			pin.internalLegIds.push(...acc.legIds);
			pin.internalDurationMin += acc.total;
			prev.visit.itemIds.push(stop.itemId);
			if (stop.dayId && !prev.visit.dayIds.includes(stop.dayId))
				prev.visit.dayIds.push(stop.dayId);
			last = {
				visit: prev.visit,
				itemId: stop.itemId,
				dayId: stop.dayId ?? null,
			};
		} else {
			const visit: MapVisit = {
				index: visits.length,
				nodeId: node.id,
				itemIds: [stop.itemId],
				dayIds: stop.dayId ? [stop.dayId] : [],
			};
			visits.push(visit);
			pin.visitIndices.push(visit.index);
			if (prev)
				edges.push(makeEdge(edges.length, prev, visit, stop.itemId, acc));
			last = { visit, itemId: stop.itemId, dayId: stop.dayId ?? null };
		}
		acc = newAcc();
	});

	return {
		granularity,
		pins: [...pins.values()].sort((a, b) => a.firstVisit - b.firstVisit),
		edges,
		visits,
		issues,
	};
}

function makeEdge(
	index: number,
	prev: Cursor,
	visit: MapVisit,
	toItemId: string,
	acc: Acc,
): MapEdge {
	const modes = [...acc.durationByMode.keys()];
	let primaryMode: TransitMode | null = null;
	let best = -1;
	for (const [mode, minutes] of acc.durationByMode) {
		if (minutes > best) {
			best = minutes;
			primaryMode = mode;
		}
	}
	const dayIds = [
		...new Set([...(prev.dayId ? [prev.dayId] : []), ...acc.days]),
	];
	const a = prev.visit.nodeId;
	const b = visit.nodeId;
	return {
		index,
		fromNodeId: a,
		toNodeId: b,
		fromVisit: prev.visit.index,
		toVisit: visit.index,
		fromItemId: prev.itemId,
		toItemId,
		legIds: acc.legIds,
		totalDurationMin: acc.total,
		modes,
		primaryMode,
		durationByMode: Object.fromEntries(acc.durationByMode) as Partial<
			Record<TransitMode, number>
		>,
		viaItemIds: acc.via,
		missingLegCount: acc.missing,
		dayIds,
		pairKey: pairKey(a, b),
	};
}

export function pairKey(a: string, b: string): string {
	return a < b ? JSON.stringify([a, b]) : JSON.stringify([b, a]);
}

export interface EdgePairSummary {
	pairKey: string;
	/** Endpoints in the direction of the first traversal. */
	nodeIds: [string, string];
	edgeIndices: number[];
	legIds: string[];
	totalDurationMin: number;
	modes: TransitMode[];
	/** True when the pair is travelled in both directions. */
	bidirectional: boolean;
}

/** Groups edge traversals by unordered node pair (for drawing one line per pair with a count). */
export function groupEdgesByPair(edges: readonly MapEdge[]): EdgePairSummary[] {
	const byKey = new Map<string, EdgePairSummary>();
	for (const e of edges) {
		let g = byKey.get(e.pairKey);
		if (!g) {
			g = {
				pairKey: e.pairKey,
				nodeIds: [e.fromNodeId, e.toNodeId],
				edgeIndices: [],
				legIds: [],
				totalDurationMin: 0,
				modes: [],
				bidirectional: false,
			};
			byKey.set(e.pairKey, g);
		}
		g.edgeIndices.push(e.index);
		g.legIds.push(...e.legIds);
		g.totalDurationMin += e.totalDurationMin;
		for (const m of e.modes) if (!g.modes.includes(m)) g.modes.push(m);
		if (e.fromNodeId !== g.nodeIds[0]) g.bidirectional = true;
	}
	return [...byKey.values()];
}
