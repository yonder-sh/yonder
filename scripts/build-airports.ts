/**
 * `pnpm airports` (SPEC §14.5): minifies the checked-in
 * `seed/airports/airports.json` (4,568 OurAirports large and medium airports,
 * public domain; zones from timezone-boundary-builder, ODbL — see its README)
 * into `src/data/airports.json`: `{ iata, name, city, country, lat, lng, tz }`,
 * sorted by IATA. The server looks zones and coordinates up here
 * (`airportByIata`); the flight form lazy-loads it for the combobox.
 */
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

type SeedAirport = {
	iata: string;
	icao: string | null;
	name: string;
	city: string | null;
	country: string;
	lat: number;
	lng: number;
	tz: string;
};

const ROOT = process.cwd();
const src = path.join(ROOT, "seed/airports/airports.json");
const out = path.join(ROOT, "src/data/airports.json");

const rows = JSON.parse(readFileSync(src, "utf8")) as SeedAirport[];
const seen = new Set<string>();
const airports = rows
	.filter(
		(a) =>
			/^[A-Z]{3}$/.test(a.iata) &&
			a.tz &&
			!seen.has(a.iata) &&
			seen.add(a.iata),
	)
	.sort((a, b) => (a.iata < b.iata ? -1 : a.iata > b.iata ? 1 : 0))
	.map((a) => ({
		iata: a.iata,
		name: a.name,
		city: a.city ?? a.name,
		country: a.country,
		lat: Math.round(a.lat * 1e5) / 1e5,
		lng: Math.round(a.lng * 1e5) / 1e5,
		tz: a.tz,
	}));
writeFileSync(out, `${JSON.stringify(airports)}\n`);
console.log(`${airports.length} airports → ${path.relative(ROOT, out)}`);
