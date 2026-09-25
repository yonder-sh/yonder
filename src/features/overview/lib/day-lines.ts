/**
 * docs/OVERVIEW.md §5 "Day by day": one line per day — the night's city
 * (with its country's colour) and the day's headline places — grouped by
 * stay, and the stays by country row (the route model's rows) so a long trip
 * can fold per country. Pure.
 */
import type { GraphIndex } from "@/lib/engine/graph-index";
import { cityOf, type RouteRow, type TripRoute } from "./trip-route";

export interface DayLine {
	dayId: string;
	/** 1-based day number. */
	n: number;
	date: string;
	/** "Tokyo", or "New York → Tokyo" on a day with no night in a city. */
	city: string;
	countryKey: string | null;
	/** The night city's country accent (null: nowhere to colour). */
	color: string | null;
	/** The stay this night belongs to (index into `route.stays`). */
	stayIndex: number | null;
	/** The day's places in order (no hotels, no unlocated blocks), each once. */
	places: string[];
}

const SKIP = new Set(["lodging"]);

export function dayLines(ix: GraphIndex, route: TripRoute): DayLine[] {
	return ix.days.map((day, i) => {
		const stayIndex = route.stays.findIndex(
			(s) => s.firstDate <= day.date && day.date <= s.lastDate,
		);
		const stay = stayIndex >= 0 ? route.stays[stayIndex] : undefined;
		const items = ix.itemsByDay.get(day.id) ?? [];
		const places: string[] = [];
		const cities: { name: string; countryKey: string }[] = [];
		for (const it of items) {
			const node = it.nodeId ? ix.node(it.nodeId) : undefined;
			if (node && it.nodeId) {
				const c = cityOf(ix, it.nodeId);
				if (c && cities.at(-1)?.name !== c.name)
					cities.push({ name: c.name, countryKey: c.countryKey });
			}
			// Headlines are places: no hotels, no unlocated blocks ("Lunch").
			if (!node || (node.category && SKIP.has(node.category))) continue;
			const name = node.name.trim();
			if (name && !places.includes(name)) places.push(name);
		}
		let city = stay?.name ?? "";
		let countryKey = stay?.countryKey ?? null;
		if (!stay) {
			const a = cities[0];
			const b = cities.at(-1);
			city =
				a && b && a.name !== b.name ? `${a.name} → ${b.name}` : (a?.name ?? "");
			countryKey = b?.countryKey ?? null;
		}
		return {
			dayId: day.id,
			n: i + 1,
			date: day.date,
			city,
			countryKey,
			color: countryKey ? (route.colors[countryKey] ?? null) : null,
			stayIndex: stay ? stayIndex : null,
			places,
		};
	});
}

export interface DayGroup {
	/** The stay (null: travel days between stays, or a trip with none). */
	stayIndex: number | null;
	lines: DayLine[];
}

export interface DaySection {
	/** The country row (null for a trip without stays). */
	row: RouteRow | null;
	rowIndex: number;
	groups: DayGroup[];
	days: number;
}

/**
 * The lines by stay, and the stays by country row. A day without a stay
 * (a flight out, a night train) belongs to the next stay's row (it is the
 * way there), after the last stay to the last row (the way home).
 */
export function daySections(
	lines: readonly DayLine[],
	route: TripRoute,
): DaySection[] {
	const rowOfStay = new Map<number, number>();
	route.rows.forEach((r, ri) => {
		for (const si of r.stayIndexes) rowOfStay.set(si, ri);
	});
	const rowOf = (i: number): number => {
		const own = lines[i]?.stayIndex;
		if (own !== null && own !== undefined) return rowOfStay.get(own) ?? 0;
		for (let k = i + 1; k < lines.length; k++) {
			const s = lines[k]?.stayIndex;
			if (s !== null && s !== undefined) return rowOfStay.get(s) ?? 0;
		}
		return Math.max(0, route.rows.length - 1);
	};
	const sections: DaySection[] = [];
	lines.forEach((line, i) => {
		const ri = route.rows.length ? rowOf(i) : 0;
		let sec = sections.at(-1);
		if (!sec || sec.rowIndex !== ri) {
			sec = { row: route.rows[ri] ?? null, rowIndex: ri, groups: [], days: 0 };
			sections.push(sec);
		}
		const g = sec.groups.at(-1);
		if (g && g.stayIndex === line.stayIndex) g.lines.push(line);
		else sec.groups.push({ stayIndex: line.stayIndex, lines: [line] });
		sec.days++;
	});
	return sections;
}
