/**
 * The HoursEditorDialog's form model (EXTENSIONS §4.5): every `OpeningHours`
 * field round-trips through `toDraft` → `fromDraft` (weekday ranges with
 * their last entry, 24h days, closed days, holidays as day 7, `alwaysOpen`,
 * `closedDays` alone, `closedNth` incl. "last", `lastEntryBeforeCloseMin`,
 * exceptions and the note). Pure.
 */
import type { HoursPeriod, OpeningHours } from "@/lib/schemas/hours";

export type RangeDraft = { open: string; close: string; lastEntry: string };
export type DayState = "hours" | "24h" | "closed";
export type DayDraft = { state: DayState; ranges: RangeDraft[] };
export type HoursMode = "weekly" | "always" | "closedOnly";

export type HoursDraft = {
	mode: HoursMode;
	/** Index 0 Sun … 6 Sat. */
	days: DayDraft[];
	/** Day 7: own hours on public holidays (off = like that weekday). */
	holiday: { on: boolean; ranges: RangeDraft[] };
	closedDays: number[];
	closedNth: { day: number; nth: number }[];
	lastEntryMin: string;
	exceptions: {
		date: string;
		closed: boolean;
		ranges: RangeDraft[];
		label: string;
	}[];
	note: string;
};

export const MAX_RANGES = 4;
export const emptyRange = (): RangeDraft => ({
	open: "",
	close: "",
	lastEntry: "",
});

const toRange = (
	p: Pick<HoursPeriod, "open" | "close" | "lastEntry">,
): RangeDraft => ({
	open: p.open,
	close: p.close,
	lastEntry: p.lastEntry ?? "",
});

export function toDraft(h: OpeningHours | null): HoursDraft {
	const days: DayDraft[] = Array.from({ length: 7 }, (_, day) => {
		const list = h?.periods.filter((p) => p.day === day) ?? [];
		if (!h || (!list.length && !h.periods.length))
			return { state: "hours", ranges: [emptyRange()] };
		if (!list.length) return { state: "closed", ranges: [emptyRange()] };
		const [only] = list;
		if (
			list.length === 1 &&
			only &&
			only.open === "00:00" &&
			only.close === "24:00" &&
			!only.lastEntry
		)
			return { state: "24h", ranges: [emptyRange()] };
		return { state: "hours", ranges: list.map(toRange) };
	});
	const hol = h?.periods.filter((p) => p.day === 7) ?? [];
	return {
		mode: !h
			? "weekly"
			: h.alwaysOpen
				? "always"
				: h.periods.length
					? "weekly"
					: "closedOnly",
		days,
		holiday: {
			on: hol.length > 0,
			ranges: hol.length ? hol.map(toRange) : [emptyRange()],
		},
		closedDays: [...(h?.closedDays ?? [])],
		closedNth: (h?.closedNth ?? []).map((n) => ({ ...n })),
		lastEntryMin:
			h?.lastEntryBeforeCloseMin !== undefined
				? String(h.lastEntryBeforeCloseMin)
				: "",
		exceptions: (h?.exceptions ?? []).map((e) => ({
			date: e.date,
			closed: e.closed || !e.periods?.length,
			ranges: e.periods?.length ? e.periods.map(toRange) : [emptyRange()],
			label: e.label ?? "",
		})),
		note: h?.note ?? "",
	};
}

/** "9" "930" "9:30" "0930" "21.30" "9pm" → "HH:mm"; null when it isn't a time. */
export function normalizeClock(raw: string, allow24 = false): string | null {
	const s = raw.trim().toLowerCase().replace(/\s+/g, "");
	if (!s) return null;
	const m = /^(\d{1,2})(?:[:.h]?(\d{2}))?([ap]m?)?$/.exec(s);
	if (!m) return null;
	let h = Number(m[1]);
	const min = m[2] === undefined ? 0 : Number(m[2]);
	const ap = m[3]?.[0];
	if (min > 59) return null;
	if (ap) {
		if (h < 1 || h > 12) return null;
		if (ap === "p" && h !== 12) h += 12;
		if (ap === "a" && h === 12) h = 0;
	}
	if (h === 24 && min === 0 && allow24) return "24:00";
	if (h > 23) return null;
	return `${String(h).padStart(2, "0")}:${String(min).padStart(2, "0")}`;
}

export type DraftResult =
	| { ok: true; hours: OpeningHours }
	| { ok: false; error: string };

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function periodsOf(
	ranges: readonly RangeDraft[],
	where: string,
):
	| { ok: true; list: Omit<HoursPeriod, "day">[] }
	| { ok: false; error: string } {
	const list: Omit<HoursPeriod, "day">[] = [];
	for (const r of ranges) {
		if (!r.open.trim() && !r.close.trim() && !r.lastEntry.trim()) continue;
		const open = normalizeClock(r.open);
		const close = normalizeClock(r.close, true);
		if (!open || !close)
			return { ok: false, error: `${where}: give both times as HH:mm.` };
		if (open === close)
			return {
				ok: false,
				error: `${where}: opening and closing times are the same.`,
			};
		const p: Omit<HoursPeriod, "day"> = {
			open,
			close: close as HoursPeriod["close"],
		};
		if (r.lastEntry.trim()) {
			const le = normalizeClock(r.lastEntry);
			if (!le)
				return { ok: false, error: `${where}: the last entry isn't a time.` };
			p.lastEntry = le;
		}
		list.push(p);
	}
	return { ok: true, list: list.slice(0, MAX_RANGES) };
}

export function fromDraft(d: HoursDraft, updatedAt: string): DraftResult {
	const hours: OpeningHours = { source: "manual", periods: [], updatedAt };
	if (d.mode === "always") hours.alwaysOpen = true;
	else if (d.mode === "weekly") {
		for (let day = 0; day < 7; day++) {
			const dd = d.days[day];
			if (!dd || dd.state === "closed") continue;
			if (dd.state === "24h") {
				hours.periods.push({ day, open: "00:00", close: "24:00" });
				continue;
			}
			const r = periodsOf(dd.ranges, WEEKDAYS[day] ?? "");
			if (!r.ok) return r;
			if (!r.list.length)
				return {
					ok: false,
					error: `${WEEKDAYS[day]}: add hours, or mark it closed.`,
				};
			for (const p of r.list) hours.periods.push({ day, ...p });
		}
		if (!hours.periods.length)
			return {
				ok: false,
				error: "Closed every day? Choose “Only closed days” instead.",
			};
		if (d.holiday.on) {
			const r = periodsOf(d.holiday.ranges, "Holidays");
			if (!r.ok) return r;
			for (const p of r.list) hours.periods.push({ day: 7, ...p });
		}
	} else {
		const closed = [...new Set(d.closedDays)]
			.filter((x) => x >= 0 && x <= 6)
			.sort((a, b) => a - b);
		if (!closed.length && !d.closedNth.length)
			return { ok: false, error: "Pick the days it's closed." };
		if (closed.length) hours.closedDays = closed;
	}
	const nth = d.closedNth.filter(
		(n, i, all) =>
			all.findIndex((x) => x.day === n.day && x.nth === n.nth) === i,
	);
	if (nth.length)
		hours.closedNth = nth.slice(0, 4).map((n) => ({
			day: n.day,
			nth: n.nth as NonNullable<OpeningHours["closedNth"]>[number]["nth"],
		}));
	if (d.lastEntryMin.trim()) {
		const n = Number(d.lastEntryMin);
		if (!Number.isInteger(n) || n < 0 || n > 240)
			return {
				ok: false,
				error: "Last entry: minutes before close, 0 to 240.",
			};
		hours.lastEntryBeforeCloseMin = n;
	}
	const seen = new Set<string>();
	const exceptions: NonNullable<OpeningHours["exceptions"]> = [];
	for (const e of d.exceptions) {
		if (!e.date && !e.label.trim()) continue;
		if (!/^\d{4}-\d{2}-\d{2}$/.test(e.date))
			return { ok: false, error: "Each special date needs a date." };
		if (seen.has(e.date))
			return { ok: false, error: `${e.date} is listed twice.` };
		seen.add(e.date);
		const label = e.label.trim().slice(0, 60);
		if (e.closed) {
			exceptions.push({
				date: e.date,
				closed: true,
				...(label ? { label } : {}),
			});
			continue;
		}
		const r = periodsOf(e.ranges, e.date);
		if (!r.ok) return r;
		exceptions.push({
			date: e.date,
			closed: r.list.length === 0,
			...(r.list.length ? { periods: r.list } : {}),
			...(label ? { label } : {}),
		});
	}
	if (exceptions.length)
		hours.exceptions = exceptions
			.sort((a, b) => a.date.localeCompare(b.date))
			.slice(0, 60);
	const note = d.note.trim().slice(0, 200);
	if (note) hours.note = note;
	return { ok: true, hours };
}
