/**
 * Airports by IATA (SPEC §14.5, D14): the server REPLACES a flight's airport
 * zone and coordinates from `src/data/airports.json` (built by
 * `pnpm airports`), so a client can never plant a wrong zone.
 */
import airportsData from "@/data/airports.json";

export type AirportRecord = {
	iata: string;
	name: string;
	city: string;
	country: string;
	lat: number;
	lng: number;
	tz: string;
};

let byIata: Map<string, AirportRecord> | undefined;

export function airportByIata(
	iata: string | null | undefined,
): AirportRecord | null {
	if (!iata) return null;
	byIata ??= new Map((airportsData as AirportRecord[]).map((a) => [a.iata, a]));
	return byIata.get(iata.trim().toUpperCase()) ?? null;
}

/** Every airport of the table (FB-19's nearest-airport search). */
export function allAirports(): readonly AirportRecord[] {
	return airportsData as AirportRecord[];
}
