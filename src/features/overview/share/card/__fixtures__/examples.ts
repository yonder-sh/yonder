/**
 * The share-card mockups' trips (`.data/mock/build_overview.py`), as real trip
 * graphs through the engine's scenario builder: Asia 2027 (the full draft's
 * stays), "Asia, the long way" (8 rows), "Around the world" (12 rows, flat
 * map) and "Four corners" (4 rows spread over the world, flat map), plus a
 * few edge cases. Stops use the mockup's `mkTrip` shape.
 */
import { scenario } from "@/lib/engine/__fixtures__/demo";
import type { TripGraph } from "@/lib/engine/types";

/** [city, ISO country, lat, lng, nights, mode into it ("flight" | "train" | "bus" | "night train" | "car" | null)] */
export type Stop = [string, string, number, number, number, (string | null)?];

const NAMES: Record<string, string> = {
	US: "USA", JP: "Japan", KR: "South Korea", VN: "Vietnam", TW: "Taiwan", TR: "Türkiye", KH: "Cambodia",
	TH: "Thailand", MY: "Malaysia", SG: "Singapore", PT: "Portugal", ES: "Spain", IT: "Italy",
	AE: "United Arab Emirates", IN: "India", ID: "Indonesia", AU: "Australia", NZ: "New Zealand", PE: "Peru",
	MX: "Mexico", IS: "Iceland", ZA: "South Africa", LA: "Laos", MM: "Myanmar", PH: "Philippines",
	FR: "France", DE: "Germany", NL: "Netherlands", BE: "Belgium", CH: "Switzerland", AT: "Austria",
	GR: "Greece", HR: "Croatia", CL: "Chile", AR: "Argentina", BR: "Brazil", NP: "Nepal", LK: "Sri Lanka",
};

export interface ExampleTrip {
	title: string;
	firstDate: string;
	stops: Stop[];
	/** Nights on a plane: out of home before the first stay, and on the way back. */
	overnight?: { out?: number; home?: number };
}

const legMode = (m: string | null | undefined) =>
	m === "flight" ? "flight" : m === "car" ? "other" : m ? "transit" : null;

export function exampleGraph(t: ExampleTrip): TripGraph {
	const nodes: Parameters<typeof scenario>[0]["nodes"] = [];
	const countries = new Set<string>();
	const cities = new Map<string, string>();
	for (const [name, cc, lat, lng] of t.stops) {
		if (!countries.has(cc)) {
			countries.add(cc);
			nodes.push({ key: `c-${cc}`, parent: null, type: "country", name: NAMES[cc] ?? cc, countryCode: cc, at: [lat, lng] });
		}
		const key = `p-${cc}-${name}`;
		if (!cities.has(key)) {
			cities.set(key, key);
			nodes.push({ key, parent: `c-${cc}`, type: "city", name, at: [lat, lng] });
		}
	}
	type Day = { night?: string; items: { k: string; node: string }[] };
	const days: Day[] = [];
	const legs: { from: string; to: string; mode: "flight" | "transit" | "other" | null }[] = [];
	let seq = 0;
	const item = (cc: string, name: string) => ({ k: `i${seq++}`, node: `p-${cc}-${name}` });
	const [home, ...rest] = t.stops;
	if (!home) throw new Error("no stops");
	let prev = item(home[1], home[0]);
	let cur: Day = { items: [prev] };
	const lastStay = rest.reduce((a, s, i) => (s[4] > 0 ? i : a), -1);
	rest.forEach(([name, cc, , , nights, mode], i) => {
		const overnight =
			(mode && /night/.test(mode) ? 1 : 0) +
			(i === 0 ? (t.overnight?.out ?? 0) : 0) +
			(i === lastStay + 1 ? (t.overnight?.home ?? 0) : 0);
		for (let k = 0; k < overnight; k++) {
			days.push(cur);
			cur = { items: [] };
		}
		const arrive = item(cc, name);
		cur.items.push(arrive);
		legs.push({ from: prev.k, to: arrive.k, mode: legMode(mode) });
		prev = arrive;
		if (nights <= 0) return;
		const city = `p-${cc}-${name}`;
		cur.night = city;
		days.push(cur);
		for (let n = 1; n < nights; n++) days.push({ night: city, items: [] });
		prev = item(cc, name);
		cur = { items: [prev] };
	});
	days.push(cur);
	const s = scenario({ firstDate: t.firstDate, nodes, days, legs });
	s.graph.trip.name = t.title;
	s.graph.trip.slug = t.title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
	return s.graph;
}

export const ASIA_2027: ExampleTrip = {
	title: "Asia 2027",
	firstDate: "2027-10-02",
	overnight: { out: 1, home: 1 },
	stops: [
		["New York", "US", 40.64, -73.78, 0],
		["Tokyo", "JP", 35.68, 139.76, 4, "flight"],
		["Mt. Fuji", "JP", 35.5, 138.76, 1, "bus"],
		["Nagoya", "JP", 35.17, 136.88, 1, "train"],
		["Kyoto", "JP", 35.01, 135.77, 3, "train"],
		["Osaka", "JP", 34.69, 135.5, 2, "train"],
		["Seoul", "KR", 37.57, 126.98, 3, "flight"],
		["Busan", "KR", 35.18, 129.08, 3, "train"],
		["Ho Chi Minh City", "VN", 10.78, 106.7, 3, "flight"],
		["Hoi An", "VN", 15.88, 108.33, 3, "flight"],
		["Hanoi", "VN", 21.03, 105.85, 1, "flight"],
		["Ninh Binh", "VN", 20.25, 105.97, 1, "car"],
		["Sa Pa", "VN", 22.34, 103.84, 1, "night train"],
		["Hanoi", "VN", 21.03, 105.85, 2, "night train"],
		["Taipei", "TW", 25.03, 121.56, 4, "flight"],
		["Istanbul", "TR", 41.28, 28.75, 0, "flight"],
		["Newark", "US", 40.69, -74.17, 0, "flight"],
	],
};

export const LONG_WAY: ExampleTrip = {
	title: "Asia, the long way",
	firstDate: "2028-03-04",
	overnight: { out: 1, home: 1 },
	stops: [
		["New York", "US", 40.64, -73.78, 0],
		["Tokyo", "JP", 35.68, 139.76, 5, "flight"],
		["Seoul", "KR", 37.57, 126.98, 4, "flight"],
		["Hanoi", "VN", 21.03, 105.85, 3, "flight"],
		["Hoi An", "VN", 15.88, 108.33, 3, "flight"],
		["Siem Reap", "KH", 13.36, 103.86, 3, "flight"],
		["Bangkok", "TH", 13.76, 100.5, 4, "bus"],
		["Chiang Mai", "TH", 18.79, 98.98, 3, "night train"],
		["Kuala Lumpur", "MY", 3.14, 101.69, 3, "flight"],
		["Singapore", "SG", 1.29, 103.85, 3, "bus"],
		["Osaka", "JP", 34.69, 135.5, 3, "flight"],
		["Kyoto", "JP", 35.01, 135.77, 3, "train"],
		["New York", "US", 40.64, -73.78, 0, "flight"],
	],
};

export const AROUND_THE_WORLD: ExampleTrip = {
	title: "Around the world",
	firstDate: "2028-09-01",
	stops: [
		["New York", "US", 40.64, -73.78, 0],
		["Lisbon", "PT", 38.72, -9.14, 4, "flight"],
		["Porto", "PT", 41.15, -8.61, 3, "train"],
		["Barcelona", "ES", 41.39, 2.17, 4, "flight"],
		["Rome", "IT", 41.9, 12.5, 4, "flight"],
		["Florence", "IT", 43.77, 11.26, 3, "train"],
		["Istanbul", "TR", 41.01, 28.98, 4, "flight"],
		["Dubai", "AE", 25.2, 55.27, 3, "flight"],
		["Delhi", "IN", 28.61, 77.21, 3, "flight"],
		["Jaipur", "IN", 26.91, 75.79, 3, "train"],
		["Bangkok", "TH", 13.76, 100.5, 4, "flight"],
		["Chiang Mai", "TH", 18.79, 98.98, 3, "night train"],
		["Bali", "ID", -8.65, 115.22, 7, "flight"],
		["Sydney", "AU", -33.87, 151.21, 5, "flight"],
		["Queenstown", "NZ", -45.03, 168.66, 5, "flight"],
		["Auckland", "NZ", -36.85, 174.76, 3, "flight"],
		["Lima", "PE", -12.05, -77.04, 3, "flight"],
		["Cusco", "PE", -13.53, -71.97, 4, "flight"],
		["Mexico City", "MX", 19.43, -99.13, 5, "flight"],
		["New York", "US", 40.64, -73.78, 0, "flight"],
	],
};

export const FOUR_CORNERS: ExampleTrip = {
	title: "Four corners",
	firstDate: "2029-05-01",
	stops: [
		["New York", "US", 40.64, -73.78, 0],
		["Reykjavik", "IS", 64.15, -21.94, 4, "flight"],
		["Cape Town", "ZA", -33.92, 18.42, 5, "flight"],
		["Kruger", "ZA", -24.0, 31.5, 3, "flight"],
		["Tokyo", "JP", 35.68, 139.76, 4, "flight"],
		["Kyoto", "JP", 35.01, 135.77, 3, "train"],
		["Lima", "PE", -12.05, -77.04, 2, "flight"],
		["Cusco", "PE", -13.53, -71.97, 4, "flight"],
		["New York", "US", 40.64, -73.78, 0, "flight"],
	],
};

/** 16 country runs, most of them in Southeast Asia and Europe: folds into regions. */
export const SIXTEEN_ROWS: ExampleTrip = {
	title: "The big one",
	firstDate: "2030-01-05",
	stops: [
		["New York", "US", 40.64, -73.78, 0],
		["Paris", "FR", 48.86, 2.35, 3, "flight"],
		["Amsterdam", "NL", 52.37, 4.9, 2, "train"],
		["Brussels", "BE", 50.85, 4.35, 2, "train"],
		["Zurich", "CH", 47.37, 8.54, 2, "train"],
		["Vienna", "AT", 48.21, 16.37, 2, "train"],
		["Athens", "GR", 37.98, 23.73, 3, "flight"],
		["Dubai", "AE", 25.2, 55.27, 2, "flight"],
		["Kathmandu", "NP", 27.72, 85.32, 4, "flight"],
		["Bangkok", "TH", 13.76, 100.5, 3, "flight"],
		["Luang Prabang", "LA", 19.89, 102.13, 3, "flight"],
		["Siem Reap", "KH", 13.36, 103.86, 3, "flight"],
		["Hanoi", "VN", 21.03, 105.85, 3, "flight"],
		["Manila", "PH", 14.6, 120.98, 3, "flight"],
		["Tokyo", "JP", 35.68, 139.76, 4, "flight"],
		["Seoul", "KR", 37.57, 126.98, 3, "flight"],
		["Taipei", "TW", 25.03, 121.56, 3, "flight"],
		["New York", "US", 40.64, -73.78, 0, "flight"],
	],
};

/** One country: the globe zooms in. */
export const JAPAN_ONLY: ExampleTrip = {
	title: "Japan in autumn: temples, trains and far too much ramen",
	firstDate: "2027-11-01",
	stops: [
		["Tokyo", "JP", 35.68, 139.76, 0],
		["Tokyo", "JP", 35.68, 139.76, 3, "train"],
		["Hakone", "JP", 35.23, 139.1, 1, "train"],
		["Kyoto", "JP", 35.01, 135.77, 4, "train"],
		["Nara", "JP", 34.68, 135.8, 1, "train"],
		["Osaka", "JP", 34.69, 135.5, 2, "train"],
		["Hiroshima", "JP", 34.39, 132.46, 2, "train"],
		["Tokyo", "JP", 35.68, 139.76, 0, "train"],
	],
};

export const EXAMPLES = {
	"asia-2027": ASIA_2027,
	"long-way": LONG_WAY,
	"around-the-world": AROUND_THE_WORLD,
	"four-corners": FOUR_CORNERS,
	"sixteen-rows": SIXTEEN_ROWS,
	"japan-only": JAPAN_ONLY,
} as const;
