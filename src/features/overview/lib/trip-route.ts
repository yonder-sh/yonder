/**
 * docs/OVERVIEW.md: the trip's route at city level, shared by the Overview
 * (globe, route strip, stats) and the share cards (route list, globe or flat
 * map). Pure: a `GraphIndex` in, plain data out, so it runs on the client and
 * in the server-side card render alike.
 *
 * - **Stays**: runs of consecutive nights in one city. A night's city is the
 *   stay node's nearest `city` ancestor-or-self, else `region` (Mt. Fuji),
 *   else `area`, else the node itself.
 * - **Nights with no place** (`nightPlaces`, owner 2026-10-07: the night
 *   decides) stay unknown. One spent on a ground leg (a night train or bus)
 *   counts toward a country when the stays on both sides are in it
 *   (`transitNights` on the stay after it). Red-eye flights and unplaced
 *   nights don't.
 * - **Rows** (share card list): consecutive stays in one country; going back
 *   to a country is a new row.
 * - **Hops** (the Overview's globe): every change of city between consecutive
 *   located items, in trip order, with the leg's mode (flights are arcs,
 *   the rest ground lines) and the day it arrives.
 * - **Colours**: `ROUTE_PALETTE` in order of first appearance among the stays
 *   (Japan coral, Korea sky, Vietnam amber, Taiwan mint, …).
 * - **View**: the globe when every stay is within `GLOBE_MAX_SPREAD_DEG` of the
 *   best centre (only stays count: flights from and back home may run over
 *   the horizon), else a flat Equal Earth map whose edge falls in the widest
 *   gap between the stays' longitudes.
 */
import { nightPlaces } from "@/lib/engine/day-place";
import { haversineKm, type LngLat } from "@/lib/engine/geo";
import { type GraphIndex, pairKey } from "@/lib/engine/graph-index";
import type { EdgeMode, GraphLeg, GraphNode } from "@/lib/engine/types";
import { heaviestMode } from "@/lib/engine/visits";

/** Country accents on dark, in order of first appearance. */
export const ROUTE_PALETTE = [
	"#ff7a6b",
	"#6fb4ff",
	"#f5c046",
	"#56d6a8",
	"#b69cff",
	"#ff8fc7",
	"#b5e05a",
	"#4fd6e0",
	"#ffa05a",
	"#8f9bff",
] as const;
/** Home, transit stops and anything outside a stay. */
export const ROUTE_NEUTRAL = "#a3a3a3";
export const GLOBE_MAX_SPREAD_DEG = 60;

export interface RoutePlace {
	/** The city (or region/area) node. */
	id: string;
	name: string;
	/** ISO code, else the country node's id, else `"?"`: the colour key. */
	countryKey: string;
	countryCode: string | null;
	countryName: string | null;
	coord: LngLat | null;
}

export interface RouteStay extends RoutePlace {
	/** The first night's day. */
	firstDayId: string;
	firstDate: string;
	lastDate: string;
	nights: number;
	/** Stay-less nights just before it, in the same country (night trains). */
	transitNights: number;
	/** How you got here from the previous stay (or from the start). */
	modeIn: EdgeMode;
	color: string;
}

export interface RouteRow {
	countryKey: string;
	countryCode: string | null;
	countryName: string;
	color: string;
	/** Stay nights plus night trains inside the country. */
	nights: number;
	/** City names in visit order, each once. */
	cities: string[];
	modeIn: EdgeMode;
	stayIndexes: number[];
}

/** One city-to-city move along the trip (the globe draws them in order). */
export interface RouteHop {
	from: RoutePlace;
	to: RoutePlace;
	/** The leg's mode between the two items (`unset` without one). */
	mode: EdgeMode;
	/** The arriving item's day. */
	date: string;
}

export interface RouteStats {
	days: number;
	countries: number;
	cities: number;
	/** Great-circle between consecutive located items (×1.2 when not flown), at least the route's cities apart. */
	km: number;
	flights: number;
	/** Timed flights by their times, others ≈ distance / 800 km/h + 30 min. */
	airHours: number;
	/** Scheduled places, not counting lodging, airports, stations and ports. */
	placesPlanned: number;
}

export type RouteView =
	| { kind: "globe"; center: LngLat; spreadDeg: number }
	| { kind: "flat"; centerLng: number; spreadDeg: number };

export interface TripRoute {
	/** Where the trip starts: a stop before the first night (New York), else the first stay; null for an empty trip. */
	start: RoutePlace | null;
	/** Where it ends: a stop after the last night (Newark), else the last stay. */
	end: RoutePlace | null;
	/** The end is in the start's country: "Home" rather than "To <end>". */
	endsHome: boolean;
	/** Cities inside the flight chain that ends the trip (Istanbul). */
	via: string[];
	/** The same cities as places (the share card's map draws the way home through them). */
	viaPlaces: RoutePlace[];
	/** How you get from the last stay to the end. */
	modeOut: EdgeMode;
	stays: RouteStay[];
	rows: RouteRow[];
	/** City changes in trip order (only between located cities). */
	hops: RouteHop[];
	/** `countryKey` → accent. */
	colors: Record<string, string>;
	stats: RouteStats;
	view: RouteView;
}

/** Short labels for long official names (the share card's route list). */
const SHORT_COUNTRY: Record<string, string> = {
	KR: "Korea",
	KP: "North Korea",
	AE: "UAE",
	US: "USA",
	GB: "UK",
	CZ: "Czechia",
	DO: "Dominican Rep.",
	BA: "Bosnia",
	CF: "Central African Rep.",
	CD: "DR Congo",
	VA: "Vatican",
};
export const countryLabel = (
	row: Pick<RouteRow, "countryCode" | "countryName">,
): string =>
	(row.countryCode && SHORT_COUNTRY[row.countryCode]) || row.countryName;

const REP_TYPES = ["city", "region", "area"] as const;
const HOME_RADIUS_KM = 150;
const NOT_PLANNED = new Set(["lodging", "airport", "station", "port"]);

/** A node's city: nearest `city` ancestor-or-self, else `region`, else `area`, else itself. */
export function cityOf(ix: GraphIndex, nodeId: string): RoutePlace | null {
	const path = ix.path(nodeId);
	let rep: GraphNode | undefined;
	for (const t of REP_TYPES) {
		rep = path.findLast((n) => n.type === t);
		if (rep) break;
	}
	rep ??= path.at(-1);
	if (!rep) return null;
	const country = path.find((n) => n.type === "country") ?? null;
	return {
		id: rep.id,
		name: rep.name,
		countryKey: country?.countryCode ?? country?.id ?? "?",
		countryCode: country?.countryCode ?? null,
		countryName: country?.name ?? null,
		coord: ix.coordOf(rep.id),
	};
}

/** A stay as a plain place (no nights or colour). */
function placeOfStay(s: RouteStay): RoutePlace {
	const { id, name, countryKey, countryCode, countryName, coord } = s;
	return { id, name, countryKey, countryCode, countryName, coord };
}

function legOfPair(ix: GraphIndex, from: string, to: string): GraphLeg | null {
	return ix.legByPair.get(pairKey(from, to)) ?? null;
}

/** Heaviest mode among the city-changing pairs whose arriving item is on a day in `[fromDate, toDate]`. */
function travelMode(
	ix: GraphIndex,
	fromDate: string,
	toDate: string,
): EdgeMode {
	const legs: (GraphLeg | null)[] = [];
	for (const p of ix.pairs) {
		const a = ix.item(p.fromItemId);
		const b = ix.item(p.toItemId);
		const day = ix.day(b?.dayId);
		if (!a?.nodeId || !b?.nodeId || !day) continue;
		if (day.date < fromDate || day.date > toDate) continue;
		if (cityOf(ix, a.nodeId)?.id === cityOf(ix, b.nodeId)?.id) continue;
		legs.push(legOfPair(ix, p.fromItemId, p.toItemId));
	}
	return heaviestMode(legs);
}

const RAD = Math.PI / 180;
const arcDeg = (a: LngLat, b: LngLat) => haversineKm(a, b) / 6371 / RAD;

/** Globe or flat map for these points (docs/OVERVIEW.md §Sharing). */
export function routeView(points: readonly LngLat[]): RouteView {
	if (!points.length) return { kind: "globe", center: [0, 20], spreadDeg: 0 };
	let best = { m: Infinity, lng: 0, lat: 0 };
	for (let lat = -60; lat <= 60; lat += 4)
		for (let lng = -180; lng < 180; lng += 4) {
			let m = 0;
			for (const p of points) m = Math.max(m, arcDeg([lng, lat], p));
			if (m < best.m) best = { m, lng, lat };
		}
	const spreadDeg = Math.round(best.m);
	if (best.m <= GLOBE_MAX_SPREAD_DEG)
		return { kind: "globe", center: [best.lng, best.lat], spreadDeg };
	// The map's edge goes in the widest gap between the stays' longitudes.
	const lngs = points
		.map((p) => ((p[0] % 360) + 360) % 360)
		.sort((a, b) => a - b);
	let gap = -1;
	let seam = 180;
	lngs.forEach((l, i) => {
		const next = lngs[i + 1] ?? (lngs[0] ?? l) + 360;
		if (next - l > gap) {
			gap = next - l;
			seam = l + gap / 2;
		}
	});
	const centerLng = ((((seam - 180) % 360) + 540) % 360) - 180;
	return { kind: "flat", centerLng, spreadDeg };
}

/** A night spent on a ground leg (night train or bus) leaving that day. */
function groundNight(ix: GraphIndex, dayId: string): boolean {
	return ix.pairs.some((p) => {
		if (!p.crossDay || ix.item(p.fromItemId)?.dayId !== dayId) return false;
		const mode = ix.legByPair.get(p.key)?.mode;
		return !!mode && mode !== "flight";
	});
}

export function tripRoute(ix: GraphIndex): TripRoute {
	// ---- stays --------------------------------------------------------------
	const stays: RouteStay[] = [];
	const nights = nightPlaces(ix);
	let pendingNull = 0;
	let pendingGround = 0;
	ix.days.forEach((day, i) => {
		const placeId = nights[i];
		const city = placeId ? cityOf(ix, placeId) : null;
		if (!city) {
			if (stays.length) {
				pendingNull++;
				if (groundNight(ix, day.id)) pendingGround++;
			}
			return;
		}
		const last = stays.at(-1);
		if (last && last.id === city.id && pendingNull === 0) {
			last.nights++;
			last.lastDate = day.date;
			return;
		}
		const sameCountry = !!last && last.countryKey === city.countryKey;
		stays.push({
			...city,
			firstDayId: day.id,
			firstDate: day.date,
			lastDate: day.date,
			nights: 1,
			transitNights: sameCountry ? pendingGround : 0,
			modeIn: "unset",
			color: ROUTE_NEUTRAL,
		});
		pendingNull = 0;
		pendingGround = 0;
	});

	// ---- colours ------------------------------------------------------------
	// By the stays' countries; a trip with no stays yet (just a flight) goes by
	// the cities it visits instead, so its route isn't all grey.
	const visited: RoutePlace[] = [];
	for (const it of ix.located) {
		const c = it.nodeId ? cityOf(ix, it.nodeId) : null;
		if (c && !visited.some((v) => v.id === c.id)) visited.push(c);
	}
	const basis: RoutePlace[] = stays.length ? stays : visited;
	// The stats count where you sleep, and the cities you spend time in
	// (a stop that isn't an airport or a station), each once.
	const spent = new Set<string>();
	for (const it of ix.located) {
		const n = it.nodeId ? ix.node(it.nodeId) : null;
		if (!n || n.category === "airport" || n.category === "station") continue;
		const c = cityOf(ix, n.id);
		if (c) spent.add(c.id);
	}
	// Just a flight so far: the cities it touches.
	const counted =
		stays.length || spent.size
			? [...stays, ...visited.filter((v) => spent.has(v.id))]
			: visited;
	const colors: Record<string, string> = {};
	for (const s of basis)
		if (!(s.countryKey in colors))
			colors[s.countryKey] =
				ROUTE_PALETTE[Object.keys(colors).length % ROUTE_PALETTE.length] ??
				ROUTE_NEUTRAL;
	for (const s of stays) s.color = colors[s.countryKey] ?? ROUTE_NEUTRAL;

	// ---- modes: travel days are the day after the previous stay's last night
	// through this stay's first night.
	const firstDate = ix.days[0]?.date ?? "";
	const lastDate = ix.days.at(-1)?.date ?? "";
	const dayAfter = (date: string) => {
		const i = ix.dayIndex.get(date);
		return i === undefined ? date : (ix.days[i + 1]?.date ?? date);
	};
	stays.forEach((s, i) => {
		const prev = stays[i - 1];
		const from = prev ? dayAfter(prev.lastDate) : firstDate;
		s.modeIn = travelMode(ix, from, s.firstDate);
	});
	const lastStay = stays.at(-1);
	const modeOut = lastStay
		? travelMode(ix, dayAfter(lastStay.lastDate), lastDate)
		: "unset";

	// ---- rows ---------------------------------------------------------------
	const rows: RouteRow[] = [];
	stays.forEach((s, i) => {
		const last = rows.at(-1);
		if (last && last.countryKey === s.countryKey) {
			last.nights += s.nights + s.transitNights;
			if (!last.cities.includes(s.name)) last.cities.push(s.name);
			last.stayIndexes.push(i);
			return;
		}
		rows.push({
			countryKey: s.countryKey,
			countryCode: s.countryCode,
			countryName: s.countryName ?? s.name,
			color: s.color,
			nights: s.nights + s.transitNights,
			cities: [s.name],
			modeIn: s.modeIn,
			stayIndexes: [i],
		});
	});

	// ---- start, end, via ----------------------------------------------------
	// The route's ends are its nights; a stop before the first night (the
	// flight out) or after the last one (the way home) goes beyond them.
	const located = ix.located;
	const dayAt = (dayId: string | null) =>
		ix.days.findIndex((d) => d.id === dayId);
	const firstNight = nights.findIndex(Boolean);
	const lastNight = nights.findLastIndex(Boolean);
	const firstIt = located[0];
	const lastIt = located.at(-1);
	const startOut =
		!!firstIt?.nodeId && (!stays.length || dayAt(firstIt.dayId) <= firstNight);
	const endOut =
		!!lastIt?.nodeId && (!stays.length || dayAt(lastIt.dayId) > lastNight);
	const firstStay = stays[0] ?? null;
	const start =
		startOut && firstIt?.nodeId
			? cityOf(ix, firstIt.nodeId)
			: firstStay && placeOfStay(firstStay);
	const end =
		endOut && lastIt?.nodeId
			? cityOf(ix, lastIt.nodeId)
			: lastStay
				? placeOfStay(lastStay)
				: null;
	// Home: back in the start's city or near it (out of JFK, back into EWR),
	// not merely the same country (Philadelphia → San Francisco isn't home).
	const endsHome =
		!!start &&
		!!end &&
		(start.id === end.id ||
			(!!start.coord &&
				!!end.coord &&
				haversineKm(start.coord, end.coord) <= HOME_RADIUS_KM));
	// The way home: the cities strictly inside the flight chain that ends the
	// trip (TPE → IST → EWR: Istanbul), never every city after the last stay
	// (a trip with few nights set would list half of it).
	const viaPlaces: RoutePlace[] = [];
	const homeChain = endOut && lastIt ? (ix.blockOf(lastIt.id) ?? []) : [];
	for (const id of homeChain.slice(1, -1)) {
		const nodeId = ix.item(id)?.nodeId;
		const c = nodeId ? cityOf(ix, nodeId) : null;
		if (
			c &&
			c.id !== end?.id &&
			c.id !== lastStay?.id &&
			!viaPlaces.some((v) => v.id === c.id || v.name === c.name)
		)
			viaPlaces.push(c);
	}

	// ---- hops ---------------------------------------------------------------
	const hops: RouteHop[] = [];
	let prevItem: (typeof located)[number] | null = null;
	let prevCity: RoutePlace | null = null;
	for (const it of located) {
		const city = it.nodeId ? cityOf(ix, it.nodeId) : null;
		if (city?.coord) {
			if (prevItem && prevCity && prevCity.id !== city.id)
				hops.push({
					from: prevCity,
					to: city,
					// The pair arriving here (consecutive located items).
					mode: legOfPair(ix, prevItem.id, it.id)?.mode ?? "unset",
					date: ix.day(it.dayId)?.date ?? "",
				});
			prevCity = city;
		}
		prevItem = it;
	}

	// ---- stats --------------------------------------------------------------
	let km = 0;
	let flights = 0;
	let airHours = 0;
	for (let i = 1; i < located.length; i++) {
		const prev = located[i - 1];
		const cur = located[i];
		if (!prev || !cur || prev.nodeId === cur.nodeId) continue;
		const a = ix.coordOf(prev.nodeId);
		const b = ix.coordOf(cur.nodeId);
		if (!a || !b) continue;
		const d = haversineKm(a, b);
		const leg = legOfPair(ix, prev.id, cur.id);
		if (leg?.mode === "flight") {
			flights++;
			km += d;
			airHours +=
				leg.depAt && leg.arrAt
					? (Date.parse(leg.arrAt) - Date.parse(leg.depAt)) / 3_600_000
					: d / 800 + 0.5;
		} else km += d * 1.2;
	}
	// Before the stops are planned, the way between the route's cities.
	const ends = [start, ...stays, end].filter(
		(p, i, all): p is RoutePlace => !!p && p.id !== all[i - 1]?.id,
	);
	let routeKm = 0;
	for (let i = 1; i < ends.length; i++) {
		const a = ends[i - 1]?.coord;
		const b = ends[i]?.coord;
		if (a && b) routeKm += haversineKm(a, b);
	}
	km = Math.max(km, routeKm);
	let placesPlanned = 0;
	for (const id of ix.scheduledNodeIds) {
		const n = ix.node(id);
		if (n?.type === "place" && !NOT_PLANNED.has(n.category ?? ""))
			placesPlanned++;
	}

	return {
		start,
		end,
		endsHome,
		via: viaPlaces.map((v) => v.name),
		viaPlaces,
		modeOut,
		stays,
		rows,
		hops,
		colors,
		stats: {
			days: ix.days.length,
			countries: new Set(counted.map((s) => s.countryKey)).size,
			cities: new Set(counted.map((s) => s.id)).size,
			km: Math.round(km / 10) * 10,
			flights,
			airHours: Math.round(airHours),
			placesPlanned,
		},
		view: routeView(basis.flatMap((s) => (s.coord ? [s.coord] : []))),
	};
}
