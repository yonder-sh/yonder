import { daysUntil } from "@/lib/format";

/**
 * The dashboard hero's "when" line (QA DASH-HERO-DAY): "in N days" before the
 * trip, "Day N" while it runs. Day 1 is the start date, so the day number is
 * the whole days elapsed since the start plus one — 20–23 Sep read on 23 Sep
 * is Day 4, never "Day -2".
 */

/** 1-based day of the trip on `today` (both `YYYY-MM-DD`); Day 1 = `startDate`. */
export function tripDayNumber(startDate: string, today: string): number {
	return daysUntil(today, startDate) + 1;
}

/** Whether the trip is under way on `today` (the end date counts as a trip day). */
export function isRunning(
	startDate: string | null,
	endDate: string | null,
	today: string | null,
): boolean {
	return (
		!!today &&
		!!startDate &&
		startDate <= today &&
		(!endDate || today <= endDate)
	);
}

export type HeroWhen =
	| { kind: "countdown"; days: number }
	| { kind: "day"; day: number }
	| null;

/** What the hero shows under the dates, or null when there's nothing to count. */
export function heroWhen(
	startDate: string | null,
	endDate: string | null,
	today: string | null,
): HeroWhen {
	if (!startDate || !today) return null;
	const until = daysUntil(startDate, today);
	if (until > 0) return { kind: "countdown", days: until };
	if (isRunning(startDate, endDate, today))
		return { kind: "day", day: tripDayNumber(startDate, today) };
	return null;
}
