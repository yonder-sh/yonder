/**
 * Days per city (ADDENDUM §10 "Still to plan"; DESIGN §4.4 "Planned 4 days ·
 * scheduled 3"): the planned days (`details.plannedDays`, the sheet's Cities
 * "Days") next to the days the timeline actually spends there, and the
 * unallocated total against the trip's length. Pure.
 *
 * A row is a city, or a non-place node with planned days and no city inside
 * it (the sheet lists "Kawaguchiko" under a region with no city). Each trip
 * day belongs to at most one row: the row holding the most scheduled minutes
 * that day, else the row of that night's stay.
 */
import type { GraphIndex } from "@/lib/engine/graph-index";
import type { GraphNode, ScheduleResult } from "@/lib/engine/types";

export type CityDaysRow = {
	nodeId: string;
	name: string;
	/** The row's country (for grouping), or null at the top level. */
	countryId: string | null;
	planned: number | null;
	scheduled: number;
	/** The trip days counted for this row, by date. */
	dayIds: string[];
};

export type CityDaysTable = {
	rows: CityDaysRow[];
	/** Days of the trip (the day rows, else the date range). */
	tripDays: number;
	plannedTotal: number;
	scheduledTotal: number;
	/** `tripDays − plannedTotal` (negative = over-allocated). */
	unallocated: number;
	/** Trip days no row claims (no located items, no stay). */
	unassignedDayIds: string[];
};

function inclusiveDays(from: string | null, to: string | null): number {
	if (!from || !to) return 0;
	const a = Date.parse(`${from}T00:00:00Z`);
	const b = Date.parse(`${to}T00:00:00Z`);
	if (!Number.isFinite(a) || !Number.isFinite(b) || b < a) return 0;
	return Math.round((b - a) / 86_400_000) + 1;
}

function planned(n: GraphNode): number | null {
	const v = n.details?.plannedDays;
	return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/** The row nodes (outline order) within `scopeId`. */
export function cityRowNodes(
	ix: GraphIndex,
	scopeId: string | null = null,
): GraphNode[] {
	const cities = ix.outline.filter((n) => n.type === "city");
	const hasCityBelow = (id: string) =>
		cities.some((c) => c.id !== id && ix.isWithin(c.id, id));
	const insideCity = (id: string) =>
		ix.path(id).some((a) => a.id !== id && a.type === "city");
	// A region or area outside any city that is planned or on the plan
	// ("Mt. Fuji" with Kawaguchiko inside) counts like a city; the outermost wins.
	const standIn = (n: GraphNode) =>
		(n.type === "region" || n.type === "area") &&
		!insideCity(n.id) &&
		!hasCityBelow(n.id) &&
		(planned(n) !== null || ix.scheduledNodeIds.has(n.id));
	const rows = ix.outline.filter(
		(n) =>
			ix.isWithin(n.id, scopeId) &&
			!ix.isDropped(n.id) &&
			(n.type === "city" || standIn(n)),
	);
	const ids = new Set(rows.map((r) => r.id));
	return rows.filter(
		(r) =>
			r.type === "city" ||
			!ix.path(r.id).some((a) => a.id !== r.id && ids.has(a.id)),
	);
}

export function cityDayTable(
	ix: GraphIndex,
	schedule: ScheduleResult | null,
	scopeId: string | null = null,
): CityDaysTable {
	const all = cityRowNodes(ix, null);
	const rowOf = (nodeId: string | null | undefined): GraphNode | undefined => {
		if (!nodeId) return undefined;
		// The deepest row node containing the node.
		let best: GraphNode | undefined;
		for (const r of all)
			if (
				ix.isWithin(nodeId, r.id) &&
				(!best || ix.path(r.id).length > ix.path(best.id).length)
			)
				best = r;
		return best;
	};

	const daysByRow = new Map<string, string[]>();
	const unassigned: string[] = [];
	for (const day of ix.days) {
		const minutes = new Map<string, number>();
		for (const it of ix.itemsByDay.get(day.id) ?? []) {
			const row = rowOf(it.nodeId);
			if (!row) continue;
			const s = schedule?.items[it.id];
			const m = s
				? Math.max(0, (s.end.getTime() - s.start.getTime()) / 60_000)
				: it.durationMin;
			minutes.set(row.id, (minutes.get(row.id) ?? 0) + Math.max(m, 1));
		}
		let pick: string | undefined;
		let most = -1;
		for (const [id, m] of minutes)
			if (m > most) {
				most = m;
				pick = id;
			}
		pick ??= rowOf(day.nightNodeId)?.id;
		if (!pick) {
			unassigned.push(day.id);
			continue;
		}
		const list = daysByRow.get(pick) ?? [];
		list.push(day.id);
		daysByRow.set(pick, list);
	}

	const countryOf = (id: string) =>
		ix.path(id).find((n) => n.type === "country")?.id ?? null;
	const rows = all
		.filter((n) => ix.isWithin(n.id, scopeId))
		.map<CityDaysRow>((n) => ({
			nodeId: n.id,
			name: n.name,
			countryId: countryOf(n.id),
			planned: planned(n),
			scheduled: daysByRow.get(n.id)?.length ?? 0,
			dayIds: daysByRow.get(n.id) ?? [],
		}));
	const tripDays =
		ix.days.length || inclusiveDays(ix.trip.startDate, ix.trip.endDate);
	const plannedTotal = rows.reduce((s, r) => s + (r.planned ?? 0), 0);
	const scheduledTotal = rows.reduce((s, r) => s + r.scheduled, 0);
	return {
		rows,
		tripDays,
		plannedTotal,
		scheduledTotal,
		unallocated: tripDays - plannedTotal,
		unassignedDayIds: scopeId === null ? unassigned : [],
	};
}

/** "3", "2.5", "½": planned days as typed (halves allowed). */
export function formatDays(n: number | null): string {
	if (n === null) return "–";
	if (Number.isInteger(n)) return String(n);
	return n.toFixed(1).replace(/\.0$/, "");
}

/** Parses a typed day count: "", "3", "2.5", "2,5" → number | null (invalid). */
export function parseDays(raw: string): number | null | "invalid" {
	const s = raw.trim().replace(",", ".");
	if (s === "") return null;
	const n = Number(s);
	if (!Number.isFinite(n) || n < 0 || n > 366) return "invalid";
	return Math.round(n * 2) / 2;
}
