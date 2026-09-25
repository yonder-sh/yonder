/**
 * Flight rules shared by the schedule, the Plan, the leg editor and the
 * server (FEEDBACK-3 FB-18, FB-19, FB-19a). Pure: plain data in and out.
 *
 * - A flight needs only its airports and its dates; the number and both times
 *   are optional. Without an arrival time its length is estimated from the
 *   great-circle distance (cruise ~800 km/h plus ~30 min taxi and climb,
 *   rounded to 5 min) and labelled "est.".
 * - Airport stops: an item whose node IS the departure (arrival) airport of
 *   the flight next to it is the time at the airport (flights have no
 *   built-in buffers; an unpinned departure stop ends at boarding). The node is matched by IATA,
 *   else by coordinates (within 5 km) plus a name or category that says
 *   "airport": places and areas alike.
 * - Auto flights (FB-19): the default Flight leg between two adjacent airport
 *   items is a real leg row that nobody chose: `mode: 'flight'`,
 *   `source: 'estimate'`, `isEdited: false`. It follows the items until a
 *   person edits or switches it.
 */
import type { FlightDetails } from "@/lib/schemas/legs";
import { haversineKm, type LngLat } from "./geo";
import { addDays, localDateTimeToEpoch, MS_PER_MINUTE } from "./time";
import type { GraphLeg, GraphNode } from "./types";

/** Cruise speed of the estimate. */
export const FLIGHT_CRUISE_KMH = 800;
/** Taxi, climb and descent on top of the cruise. */
export const FLIGHT_OVERHEAD_MIN = 30;
/** A node this close to an airport, named like one, is that airport. */
export const AIRPORT_MATCH_KM = 5;
/**
 * Two airports closer than this are a ground transfer (NRT → HND, EWR → JFK),
 * never a default flight (FB-19).
 */
export const AUTO_FLIGHT_MIN_KM = 150;

/** Great-circle minutes: km ÷ 800 km/h + 30 min, rounded to 5 min (FB-18). */
export function flightEstimateMin(km: number): number {
	const raw = (Math.max(0, km) / FLIGHT_CRUISE_KMH) * 60 + FLIGHT_OVERHEAD_MIN;
	return Math.max(5, Math.round(raw / 5) * 5);
}

type Point = { lat: number; lng: number };

/** The estimate between two airports (or any two points). */
export function flightEstimateBetween(a: Point, b: Point): number {
	return flightEstimateMin(haversineKm([a.lng, a.lat], [b.lng, b.lat]));
}

export type FlightLike = Pick<
	FlightDetails,
	| "from"
	| "to"
	| "depLocal"
	| "arrLocal"
	| "depDate"
	| "arrDate"
	| "depFold"
	| "arrFold"
>;

/** The local departure date: from `depLocal`, else `depDate`. */
export function flightDepDate(
	f: Pick<FlightDetails, "depLocal" | "depDate">,
): string | null {
	return f.depLocal?.slice(0, 10) ?? f.depDate ?? null;
}

/** The local arrival date: from `arrLocal`, else `arrDate`. */
export function flightArrDate(
	f: Pick<FlightDetails, "arrLocal" | "arrDate">,
): string | null {
	return f.arrLocal?.slice(0, 10) ?? f.arrDate ?? null;
}

/** Local "HH:mm" of the departure, or null while it's unknown. */
export const flightDepTime = (f: Pick<FlightDetails, "depLocal">) =>
	f.depLocal?.slice(11) ?? null;
/** Local "HH:mm" of the arrival, or null while it's unknown. */
export const flightArrTime = (f: Pick<FlightDetails, "arrLocal">) =>
	f.arrLocal?.slice(11) ?? null;

export interface FlightTimes {
	/** Departure instant, null without a departure time. */
	depMs: number | null;
	/** Arrival instant: the given one, or departure + estimate; null when untimed. */
	arrMs: number | null;
	/** The flight's own minutes (the ticket's "14h"), or the estimate. */
	minutes: number;
	/** `minutes` (and so `arrMs`) is the great-circle estimate. */
	estimate: boolean;
	/** Only a departure time is known: the arrival is dep + estimate. */
	arrEstimated: boolean;
	/** Neither time is known. */
	untimed: boolean;
}

/**
 * The instants and length of a flight, whatever it knows (FB-18): both
 * times, only the departure (arrival = dep + estimate), or neither (the
 * estimate alone). A bad pair (arrival not after departure) counts as the
 * estimate too.
 */
export function flightTimes(f: FlightLike): FlightTimes {
	const est = flightEstimateBetween(f.from, f.to);
	const dep = f.depLocal
		? localDateTimeToEpoch(f.depLocal, f.from.tz, f.depFold)
		: null;
	const arr = f.arrLocal
		? localDateTimeToEpoch(f.arrLocal, f.to.tz, f.arrFold)
		: null;
	if (dep !== null && arr !== null && arr > dep)
		return {
			depMs: dep,
			arrMs: arr,
			minutes: Math.round((arr - dep) / MS_PER_MINUTE),
			estimate: false,
			arrEstimated: false,
			untimed: false,
		};
	if (dep !== null)
		return {
			depMs: dep,
			arrMs: dep + est * MS_PER_MINUTE,
			minutes: est,
			estimate: true,
			arrEstimated: true,
			untimed: false,
		};
	return {
		depMs: null,
		arrMs: null,
		minutes: est,
		estimate: true,
		arrEstimated: false,
		untimed: true,
	};
}

/** A flight's own minutes, departure to arrival, when both times are known. */
export function flightOwnMinutes(f: FlightLike): number | null {
	const t = flightTimes(f);
	return t.estimate ? null : t.minutes;
}

const shiftDate = (date: string | undefined, days: number) =>
	date ? addDays(date, days) : undefined;
const shiftLocal = (local: string | undefined, days: number) =>
	local ? `${addDays(local.slice(0, 10), days)}${local.slice(10)}` : undefined;

/** The flight moved by `days`: local times and dates keep their wall clock. */
export function shiftFlight<F extends FlightLike>(f: F, days: number): F {
	const out: F = { ...f };
	const depLocal = shiftLocal(f.depLocal, days);
	const arrLocal = shiftLocal(f.arrLocal, days);
	const depDate = shiftDate(f.depDate, days);
	const arrDate = shiftDate(f.arrDate, days);
	if (depLocal) out.depLocal = depLocal;
	if (arrLocal) out.arrLocal = arrLocal;
	if (depDate) out.depDate = depDate;
	if (arrDate) out.arrDate = arrDate;
	return out;
}

/**
 * The default Flight leg nobody chose (FB-19): a flight row the server wrote
 * between two adjacent airports. A person's edit (saving the flight form,
 * switching the mode) makes it theirs.
 */
export function isAutoFlight(
	leg: Pick<GraphLeg, "mode" | "isEdited" | "source"> | null | undefined,
): boolean {
	return (
		!!leg && leg.mode === "flight" && !leg.isEdited && leg.source === "estimate"
	);
}

// ---------------------------------------------------------------------------
// Airport detection
// ---------------------------------------------------------------------------

const AIRPORT_WORDS =
	/\b(airport|airfield|aerodrome|aeroporto|aeropuerto|aéroport|aeroport|flughafen|lufthavn|flygplats|luchthaven|lotnisko|havalimanı|havalimani|san bay|sân bay)\b|空港|机场|機場|공항/iu;
const NOT_AIRPORT_WORDS =
	/\b(hotel|hostel|inn|motel|lodge|ryokan|station|parking|car park|lounge|restaurant|café|cafe|bar|shuttle|rail link)\b|ホテル|駅/iu;
/** Categories that are never the airport itself (a hotel "at the airport"). */
const NOT_AIRPORT_CATEGORIES: ReadonlySet<string> = new Set([
	"lodging",
	"station",
	"port",
	"restaurant",
	"cafe",
	"bar",
	"food_drink",
	"market",
	"shopping",
	"nightlife",
	"onsen",
	"museum",
	"temple_shrine",
	"park",
	"beach",
	"nature",
	"viewpoint",
	"event",
]);

const fold = (s: string) =>
	s.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase().trim();

type AirportishNode = Pick<GraphNode, "type" | "category" | "name"> & {
	details?: unknown;
};

/** The node's own IATA code (`details.iata`), upper-cased. */
export function nodeIata(node: { details?: unknown } | null | undefined) {
	const iata = (node?.details as { iata?: unknown } | null | undefined)?.iata;
	return typeof iata === "string" && /^[A-Za-z]{3}$/.test(iata)
		? iata.toUpperCase()
		: null;
}

/**
 * A place or area that says it is an airport: an IATA code, the `airport`
 * category, or a name like "Haneda Airport" / "成田空港" (and not "Hilton
 * Airport Hotel" or "Haneda Airport Station").
 */
export function looksLikeAirportNode(node: AirportishNode): boolean {
	if (node.type !== "place" && node.type !== "area") return false;
	if (nodeIata(node)) return true;
	if (node.category === "airport") return true;
	if (node.category && NOT_AIRPORT_CATEGORIES.has(node.category)) return false;
	return AIRPORT_WORDS.test(node.name) && !NOT_AIRPORT_WORDS.test(node.name);
}

/**
 * How well a node's name fits an airport: 2 for an airport-like name or the
 * IATA code as a word ("JFK T4"), 1 for a part of the airport's own name
 * ("Haneda" in "Tokyo Haneda International Airport"), 0 otherwise.
 */
export function airportNameScore(
	node: AirportishNode,
	airport: { iata: string; name: string },
): number {
	if (nodeIata(node) === airport.iata.toUpperCase()) return 3;
	if (looksLikeAirportNode(node)) return 2;
	if (new RegExp(`\\b${airport.iata}\\b`, "i").test(node.name)) return 2;
	const n = fold(node.name);
	if (n.length >= 4 && fold(airport.name).includes(n)) return 1;
	return 0;
}

/**
 * Is this node that airport (FB-19a)? Same IATA code, or within 5 km with a
 * name that fits ("match by coordinates + name", places and areas alike).
 */
export function nodeIsAirport(
	node: AirportishNode | null | undefined,
	coord: LngLat | null,
	airport: { iata: string; name: string; lat: number; lng: number },
): boolean {
	if (!node) return false;
	if (nodeIata(node) === airport.iata.toUpperCase()) return true;
	if (node.type !== "place" && node.type !== "area") return false;
	if (node.category && NOT_AIRPORT_CATEGORIES.has(node.category)) return false;
	if (!coord) return false;
	if (haversineKm(coord, [airport.lng, airport.lat]) > AIRPORT_MATCH_KM)
		return false;
	return airportNameScore(node, airport) > 0;
}
