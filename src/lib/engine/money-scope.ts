/**
 * Where an expense counts (EXTENSIONS §8.2 "totals and true-ups at EVERY
 * scope"), WP-Money. Pure over a `GraphIndex`.
 *
 * Every expense gets ONE anchor node, so scope totals never double-count:
 * - item → its effective node (where you physically are; §8.1), and its day;
 * - leg → its FROM endpoint (a Tokyo → Kyoto train counts in Tokyo), and the
 *   from-item's day (a stay leg: the stay node and its day);
 * - day → the lowest common place of the day's stops (a Tokyo-only day is in
 *   Tokyo, a Tokyo + Fuji day is in Japan), else the night's stay node;
 * - node → itself; trip → the trip root (no node).
 *
 * With a day range, an expense is in view when its anchor day is in range;
 * a node-level cost is in view when the range visits that place.
 */

import type { GraphIndex } from "./graph-index";
import type { BudgetTree } from "./money-budget";
import type { DayRange } from "./types";
import { inDayRange } from "./visits";

export type MoneyTarget =
	| { kind: "trip" }
	| { kind: "node"; nodeId: string }
	| { kind: "leg"; legId: string }
	| { kind: "item"; itemId: string }
	| { kind: "day"; dayId: string };

export type MoneyAnchor = {
	/** The place the cost belongs to (null = the trip root / unknown). */
	nodeId: string | null;
	/** The day it happens on, when it has one. */
	dayId: string | null;
};

function itemNode(
	ix: GraphIndex,
	itemId: string | null | undefined,
): string | null {
	const it = ix.item(itemId);
	if (!it) return null;
	if (it.dayId && ix.day(it.dayId))
		return ix.effectiveNodeId(it.id) ?? it.nodeId;
	return it.nodeId;
}

/** The lowest common ancestor of `ids` (null when they share nothing but the root). */
export function commonPlace(
	ix: GraphIndex,
	ids: readonly string[],
): string | null {
	const paths = ids
		.map((id) => ix.path(id).map((n) => n.id))
		.filter((p) => p.length > 0);
	if (!paths.length) return null;
	let lca: string | null = null;
	const first = paths[0] as string[];
	for (let i = 0; i < first.length; i++) {
		const id = first[i] as string;
		if (paths.every((p) => p[i] === id)) lca = id;
		else break;
	}
	return lca;
}

/** The node a day's costs belong to (see the file header). */
export function dayAnchorNode(ix: GraphIndex, dayId: string): string | null {
	const nodes = new Set<string>();
	for (const it of ix.itemsByDay.get(dayId) ?? []) {
		const n = itemNode(ix, it.id);
		if (n) nodes.add(n);
	}
	if (nodes.size) return commonPlace(ix, [...nodes]);
	return ix.day(dayId)?.nightNodeId ?? null;
}

export function expenseAnchor(
	ix: GraphIndex,
	target: MoneyTarget,
): MoneyAnchor {
	switch (target.kind) {
		case "trip":
			return { nodeId: null, dayId: null };
		case "node":
			return {
				nodeId: ix.node(target.nodeId) ? target.nodeId : null,
				dayId: null,
			};
		case "item": {
			const it = ix.item(target.itemId);
			return {
				nodeId: itemNode(ix, target.itemId),
				dayId: it?.dayId && ix.day(it.dayId) ? it.dayId : null,
			};
		}
		case "day":
			return ix.day(target.dayId)
				? { nodeId: dayAnchorNode(ix, target.dayId), dayId: target.dayId }
				: { nodeId: null, dayId: null };
		case "leg": {
			const leg = ix.leg(target.legId);
			if (!leg) return { nodeId: null, dayId: null };
			if (leg.kind === "pair") {
				const from = ix.item(leg.fromItemId);
				return {
					nodeId: itemNode(ix, leg.fromItemId),
					dayId: from?.dayId && ix.day(from.dayId) ? from.dayId : null,
				};
			}
			const dayId = leg.stayDayId;
			if (!dayId) return { nodeId: null, dayId: null };
			const plan =
				leg.kind === "stay_start"
					? ix.morningStay(dayId)
					: ix.eveningStay(dayId);
			const stay =
				plan?.fromNodeId ??
				(leg.kind === "stay_start"
					? ix.prevDay(dayId)?.nightNodeId
					: ix.day(dayId)?.nightNodeId) ??
				null;
			return { nodeId: stay, dayId: ix.day(dayId) ? dayId : null };
		}
	}
}

export type MoneyView = {
	/** The scope node (null = the trip root). */
	scopeId: string | null;
	/** "Only Tokyo": just the scope's own costs. */
	only?: boolean;
	days?: DayRange | null;
};

/** Is an expense with this target in the view? */
export function inMoneyView(
	ix: GraphIndex,
	target: MoneyTarget,
	view: MoneyView,
	anchor: MoneyAnchor = expenseAnchor(ix, target),
): boolean {
	const scopeId = view.scopeId && ix.node(view.scopeId) ? view.scopeId : null;
	if (view.only)
		return scopeId === null
			? target.kind === "trip"
			: target.kind === "node" && target.nodeId === scopeId;
	const within = (n: string | null) =>
		scopeId === null || (n !== null && ix.isWithin(n, scopeId));
	const range = view.days ?? null;
	if (!range) return within(anchor.nodeId);
	if (target.kind === "trip") return false;
	if (anchor.dayId) {
		const day = ix.day(anchor.dayId);
		return !!day && inDayRange(day.date, range) && within(anchor.nodeId);
	}
	if (target.kind === "node") {
		if (!within(target.nodeId)) return false;
		for (const day of ix.days) {
			if (!inDayRange(day.date, range)) continue;
			for (const it of ix.itemsByDay.get(day.id) ?? []) {
				const n = itemNode(ix, it.id);
				if (n && ix.isWithin(n, target.nodeId)) return true;
			}
		}
	}
	return false;
}

/** Costs that sit exactly on an inspector target (item, day, leg, node or trip). */
export function onTarget(
	ix: GraphIndex,
	exp: MoneyTarget,
	target: MoneyTarget,
	anchor: MoneyAnchor = expenseAnchor(ix, exp),
): boolean {
	switch (target.kind) {
		case "trip":
			return true;
		case "node":
			return (
				anchor.nodeId !== null && ix.isWithin(anchor.nodeId, target.nodeId)
			);
		case "day":
			return anchor.dayId === target.dayId;
		case "item":
			return exp.kind === "item" && exp.itemId === target.itemId;
		case "leg":
			return exp.kind === "leg" && exp.legId === target.legId;
	}
}

/** Days whose schedule touches the scope (per-day budgets): every trip day at the root. */
export function daysTouching(ix: GraphIndex, scopeId: string | null): number {
	if (scopeId === null) return ix.days.length;
	let n = 0;
	for (const day of ix.days) {
		const items = ix.itemsByDay.get(day.id) ?? [];
		const touches =
			items.some((it) => {
				const node = itemNode(ix, it.id);
				return node !== null && ix.isWithin(node, scopeId);
			}) ||
			(day.nightNodeId !== null && ix.isWithin(day.nightNodeId, scopeId));
		if (touches) n += 1;
	}
	return n;
}

/** The budget engine's view of the place tree. */
export function budgetTree(ix: GraphIndex): BudgetTree {
	const cache = new Map<string | null, number>();
	return {
		parentOf: (id) => {
			const n = ix.node(id);
			return n ? n.parentId : undefined;
		},
		daysIn: (id) => {
			let v = cache.get(id);
			if (v === undefined) {
				v = daysTouching(ix, id);
				cache.set(id, v);
			}
			return v;
		},
	};
}

/** The country code of a scope (itself or its nearest ancestor with one), for "Local". */
export function scopeCountry(
	ix: GraphIndex,
	scopeId: string | null,
): string | null {
	if (!scopeId) return null;
	const path = ix.path(scopeId);
	const country = path.find((n) => n.type === "country");
	if (country?.countryCode) return country.countryCode;
	for (let i = path.length - 1; i >= 0; i--) {
		const cc = path[i]?.countryCode;
		if (cc) return cc;
	}
	return null;
}

/** "Day 4" / "Tokyo › Shibuya" style label for where an expense hangs. */
export function targetLabel(ix: GraphIndex, target: MoneyTarget): string {
	switch (target.kind) {
		case "trip":
			return "Trip-wide";
		case "node":
			return ix.node(target.nodeId)?.name ?? "Trip-wide";
		case "day": {
			const n = ix.day(target.dayId) ? ix.dayNumber(target.dayId) : 0;
			return n ? `Day ${n}` : "Trip-wide";
		}
		case "item": {
			const it = ix.item(target.itemId);
			if (!it) return "Trip-wide";
			return it.title ?? ix.node(it.nodeId)?.name ?? "Untitled stop";
		}
		case "leg": {
			const leg = ix.leg(target.legId);
			if (!leg) return "Trip-wide";
			if (leg.kind === "pair") {
				const name = (id: string | null) => {
					const it = ix.item(id);
					return it ? (it.title ?? ix.node(it.nodeId)?.name ?? "?") : "?";
				};
				return `${name(leg.fromItemId)} → ${name(leg.toItemId)}`;
			}
			const a = expenseAnchor(ix, target);
			return a.nodeId ? `Stay · ${ix.node(a.nodeId)?.name ?? ""}` : "Stay";
		}
	}
}
