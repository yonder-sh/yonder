/**
 * What a share card shows, from the graph the viewer can see: the trip's
 * name, its dates and its route model. `cardFingerprint` is the stable text
 * of exactly the inputs the picture depends on (the endpoint's ETag).
 */
import { indexGraph } from "@/lib/engine/graph-index";
import type { TripGraph } from "@/lib/engine/types";
import { tripRoute } from "../../lib/trip-route";
import type { ShareCardData } from "./card-svg";

const MONTHS = [
	"Jan",
	"Feb",
	"Mar",
	"Apr",
	"May",
	"Jun",
	"Jul",
	"Aug",
	"Sep",
	"Oct",
	"Nov",
	"Dec",
];

/** "Oct 2 – Nov 7 · 2027"; across a new year "Dec 20 · 2027 – Jan 5 · 2028"; one day "Oct 2 · 2027". */
export function cardDates(first: string | null, last: string | null): string {
	const parse = (d: string) => {
		const [y, mo, da] = d.split("-").map(Number);
		return { y: y ?? 0, m: MONTHS[(mo ?? 1) - 1] ?? "", d: da ?? 1 };
	};
	if (!first) return "";
	const a = parse(first);
	if (!last || last === first) return `${a.m} ${a.d} · ${a.y}`;
	const b = parse(last);
	if (a.y !== b.y) return `${a.m} ${a.d} · ${a.y} – ${b.m} ${b.d} · ${b.y}`;
	return `${a.m} ${a.d} – ${b.m} ${b.d} · ${a.y}`;
}

export function shareCardData(graph: TripGraph): ShareCardData {
	const ix = indexGraph(graph);
	return {
		title: graph.trip.name,
		dates: cardDates(
			ix.days[0]?.date ?? graph.trip.startDate,
			ix.days.at(-1)?.date ?? graph.trip.endDate,
		),
		route: tripRoute(ix),
	};
}

/** The card's inputs as stable text: equal fingerprints draw the same picture. */
export function cardFingerprint(data: ShareCardData): string {
	const r = data.route;
	const place = (
		p: {
			name: string;
			countryKey: string;
			coord: [number, number] | null;
		} | null,
	) => (p ? [p.name, p.countryKey, p.coord] : null);
	return JSON.stringify([
		data.title,
		data.dates,
		place(r.start),
		place(r.end),
		r.endsHome,
		r.viaPlaces.map(place),
		r.modeOut,
		r.stays.map((s) => [
			s.id,
			s.name,
			s.countryKey,
			s.coord,
			s.nights,
			s.transitNights,
			s.modeIn,
			s.color,
		]),
		r.rows.map((row) => [
			row.countryCode,
			row.countryName,
			row.color,
			row.nights,
			row.cities,
			row.modeIn,
		]),
		r.stats.days,
		r.stats.countries,
		r.stats.cities,
		r.stats.km,
		r.view,
	]);
}
