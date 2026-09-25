/**
 * `rollup(ix, options, data)` (SPEC §8.4): the bundle entries (attachments,
 * list items or note documents) in view for a scope, lens and day range,
 * grouped the way the Media, Lists and Notes tabs and the inspector show them:
 *
 *   scope's own group · visited reps (pin order) · never-visited reps (outline
 *   order) · days (by date) · "Unlinked transit"
 *
 * Every entry names its target with the bundle target columns
 * (`nodeId`/`legId`/`itemId`/`dayId`; all null = the trip root). A list item may
 * add `extraNodeIds` (its `list_item_targets`): it is grouped under its primary
 * target, but also matches when only an extra target is in view.
 */
import { type GraphIndex, stayKey } from "./graph-index";
import { repAt } from "./lens";
import type { DayRange, GraphLeg, Lens, WorkspaceModel } from "./types";
import { buildModel, inDayRange } from "./visits";

export interface RollupEntryRef {
	nodeId?: string | null;
	legId?: string | null;
	itemId?: string | null;
	dayId?: string | null;
	/** Extra candidate nodes (list items: "Hands Shibuya or Shibuya Loft"). */
	extraNodeIds?: readonly string[] | null;
}

export interface RollupOptions {
	scopeId: string | null;
	lens: Lens;
	/** Default true ("Everything inside"); false = only the scope's own target ("Only Tokyo"). */
	includeDescendants?: boolean;
	dayRange?: DayRange | null;
	/** Dropped nodes (and everything under them) are excluded unless set. */
	showDropped?: boolean;
	/** Reuse an already built model for this scope, lens and range (it orders the groups). */
	model?: WorkspaceModel;
}

export type RollupSubgroupKind =
	| "trip"
	| "node"
	| "visit"
	| "transit"
	| "day"
	| "unlinked";

export interface RollupSubgroup<T> {
	key: string;
	kind: RollupSubgroupKind;
	/** node: the target node. */
	nodeId?: string;
	/** visit: the item ("This visit · Day 4 · 11:42"). */
	itemId?: string;
	/** transit / unlinked: the leg row. */
	legId?: string;
	/** visit, day, unlinked and stay-leg subgroups: the day. */
	dayId?: string | null;
	/** transit: reps of the endpoints ("Transit · Osaka → Seoul"). */
	fromRepId?: string | null;
	toRepId?: string | null;
	/** Node ids from the group's rep down to the target, for captions ("Shibuya › Shibuya Sky"). */
	caption: string[];
	entries: T[];
}

export interface RollupGroup<T> {
	key: string;
	/** 'scope': the scope node's (or trip root's) own entries. */
	kind: "scope" | "rep" | "day" | "unlinked";
	/** The rep node (rep groups), the scope node (scope group; null at the root). */
	repId: string | null;
	dayId: string | null;
	/** The rep's pin number when visited in view. */
	pinNumber: number | null;
	subgroups: RollupSubgroup<T>[];
	count: number;
}

interface TargetSets {
	nodes: Set<string>;
	items: Set<string>;
	legs: Set<string>;
	days: Set<string>;
	trip: boolean;
}

function legEndpoints(
	ix: GraphIndex,
	leg: GraphLeg,
): { fromNodeId: string | null; toNodeId: string | null; dayIds: string[] } {
	if (leg.kind === "pair") {
		const from = ix.item(leg.fromItemId);
		const to = ix.item(leg.toItemId);
		return {
			fromNodeId: from ? ix.effectiveNodeId(from.id) : null,
			toNodeId: to ? ix.effectiveNodeId(to.id) : null,
			dayIds: [from?.dayId, to?.dayId].filter((d): d is string => !!d),
		};
	}
	const dayId = leg.stayDayId;
	if (!dayId) return { fromNodeId: null, toNodeId: null, dayIds: [] };
	const plan =
		leg.kind === "stay_start" ? ix.morningStay(dayId) : ix.eveningStay(dayId);
	if (plan)
		return {
			fromNodeId: plan.fromNodeId,
			toNodeId: plan.toNodeId,
			dayIds: [dayId],
		};
	// The stay leg no longer applies (stop or stay changed): fall back to the stay node.
	const stay =
		leg.kind === "stay_start"
			? ix.prevDay(dayId)?.nightNodeId
			: ix.day(dayId)?.nightNodeId;
	return { fromNodeId: stay ?? null, toNodeId: stay ?? null, dayIds: [dayId] };
}

function targetsInView(ix: GraphIndex, opts: RollupOptions): TargetSets {
	const scopeId = opts.scopeId && ix.node(opts.scopeId) ? opts.scopeId : null;
	const range = opts.dayRange ?? null;
	const visible = (nodeId: string | null | undefined): nodeId is string =>
		!!nodeId &&
		!!ix.node(nodeId) &&
		(opts.showDropped || !ix.isDropped(nodeId));
	const within = (nodeId: string | null | undefined) =>
		scopeId === null || ix.isWithin(nodeId, scopeId);
	const sets: TargetSets = {
		nodes: new Set(),
		items: new Set(),
		legs: new Set(),
		days: new Set(),
		trip: false,
	};

	if (opts.includeDescendants === false) {
		if (scopeId) sets.nodes.add(scopeId);
		else sets.trip = true;
		return sets;
	}

	const itemIn = (itemId: string): boolean => {
		const it = ix.item(itemId);
		if (!it) return false;
		if (scopeId === null) return true;
		const eff =
			it.dayId && ix.day(it.dayId) ? ix.effectiveNodeId(it.id) : it.nodeId;
		return within(eff);
	};

	if (!range) {
		const nodes = scopeId
			? ix.hierarchy.descendants(scopeId, { includeSelf: true })
			: ix.outline;
		for (const n of nodes) if (visible(n.id)) sets.nodes.add(n.id);
		for (const it of [...ix.ordered, ...ix.unscheduled])
			if (itemIn(it.id)) sets.items.add(it.id);
		for (const day of ix.days) {
			if (
				scopeId === null ||
				(ix.itemsByDay.get(day.id) ?? []).some((it) => itemIn(it.id))
			)
				sets.days.add(day.id);
		}
		for (const leg of ix.graph.legs) {
			if (scopeId === null) {
				sets.legs.add(leg.id);
				continue;
			}
			if (leg.kind === "pair") {
				if (
					(leg.fromItemId && itemIn(leg.fromItemId)) ||
					(leg.toItemId && itemIn(leg.toItemId))
				)
					sets.legs.add(leg.id);
			} else if (leg.stayDayId) {
				const e = legEndpoints(ix, leg);
				if (
					sets.days.has(leg.stayDayId) ||
					within(e.fromNodeId) ||
					within(e.toNodeId)
				)
					sets.legs.add(leg.id);
			}
		}
		sets.trip = scopeId === null;
		return sets;
	}

	// With a day range: the items in range and their nodes' subtrees, the legs in range,
	// the stay nodes of those nights, and the day targets.
	for (const day of ix.days) {
		if (!inDayRange(day.date, range)) continue;
		let anyIn = false;
		for (const it of ix.itemsByDay.get(day.id) ?? []) {
			if (!itemIn(it.id)) continue;
			anyIn = true;
			sets.items.add(it.id);
			if (it.nodeId)
				for (const id of ix.hierarchy.subtreeIds(it.nodeId))
					if (visible(id) && within(id)) sets.nodes.add(id);
		}
		if (anyIn || scopeId === null) sets.days.add(day.id);
		if (day.nightNodeId && visible(day.nightNodeId) && within(day.nightNodeId))
			sets.nodes.add(day.nightNodeId);
	}
	for (const leg of ix.graph.legs) {
		if (leg.kind === "pair") {
			if (
				(leg.fromItemId && sets.items.has(leg.fromItemId)) ||
				(leg.toItemId && sets.items.has(leg.toItemId))
			)
				sets.legs.add(leg.id);
		} else if (leg.stayDayId && sets.days.has(leg.stayDayId)) {
			sets.legs.add(leg.id);
		}
	}
	return sets;
}

/** Groups bundle entries for the Media, Lists and Notes tabs and the inspector (SPEC §8.4). */
export function rollup<T extends RollupEntryRef>(
	ix: GraphIndex,
	opts: RollupOptions,
	data: readonly T[],
): RollupGroup<T>[] {
	const scopeId = opts.scopeId && ix.node(opts.scopeId) ? opts.scopeId : null;
	const sets = targetsInView(ix, opts);
	const model =
		opts.model ?? buildModel(ix, scopeId, opts.lens, opts.dayRange ?? null);
	const pinNumber = new Map<string, number>();
	for (const p of model.pins)
		if (p.number != null) pinNumber.set(p.repId, p.number);
	const detachedDay = new Map(ix.detachedLegs.map((d) => [d.legId, d.dayId]));
	const repCache = new Map<string, string>();
	const repOf = (nodeId: string) => {
		let r = repCache.get(nodeId);
		if (r === undefined) {
			r = repAt(ix, nodeId, opts.lens, scopeId).id;
			repCache.set(nodeId, r);
		}
		return r;
	};
	/** rep → … → target, node ids (the target's path strictly below the rep). */
	const caption = (repId: string, targetId: string): string[] => {
		const path = ix.path(targetId).map((n) => n.id);
		const i = path.indexOf(repId);
		return i >= 0 ? path.slice(i) : [targetId];
	};

	const groups = new Map<string, RollupGroup<T>>();
	const group = (
		key: string,
		kind: RollupGroup<T>["kind"],
		repId: string | null,
		dayId: string | null,
	): RollupGroup<T> => {
		let g = groups.get(key);
		if (!g) {
			g = {
				key,
				kind,
				repId,
				dayId,
				pinNumber: repId ? (pinNumber.get(repId) ?? null) : null,
				subgroups: [],
				count: 0,
			};
			groups.set(key, g);
		}
		return g;
	};
	const scopeGroup = () => group("scope", "scope", scopeId, null);
	const repGroup = (repId: string) =>
		repId === scopeId
			? scopeGroup()
			: group(`rep:${repId}`, "rep", repId, null);
	const add = (
		g: RollupGroup<T>,
		sub: Omit<RollupSubgroup<T>, "entries">,
		entry: T,
	) => {
		let s = g.subgroups.find((x) => x.key === sub.key);
		if (!s) {
			s = { ...sub, entries: [] };
			g.subgroups.push(s);
		}
		s.entries.push(entry);
		g.count += 1;
	};

	for (const entry of data) {
		const extraHit = (entry.extraNodeIds ?? []).find((id) =>
			sets.nodes.has(id),
		);
		if (entry.nodeId) {
			const nodeId = sets.nodes.has(entry.nodeId) ? entry.nodeId : extraHit;
			if (!nodeId) continue;
			const repId = nodeId === scopeId ? scopeId : repOf(nodeId);
			add(
				repGroup(repId),
				{
					key: `node:${nodeId}`,
					kind: "node",
					nodeId,
					caption: caption(repId, nodeId),
				},
				entry,
			);
		} else if (entry.itemId) {
			if (!sets.items.has(entry.itemId)) {
				if (extraHit)
					add(
						repGroup(repOf(extraHit)),
						{
							key: `node:${extraHit}`,
							kind: "node",
							nodeId: extraHit,
							caption: caption(repOf(extraHit), extraHit),
						},
						entry,
					);
				continue;
			}
			const item = ix.item(entry.itemId);
			const eff = ix.effectiveNodeId(entry.itemId);
			const sub = {
				key: `visit:${entry.itemId}`,
				kind: "visit" as const,
				itemId: entry.itemId,
				dayId: item?.dayId ?? null,
			};
			if (eff) {
				const repId = repOf(eff);
				add(repGroup(repId), { ...sub, caption: caption(repId, eff) }, entry);
			} else if (item?.dayId) {
				add(
					group(`day:${item.dayId}`, "day", null, item.dayId),
					{ ...sub, caption: [] },
					entry,
				);
			} else {
				add(scopeGroup(), { ...sub, caption: [] }, entry);
			}
		} else if (entry.legId) {
			const leg = ix.leg(entry.legId);
			if (!leg || !sets.legs.has(leg.id)) {
				if (extraHit)
					add(
						repGroup(repOf(extraHit)),
						{
							key: `node:${extraHit}`,
							kind: "node",
							nodeId: extraHit,
							caption: caption(repOf(extraHit), extraHit),
						},
						entry,
					);
				continue;
			}
			if (detachedDay.has(leg.id)) {
				const dayId = detachedDay.get(leg.id) ?? null;
				const g =
					dayId && ix.day(dayId)
						? group(`day:${dayId}`, "day", null, dayId)
						: group("unlinked", "unlinked", null, null);
				add(
					g,
					{
						key: `unlinked:${leg.id}`,
						kind: "unlinked",
						legId: leg.id,
						dayId,
						caption: [],
					},
					entry,
				);
				continue;
			}
			const e = legEndpoints(ix, leg);
			const inScope = (n: string | null) =>
				!!n && (scopeId === null || ix.isWithin(n, scopeId));
			const anchor = inScope(e.fromNodeId)
				? e.fromNodeId
				: inScope(e.toNodeId)
					? e.toNodeId
					: e.fromNodeId;
			const sub = {
				key: `transit:${leg.id}`,
				kind: "transit" as const,
				legId: leg.id,
				dayId:
					leg.kind === "pair"
						? (ix.item(leg.fromItemId)?.dayId ?? null)
						: leg.stayDayId,
				fromRepId: e.fromNodeId ? repOf(e.fromNodeId) : null,
				toRepId: e.toNodeId ? repOf(e.toNodeId) : null,
				caption: [],
			};
			if (anchor) add(repGroup(repOf(anchor)), sub, entry);
			else add(scopeGroup(), sub, entry);
		} else if (entry.dayId) {
			if (!sets.days.has(entry.dayId)) {
				if (extraHit)
					add(
						repGroup(repOf(extraHit)),
						{
							key: `node:${extraHit}`,
							kind: "node",
							nodeId: extraHit,
							caption: caption(repOf(extraHit), extraHit),
						},
						entry,
					);
				continue;
			}
			add(
				group(`day:${entry.dayId}`, "day", null, entry.dayId),
				{
					key: `day:${entry.dayId}`,
					kind: "day",
					dayId: entry.dayId,
					caption: [],
				},
				entry,
			);
		} else {
			// The trip root.
			if (sets.trip)
				add(scopeGroup(), { key: "trip", kind: "trip", caption: [] }, entry);
			else if (extraHit)
				add(
					repGroup(repOf(extraHit)),
					{
						key: `node:${extraHit}`,
						kind: "node",
						nodeId: extraHit,
						caption: caption(repOf(extraHit), extraHit),
					},
					entry,
				);
		}
	}

	// ---- order ---------------------------------------------------------------
	const orderSub = (s: RollupSubgroup<T>): [number, number] => {
		switch (s.kind) {
			case "trip":
				return [0, 0];
			case "node":
				return [1, ix.outlineIndex(s.nodeId ?? "")];
			case "visit":
				return [2, ix.orderOf(s.itemId ?? "")];
			case "transit": {
				const leg = ix.leg(s.legId);
				const at =
					leg?.kind === "pair"
						? ix.orderOf(leg.fromItemId ?? "")
						: (ix.dayIndex.get(ix.day(leg?.stayDayId)?.date ?? "") ?? 0);
				return [3, at];
			}
			case "day":
				return [4, 0];
			case "unlinked":
				return [5, 0];
		}
	};
	for (const g of groups.values())
		g.subgroups.sort((a, b) => {
			const [ka, va] = orderSub(a);
			const [kb, vb] = orderSub(b);
			return ka - kb || va - vb;
		});
	const rank = (g: RollupGroup<T>): [number, number] => {
		switch (g.kind) {
			case "scope":
				return [0, 0];
			case "rep":
				return g.pinNumber != null
					? [1, g.pinNumber]
					: [2, ix.outlineIndex(g.repId ?? "")];
			case "day":
				return [3, ix.dayIndex.get(ix.day(g.dayId)?.date ?? "") ?? 0];
			case "unlinked":
				return [4, 0];
		}
	};
	return [...groups.values()].sort((a, b) => {
		const [ka, va] = rank(a);
		const [kb, vb] = rank(b);
		return ka - kb || va - vb;
	});
}

/** The stay-leg key of a leg row (`<dayId>:start|end`), or null for a pair leg. */
export function stayKeyOf(leg: GraphLeg): string | null {
	if (leg.kind === "pair" || !leg.stayDayId) return null;
	return stayKey(leg.stayDayId, leg.kind === "stay_start" ? "start" : "end");
}
