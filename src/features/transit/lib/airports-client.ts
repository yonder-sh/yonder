/**
 * The airport and airline tables for the flight form (SPEC §14.5): lazy
 * chunks (`import('@/data/airports.json')`), searched like cmdk ranks —
 * exact IATA, then IATA prefix, then city, then name.
 */
import {
	AIRPORT_MATCH_KM,
	airportNameScore,
	looksLikeAirportNode,
	nodeIata,
} from "@/lib/engine/flights";
import { haversineKm } from "@/lib/engine/geo";
import { tzLabel } from "@/lib/engine/time";

export type AirportRow = {
	iata: string;
	name: string;
	city: string;
	country: string;
	lat: number;
	lng: number;
	tz: string;
};

export type AirlineRow = { iata: string; icao: string; name: string };

let airports:
	| Promise<{ list: AirportRow[]; byIata: Map<string, AirportRow> }>
	| undefined;
let airlines: Promise<AirlineRow[]> | undefined;

export function loadAirports() {
	airports ??= import("@/data/airports.json").then((m) => {
		const list = (m.default ?? m) as unknown as AirportRow[];
		return { list, byIata: new Map(list.map((a) => [a.iata, a])) };
	});
	return airports;
}

export function loadAirlines(): Promise<AirlineRow[]> {
	airlines ??= import("@/data/airlines.json").then(
		(m) => (m.default ?? m) as unknown as AirlineRow[],
	);
	return airlines;
}

const fold = (s: string) =>
	s.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();

export async function searchAirports(
	q: string,
	limit = 8,
): Promise<AirportRow[]> {
	const { list } = await loadAirports();
	const needle = fold(q.trim());
	if (!needle) return [];
	const upper = q.trim().toUpperCase();
	const scored: { a: AirportRow; s: number }[] = [];
	for (const a of list) {
		let s = -1;
		if (a.iata === upper) s = 100;
		else if (upper.length <= 3 && a.iata.startsWith(upper)) s = 60;
		else {
			const city = fold(a.city);
			const name = fold(a.name);
			if (city.startsWith(needle)) s = 40;
			else if (name.startsWith(needle)) s = 30;
			else if (
				needle.length >= 3 &&
				(city.includes(needle) || name.includes(needle))
			)
				s = 10;
		}
		if (s >= 0) scored.push({ a, s });
	}
	scored.sort((x, y) => y.s - x.s || x.a.iata.localeCompare(y.a.iata));
	return scored.slice(0, limit).map((x) => x.a);
}

export async function searchAirlines(
	q: string,
	limit = 8,
): Promise<AirlineRow[]> {
	const list = await loadAirlines();
	const needle = fold(q.trim());
	if (!needle) return [];
	const upper = q.trim().toUpperCase();
	const scored: { a: AirlineRow; s: number }[] = [];
	for (const a of list) {
		let s = -1;
		if (a.iata === upper || a.icao === upper) s = 100;
		else if (upper.length <= 2 && a.iata.startsWith(upper)) s = 60;
		else {
			const name = fold(a.name);
			if (name.startsWith(needle)) s = 40;
			else if (needle.length >= 3 && name.includes(needle)) s = 10;
		}
		if (s >= 0) scored.push({ a, s });
	}
	scored.sort((x, y) => y.s - x.s || x.a.name.localeCompare(y.a.name));
	return scored.slice(0, limit).map((x) => x.a);
}

/**
 * "HND · Tokyo Haneda International Airport · JST". `at` is required
 * (FB-20): the zone label at the flight's own time (EST for a December JFK
 * departure, EDT in September).
 */
export function airportLabel(a: AirportRow, at: number | Date): string {
	return `${a.iata} · ${a.name} · ${tzLabel(a.tz, at)}`;
}

/**
 * The airport a node stands for (FB-19, the form's defaults): its IATA code,
 * else the best-named airport within 5 km of it — the same rule the server
 * uses for the default flight.
 */
export async function airportForNode(
	node: Parameters<typeof airportNameScore>[0] & {
		lat?: number | null;
		lng?: number | null;
	},
	coord: [lng: number, lat: number] | null,
): Promise<AirportRow | null> {
	const { list, byIata } = await loadAirports();
	const own = nodeIata(node);
	if (own) return byIata.get(own) ?? null;
	if (!coord || !looksLikeAirportNode(node)) return null;
	let best: { a: AirportRow; score: number; km: number } | null = null;
	for (const a of list) {
		if (Math.abs(a.lat - coord[1]) > 0.1) continue;
		const km = haversineKm(coord, [a.lng, a.lat]);
		if (km > AIRPORT_MATCH_KM) continue;
		const score = airportNameScore(node, a);
		if (!best || score > best.score || (score === best.score && km < best.km))
			best = { a, score, km };
	}
	return best?.a ?? null;
}
