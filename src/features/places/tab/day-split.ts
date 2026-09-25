/**
 * The day split (the Schedule step while no trip day has a city): how many
 * of the trip's days each city with places gets, from the time its
 * shortlist needs, in the order with the least travel. Afterwards: the split
 * the days hold now (runs of nights in one city), a changed split laid out
 * on the days, and what applying it writes (the nights) and moves off a day
 * (places on a day that changes city). Pure.
 */
import { defaultItemDuration } from "@/lib/domain/taxonomy";
import { haversineKm, type LngLat } from "@/lib/engine/geo";
import type { GraphIndex } from "@/lib/engine/graph-index";
import type { GraphItem, GraphMember } from "@/lib/engine/types";
import type { CityDaysTable } from "../lib/days";
import { isRateable } from "../lib/rate";
import type { PlaceRow } from "./model";
import { cityRowOf, sightDays } from "./schedule-next";
import { compareByScore } from "./score";

// ---------------------------------------------------------------------------
// Cities and what their shortlist needs
// ---------------------------------------------------------------------------

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
		c.shortlistIds = (short.get(c.id) ?? [])
			.sort(compareByScore)
			.map((r) => r.id);
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

// ---------------------------------------------------------------------------
// Order: the least travel between cities
// ---------------------------------------------------------------------------

type Point = { id: string; at: LngLat | null };

/**
 * The visiting order with the least travel: nearest neighbour from the
 * start, then 2-opt on the open path (the start stays first). Points without
 * coordinates go last, in the order given.
 */
export function routeOrder(
	points: readonly Point[],
	startId: string | null,
): string[] {
	const located = points.filter((p): p is Point & { at: LngLat } => !!p.at);
	const rest = points.filter((p) => !p.at).map((p) => p.id);
	if (!located.length) return rest;
	const start = located.find((p) => p.id === startId) ?? located[0];
	const path = [start as Point & { at: LngLat }];
	const todo = located.filter((p) => p !== start);
	while (todo.length) {
		const last = path.at(-1)?.at as LngLat;
		let best = 0;
		for (let i = 1; i < todo.length; i++)
			if (
				haversineKm(last, (todo[i] as Point & { at: LngLat }).at) <
				haversineKm(last, (todo[best] as Point & { at: LngLat }).at)
			)
				best = i;
		path.push(todo.splice(best, 1)[0] as Point & { at: LngLat });
	}
	const d = (a: number, b: number) =>
		b >= path.length
			? 0
			: haversineKm(
					(path[a] as Point & { at: LngLat }).at,
					(path[b] as Point & { at: LngLat }).at,
				);
	for (let improved = true, rounds = 0; improved && rounds < 50; rounds++) {
		improved = false;
		for (let i = 1; i < path.length - 1; i++)
			for (let j = i + 1; j < path.length; j++) {
				const delta = d(i - 1, j) + d(i, j + 1) - d(i - 1, i) - d(j, j + 1);
				if (delta < -1e-9) {
					path.splice(i, j - i + 1, ...path.slice(i, j + 1).reverse());
					improved = true;
				}
			}
	}
	return [...path.map((p) => p.id), ...rest];
}

/**
 * Where the trip starts: the city of its first located item (where a first
 * flight lands) when it's one of `cities`, else the one nearest to it. Null
 * when nothing is located.
 */
export function arrivalCity(
	ix: Pick<GraphIndex, "located" | "blockOf" | "item" | "isWithin" | "coordOf">,
	cities: readonly Point[],
): string | null {
	const first = ix.located[0];
	if (!first) return null;
	const landed = ix.blockOf(first.id)?.at(-1) ?? first.id;
	const nodeId = ix.item(landed)?.nodeId ?? first.nodeId;
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

// ---------------------------------------------------------------------------
// The suggestion, and − / + on it
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
 * trip, ordered by the least travel from the arrival city (else from the
 * city with the most days). Cities with no days follow, nearest first.
 */
export function suggestSplit(
	ix: Parameters<typeof arrivalCity>[0],
	cities: readonly SplitCity[],
	tripDays: number,
): DaySplit {
	const base = [...cities].sort(
		(a, b) =>
			b.need - a.need ||
			b.shortlisted - a.shortlisted ||
			a.name.localeCompare(b.name),
	);
	const fitted = fitDays(
		base.map((c) => c.need),
		tripDays,
	);
	const rows: SplitRow[] = base.map((c, i) => ({ ...c, days: fitted[i] ?? 0 }));
	const on = rows
		.filter((r) => r.days > 0)
		.sort((a, b) => b.days - a.days || rows.indexOf(a) - rows.indexOf(b));
	const off = rows.filter((r) => r.days === 0);
	const start = arrivalCity(ix, on) ?? on[0]?.id ?? null;
	const route = routeOrder(on, start);
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
export function stepEntry(
	entries: readonly SplitEntry[],
	index: number,
	delta: 1 | -1,
	tripDays: number,
): SplitEntry[] | null {
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

/** "Tokyo 4 · Kyoto 3 · Osaka 2". */
export function splitText(
	entries: readonly SplitEntry[],
	nameOf: (id: string) => string,
): string {
	return entries
		.filter((e) => e.days > 0)
		.map((e) => `${nameOf(e.cityId)} ${e.days}`)
		.join(" · ");
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

/** "4 days not used". */
export function unusedText(unused: number): string {
	return `${plural(unused, "day")} not used`;
}

/** "3 places are on days that move to another city. They'll go back to your list to schedule again." */
export function displacedText(n: number): string {
	return n === 1
		? "1 place is on a day that moves to another city. It'll go back to your list to schedule again."
		: `${n} places are on days that move to another city. They'll go back to your list to schedule again.`;
}
