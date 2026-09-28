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
import type { GraphIndex } from "@/lib/engine/graph-index";
import { localDateOf, zonedEpoch } from "@/lib/engine/time";
import type { ScheduleResult } from "@/lib/engine/types";
import { daysUntil } from "@/lib/format";

export type PhaseDay = { id: string; date: string; tz: string };

/** The trip's days in order, each in its own zone (the schedule's). */
export function phaseDays(
	ix: GraphIndex,
	schedule: ScheduleResult,
): PhaseDay[] {
	return ix.days.map((d) => ({
		id: d.id,
		date: d.date,
		tz: schedule.days[d.id]?.tz ?? ix.defaultTz,
	}));
}

/** `nowFor`'s zone for an `asOf`: the zone of that trip day, else the trip's. */
export function asOfZone(
	ix: GraphIndex,
	schedule: ScheduleResult,
): (date: string) => string {
	return (date) =>
		schedule.days[ix.dayOfDate(date)?.id ?? ""]?.tz ?? ix.defaultTz;
}

export type TripPhase =
	/** No days yet. */
	| { kind: "empty" }
	| { kind: "before"; daysToGo: number }
	/** `index` into the days; `today` is the date there. */
	| { kind: "during"; index: number; today: string }
	| { kind: "after"; daysSince: number };

/** The date an `asOf` stands for: a date, or a local date-time on it ("2027-10-05T14:40"). */
export function asOfDate(asOf: string): string;
export function asOfDate(asOf: string | null | undefined): string | null;
export function asOfDate(asOf: string | null | undefined): string | null {
	return asOf ? asOf.slice(0, 10) : null;
}

/** The phase of a trip whose days (in order) are `days`, at `now`. */
export function tripPhase(
	days: readonly PhaseDay[],
	now: number,
	asOf?: string | null,
): TripPhase {
	const first = days[0];
	const last = days.at(-1);
	if (!first || !last) return { kind: "empty" };
	const date = asOfDate(asOf);
	const todayAt = (d: PhaseDay) => date ?? localDateOf(now, d.tz);
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
 * The instant "now" stands for: the real one, or `asOf` in the zone of that
 * day (`tz`, or a function of the date: the trip day's own zone). A date
 * alone means noon (a demo of Day 9 shows the morning's stops as done);
 * `2027-10-05T14:40` is 14:40 there (Today's demos and e2e).
 */
export function nowFor(
	asOf: string | null | undefined,
	tz: string | ((date: string) => string),
): number {
	if (!asOf) return Date.now();
	const date = asOfDate(asOf);
	const time = asOf.length > 10 ? asOf.slice(11, 16) : "12:00";
	return zonedEpoch(date, time, typeof tz === "string" ? tz : tz(date));
}
