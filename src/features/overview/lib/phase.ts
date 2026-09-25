/**
 * docs/OVERVIEW.md §3: which part of the trip "today" is in — before (a
 * countdown), during (Day 9 of 37) or after (the recap). Pure.
 *
 * Trip days are calendar dates in their own zone (the schedule's `tz` per
 * day): Day 1 of a trip that starts with a New York flight begins in New
 * York, the Kyoto days in Japan. "Today" on a day is the date there, so the
 * travellers see the day they are living, wherever the viewer is. `asOf`
 * (the `?asOf=` param, demos and e2e) replaces "today" everywhere.
 */
import { localDateOf, zonedEpoch } from "@/lib/engine/time";
import { daysUntil } from "@/lib/format";

export type PhaseDay = { id: string; date: string; tz: string };

export type TripPhase =
	/** No days yet. */
	| { kind: "empty" }
	| { kind: "before"; daysToGo: number }
	/** `index` into the days; `today` is the date there. */
	| { kind: "during"; index: number; today: string }
	| { kind: "after"; daysSince: number };

/** The phase of a trip whose days (in order) are `days`, at `now`. */
export function tripPhase(
	days: readonly PhaseDay[],
	now: number,
	asOf?: string | null,
): TripPhase {
	const first = days[0];
	const last = days.at(-1);
	if (!first || !last) return { kind: "empty" };
	const todayAt = (d: PhaseDay) => asOf ?? localDateOf(now, d.tz);
	const t0 = todayAt(first);
	if (t0 < first.date)
		return { kind: "before", daysToGo: daysUntil(first.date, t0) };
	const tl = todayAt(last);
	if (tl > last.date)
		return { kind: "after", daysSince: daysUntil(tl, last.date) };
	let index = 0;
	days.forEach((d, i) => {
		if (d.date <= todayAt(d)) index = i;
	});
	const day = days[index] ?? first;
	return { kind: "during", index, today: todayAt(day) };
}

/**
 * The instant "now" stands for: the real one, or noon on `asOf` in the
 * trip's zone (so a demo of Day 9 shows the morning's stops as done).
 */
export function nowFor(asOf: string | null | undefined, tz: string): number {
	return asOf ? zonedEpoch(asOf, "12:00", tz) : Date.now();
}
