/**
 * E3 the place a day happens in (EXTENSIONS §6), WP-Insights: the city rep
 * with the most scheduled minutes, else that night's stay, else the previous
 * day's place.
 *
 * "The previous day's place" is where that day ENDED, not where it spent the
 * most minutes: after a KIX → ICN flight day the empty days that follow are in
 * Seoul, not Osaka. A day ends at its night stay, else at its last located
 * item (the arrival end of a flight). A tie on minutes goes to the city the day
 * reaches later, so a flight day made of two zero-length airport items is in
 * the arrival city.
 */
import type { GraphIndex } from "./graph-index";
import { repAt } from "./lens";
import type { ScheduleResult } from "./types";

/** The city an item's node belongs to (its own node when there is no city above or below it). */
function cityOf(ix: GraphIndex, nodeId: string): string {
	const rep = repAt(ix, nodeId, "city", null);
	return rep.id;
}

/** The city with the most scheduled minutes on a day; ties go to the city reached later. */
function busiestCity(
	ix: GraphIndex,
	schedule: ScheduleResult,
	dayId: string,
): string | null {
	const minutes = new Map<string, number>();
	const lastSeen = new Map<string, number>();
	let order = 0;
	for (const item of ix.itemsByDay.get(dayId) ?? []) {
		if (!item.nodeId || !ix.node(item.nodeId)) continue;
		const s = schedule.items[item.id];
		const m = s
			? Math.max(0, (s.end.getTime() - s.start.getTime()) / 60_000)
			: item.durationMin;
		const city = cityOf(ix, item.nodeId);
		minutes.set(city, (minutes.get(city) ?? 0) + Math.max(m, 1));
		lastSeen.set(city, order++);
	}
	let best: string | null = null;
	let bestMin = -1;
	let bestSeen = -1;
	for (const [city, m] of minutes) {
		const seen = lastSeen.get(city) ?? -1;
		if (m > bestMin || (m === bestMin && seen > bestSeen)) {
			best = city;
			bestMin = m;
			bestSeen = seen;
		}
	}
	return best;
}

/** Where a day ends: its night stay, else its last located item. */
function endCity(ix: GraphIndex, dayId: string): string | null {
	const day = ix.day(dayId);
	if (!day) return null;
	if (day.nightNodeId && ix.node(day.nightNodeId))
		return cityOf(ix, day.nightNodeId);
	const items = ix.itemsByDay.get(dayId) ?? [];
	for (let i = items.length - 1; i >= 0; i--) {
		const nodeId = items[i]?.nodeId;
		if (nodeId && ix.node(nodeId)) return cityOf(ix, nodeId);
	}
	return null;
}

const memo = new WeakMap<ScheduleResult, Map<string, string | null>>();

export function dayPlace(
	ix: GraphIndex,
	schedule: ScheduleResult,
	dayId: string,
): string | null {
	let byDay = memo.get(schedule);
	if (!byDay) {
		byDay = new Map();
		memo.set(schedule, byDay);
	}
	if (byDay.has(dayId)) return byDay.get(dayId) ?? null;

	const day = ix.day(dayId);
	let result: string | null = null;
	if (day) {
		result = busiestCity(ix, schedule, day.id);
		if (!result && day.nightNodeId && ix.node(day.nightNodeId))
			result = cityOf(ix, day.nightNodeId);
		// Walk back to the nearest day that ends somewhere (bounded by the trip length).
		let prev = result ? undefined : ix.prevDay(day.id);
		for (let guard = 0; !result && prev && guard <= ix.days.length; guard++) {
			result = endCity(ix, prev.id);
			prev = ix.prevDay(prev.id);
		}
	}
	byDay.set(dayId, result);
	return result;
}

// ---------------------------------------------------------------------------
// Where a day is, as every screen names it (owner, 2026-10-07)
// ---------------------------------------------------------------------------

/** What a day's place is shown as: a city, else the region or area standing in for one. */
const REP_TYPES = ["city", "region", "area"] as const;

/** A node's place for day labels: its nearest city, else region, else area, else itself. */
function placeOf(ix: GraphIndex, nodeId: string): string | null {
	const path = ix.path(nodeId);
	for (const t of REP_TYPES) {
		const rep = path.findLast((n) => n.type === t);
		if (rep) return rep.id;
	}
	return path.at(-1)?.id ?? null;
}

/** The place of a day's night (a hotel's city), or null. */
function nightPlace(ix: GraphIndex, dayId: string | undefined): string | null {
	const night = dayId ? ix.day(dayId)?.nightNodeId : null;
	if (!night || !ix.node(night) || ix.isDropped(night)) return null;
	return placeOf(ix, night);
}

export type DayWhere = {
	/**
	 * Where the day is: where you sleep that night; on the trip's last day
	 * (no night of its own), where you slept; else where its last stop is,
	 * else where the day before ended. Null: nowhere known yet.
	 */
	placeId: string | null;
	/** A travel day: where it starts (the night before's place, else its first stop's), when it isn't `placeId`. */
	fromId: string | null;
	/** The trip's last day, spent where the last night was, ending with the way home. */
	last: boolean;
	/** The last day has a flight (an airport on it). */
	flies: boolean;
};

/**
 * The one rule for where a day is (owner, 2026-10-07: "nights + dates"):
 * the night decides, every day is a day to plan, a travel day reads "Tokyo →
 * Kyoto" and the last day "Kyoto · fly home". Pure; no schedule needed.
 */
export function dayWhere(ix: GraphIndex, dayId: string): DayWhere {
	const none: DayWhere = {
		placeId: null,
		fromId: null,
		last: false,
		flies: false,
	};
	const day = ix.day(dayId);
	if (!day) return none;
	const i = ix.days.findIndex((d) => d.id === dayId);
	const before = i > 0 ? nightPlace(ix, ix.days[i - 1]?.id) : null;
	const night = nightPlace(ix, dayId);
	if (night)
		return {
			placeId: night,
			fromId: before && before !== night ? before : null,
			last: false,
			flies: false,
		};
	const items = ix.itemsByDay.get(dayId) ?? [];
	if (i > 0 && i === ix.days.length - 1 && before)
		return {
			placeId: before,
			fromId: null,
			last: true,
			flies: items.some((it) => ix.node(it.nodeId)?.category === "airport"),
		};
	// No night yet: where its stops go (first → last, a flight day "Osaka →
	// Seoul"), else where the day before ended.
	const stops = items
		.map((it) => ix.effectiveNodeId(it.id))
		.flatMap((id) => (id && ix.node(id) ? [placeOf(ix, id)] : []))
		.filter((p): p is string => !!p);
	const end = stops.at(-1);
	if (end)
		return {
			...none,
			placeId: end,
			fromId: stops[0] && stops[0] !== end ? stops[0] : null,
		};
	for (let k = i - 1; k >= 0; k--) {
		const d = ix.days[k];
		if (!d) break;
		const end = nightPlace(ix, d.id) ?? placeOfLast(ix, d.id);
		if (end) return { ...none, placeId: end };
	}
	return none;
}

/** Where a day's last located stop is (a day with no night ends there). */
function placeOfLast(ix: GraphIndex, dayId: string): string | null {
	const last = ix.lastLocated(dayId);
	return last?.nodeId && ix.node(last.nodeId) ? placeOf(ix, last.nodeId) : null;
}

/** "Tokyo", "Tokyo → Kyoto" (a travel day), "Kyoto · fly home" (the last day); null when nowhere is known. */
export function dayWhereText(ix: GraphIndex, w: DayWhere): string | null {
	const name = (id: string | null) => (id ? (ix.node(id)?.name ?? null) : null);
	const at = name(w.placeId);
	if (!at) return null;
	if (w.last) return `${at} · ${w.flies ? "fly home" : "going home"}`;
	const from = name(w.fromId);
	return from ? `${from} → ${at}` : at;
}

/** Each day's night as its place (a hotel's city), null without one: the route as the days hold it. */
export function nightPlaces(ix: GraphIndex): (string | null)[] {
	return ix.days.map((d) => nightPlace(ix, d.id));
}

/** Nights per place in route order ("Tokyo 3, Kyoto 3"), only places within `scopeId` when given. */
export function nightsByPlace(
	ix: GraphIndex,
	scopeId: string | null = null,
): { placeId: string; nights: number }[] {
	const on = new Map<string, number>();
	for (const id of nightPlaces(ix))
		if (id && ix.isWithin(id, scopeId)) on.set(id, (on.get(id) ?? 0) + 1);
	return [...on].map(([placeId, nights]) => ({ placeId, nights }));
}
