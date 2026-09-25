/**
 * The default flight between two adjacent airports (FEEDBACK-3 FB-19).
 *
 * An item's node is an airport when it carries an IATA code, or when it is a
 * place or area within 5 km of an airport in `src/data/airports.json` and its
 * name or category says so ("John F. Kennedy International Airport" is a
 * place, "Haneda Airport" an area in the owner's test trip): coordinates plus
 * name, never the node type alone. `reconcileLegs` writes the default
 * (`syncAutoFlights`); the autofill sweep heals trips planned before it.
 */
import {
	AIRPORT_MATCH_KM,
	AUTO_FLIGHT_MIN_KM,
	airportNameScore,
	looksLikeAirportNode,
	nodeIata,
} from "@/lib/engine/flights";
import { haversineKm } from "@/lib/engine/geo";
import type { GraphIndex } from "@/lib/engine/graph-index";
import type { GraphNode } from "@/lib/engine/types";
import type { Airport, FlightDetails, LegDetails } from "@/lib/schemas/legs";
import {
	type AirportRecord,
	airportByIata,
	allAirports,
} from "./airports.server";

/** Degrees of latitude that surely hold 5 km (a cheap prefilter). */
const LAT_WINDOW = 0.1;

/**
 * The airport a node stands for, or null: its IATA code, else the best-named
 * airport within 5 km of it (nearest first among equally named ones).
 */
export function airportOfNode(
	node: GraphNode | undefined,
	coord: [lng: number, lat: number] | null,
): AirportRecord | null {
	if (!node) return null;
	const own = airportByIata(nodeIata(node));
	if (own) return own;
	if (!coord || !looksLikeAirportNode(node)) return null;
	const lat = coord[1];
	let best: { a: AirportRecord; score: number; km: number } | null = null;
	for (const a of allAirports()) {
		if (Math.abs(a.lat - lat) > LAT_WINDOW) continue;
		const km = haversineKm(coord, [a.lng, a.lat]);
		if (km > AIRPORT_MATCH_KM) continue;
		const score = airportNameScore(node, a);
		if (!best || score > best.score || (score === best.score && km < best.km))
			best = { a, score, km };
	}
	return best?.a ?? null;
}

const toAirport = (a: AirportRecord): Airport => ({
	iata: a.iata,
	name: a.name,
	city: a.city,
	country: a.country,
	tz: a.tz,
	lat: a.lat,
	lng: a.lng,
});

/**
 * The default flight for the pair, or null when its items aren't two
 * different airports at least 150 km apart: both airports, the items' days
 * as dates, no times and no number (FB-18).
 */
export function autoFlightFor(
	ix: GraphIndex,
	fromItemId: string,
	toItemId: string,
	cache: Map<string, AirportRecord | null> = new Map(),
): FlightDetails | null {
	const a = ix.item(fromItemId);
	const b = ix.item(toItemId);
	if (!a?.nodeId || !b?.nodeId || a.nodeId === b.nodeId) return null;
	const depDate = ix.day(a.dayId)?.date;
	const arrDate = ix.day(b.dayId)?.date;
	if (!depDate || !arrDate) return null;
	const of = (nodeId: string) => {
		if (!cache.has(nodeId))
			cache.set(nodeId, airportOfNode(ix.node(nodeId), ix.coordOf(nodeId)));
		return cache.get(nodeId) ?? null;
	};
	const from = of(a.nodeId);
	const to = from ? of(b.nodeId) : null;
	if (!from || !to || from.iata === to.iata) return null;
	if (haversineKm([from.lng, from.lat], [to.lng, to.lat]) < AUTO_FLIGHT_MIN_KM)
		return null;
	return {
		from: toAirport(from),
		to: toAirport(to),
		depDate,
		arrDate,
		seats: [],
	};
}

/** The stored default already says this (same airports and dates). */
export function sameAutoFlight(stored: LegDetails, f: FlightDetails): boolean {
	if (stored.kind !== "flight") return false;
	const s = stored.flight;
	return (
		s.from.iata === f.from.iata &&
		s.to.iata === f.to.iata &&
		s.depDate === f.depDate &&
		s.arrDate === f.arrDate &&
		!s.depLocal &&
		!s.arrLocal
	);
}
