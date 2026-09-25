/**
 * How long in each city (the top of the Plan while no trip day has a city):
 * how many of the trip's days each city with places gets, from the time its
 * shortlist needs, the spare days shared out, in the order with the least
 * travel from where you land to where you fly home. The stops read in
 * travel order under their country (and region) headings, and can be
 * reordered. Afterwards: the days each city holds now (runs of nights in one
 * city), a change laid out on the days, and what applying it writes (the
 * nights) and moves off a day (places on a day that changes city). Pure.
 */

import type { CityDaysTable } from "@/features/places/lib/days";
import { isRateable } from "@/features/places/lib/rate";
import type { PlaceRow } from "@/features/places/tab/model";
import { cityRowOf, sightDays } from "@/features/places/tab/schedule-next";
import { compareByScore } from "@/features/places/tab/score";
import { defaultItemDuration } from "@/lib/domain/taxonomy";
import { haversineKm, type LngLat } from "@/lib/engine/geo";
import type { GraphIndex } from "@/lib/engine/graph-index";
import type { GraphItem, GraphMember } from "@/lib/engine/types";

// ---------------------------------------------------------------------------
// Cities and what their shortlist needs
// ---------------------------------------------------------------------------

/** Shortlisted places of a city in one area (the top-level area under the city; null: right under it). */
export type SplitArea = {
	id: string | null;
	name: string;
	minutes: number;
	/** Best first. */
	ids: string[];
};

export type SplitCity = {
	id: string;
	name: string;
	at: LngLat | null;
	/** Shortlisted places (on a day or not). */
	shortlisted: number;
	/** Places some rater hasn't rated yet. */
	notRated: number;
	/** The shortlist's time needed. */
	minutes: number;
	/** Whole days that time takes: at least 1 with anything shortlisted, else 0. */
	need: number;
	/** What's there: the shortlist (best first), the places not rated by everyone yet, and the rest's count. */
	shortlistIds: string[];
	toRateIds: string[];
	belowShortlist: number;
	/** The shortlist by area: in order of their best place, the city's own last. */
	areas: SplitArea[];
};

type Tree = Pick<GraphIndex, "isWithin" | "path" | "node">;

/** A place's city, as Schedule next reads it: its days-per-city row, else its city (or the level above; never a country). */
export function splitCityOf(
	ix: Tree,
	cityDays: Pick<CityDaysTable, "rows">,
	row: Pick<PlaceRow, "id" | "city">,
): { id: string; name: string } | null {
	const r = cityRowOf(ix, cityDays, row.id);
	if (r) return { id: r.nodeId, name: r.name };
	if (!row.city || ix.node(row.city.id)?.type === "country") return null;
	return row.city;
}

/** The top-level area under `cityId` on a place's path, or null. */
export function topAreaOf(
	ix: Pick<GraphIndex, "path">,
	nodeId: string,
	cityId: string,
): { id: string; name: string } | null {
	const path = ix.path(nodeId).slice(0, -1);
	const at = path.findIndex((n) => n.id === cityId);
	if (at < 0) return null;
	return path.slice(at + 1).find((n) => n.type === "area") ?? null;
}

/** Days a shortlist needs: the "about 1.5 days of sights" estimate, rounded up. */
export function daysNeeded(minutes: number, capacityMin: number): number {
	return Math.ceil(sightDays(minutes, capacityMin));
}

/** Every city with places that aren't dropped, with its shortlist and what's left to rate. */
export function splitCities(
	ix: Tree & Pick<GraphIndex, "coordOf">,
	rows: readonly PlaceRow[],
	cityDays: Pick<CityDaysTable, "rows">,
	opts: { raterIds: readonly string[]; capacityMin: number },
): SplitCity[] {
	const by = new Map<string, SplitCity>();
	const short = new Map<string, PlaceRow[]>();
	for (const row of rows) {
		if (row.status === "dropped") continue;
		const city = splitCityOf(ix, cityDays, row);
		if (!city) continue;
		let c = by.get(city.id);
		if (!c) {
			c = {
				id: city.id,
				name: city.name,
				at: ix.coordOf(city.id),
				shortlisted: 0,
				notRated: 0,
				minutes: 0,
				need: 0,
				shortlistIds: [],
				toRateIds: [],
				belowShortlist: 0,
				areas: [],
			};
			by.set(city.id, c);
		}
		const listed = row.status === "shortlist" || row.status === "scheduled";
		const unrated = opts.raterIds.some(
			(m) => row.node.priorities[m] === undefined,
		);
		if (listed) {
			c.shortlisted += 1;
			c.minutes += defaultItemDuration(row.node);
			short.set(c.id, [...(short.get(c.id) ?? []), row]);
		} else if (unrated) c.toRateIds.push(row.id);
		else c.belowShortlist += 1;
		if (unrated) c.notRated += 1;
	}
	const out = [...by.values()];
	for (const c of out) {
		c.need = c.shortlisted ? daysNeeded(c.minutes, opts.capacityMin) : 0;
		const best = (short.get(c.id) ?? []).sort(compareByScore);
		c.shortlistIds = best.map((r) => r.id);
		const areas = new Map<string, SplitArea>();
		for (const r of best) {
			const a = topAreaOf(ix, r.id, c.id);
			const key = a?.id ?? "";
			const area = areas.get(key) ?? {
				id: a?.id ?? null,
				name: a?.name ?? "",
				minutes: 0,
				ids: [],
			};
			area.minutes += defaultItemDuration(r.node);
			area.ids.push(r.id);
			areas.set(key, area);
		}
		c.areas = [...areas.values()].sort(
			(a, b) => Number(a.id === null) - Number(b.id === null),
		);
	}
	return out;
}

// ---------------------------------------------------------------------------
// Fitting the trip's length
// ---------------------------------------------------------------------------

/**
 * Days per city within `budget`: everything when it fits; else scaled down
 * (largest remainder), keeping at least 1 each where there are days enough,
 * else 1 each for the cities that need the most.
 */
export function fitDays(need: readonly number[], budget: number): number[] {
	const total = need.reduce((s, n) => s + n, 0);
	if (total <= budget) return [...need];
	const out = need.map(() => 0);
	const want = need
		.map((n, i) => ({ n, i }))
		.filter((x) => x.n > 0)
		.sort((a, b) => b.n - a.n || a.i - b.i);
	if (budget <= 0) return out;
	if (want.length >= budget) {
		for (const x of want.slice(0, budget)) out[x.i] = 1;
		return out;
	}
	const rest = budget - want.length;
	const extra = want.reduce((s, x) => s + x.n - 1, 0);
	const shares = want.map((x) => {
		const exact = extra ? ((x.n - 1) * rest) / extra : 0;
		return { ...x, days: 1 + Math.floor(exact), frac: exact % 1 };
	});
	let left = budget - shares.reduce((s, x) => s + x.days, 0);
	for (const x of [...shares].sort(
		(a, b) => b.frac - a.frac || b.n - a.n || a.i - b.i,
	)) {
		if (left <= 0) break;
		x.days += 1;
		left -= 1;
	}
	for (const x of shares) out[x.i] = x.days;
	return out;
}

/**
 * The spare days shared out: one more day each, in turn, to the cities with
 * days, the most time needed first, until the trip is full.
 */
export function shareSpare(
	days: readonly number[],
	minutes: readonly number[],
	budget: number,
): number[] {
	const out = [...days];
	const turn = out
		.map((d, i) => ({ d, i, m: minutes[i] ?? 0 }))
		.filter((x) => x.d > 0)
		.sort((a, b) => b.m - a.m || b.d - a.d || a.i - b.i);
	let left = budget - out.reduce((s, d) => s + d, 0);
	while (left > 0 && turn.length)
		for (const x of turn) {
			if (left <= 0) break;
			out[x.i] = (out[x.i] ?? 0) + 1;
			left -= 1;
		}
	return out;
}

// ---------------------------------------------------------------------------
// Order: the least travel between cities
// ---------------------------------------------------------------------------

type Point = { id: string; at: LngLat | null };
type Located = Point & { at: LngLat };

/**
 * The visiting order with the least travel: nearest neighbour from the
 * start, then 2-opt; the start stays first and `endId` last (the end back at
 * the start: a round trip). Points without coordinates go last, in the order
 * given.
 */
export function routeOrder(
	points: readonly Point[],
	startId: string | null,
	endId: string | null = null,
): string[] {
	const located = points.filter((p): p is Located => !!p.at);
	const rest = points.filter((p) => !p.at).map((p) => p.id);
	const start = located.find((p) => p.id === startId) ?? located[0];
	if (!start) return rest;
	const round = endId === start.id && located.length > 2;
	const end =
		(endId && located.find((p) => p.id === endId && p !== start)) || null;
	const path: Located[] = [start];
	const todo = located.filter((p) => p !== start && p !== end);
	while (todo.length) {
		const last = (path.at(-1) as Located).at;
		let best = 0;
		for (let i = 1; i < todo.length; i++)
			if (
				haversineKm(last, (todo[i] as Located).at) <
				haversineKm(last, (todo[best] as Located).at)
			)
				best = i;
		path.push(todo.splice(best, 1)[0] as Located);
	}
	if (end) path.push(end);
	const at = (i: number) => (path[i] as Located).at;
	const d = (a: number, b: number) =>
		b < path.length
			? haversineKm(at(a), at(b))
			: round
				? haversineKm(at(a), start.at)
				: 0;
	const lastFree = end ? path.length - 2 : path.length - 1;
	for (let improved = true, rounds = 0; improved && rounds < 50; rounds++) {
		improved = false;
		for (let i = 1; i < lastFree; i++)
			for (let j = i + 1; j <= lastFree; j++) {
				const delta = d(i - 1, j) + d(i, j + 1) - d(i - 1, i) - d(j, j + 1);
				if (delta < -1e-9) {
					path.splice(i, j - i + 1, ...path.slice(i, j + 1).reverse());
					improved = true;
				}
			}
	}
	return [...path.map((p) => p.id), ...rest];
}

type Trip = Pick<
	GraphIndex,
	"located" | "blockOf" | "item" | "isWithin" | "coordOf"
>;

/** The city holding `nodeId`, else the one nearest to it; null when it has no place. */
function cityAt(
	ix: Pick<GraphIndex, "isWithin" | "coordOf">,
	nodeId: string | null | undefined,
	cities: readonly Point[],
): string | null {
	if (!nodeId) return null;
	const inside = cities.find((c) => ix.isWithin(nodeId, c.id));
	if (inside) return inside.id;
	const at = ix.coordOf(nodeId);
	if (!at) return null;
	let best: string | null = null;
	let km = Number.POSITIVE_INFINITY;
	for (const c of cities) {
		if (!c.at) continue;
		const k = haversineKm(at, c.at);
		if (k < km) {
			km = k;
			best = c.id;
		}
	}
	return best;
}

/**
 * Where the trip starts: the city of its first located item (where a first
 * flight lands) when it's one of `cities`, else the one nearest to it. Null
 * when nothing is located.
 */
export function arrivalCity(ix: Trip, cities: readonly Point[]): string | null {
	const first = ix.located[0];
	if (!first) return null;
	const landed = ix.blockOf(first.id)?.at(-1) ?? first.id;
	return cityAt(ix, ix.item(landed)?.nodeId ?? first.nodeId, cities);
}

/**
 * Where the trip ends: the city of its last located item (where the last
 * flight leaves from), or the one nearest to it. Null when nothing is
 * located after the way in.
 */
export function departureCity(
	ix: Trip,
	cities: readonly Point[],
): string | null {
	const first = ix.located[0];
	const last = ix.located.at(-1);
	if (!first || !last) return null;
	const block = ix.blockOf(last.id);
	if (last.id === first.id || block?.includes(first.id)) return null;
	const from = block?.[0] ?? last.id;
	return cityAt(ix, ix.item(from)?.nodeId ?? last.nodeId, cities);
}

// ---------------------------------------------------------------------------
// The suggestion, and − / + and reordering on it
// ---------------------------------------------------------------------------

export type SplitRow = SplitCity & { days: number };

export type DaySplit = {
	tripDays: number;
	/** In visiting order; the cities with no days after the route. */
	rows: SplitRow[];
	/** Days the whole shortlist needs. */
	need: number;
	unused: number;
};

/**
 * The suggested split: each city's days from its shortlist, fitted to the
 * trip, the spare days shared out, ordered by the least travel from the
 * arrival city (else the city with the most days) to the departure city.
 * Cities with no days follow, nearest first.
 */
export function suggestSplit(
	ix: Trip,
	cities: readonly SplitCity[],
	tripDays: number,
): DaySplit {
	const base = [...cities].sort(
		(a, b) =>
			b.need - a.need ||
			b.shortlisted - a.shortlisted ||
			a.name.localeCompare(b.name),
	);
	const fitted = shareSpare(
		fitDays(
			base.map((c) => c.need),
			tripDays,
		),
		base.map((c) => c.minutes),
		tripDays,
	);
	const rows: SplitRow[] = base.map((c, i) => ({ ...c, days: fitted[i] ?? 0 }));
	const on = rows
		.filter((r) => r.days > 0)
		.sort((a, b) => b.days - a.days || rows.indexOf(a) - rows.indexOf(b));
	const off = rows.filter((r) => r.days === 0);
	const start = arrivalCity(ix, on) ?? on[0]?.id ?? null;
	const route = routeOrder(on, start, departureCity(ix, on));
	// Cities with no days: a nearest-neighbour chain on from the route's end.
	const byId = new Map(rows.map((r) => [r.id, r]));
	const end = byId.get(route.at(-1) ?? "")?.at;
	const tail = end
		? routeOrder([{ id: "", at: end }, ...off], "").slice(1)
		: routeOrder(off, null);
	const need = cities.reduce((s, c) => s + c.need, 0);
	const used = rows.reduce((s, r) => s + r.days, 0);
	return {
		tripDays,
		rows: [...route, ...tail].map((id) => byId.get(id) as SplitRow),
		need,
		unused: Math.max(0, tripDays - used),
	};
}

/**
 * The suggestion with the − / + changes on top: a changed city keeps its
 * count, the others fit what's left (never more than suggested), so − frees
 * a day and a new rating never takes a day you set.
 */
export function withOverrides(
	split: DaySplit,
	overrides: Readonly<Record<string, number>>,
): DaySplit {
	const fixed = new Map<string, number>();
	let budget = split.tripDays;
	for (const r of split.rows) {
		const o = overrides[r.id];
		if (o === undefined) continue;
		const days = Math.max(0, Math.min(o, budget));
		fixed.set(r.id, days);
		budget -= days;
	}
	const free = split.rows.filter((r) => !fixed.has(r.id));
	const fitted = fitDays(
		free.map((r) => r.days),
		budget,
	);
	const days = new Map(free.map((r, i) => [r.id, fitted[i] ?? 0]));
	const rows = split.rows.map((r) => ({
		...r,
		days: fixed.get(r.id) ?? days.get(r.id) ?? 0,
	}));
	const used = rows.reduce((s, r) => s + r.days, 0);
	return { ...split, rows, unused: Math.max(0, split.tripDays - used) };
}

/**
 * The suggestion in the order you set: the cities you placed keep their
 * order; a city new to the suggestion goes after the one before it there.
 */
export function withOrder(
	split: DaySplit,
	order: readonly string[] | null | undefined,
): DaySplit {
	if (!order?.length) return split;
	const byId = new Map(split.rows.map((r) => [r.id, r]));
	const ids = order.filter((id) => byId.has(id));
	const seen = new Set(ids);
	let prev: string | null = null;
	for (const r of split.rows) {
		if (!seen.has(r.id)) {
			ids.splice(prev ? ids.indexOf(prev) + 1 : 0, 0, r.id);
			seen.add(r.id);
		}
		prev = r.id;
	}
	return { ...split, rows: ids.map((id) => byId.get(id) as SplitRow) };
}

/** `list` with the element at `from` moved to `to`; null when either is out of range. */
export function moveAt<T>(
	list: readonly T[],
	from: number,
	to: number,
): T[] | null {
	if (from === to || from < 0 || to < 0) return null;
	if (from >= list.length || to >= list.length) return null;
	const out = [...list];
	const [x] = out.splice(from, 1);
	out.splice(to, 0, x as T);
	return out;
}

/** − / + on a city of the suggestion: the new overrides, or null when it can't (+ with no unused day, − at 0). */
export function stepCity(
	split: DaySplit,
	overrides: Readonly<Record<string, number>>,
	cityId: string,
	delta: 1 | -1,
): Record<string, number> | null {
	const row = split.rows.find((r) => r.id === cityId);
	if (!row) return null;
	if (delta > 0 && split.unused < 1) return null;
	if (delta < 0 && row.days < 1) return null;
	return { ...overrides, [cityId]: row.days + delta };
}

// ---------------------------------------------------------------------------
// Headings: country and region runs in travel order
// ---------------------------------------------------------------------------

export type SplitLine =
	| {
			kind: "country" | "region";
			key: string;
			name: string;
			days: number;
	  }
	| {
			kind: "stop";
			key: string;
			/** The row's index. */
			index: number;
			/** 1, 2, 3… for the rows with days, in order; null without. */
			stop: number | null;
			/** Under a region heading. */
			inRegion: boolean;
	  };

/**
 * The rows with their headings, in travel order: a country heading over each
 * run of its cities (again when the route comes back), with the run's days;
 * a region heading over two or more cities in a row that share a region.
 */
export function splitLines(
	ix: Pick<GraphIndex, "path">,
	rows: readonly { id: string; days: number }[],
): SplitLine[] {
	const above = rows.map((r) => {
		const path = ix.path(r.id).slice(0, -1);
		const country = path.find((n) => n.type === "country") ?? null;
		const region = path.findLast((n) => n.type === "region") ?? null;
		return { country, region };
	});
	const sum = (a: number, b: number) =>
		rows.slice(a, b).reduce((s, r) => s + r.days, 0);
	const out: SplitLine[] = [];
	let stop = 0;
	for (let i = 0; i < rows.length; ) {
		const country = above[i]?.country ?? null;
		let j = i + 1;
		while (j < rows.length && above[j]?.country?.id === country?.id) j++;
		if (country)
			out.push({
				kind: "country",
				key: `c:${country.id}:${i}`,
				name: country.name,
				days: sum(i, j),
			});
		for (let k = i; k < j; ) {
			const region = above[k]?.region ?? null;
			let m = k + 1;
			while (region && m < j && above[m]?.region?.id === region.id) m++;
			const inRegion = !!region && m - k >= 2;
			if (region && inRegion)
				out.push({
					kind: "region",
					key: `r:${region.id}:${k}`,
					name: region.name,
					days: sum(k, m),
				});
			for (let x = k; x < m; x++) {
				const days = rows[x]?.days ?? 0;
				out.push({
					kind: "stop",
					key: `s:${rows[x]?.id}:${x}`,
					index: x,
					stop: days > 0 ? ++stop : null,
					inRegion,
				});
			}
			k = m;
		}
		i = j;
	}
	return out;
}

// ---------------------------------------------------------------------------
// The split the days hold, and changing it
// ---------------------------------------------------------------------------

/**
 * Each trip day's city for the split: where you sleep (the night's city);
 * the trip's last day, the day you leave, with no night: the night before's;
 * else where the day is spent (the days-per-city table). So a day trip from
 * Kyoto to Nara stays a Kyoto day.
 */
export function dayCityIds(
	ix: Pick<GraphIndex, "days" | "node" | "isWithin" | "path">,
	cityDays: Pick<CityDaysTable, "rows">,
): (string | null)[] {
	const rowOfDay = new Map<string, string>();
	for (const r of cityDays.rows)
		for (const d of r.dayIds) rowOfDay.set(d, r.nodeId);
	const nightCity = (nodeId: string | null | undefined) =>
		nodeId && ix.node(nodeId)
			? (cityRowOf(ix, cityDays, nodeId)?.nodeId ?? null)
			: null;
	const out: (string | null)[] = [];
	ix.days.forEach((day, i) => {
		const last = i === ix.days.length - 1 && i > 0;
		out.push(
			nightCity(day.nightNodeId) ??
				(last && !day.nightNodeId
					? nightCity(ix.days[i - 1]?.nightNodeId)
					: null) ??
				rowOfDay.get(day.id) ??
				null,
		);
	});
	return out;
}

export type SplitEntry = { cityId: string; days: number };

/** Runs of consecutive days in one city, in order; days with no city are unused. */
export function runsOf(cityIds: readonly (string | null)[]): {
	entries: SplitEntry[];
	unused: number;
} {
	const entries: SplitEntry[] = [];
	let unused = 0;
	let prev: string | null = null;
	for (const id of cityIds) {
		if (!id) unused += 1;
		else if (id === prev) (entries.at(-1) as SplitEntry).days += 1;
		else entries.push({ cityId: id, days: 1 });
		prev = id;
	}
	return { entries, unused };
}

/** A split laid on the days: each city's days in turn from the first day, the rest unused. */
export function layoutDays(
	entries: readonly SplitEntry[],
	dayCount: number,
): (string | null)[] {
	const out: (string | null)[] = [];
	for (const e of entries)
		for (let k = 0; k < e.days && out.length < dayCount; k++)
			out.push(e.cityId);
	while (out.length < dayCount) out.push(null);
	return out;
}

/**
 * − / + on one entry of a split: − frees a day (the later cities move up, the
 * freed day goes to the end, unused); + takes an unused day. Null when it
 * can't.
 */
export function stepEntry<E extends SplitEntry>(
	entries: readonly E[],
	index: number,
	delta: 1 | -1,
	tripDays: number,
): E[] | null {
	const e = entries[index];
	if (!e) return null;
	const used = entries.reduce((s, x) => s + x.days, 0);
	if (delta > 0 && used >= tripDays) return null;
	if (delta < 0 && e.days < 1) return null;
	return entries.map((x, i) =>
		i === index ? { ...x, days: x.days + delta } : x,
	);
}

export type StayRange = {
	fromDayId: string;
	toDayId: string;
	/** The city (the hotel is picked later), or null: no night. */
	nodeId: string | null;
};

export type ApplyPlan = {
	/** The nights to set, as ranges of consecutive days. */
	stays: StayRange[];
	/** Places on a day that changes city, not in the new one: off their day. */
	displaced: GraphItem[];
};

/**
 * What applying a split writes. Each day's night becomes its city, except:
 * a night already in that city (a hotel) stays; unused days get none; the
 * trip's last day (the day you leave) gets none when it's in the same city
 * as the day before. And the places on a day whose city changes that aren't
 * in its new city go back to "not on a day".
 */
export function applyPlan(
	ix: Pick<GraphIndex, "days" | "node" | "isWithin" | "itemsByDay">,
	next: readonly (string | null)[],
	current: readonly (string | null)[],
): ApplyPlan {
	const stays: StayRange[] = [];
	const displaced: GraphItem[] = [];
	let run: StayRange | null = null;
	ix.days.forEach((day, i) => {
		const city = next[i] ?? null;
		const night =
			day.nightNodeId && ix.node(day.nightNodeId) ? day.nightNodeId : null;
		const leaving = i === ix.days.length - 1 && i > 0 && city === next[i - 1];
		const keep = city ? night !== null && ix.isWithin(night, city) : false;
		let target: string | null | undefined;
		if (leaving || !city) target = night === null || keep ? undefined : null;
		else target = keep ? undefined : city;
		if (target === undefined) run = null;
		else if (run && run.nodeId === target) run.toDayId = day.id;
		else {
			run = { fromDayId: day.id, toDayId: day.id, nodeId: target };
			stays.push(run);
		}
		if ((current[i] ?? null) === city) return;
		for (const it of ix.itemsByDay.get(day.id) ?? []) {
			const node = ix.node(it.nodeId);
			if (!node || !isRateable(node)) continue;
			if (city && ix.isWithin(node.id, city)) continue;
			displaced.push(it);
		}
	});
	return { stays, displaced };
}

// ---------------------------------------------------------------------------
// Words
// ---------------------------------------------------------------------------

const plural = (n: number, one: string, many = `${one}s`) =>
	`${n} ${n === 1 ? one : many}`;

/** "Tokyo 4 days · Kyoto 3 · Osaka 2". */
export function splitText(
	entries: readonly SplitEntry[],
	nameOf: (id: string) => string,
): string {
	return entries
		.filter((e) => e.days > 0)
		.map((e, i) => `${nameOf(e.cityId)} ${i ? e.days : plural(e.days, "day")}`)
		.join(" · ");
}

/** What the shortlist needs per city, in travel order ("Tokyo 4 days · Kyoto 3 · Osaka 1"). */
export function needText(
	ix: Trip,
	cities: readonly SplitCity[],
): string | null {
	const total = cities.reduce((s, c) => s + c.need, 0);
	if (!total) return null;
	const split = suggestSplit(ix, cities, total);
	const byId = new Map(split.rows.map((r) => [r.id, r.name]));
	return splitText(
		split.rows.map((r) => ({ cityId: r.id, days: r.days })),
		(id) => byId.get(id) ?? "?",
	);
}

/** "Japan · 9 days". */
export function headingText(name: string, days: number): string {
	return `${name} · ${plural(days, "day")}`;
}

export type LeftToRate = {
	memberId: string;
	name: string;
	you: boolean;
	count: number;
};

/** Places each rater hasn't rated (not dropped), you first; only those with some left. */
export function leftToRate(
	rows: readonly Pick<PlaceRow, "status" | "node">[],
	raters: readonly Pick<GraphMember, "id" | "name" | "firstName">[],
	me: string | null,
): LeftToRate[] {
	const out = raters.map((m) => ({
		memberId: m.id,
		name: m.firstName ?? m.name,
		you: m.id === me,
		count: rows.filter(
			(r) => r.status !== "dropped" && r.node.priorities[m.id] === undefined,
		).length,
	}));
	return out
		.filter((x) => x.count > 0)
		.sort((a, b) => Number(b.you) - Number(a.you));
}

/** "You have 40 places to rate and Audrey 12. These days will change as you rate." */
export function leftToRateText(left: readonly LeftToRate[]): string | null {
	const [first, ...rest] = left;
	if (!first) return null;
	const head = `${first.you ? "You have" : `${first.name} has`} ${plural(first.count, "place")} to rate`;
	const others = rest.map((x) => `${x.name} ${x.count}`);
	const tail =
		others.length > 1
			? `, ${others.slice(0, -1).join(", ")} and ${others.at(-1)}`
			: others.length
				? ` and ${others[0]}`
				: "";
	return `${head}${tail}. These days will change as ${first.you ? "you" : "they"} rate.`;
}

/** "Your shortlist needs about 16 days, and you have 14. Remove a city or some places." */
export function overText(need: number, tripDays: number): string {
	return `Your shortlist needs about ${need} days, and you have ${tripDays}. Remove a city or some places.`;
}

/** "4 days not planned yet". */
export function unusedText(unused: number): string {
	return `${plural(unused, "day")} not planned yet`;
}

/** "3 places are on days that move to another city. They'll go back to your list to schedule again." */
export function displacedText(n: number): string {
	return n === 1
		? "1 place is on a day that moves to another city. It'll go back to your list to schedule again."
		: `${n} places are on days that move to another city. They'll go back to your list to schedule again.`;
}
