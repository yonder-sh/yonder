/**
 * `pnpm airlines` (SPEC §14.5): reads OpenFlights `airlines.dat` (ODbL),
 * keeps active airlines with a two-character IATA code, and writes
 * `src/data/airlines.json` (`{ iata, icao, name }`, checked in). The flight
 * form lazy-loads it for the airline combobox.
 */
import { writeFileSync } from "node:fs";
import path from "node:path";

const URL =
	"https://raw.githubusercontent.com/jpatokal/openflights/master/data/airlines.dat";
/** Names people actually use on tickets and boards (QA FLT-01: "ANA NH 9"). */
const DISPLAY_NAMES: Record<string, string> = { NH: "ANA" };

const ROOT = process.cwd();
const out = path.join(ROOT, "src/data/airlines.json");

/** One CSV line of airlines.dat (quoted fields, `\N` for null). */
function parseLine(line: string): string[] {
	const cells: string[] = [];
	let cur = "";
	let quoted = false;
	for (let i = 0; i < line.length; i++) {
		const ch = line[i];
		if (quoted) {
			if (ch === '"' && line[i + 1] === '"') {
				cur += '"';
				i++;
			} else if (ch === '"') quoted = false;
			else cur += ch;
		} else if (ch === '"') quoted = true;
		else if (ch === ",") {
			cells.push(cur);
			cur = "";
		} else cur += ch;
	}
	cells.push(cur);
	return cells.map((c) => (c === "\\N" ? "" : c.trim()));
}

async function main() {
	const res = await fetch(URL, {
		headers: { "user-agent": "yonder (airlines)" },
	});
	if (!res.ok) throw new Error(`airlines.dat: HTTP ${res.status}`);
	const text = await res.text();
	const byIata = new Map<
		string,
		{ iata: string; icao: string; name: string }
	>();
	for (const line of text.split(/\r?\n/)) {
		if (!line.trim()) continue;
		// id, name, alias, IATA, ICAO, callsign, country, active
		const [, name, , iata, icao, , , active] = parseLine(line);
		if (active !== "Y" || !name || !iata || !/^[A-Z0-9]{2}$/.test(iata))
			continue;
		if (byIata.has(iata)) continue; // the first active row wins
		byIata.set(iata, {
			iata,
			icao: /^[A-Z]{3}$/.test(icao ?? "") ? (icao as string) : "",
			name: DISPLAY_NAMES[iata] ?? name,
		});
	}
	const airlines = [...byIata.values()].sort((a, b) =>
		a.iata < b.iata ? -1 : a.iata > b.iata ? 1 : 0,
	);
	writeFileSync(out, `${JSON.stringify(airlines)}\n`);
	console.log(`${airlines.length} airlines → ${path.relative(ROOT, out)}`);
}

main().catch((e) => {
	console.error(e instanceof Error ? e.message : e);
	process.exitCode = 1;
});
