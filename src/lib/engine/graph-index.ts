/**
 * `indexGraph(g)` (SPEC §8.1): one pass over the trip graph that every other
 * engine function reads. Ordering, the located sequence and its pairs, leg
 * lookups by pair and by stay, effective nodes, boundary kinds, stays, flight
 * blocks, detached legs and zone resolution.
 *
 * Pure and deterministic: the same graph always gives the same index. It never
 * throws on bad data (unknown ids, broken trees, bad zones); it degrades.
 */
import type { LegDetails } from "@/lib/schemas/legs";
import { isAutoFlight } from "./flights";
import { bboxCenter, type LngLat, lngLatOf } from "./geo";
import { createHierarchy, type Hierarchy } from "./hierarchy";
import { addDays, parseTime, safeTimeZone } from "./time";
import type {
	BoundaryKind,
	DetachedLeg,
	GraphDay,
	GraphItem,
	GraphLeg,
	GraphNode,
	GraphTrip,
	PairKey,
	StayKey,
	TripGraph,
} from "./types";

/** `TripSettings` with the defaults applied (SPEC §6.5). */
export interface ResolvedSettings {
	defaultDayStart: string;
	currency: string;
	walkSpeedKmh: number;
	compact: boolean;
	autofillLegs: boolean;
	dayCapacityMin: number;
}

export interface Pair {
	fromItemId: string;
	toItemId: string;
	key: PairKey;
	crossDay: boolean;
}

export interface StayLegPlan {
	dayId: string;
	end: "start" | "end";
	/** The stay node (last night's for `start`, tonight's for `end`). */
	stayNodeId: string;
	/** F (first located item) for `start`, L (last located item) for `end`. */
	anchorItemId: string;
	/** Endpoints in travel order. */
	fromNodeId: string;
	toNodeId: string;
}

export interface GraphIndex {
	readonly graph: TripGraph;
	readonly trip: GraphTrip;
	readonly settings: ResolvedSettings;
	/** `trip.defaultTz`, validated (UTC when invalid). */
	readonly defaultTz: string;
	/** The place tree, children by `(position, id)`. Lenient: a bad row never breaks the trip. */
	readonly hierarchy: Hierarchy<GraphNode>;

	node(id: string | null | undefined): GraphNode | undefined;
	/** Children by `(position, id)`; `null` = the trip root's children. */
	children(id: string | null): GraphNode[];
	/** Root → node. Empty for unknown ids. */
	path(id: string): GraphNode[];
	/** `id` is the scope or inside it. Every known node is within the root (`scopeId === null`). */
	isWithin(id: string | null | undefined, scopeId: string | null): boolean;
	/** The node or an ancestor has `status: 'dropped'`. */
	isDropped(id: string): boolean;
	/** Every node in outline order (depth-first, children by position). */
	readonly outline: readonly GraphNode[];
	outlineIndex(id: string): number;

	/** By date. */
	readonly days: readonly GraphDay[];
	day(id: string | null | undefined): GraphDay | undefined;
	/** date → 0-based ordinal among the trip's days. */
	readonly dayIndex: ReadonlyMap<string, number>;
	/** 1-based "Day N", or 0 for an unknown day. */
	dayNumber(dayId: string): number;
	dayOfDate(date: string): GraphDay | undefined;
	/** The day whose date is one before this day's (the "previous night"). */
	prevDay(dayId: string): GraphDay | undefined;
	/** Live items per day, by `(position, id)`. */
	readonly itemsByDay: ReadonlyMap<string, readonly GraphItem[]>;
	/** `dayId = null` items (and items on unknown days), by `(position, id)`. */
	readonly unscheduled: readonly GraphItem[];
	item(id: string | null | undefined): GraphItem | undefined;
	/** Every scheduled item by `(day.date, position, id)`. */
	readonly ordered: readonly GraphItem[];
	/** Index in `ordered`, -1 when unscheduled or unknown. */
	orderOf(itemId: string): number;
	/** The items of `ordered` that have a node. */
	readonly located: readonly GraphItem[];
	/** Nearest located item strictly before `itemId` in `ordered` (across days). */
	prevLocated(itemId: string): GraphItem | null;
	/** Nearest located item strictly after `itemId` in `ordered` (across days). */
	nextLocated(itemId: string): GraphItem | null;
	firstLocated(dayId: string): GraphItem | null;
	lastLocated(dayId: string): GraphItem | null;
	/** The current pairs: consecutive located items with different nodes (§7.8). */
	readonly pairs: readonly Pair[];
	isPair(fromItemId: string, toItemId: string): boolean;

	leg(id: string | null | undefined): GraphLeg | undefined;
	/** `"from>to"` → pair leg row. */
	readonly legByPair: ReadonlyMap<string, GraphLeg>;
	/** `"<dayId>:start|end"` → stay leg row. */
	readonly legByStay: ReadonlyMap<string, GraphLeg>;
	/** `details`, with the DB default `{}` read as `{ kind: 'none' }`. */
	legDetails(leg: GraphLeg): LegDetails;
	/** A flight, or transit with fixed times: it has `depAt` and `arrAt`. */
	isTimed(
		leg: GraphLeg | null | undefined,
	): leg is GraphLeg & { depAt: string; arrAt: string };
	/** Something a user would miss if the leg vanished (§7.8). */
	isSignificant(leg: GraphLeg): boolean;
	/** Significant pair legs whose pair is no longer consecutive (§7.8). Derived, never stored. */
	readonly detachedLegs: readonly DetachedLeg[];

	/** Nodes with scheduled items, stay nodes, and all their ancestors. */
	readonly scheduledNodeIds: ReadonlySet<string>;
	/** Item-id chains joined by flight legs (§7.9), in trip order. */
	readonly flightBlocks: readonly (readonly string[])[];
	blockOf(itemId: string): readonly string[] | null;

	/** Where you physically are during the item (§8.1). */
	effectiveNodeId(itemId: string): string | null;
	/** How the pair P→I is travelled; `same-day` when both are on one day. */
	boundaryKind(fromItemId: string, toItemId: string): BoundaryKind;
	/** The morning stay leg of a day, when one applies (§7.6). */
	morningStay(dayId: string): StayLegPlan | null;
	/** The evening stay leg of a day, when one applies (§7.6). */
	eveningStay(dayId: string): StayLegPlan | null;

	/** Resolved IANA zone of a node: own `tz`, nearest ancestor's, `trip.defaultTz`, UTC (§7.4). Never throws. */
	tzOf(nodeId: string | null | undefined): string;
	/** A node's coordinates, else the centre of its located descendants' bbox. */
	coordOf(nodeId: string | null | undefined): LngLat | null;
}

/** Sort key compare matching Postgres `COLLATE "C"` for ASCII fractional-indexing keys. */
export function compareKeys(a: string, b: string): number {
	return a < b ? -1 : a > b ? 1 : 0;
}

const byPositionThenId = (
	a: { position: string; id: string },
	b: { position: string; id: string },
) => compareKeys(a.position, b.position) || compareKeys(a.id, b.id);

export const pairKey = (fromItemId: string, toItemId: string): PairKey =>
	`${fromItemId}>${toItemId}`;
export const stayKey = (dayId: string, end: "start" | "end"): StayKey =>
	`${dayId}:${end}`;

export function resolveSettings(trip: GraphTrip): ResolvedSettings {
	const s = trip.settings ?? {};
	return {
		defaultDayStart: parseTime(s.defaultDayStart) ?? "09:00",
		currency: s.currency ?? "USD",
		walkSpeedKmh: s.walkSpeedKmh && s.walkSpeedKmh > 0 ? s.walkSpeedKmh : 4.5,
		compact: s.compact ?? false,
		autofillLegs: s.autofillLegs ?? true,
		dayCapacityMin: s.dayCapacityMin ?? 840,
	};
}

/** Reads `legs.details` without zod: `{}` or anything without a known `kind` is `{ kind: 'none' }`. */
export function readDetails(leg: GraphLeg): LegDetails {
	const d = leg.details as { kind?: unknown } | null | undefined;
	switch (d?.kind) {
		case "walk":
		case "transit":
		case "flight":
		case "other":
		case "none":
			return d as LegDetails;
		default:
			return { kind: "none" };
	}
}

const validInstant = (iso: string | null | undefined): boolean =>
	iso != null && Number.isFinite(Date.parse(iso));

export function indexGraph(g: TripGraph): GraphIndex {
	const trip = g.trip;
	const settings = resolveSettings(trip);
	const defaultTz = safeTimeZone(trip.defaultTz);

	// ---- nodes ---------------------------------------------------------------
	const sortedNodes = [...g.nodes].sort(byPositionThenId);
	const hierarchy = createHierarchy(sortedNodes, { strict: false });
	const rootChildren = hierarchy.roots();
	const outline: GraphNode[] = [];
	for (const r of rootChildren)
		outline.push(...hierarchy.descendants(r.id, { includeSelf: true }));
	const outlinePos = new Map(outline.map((n, i) => [n.id, i]));

	const droppedCache = new Map<string, boolean>();
	const isDropped = (id: string): boolean => {
		const cached = droppedCache.get(id);
		if (cached !== undefined) return cached;
		const result = hierarchy
			.ancestors(id, { includeSelf: true })
			.some((n) => n.status === "dropped");
		droppedCache.set(id, result);
		return result;
	};

	const coordCache = new Map<string, LngLat | null>();
	const coordOf = (id: string | null | undefined): LngLat | null => {
		if (!id) return null;
		if (coordCache.has(id)) return coordCache.get(id) ?? null;
		const n = hierarchy.get(id);
		let c = lngLatOf(n);
		if (n && !c) {
			const pts = hierarchy
				.descendants(id)
				.map(lngLatOf)
				.filter((p): p is LngLat => p !== null);
			c = bboxCenter(pts);
		}
		coordCache.set(id, c);
		return c;
	};

	const tzOf = (nodeId: string | null | undefined): string => {
		if (!nodeId) return defaultTz;
		return hierarchy.resolveTimezone(nodeId) ?? defaultTz;
	};

	// ---- days ----------------------------------------------------------------
	const days = [...g.days].sort(
		(a, b) => compareKeys(a.date, b.date) || compareKeys(a.id, b.id),
	);
	const dayById = new Map(days.map((d) => [d.id, d]));
	const dayByDate = new Map<string, GraphDay>();
	for (const d of days) if (!dayByDate.has(d.date)) dayByDate.set(d.date, d);
	const dayIndex = new Map(days.map((d, i) => [d.date, i] as const));
	const dayOrdinal = new Map(days.map((d, i) => [d.id, i + 1] as const));
	const prevDay = (dayId: string): GraphDay | undefined => {
		const d = dayById.get(dayId);
		if (!d) return undefined;
		try {
			return dayByDate.get(addDays(d.date, -1));
		} catch {
			return undefined;
		}
	};
	/** A day's stay node, only when the node is live. */
	const nightOf = (day: GraphDay | undefined): string | null =>
		day?.nightNodeId && hierarchy.has(day.nightNodeId) ? day.nightNodeId : null;

	// ---- items ---------------------------------------------------------------
	const itemById = new Map(g.items.map((i) => [i.id, i]));
	const itemsByDay = new Map<string, GraphItem[]>(days.map((d) => [d.id, []]));
	const unscheduled: GraphItem[] = [];
	for (const item of g.items) {
		const list = item.dayId ? itemsByDay.get(item.dayId) : undefined;
		if (list) list.push(item);
		else unscheduled.push(item);
	}
	for (const list of itemsByDay.values()) list.sort(byPositionThenId);
	unscheduled.sort(byPositionThenId);
	const ordered: GraphItem[] = days.flatMap((d) => itemsByDay.get(d.id) ?? []);
	const orderPos = new Map(ordered.map((it, i) => [it.id, i]));
	const located = ordered.filter((it) => it.nodeId != null);

	// prev/next located, by position in `ordered`
	const prevLoc: (GraphItem | null)[] = new Array(ordered.length);
	const nextLoc: (GraphItem | null)[] = new Array(ordered.length);
	{
		let last: GraphItem | null = null;
		for (let i = 0; i < ordered.length; i++) {
			prevLoc[i] = last;
			const it = ordered[i] as GraphItem;
			if (it.nodeId) last = it;
		}
		let next: GraphItem | null = null;
		for (let i = ordered.length - 1; i >= 0; i--) {
			nextLoc[i] = next;
			const it = ordered[i] as GraphItem;
			if (it.nodeId) next = it;
		}
	}
	const firstLocByDay = new Map<string, GraphItem>();
	const lastLocByDay = new Map<string, GraphItem>();
	for (const it of located) {
		const dayId = it.dayId as string;
		if (!firstLocByDay.has(dayId)) firstLocByDay.set(dayId, it);
		lastLocByDay.set(dayId, it);
	}

	const pairs: Pair[] = [];
	const pairSet = new Set<string>();
	for (let i = 1; i < located.length; i++) {
		const a = located[i - 1] as GraphItem;
		const b = located[i] as GraphItem;
		if (a.nodeId === b.nodeId) continue;
		const key = pairKey(a.id, b.id);
		pairs.push({
			fromItemId: a.id,
			toItemId: b.id,
			key,
			crossDay: a.dayId !== b.dayId,
		});
		pairSet.add(key);
	}

	// ---- legs ----------------------------------------------------------------
	const legById = new Map(g.legs.map((l) => [l.id, l]));
	const legByPair = new Map<string, GraphLeg>();
	const legByStay = new Map<string, GraphLeg>();
	for (const leg of g.legs) {
		if (leg.kind === "pair") {
			if (leg.fromItemId && leg.toItemId)
				legByPair.set(pairKey(leg.fromItemId, leg.toItemId), leg);
		} else if (leg.stayDayId) {
			legByStay.set(
				stayKey(leg.stayDayId, leg.kind === "stay_start" ? "start" : "end"),
				leg,
			);
		}
	}
	const isTimed = (
		leg: GraphLeg | null | undefined,
	): leg is GraphLeg & { depAt: string; arrAt: string } =>
		!!leg && validInstant(leg.depAt) && validInstant(leg.arrAt);
	const isSignificant = (leg: GraphLeg): boolean => {
		if (leg.isEdited || leg.hasContent) return true;
		// The default flight between two airports follows the items (FB-19):
		// when they stop being adjacent it goes, like an autofilled walk.
		if (isAutoFlight(leg)) return false;
		if (leg.mode === "flight") return true;
		if (leg.source === "manual" && leg.mode != null) return true;
		const d = readDetails(leg);
		if (d.kind === "flight") return true;
		if (
			d.kind === "transit" &&
			(d.fixed || d.booking || d.route?.source === "manual")
		)
			return true;
		return false;
	};
	const detachedLegs: DetachedLeg[] = [];
	for (const leg of g.legs) {
		if (leg.kind !== "pair" || !leg.fromItemId || !leg.toItemId) continue;
		if (
			pairSet.has(pairKey(leg.fromItemId, leg.toItemId)) ||
			!isSignificant(leg)
		)
			continue;
		const from = itemById.get(leg.fromItemId);
		const to = itemById.get(leg.toItemId);
		detachedLegs.push({
			legId: leg.id,
			dayId: from ? from.dayId : (to?.dayId ?? null),
			fromItemId: leg.fromItemId,
			toItemId: leg.toItemId,
		});
	}

	// ---- flight blocks -------------------------------------------------------
	const flightBlocks: string[][] = [];
	const blockByItem = new Map<string, string[]>();
	for (const p of pairs) {
		const leg = legByPair.get(p.key);
		// An auto flight (FB-19) isn't a booked block: its items move freely.
		if (leg?.mode !== "flight" || isAutoFlight(leg)) continue;
		const last = flightBlocks.at(-1);
		if (last && last.at(-1) === p.fromItemId) last.push(p.toItemId);
		else flightBlocks.push([p.fromItemId, p.toItemId]);
	}
	for (const block of flightBlocks)
		for (const id of block) blockByItem.set(id, block);

	// ---- effective nodes (§8.1) ----------------------------------------------
	const effective = new Map<string, string | null>();
	{
		let lastNode: string | null = null;
		const pending: string[] = []; // before anything located in the whole trip
		for (const day of days) {
			const list = itemsByDay.get(day.id) ?? [];
			const first = firstLocByDay.get(day.id);
			const stay = nightOf(prevDay(day.id));
			let beforeFirst = true;
			for (const it of list) {
				if (it === first) beforeFirst = false;
				if (it.nodeId) {
					effective.set(it.id, it.nodeId);
					lastNode = it.nodeId;
					if (pending.length) {
						for (const id of pending) effective.set(id, it.nodeId);
						pending.length = 0;
					}
				} else if (beforeFirst && stay) {
					effective.set(it.id, stay);
				} else if (lastNode) {
					effective.set(it.id, lastNode);
				} else {
					pending.push(it.id);
				}
			}
		}
		for (const id of pending) effective.set(id, null);
		for (const it of unscheduled) effective.set(it.id, it.nodeId);
	}

	// ---- scheduled nodes -----------------------------------------------------
	const scheduledNodeIds = new Set<string>();
	const markWithAncestors = (id: string) => {
		for (const n of hierarchy.ancestors(id, { includeSelf: true })) {
			if (scheduledNodeIds.has(n.id)) break;
			scheduledNodeIds.add(n.id);
		}
	};
	for (const it of located) if (it.nodeId) markWithAncestors(it.nodeId);
	for (const d of days) {
		const s = nightOf(d);
		if (s) markWithAncestors(s);
	}

	// ---- boundaries and stays ------------------------------------------------
	const boundaryKind = (fromItemId: string, toItemId: string): BoundaryKind => {
		const p = itemById.get(fromItemId);
		const i = itemById.get(toItemId);
		if (!p || !i || p.dayId === i.dayId) return "same-day";
		const leg = legByPair.get(pairKey(fromItemId, toItemId));
		if (isTimed(leg)) return "timed";
		if (leg?.mode) return "moded";
		const d1 = dayById.get(p.dayId ?? "");
		const d2Prev = i.dayId ? prevDay(i.dayId) : undefined;
		if (nightOf(d1) || nightOf(d2Prev)) return "stay";
		return "overnight";
	};

	const morningStay = (dayId: string): StayLegPlan | null => {
		const stay = nightOf(prevDay(dayId));
		const first = firstLocByDay.get(dayId);
		if (!stay || !first?.nodeId || first.nodeId === stay) return null;
		const p = prevLoc[orderPos.get(first.id) ?? -1];
		if (p) {
			const kind = boundaryKind(p.id, first.id);
			if (kind === "timed" || kind === "moded") return null;
		}
		return {
			dayId,
			end: "start",
			stayNodeId: stay,
			anchorItemId: first.id,
			fromNodeId: stay,
			toNodeId: first.nodeId,
		};
	};

	const eveningStay = (dayId: string): StayLegPlan | null => {
		const stay = nightOf(dayById.get(dayId));
		const last = lastLocByDay.get(dayId);
		if (!stay || !last?.nodeId || last.nodeId === stay) return null;
		const x = nextLoc[orderPos.get(last.id) ?? -1];
		if (x && legByPair.get(pairKey(last.id, x.id))?.mode) return null;
		return {
			dayId,
			end: "end",
			stayNodeId: stay,
			anchorItemId: last.id,
			fromNodeId: last.nodeId,
			toNodeId: stay,
		};
	};

	return {
		graph: g,
		trip,
		settings,
		defaultTz,
		hierarchy,
		node: (id) => (id ? hierarchy.get(id) : undefined),
		children: (id) => (id === null ? rootChildren : hierarchy.children(id)),
		path: (id) => hierarchy.path(id),
		isWithin: (id, scopeId) => {
			if (!id || !hierarchy.has(id)) return false;
			return scopeId === null || hierarchy.isInSubtree(id, scopeId);
		},
		isDropped,
		outline,
		outlineIndex: (id) => outlinePos.get(id) ?? -1,

		days,
		day: (id) => (id ? dayById.get(id) : undefined),
		dayIndex,
		dayNumber: (dayId) => dayOrdinal.get(dayId) ?? 0,
		dayOfDate: (date) => dayByDate.get(date),
		prevDay,
		itemsByDay,
		unscheduled,
		item: (id) => (id ? itemById.get(id) : undefined),
		ordered,
		orderOf: (itemId) => orderPos.get(itemId) ?? -1,
		located,
		prevLocated: (itemId) => {
			const i = orderPos.get(itemId);
			return i === undefined ? null : (prevLoc[i] ?? null);
		},
		nextLocated: (itemId) => {
			const i = orderPos.get(itemId);
			return i === undefined ? null : (nextLoc[i] ?? null);
		},
		firstLocated: (dayId) => firstLocByDay.get(dayId) ?? null,
		lastLocated: (dayId) => lastLocByDay.get(dayId) ?? null,
		pairs,
		isPair: (a, b) => pairSet.has(pairKey(a, b)),

		leg: (id) => (id ? legById.get(id) : undefined),
		legByPair,
		legByStay,
		legDetails: readDetails,
		isTimed,
		isSignificant,
		detachedLegs,

		scheduledNodeIds,
		flightBlocks,
		blockOf: (itemId) => blockByItem.get(itemId) ?? null,

		effectiveNodeId: (itemId) => effective.get(itemId) ?? null,
		boundaryKind,
		morningStay,
		eveningStay,

		tzOf,
		coordOf,
	};
}
