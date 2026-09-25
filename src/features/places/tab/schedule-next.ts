/**
 * Schedule next (docs/PLACES.md §4): what should go where. Pure.
 *
 * It runs per **stay window**: a run of consecutive trip days in one city
 * (the city each day belongs to comes from the days-per-city table: the
 * city with the most scheduled minutes that day, else that night's stay).
 *
 * - Per window: the city's shortlisted places not on a day yet, grouped by
 *   area, each with a fit hint per day of the window: open or closed that
 *   day (the place's opening hours, holidays included), its time needed
 *   against the day's free time (the schedule engine's capacity less the
 *   day's stops and travel), and the distance from that day's stay or
 *   stops. The best day is open, has the time, and is nearest.
 * - Cities with shortlisted places but no days yet, with the time needed
 *   in total ("about 1.5 days of sights").
 * - Can't fit: closed on every day you're in its city, or a Must place in
 *   a city with no days.
 * - `bestSpot`: where on a day a place goes: the cheapest detour between
 *   the day's stay and stops (never inside a flight, never pushing a pinned
 *   stop late), checked with the Plan's own drop rules (`planDrop`).
 */
import { planDrop } from "@/features/plan/plan-drop";
import { defaultItemDuration } from "@/lib/domain/taxonomy";
import { haversineKm, type LngLat } from "@/lib/engine/geo";
import type { GraphIndex } from "@/lib/engine/graph-index";
import {
	effectiveHours,
	holidayFinder,
	hoursApply,
	hoursOnDate,
} from "@/lib/engine/hours";
import type { ScheduleResult } from "@/lib/engine/types";
import { formatDayDate } from "@/lib/format";
import type { Holiday } from "@/lib/schemas/trips";
import type { CityDaysRow, CityDaysTable } from "../lib/days";
import type { PlaceRow } from "./model";

// ---------------------------------------------------------------------------
// Stay windows
// ---------------------------------------------------------------------------

export type StayWindow = {
	key: string;
	cityId: string;
	cityName: string;
	/** Consecutive trip days, in order. */
	dayIds: string[];
};

/** Runs of consecutive trip days in one city (a day no city claims breaks a run). */
export function stayWindows(
	ix: Pick<GraphIndex, "days">,
	cityDays: Pick<CityDaysTable, "rows">,
): StayWindow[] {
	const rowOfDay = new Map<string, CityDaysRow>();
	for (const r of cityDays.rows) for (const d of r.dayIds) rowOfDay.set(d, r);
	const out: StayWindow[] = [];
	let cur: StayWindow | null = null;
	for (const day of ix.days) {
		const r = rowOfDay.get(day.id);
		if (!r) {
			cur = null;
			continue;
		}
		if (cur && cur.cityId === r.nodeId) cur.dayIds.push(day.id);
		else {
			cur = {
				key: `${r.nodeId}:${day.id}`,
				cityId: r.nodeId,
				cityName: r.name,
				dayIds: [day.id],
			};
			out.push(cur);
		}
	}
	return out;
}

/** The deepest days-per-city row holding a node (its city, or a stand-in). */
export function cityRowOf(
	ix: Pick<GraphIndex, "isWithin" | "path">,
	cityDays: Pick<CityDaysTable, "rows">,
	nodeId: string,
): CityDaysRow | undefined {
	let best: CityDaysRow | undefined;
	let depth = -1;
	for (const r of cityDays.rows) {
		if (!ix.isWithin(nodeId, r.nodeId)) continue;
		const d = ix.path(r.nodeId).length;
		if (d > depth) {
			best = r;
			depth = d;
		}
	}
	return best;
}

// ---------------------------------------------------------------------------
// One day
// ---------------------------------------------------------------------------

export type Near = {
	nodeId: string;
	name: string;
	km: number;
	/** Walking minutes (streets are about a quarter longer than the crow flies). */
	walkMin: number;
};

export type DayFit = {
	dayId: string;
	date: string;
	/** "Closed Mon" when the place is closed that day (struck through). */
	closed: string | null;
	/** Its hours are known for that date (open or closed). */
	hoursKnown: boolean;
	/** The day's free time: capacity less the day's stops and travel. */
	freeMin: number;
	/** The time needed fits in the free time. */
	fits: boolean;
	/** The nearest of that day's stay and stops. */
	near: Near | null;
};

/** The day's free time from the schedule engine (capacity − stops − travel). */
export function freeTimeOf(
	schedule: Pick<ScheduleResult, "days"> | null,
	dayId: string,
	capacityMin: number,
): number {
	const sd = schedule?.days[dayId];
	if (!sd) return capacityMin;
	return Math.max(0, sd.capacityMin - sd.activitiesMin - sd.travelMin);
}

type Stop = { nodeId: string; name: string; at: LngLat };

/** That day's stay (last night's and tonight's) and its located stops. */
function stopsOf(ix: GraphIndex, dayId: string, except: string): Stop[] {
	const ids = [
		ix.prevDay(dayId)?.nightNodeId ?? null,
		...(ix.itemsByDay.get(dayId) ?? []).map((it) => it.nodeId),
		ix.day(dayId)?.nightNodeId ?? null,
	];
	const out: Stop[] = [];
	const seen = new Set<string>();
	for (const id of ids) {
		if (!id || id === except || seen.has(id)) continue;
		seen.add(id);
		const n = ix.node(id);
		const at = ix.coordOf(id);
		if (n && at) out.push({ nodeId: id, name: n.name, at });
	}
	return out;
}

export function walkMinutes(km: number, walkKmh: number): number {
	return Math.max(1, Math.round((km * 1.25 * 60) / Math.max(1, walkKmh)));
}

function nearestStop(
	stops: readonly Stop[],
	at: LngLat | null,
	walkKmh: number,
): Near | null {
	if (!at) return null;
	let best: Near | null = null;
	for (const s of stops) {
		const km = haversineKm(at, s.at);
		if (!best || km < best.km)
			best = {
				nodeId: s.nodeId,
				name: s.name,
				km,
				walkMin: walkMinutes(km, walkKmh),
			};
	}
	return best;
}

/** Best first: it fits the free time, then nearest, then the most free, then earliest. */
export function compareFits(a: DayFit, b: DayFit): number {
	return (
		Number(b.fits) - Number(a.fits) ||
		(a.near?.km ?? Number.POSITIVE_INFINITY) -
			(b.near?.km ?? Number.POSITIVE_INFINITY) ||
		b.freeMin - a.freeMin ||
		a.date.localeCompare(b.date)
	);
}

// ---------------------------------------------------------------------------
// The panel
// ---------------------------------------------------------------------------

export type ScheduleCandidate = {
	row: PlaceRow;
	/** Its time needed, or the category's default (`needSet` false). */
	needMin: number;
	needSet: boolean;
	days: DayFit[];
	/** The best open day (null never: a place with no open day can't fit). */
	best: DayFit;
};

export type AreaGroup = {
	key: string;
	/** The area's name, or "" for places right under the city. */
	label: string;
	items: ScheduleCandidate[];
};

export type WindowPlan = StayWindow & {
	groups: AreaGroup[];
	/** Places waiting in this window. */
	count: number;
	days: { dayId: string; date: string; freeMin: number }[];
};

export type NoDaysCity = {
	key: string;
	/** The city (or the nearest level above) the places are in. */
	cityId: string | null;
	name: string;
	rows: PlaceRow[];
	/** Their time needed together. */
	minutes: number;
	/** Rounded to half days of the day capacity ("about 1.5 days"). */
	days: number;
};

export type CantFit = {
	row: PlaceRow;
	kind: "closed" | "no_days";
	/** "Closed every day you're in Kyoto" · "Must, but no days in Nara". */
	reason: string;
	/** "Closed Mon · Mon 11 Oct". */
	detail?: string;
};

export type ScheduleNextResult = {
	windows: WindowPlan[];
	noDays: NoDaysCity[];
	cantFit: CantFit[];
	/** Shortlisted places not on a day (each counted once). */
	waiting: number;
};

/** Sights' time in half days of the day capacity ("about 1.5 days"), at least half a day. */
export function sightDays(minutes: number, capacityMin: number): number {
	return Math.max(
		0.5,
		Math.round((minutes / Math.max(60, capacityMin)) * 2) / 2,
	);
}

function areaOf(ix: GraphIndex, nodeId: string, cityId: string) {
	const path = ix.path(nodeId).slice(0, -1);
	const at = path.findIndex((n) => n.id === cityId);
	for (let i = path.length - 1; i > at; i--) {
		const n = path[i];
		if (n?.type === "area") return n;
	}
	return null;
}

const byPriority = (a: ScheduleCandidate, b: ScheduleCandidate) =>
	b.row.score - a.row.score ||
	(b.row.top ?? -9) - (a.row.top ?? -9) ||
	a.row.name.localeCompare(b.row.name);

export function scheduleNext(
	ix: GraphIndex,
	schedule: ScheduleResult | null,
	rows: readonly PlaceRow[],
	cityDays: Pick<CityDaysTable, "rows">,
	opts: { holidays?: readonly Holiday[] } = {},
): ScheduleNextResult {
	const capacity = ix.settings.dayCapacityMin;
	const walkKmh = ix.settings.walkSpeedKmh;
	const windows = stayWindows(ix, cityDays);
	const free = new Map<string, number>();
	const stops = new Map<string, Stop[]>();
	for (const w of windows)
		for (const d of w.dayIds) free.set(d, freeTimeOf(schedule, d, capacity));
	const stopsFor = (dayId: string, except: string) => {
		const key = `${dayId}|${except}`;
		let s = stops.get(key);
		if (!s) {
			s = stopsOf(ix, dayId, except);
			stops.set(key, s);
		}
		return s;
	};

	const inWindow = new Map<string, Map<string, AreaGroup>>();
	const noDays = new Map<string, NoDaysCity>();
	const cantFit: CantFit[] = [];
	let waiting = 0;

	for (const row of rows) {
		if (row.status !== "shortlist") continue;
		waiting += 1;
		const node = row.node;
		const needMin = defaultItemDuration(node);
		const needSet = node.timeNeededMin != null;
		const cityRow = cityRowOf(ix, cityDays, row.id);
		const wins = cityRow
			? windows.filter((w) => w.cityId === cityRow.nodeId)
			: [];
		if (!wins.length) {
			const cityId = cityRow?.nodeId ?? row.city?.id ?? null;
			const name = cityRow?.name ?? row.city?.name ?? "Elsewhere";
			const key = cityId ?? "none";
			const c = noDays.get(key) ?? {
				key,
				cityId,
				name,
				rows: [],
				minutes: 0,
				days: 0,
			};
			c.rows.push(row);
			c.minutes += needMin;
			noDays.set(key, c);
			if (row.must && ix.days.length)
				cantFit.push({
					row,
					kind: "no_days",
					reason: `Must, but no days in ${name}`,
				});
			continue;
		}
		const eh = hoursApply(node) ? effectiveHours(node, ix.settings) : null;
		const holidayOf = holidayFinder(ix, opts.holidays ?? [], node.id);
		const at = ix.coordOf(node.id);
		const closedDays: string[] = [];
		let placed = false;
		for (const w of wins) {
			const days = w.dayIds.map((dayId): DayFit => {
				const date = ix.day(dayId)?.date ?? "";
				const h = eh ? hoursOnDate(eh.hours, date, holidayOf(date)) : null;
				// Low-confidence hours (parsed sheet text) only close on explicit closures.
				const closed =
					h?.state === "closed" &&
					!(eh?.confidence === "low" && h.why === "weekday")
						? h.label
						: null;
				const freeMin = free.get(dayId) ?? capacity;
				if (closed) closedDays.push(`${formatDayDate(date)}`);
				return {
					dayId,
					date,
					closed,
					hoursKnown: !!h && h.state !== "unknown",
					freeMin,
					fits: needMin <= freeMin,
					near: nearestStop(stopsFor(dayId, node.id), at, walkKmh),
				};
			});
			const open = days.filter((d) => !d.closed);
			const best = [...open].sort(compareFits)[0];
			if (!best) continue;
			placed = true;
			const area = areaOf(ix, node.id, w.cityId);
			const groups = inWindow.get(w.key) ?? new Map<string, AreaGroup>();
			const gk = area?.id ?? "";
			const g = groups.get(gk) ?? {
				key: gk || `${w.key}:city`,
				label: area?.name ?? "",
				items: [],
			};
			g.items.push({ row, needMin, needSet, days, best });
			groups.set(gk, g);
			inWindow.set(w.key, groups);
		}
		if (!placed)
			cantFit.push({
				row,
				kind: "closed",
				reason: `Closed every day you're in ${cityRow?.name ?? "its city"}`,
				detail: [...new Set(closedDays)].join(", "),
			});
	}

	const windowPlans: WindowPlan[] = [];
	for (const w of windows) {
		const groups = [...(inWindow.get(w.key)?.values() ?? [])];
		if (!groups.length) continue;
		for (const g of groups) g.items.sort(byPriority);
		groups.sort(
			(a, b) =>
				Number(!a.label) - Number(!b.label) ||
				byPriority(
					a.items[0] as ScheduleCandidate,
					b.items[0] as ScheduleCandidate,
				) ||
				a.label.localeCompare(b.label),
		);
		windowPlans.push({
			...w,
			groups,
			count: groups.reduce((s, g) => s + g.items.length, 0),
			days: w.dayIds.map((dayId) => ({
				dayId,
				date: ix.day(dayId)?.date ?? "",
				freeMin: free.get(dayId) ?? capacity,
			})),
		});
	}
	const cities = [...noDays.values()].map((c) => ({
		...c,
		rows: [...c.rows].sort(
			(a, b) => b.score - a.score || a.name.localeCompare(b.name),
		),
		days: sightDays(c.minutes, capacity),
	}));
	cities.sort(
		(a, b) => b.rows.length - a.rows.length || a.name.localeCompare(b.name),
	);
	cantFit.sort(
		(a, b) => b.row.score - a.row.score || a.row.name.localeCompare(b.row.name),
	);
	return { windows: windowPlans, noDays: cities, cantFit, waiting };
}

// ---------------------------------------------------------------------------
// Where on the day
// ---------------------------------------------------------------------------

export type Spot = {
	dayId: string;
	afterItemId?: string;
	beforeItemId?: string;
	/** "after Kiyomizu-dera", "before Senso-ji", "" (an empty day). */
	label: string;
};

function itemName(ix: GraphIndex, itemId: string): string {
	const it = ix.item(itemId);
	return it?.title ?? ix.node(it?.nodeId)?.name ?? "the stop";
}

function spotOf(
	ix: GraphIndex,
	dayId: string,
	drop: { afterItemId?: string; beforeItemId?: string },
): Spot {
	if (drop.afterItemId)
		return {
			dayId,
			afterItemId: drop.afterItemId,
			label: `after ${itemName(ix, drop.afterItemId)}`,
		};
	if (drop.beforeItemId)
		return {
			dayId,
			beforeItemId: drop.beforeItemId,
			label: `before ${itemName(ix, drop.beforeItemId)}`,
		};
	return { dayId, label: "" };
}

/**
 * Where a place goes on a day: the gap between the day's stay and stops
 * that adds the shortest detour (cheapest insertion by distance). Gaps
 * inside a flight, and gaps right before a pinned stop without the time
 * free, are skipped; ties go to the later gap (the least disruptive). No
 * coordinates, or an empty day: the end of the day, as a drop would.
 */
export function bestSpot(
	ix: GraphIndex,
	dayId: string,
	nodeId: string,
	opts: { schedule?: ScheduleResult | null; needMin?: number } = {},
): Spot {
	const end = planDrop(ix, null, { panel: "plan", dayId });
	const fallback = spotOf(ix, dayId, end.ok ? end : {});
	const at = ix.coordOf(nodeId);
	const items = ix.itemsByDay.get(dayId) ?? [];
	if (!at || !items.length) return fallback;
	const coords = items.map((it) => (it.nodeId ? ix.coordOf(it.nodeId) : null));
	const morning = ix.coordOf(ix.prevDay(dayId)?.nightNodeId ?? null);
	const night = ix.coordOf(ix.day(dayId)?.nightNodeId ?? null);
	const need = opts.needMin ?? 0;
	let best: {
		cost: number;
		drop: { afterItemId?: string; beforeItemId?: string };
	} | null = null;
	for (let g = 0; g <= items.length; g++) {
		const over = items[g];
		const drop = over
			? planDrop(ix, null, { panel: "plan", dayId, itemId: over.id })
			: end;
		if (!drop.ok) continue;
		// Never push a pinned stop late.
		const s = over ? opts.schedule?.items[over.id] : undefined;
		if (s?.pinned && s.freeBeforeMin < need) continue;
		let prev: LngLat | null = morning;
		for (let i = g - 1; i >= 0; i--)
			if (coords[i]) {
				prev = coords[i] as LngLat;
				break;
			}
		let next: LngLat | null = night;
		for (let i = g; i < items.length; i++)
			if (coords[i]) {
				next = coords[i] as LngLat;
				break;
			}
		const cost =
			(prev ? haversineKm(prev, at) : 0) +
			(next ? haversineKm(at, next) : 0) -
			(prev && next ? haversineKm(prev, next) : 0);
		if (!best || cost <= best.cost + 1e-9) best = { cost, drop };
	}
	return best ? spotOf(ix, dayId, best.drop) : fallback;
}
