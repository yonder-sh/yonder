/**
 * What the Overview says about a node (DESIGN §4.4), computed from the graph
 * index and the schedule. Pure.
 *
 * - visits of a coarse node: runs of consecutive trip days that touch it
 *   ("12–18 Apr · 6 nights · 23 stops", with day links);
 * - a place's scheduled occurrences, the nights it is the stay, and its travel
 *   in and out (the legs of its first occurrence);
 * - place and idea counts below a node.
 */
import type { GraphIndex } from "@/lib/engine/graph-index";
import type {
	GraphDay,
	GraphItem,
	GraphLeg,
	GraphNode,
	ScheduleResult,
} from "@/lib/engine/types";

export type NodeVisit = {
	days: GraphDay[];
	nights: number;
	stops: number;
};

/** Consecutive-day runs whose items (or night's stay) are inside `nodeId`. */
export function visitsOf(ix: GraphIndex, nodeId: string): NodeVisit[] {
	const out: NodeVisit[] = [];
	let cur: NodeVisit | null = null;
	let prevIndex = -2;
	for (const [i, day] of ix.days.entries()) {
		const items = (ix.itemsByDay.get(day.id) ?? []).filter((it) =>
			ix.isWithin(it.nodeId, nodeId),
		);
		const night = ix.isWithin(day.nightNodeId, nodeId);
		if (!items.length && !night) continue;
		if (!cur || i !== prevIndex + 1) {
			cur = { days: [], nights: 0, stops: 0 };
			out.push(cur);
		}
		cur.days.push(day);
		cur.stops += items.length;
		if (night) cur.nights += 1;
		prevIndex = i;
	}
	return out;
}

/** Scheduled items of exactly this node, in trip order. */
export function occurrencesOf(ix: GraphIndex, nodeId: string): GraphItem[] {
	return ix.ordered.filter((it) => it.nodeId === nodeId);
}

/** Unscheduled items (dayId = null) of this node. */
export function unscheduledOf(ix: GraphIndex, nodeId: string): GraphItem[] {
	return ix.unscheduled.filter((it) => it.nodeId === nodeId);
}

/** The days whose night's stay is this node. */
export function stayNightsOf(ix: GraphIndex, nodeId: string): GraphDay[] {
	return ix.days.filter((d) => d.nightNodeId === nodeId);
}

export type TravelHop = {
	dir: "in" | "out";
	fromItemId: string;
	toItemId: string;
	/** The other end's node. */
	otherNodeId: string | null;
	leg: GraphLeg | null;
	minutes: number | null;
	estimate: boolean;
};

/** Travel into and out of an item (its pair legs), for "In: walk 12m from Itoya". */
export function travelOf(
	ix: GraphIndex,
	schedule: ScheduleResult | null,
	itemId: string,
): TravelHop[] {
	const it = ix.item(itemId);
	if (!it?.nodeId) return [];
	const hops: TravelHop[] = [];
	const prev = ix.prevLocated(itemId);
	const next = ix.nextLocated(itemId);
	const mk = (dir: "in" | "out", from: GraphItem, to: GraphItem) => {
		if (from.nodeId === to.nodeId) return;
		const key = `${from.id}>${to.id}`;
		const leg = ix.legByPair.get(key) ?? null;
		const s = schedule?.legs[key];
		hops.push({
			dir,
			fromItemId: from.id,
			toItemId: to.id,
			otherNodeId: dir === "in" ? from.nodeId : to.nodeId,
			leg,
			minutes: s?.minutes ?? leg?.durationMin ?? null,
			estimate: s?.estimate ?? false,
		});
	};
	if (prev && prev.dayId === it.dayId) mk("in", prev, it);
	if (next && next.dayId === it.dayId) mk("out", it, next);
	return hops;
}

export type NodeCounts = { places: number; ideas: number; scheduled: number };

/** Places below `nodeId` (live, not dropped), how many are ideas (never scheduled). */
export function placeCounts(ix: GraphIndex, nodeId: string | null): NodeCounts {
	let places = 0;
	let ideas = 0;
	for (const n of ix.outline) {
		if (n.type !== "place" || n.id === nodeId) continue;
		if (!ix.isWithin(n.id, nodeId) || ix.isDropped(n.id)) continue;
		places += 1;
		if (!ix.scheduledNodeIds.has(n.id)) ideas += 1;
	}
	return { places, ideas, scheduled: places - ideas };
}

/** Number of live places inside a node (for the children list). */
export function placesInside(ix: GraphIndex, nodeId: string): number {
	let n = 0;
	for (const x of ix.outline)
		if (
			x.type === "place" &&
			x.id !== nodeId &&
			ix.isWithin(x.id, nodeId) &&
			!ix.isDropped(x.id)
		)
			n += 1;
	return n;
}

/** Open todo and shopping counts attached inside a node (its nodes and their items). */
export function openListCounts(
	ix: GraphIndex,
	counts:
		| {
				byNode: Record<string, { todoOpen: number; shopOpen: number }>;
				byItem: Record<string, { todoOpen: number; shopOpen: number }>;
		  }
		| undefined,
	nodeId: string,
): { todo: number; shop: number } {
	const out = { todo: 0, shop: 0 };
	if (!counts) return out;
	for (const [id, c] of Object.entries(counts.byNode))
		if (ix.isWithin(id, nodeId)) {
			out.todo += c.todoOpen;
			out.shop += c.shopOpen;
		}
	for (const [id, c] of Object.entries(counts.byItem))
		if (ix.isWithin(ix.item(id)?.nodeId, nodeId)) {
			out.todo += c.todoOpen;
			out.shop += c.shopOpen;
		}
	return out;
}

/** The node's crumbs above it (Japan › Tokyo for Itoya). */
export function ancestorsOf(ix: GraphIndex, nodeId: string): GraphNode[] {
	return ix.path(nodeId).slice(0, -1);
}
