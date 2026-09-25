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
