/**
 * Clock times the sheet states in words (SPEC §17.3 step 6, EXTENSIONS D4).
 * The Itinerary tab has no time column, so every day would start at 09:00
 * and "Chureito Pagoda (sunrise)" would land mid-morning. These few rows
 * say when things happen in their Open Hours or Notes text; each rule quotes
 * that text and applies only while the row still says it (a changed sheet
 * skips the rule and the report lists it).
 *
 * - `pin`: the item's pinned start (◆). "reserve" means *needs* booking, so a
 *   pinned tour stays un-booked and shows under "Timed — check" (E2).
 * - `dayStart`: the day's start time, when the sheet times the day's first
 *   move ("Taxi ~15 min at ~5:30").
 */
export type SheetTime = {
	kind: "pin" | "dayStart";
	/** The sheet's day number ("5 · Mt. Fuji · …"). */
	day: number;
	/** The Itinerary row's Place. */
	place: string;
	at: string;
	/** Must appear in the row's Open Hours or Notes. */
	quote: string;
	why: string;
};

export const SHEET_TIMES: readonly SheetTime[] = [
	{
		kind: "pin",
		day: 1,
		place: "JAL Sky Museum",
		at: "09:30",
		quote: "Earliest tour 9:30",
		why: "the earliest tour (reserve ahead: not booked yet)",
	},
	{
		kind: "dayStart",
		day: 1,
		place: "JAL Sky Museum",
		at: "07:30",
		quote: "arrive ~9:00",
		why: "breakfast at the airport and Anamori Inari fit before the 09:30 tour",
	},
	{
		kind: "dayStart",
		day: 5,
		place: "Fuji Excursion (Shinjuku → Kawaguchiko)",
		at: "08:00",
		quote: "~8:30–9 AM departure",
		why: "breakfast, then the ~08:30 train",
	},
	{
		kind: "pin",
		day: 5,
		place: "Mt. Fuji Panoramic Ropeway",
		at: "15:30",
		quote: "Go ~3:30–4 PM",
		why: "queues thin out, and sunset lands before the last descent",
	},
	{
		kind: "dayStart",
		day: 6,
		place: "Chureito Pagoda (sunrise)",
		at: "05:30",
		quote: "Taxi ~15 min at ~5:30",
		why: "the taxi to the pagoda for sunrise (~5:50)",
	},
];

/** Whether `rule` still matches its row's text. */
export function quoteHolds(
	rule: SheetTime,
	row: { "Open Hours": string | null; Notes: string | null },
): boolean {
	return [row["Open Hours"], row.Notes].some((t) => t?.includes(rule.quote));
}
