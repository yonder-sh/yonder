/**
 * OpenStreetMap `opening_hours` → `OpeningHours` (`source: 'osm'`), and the
 * precedence rule for writing them. Pure (no DB, no network).
 *
 * The tag is parsed and normalised by opening_hours.js (the reference parser
 * of the OSM wiki spec): sloppy input (`mo-fr 9-18`, `9am-5pm`) comes back
 * canonical (`Mo-Fr 09:00-18:00`), anything invalid throws. The canonical
 * value is then read by a strict grammar that knows only what the model can
 * say:
 *
 * - weekday ranges and lists with one or more time ranges (`Mo-Fr
 *   09:00-12:00,13:00-18:00`), overnight ranges (`18:00-02:00`, `22:00-26:00`),
 *   whole days (`Mo-Fr`, `00:00-24:00`), `24/7`, `off` / `closed` weekdays;
 * - additional rules (`Mo-Fr 08:00-12:00, We 14:00-18:00`);
 * - `PH` (public holidays): own hours → day 7; `PH off` → `closedOnHolidays`;
 * - nth weekday closures (`Tu[2] off`, `Su[-1] off`) → `closedNth`;
 * - dates (`2027 Dec 25 off`, `Dec 24-26 off`, `Dec 31 10:00-15:00`) →
 *   `exceptions` inside a rolling window (recurring dates are expanded for
 *   the next two years; the 30-day refresh keeps the window rolling);
 * - comments (`"by appointment"`) → the note (a date's comment → its label).
 *
 * Anything else (months and seasons, week numbers, school holidays, easter,
 * sunrise/sunset, open ends `10:00+`, `unknown`, fallback rules `||`, times
 * with `off`, nth weekdays with hours…) is skipped: the hours keep only the
 * raw tag as their note, and say nothing about any day.
 *
 * Every conversion is then CHECKED against opening_hours.js itself: both are
 * evaluated minute by minute for every day of the window (holidays taken
 * from the library's German calendar, only as a probe), and any difference
 * skips the tag too. One difference is allowed on purpose: a later rule
 * that, by the letter of the spec, cuts the previous night short (`Mo-Th
 * 17:00-01:00; Fr-Sa 17:00-03:00` closes Thursday night at midnight); the
 * app keeps the night going, as mappers mean it (the library warns about
 * exactly this).
 */
import OpeningHoursJs, { type optional_conf } from "opening_hours";
import { hoursOnDate, toMinutes, weekdayOf } from "@/lib/engine/hours";
import type {
	HoursException,
	HoursPeriod,
	OpeningHours,
} from "@/lib/schemas/hours";
import type { NodeDetails } from "@/lib/schemas/nodes";
import type { Holiday } from "@/lib/schemas/trips";

/** Days from the fetch date that dated rules are expanded into (and checked). */
export const OSM_HOURS_WINDOW_DAYS = 731;

/** Only a probe for `PH` rules: the check needs SOME holiday calendar. */
const PROBE_PLACE = {
	lat: 52.52,
	lon: 13.405,
	address: { country_code: "de", state: "Berlin" },
};
/** Time ranges only (no points in time), English names. */
const CONF: optional_conf = {
	mode: 0,
	tag_key: "opening_hours",
	map_value: false,
	warnings_severity: 4,
	locale: "en",
};

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
] as const;
const WEEKDAYS: Record<string, number> = {
	Su: 0,
	Mo: 1,
	Tu: 2,
	We: 3,
	Th: 4,
	Fr: 5,
	Sa: 6,
};

export type OsmConversion =
	| { kind: "hours"; hours: OpeningHours }
	/** The tag can't be said faithfully: `hours` only carries it as the note. */
	| { kind: "skipped"; reason: string; hours: OpeningHours };

/** Minutes after midnight; `close` may pass 1440 (OSM extended time, `26:00`). */
type Range = { open: number; close: number };
type Ymd = { y?: number; m: number; d: number };
type DateItem = { from: Ymd; to?: Ymd };

type Rule = {
	/** Joined with `, ` (adds to the days it names) rather than `; `. */
	additional: boolean;
	always?: true;
	dates?: DateItem[];
	days?: number[];
	nth?: { day: number; nth: number }[];
	ph?: true;
	/** Null: the whole day. */
	times: Range[] | null;
	closed: boolean;
	comment?: string;
};

class Unsupported extends Error {}
const unsupported = (why: string): never => {
	throw new Unsupported(why);
};

// ---------------------------------------------------------------------------
// The canonical value → rules
// ---------------------------------------------------------------------------

/** Splits on `; ` and `, ` outside quotes; `||` (fallback rules) is unsupported. */
function splitRules(value: string): { text: string; additional: boolean }[] {
	const out: { text: string; additional: boolean }[] = [];
	let cur = "";
	let additional = false;
	let quoted = false;
	for (let i = 0; i < value.length; i++) {
		const c = value[i];
		if (c === '"') quoted = !quoted;
		if (!quoted) {
			if (c === "|" && value[i + 1] === "|") unsupported("fallback rule");
			const sep =
				c === ";" ? "normal" : c === "," && value[i + 1] === " " ? "add" : null;
			if (sep) {
				if (cur.trim()) out.push({ text: cur.trim(), additional });
				cur = "";
				additional = sep === "add";
				continue;
			}
		}
		cur += c;
	}
	if (quoted) unsupported("unbalanced quotes");
	if (cur.trim()) out.push({ text: cur.trim(), additional });
	return out;
}

const MONTH_RE = MONTHS.join("|");
const FULL_DATE = new RegExp(
	`(?:(\\d{4}) )?(${MONTH_RE}) (\\d{2})(?:-(?:(?:(\\d{4}) )?(${MONTH_RE}) )?(\\d{2}))?`,
	"y",
);
const SHORT_DATE = /(\d{2})(?:-(\d{2}))?/y;

const monthOf = (name: string | undefined): number =>
	MONTHS.indexOf(name as (typeof MONTHS)[number]) + 1;

/** A leading date selector (`2027 Dec 24-26,31`); `rest` starts after it. */
function parseDates(s: string): { items: DateItem[]; rest: string } | null {
	const items: DateItem[] = [];
	let i = 0;
	for (;;) {
		FULL_DATE.lastIndex = i;
		const full = FULL_DATE.exec(s);
		if (full) {
			const from: Ymd = {
				...(full[1] ? { y: Number(full[1]) } : {}),
				m: monthOf(full[2]),
				d: Number(full[3]),
			};
			const to: Ymd | undefined = full[6]
				? {
						...(full[4] ? { y: Number(full[4]) } : {}),
						m: full[5] ? monthOf(full[5]) : from.m,
						d: Number(full[6]),
					}
				: undefined;
			items.push(to ? { from, to } : { from });
			i += full[0].length;
		} else {
			const prev = items.at(-1);
			SHORT_DATE.lastIndex = i;
			const short = prev ? SHORT_DATE.exec(s) : null;
			if (!prev || !short) break;
			// `Dec 24,31`: the month (and year) of the item before.
			const base = prev.to ?? prev.from;
			const from: Ymd = { ...base, d: Number(short[1]) };
			items.push(
				short[2] ? { from, to: { ...base, d: Number(short[2]) } } : { from },
			);
			i += short[0].length;
		}
		if (s[i] === "," && s[i + 1] !== " ") {
			i++;
			continue;
		}
		break;
	}
	if (!items.length) return null;
	const rest = s.slice(i);
	if (rest && !rest.startsWith(" ")) unsupported("date selector");
	return { items, rest: rest.trim() };
}

/** `Mo-Fr`, `Su,PH`, `Tu[2],Th[-1]`, `Mo[1-2]`; null when the token isn't one. */
function parseDaySelector(
	token: string,
): Pick<Rule, "days" | "nth" | "ph"> | null {
	if (!/^(?:Mo|Tu|We|Th|Fr|Sa|Su|PH|SH)/.test(token)) return null;
	const parts = token.split(/,(?![^[]*\])/);
	const days = new Set<number>();
	const nth: { day: number; nth: number }[] = [];
	let ph = false;
	for (const part of parts) {
		if (part === "PH") {
			ph = true;
			continue;
		}
		const nthM = /^(Mo|Tu|We|Th|Fr|Sa|Su)\[([-\d,]+)\]$/.exec(part);
		if (nthM) {
			const day = WEEKDAYS[nthM[1] ?? ""] as number;
			for (const item of (nthM[2] ?? "").split(",")) {
				const range = /^(\d)-(\d)$/.exec(item);
				const list = range
					? Array.from(
							{ length: Number(range[2]) - Number(range[1]) + 1 },
							(_, k) => Number(range[1]) + k,
						)
					: [Number(item)];
				for (const n of list) {
					if (!(n === -1 || (Number.isInteger(n) && n >= 1 && n <= 5)))
						unsupported(`nth weekday ${item}`);
					nth.push({ day, nth: n });
				}
			}
			continue;
		}
		const m = /^(Mo|Tu|We|Th|Fr|Sa|Su)(?:-(Mo|Tu|We|Th|Fr|Sa|Su))?$/.exec(part);
		if (!m) unsupported(`day selector ${part}`);
		const a = WEEKDAYS[m?.[1] ?? ""] as number;
		const b = m?.[2] ? (WEEKDAYS[m[2]] as number) : a;
		// Mon-first ranges may wrap (`Sa-Mo`).
		for (let d = a, k = 0; k < 7; d = (d + 1) % 7, k++) {
			days.add(d);
			if (d === b) break;
		}
	}
	return {
		...(days.size ? { days: [...days].sort((x, y) => x - y) } : {}),
		...(nth.length ? { nth } : {}),
		...(ph ? { ph: true as const } : {}),
	};
}

const TIME_RANGE = /^(\d{2}):(\d{2})-(\d{2}):(\d{2})$/;

/** `09:00-12:00,13:00-18:00`; null when the token isn't a time list. */
function parseTimes(token: string): Range[] | null {
	if (!/^\d{2}:\d{2}/.test(token)) return null;
	return token.split(",").map((part) => {
		const m = TIME_RANGE.exec(part);
		if (!m) return unsupported(`time ${part}`);
		const open = Number(m[1]) * 60 + Number(m[2]);
		const close = Number(m[3]) * 60 + Number(m[4]);
		if (open >= 1440 || close > 2880) unsupported(`time ${part}`);
		return { open, close };
	});
}

function parseRule(text: string, additional: boolean): Rule {
	let s = text;
	let comment: string | undefined;
	const cm = /\s*"([^"]*)"$/.exec(s);
	if (cm) {
		comment = cm[1]?.trim() || undefined;
		s = s.slice(0, cm.index).trim();
	}
	if (s.includes('"')) unsupported("comment inside a rule");
	const rule: Rule = {
		additional,
		times: null,
		closed: false,
		...(comment ? { comment } : {}),
	};
	if (s === "24/7" || s === "24/7 open") return { ...rule, always: true };
	const dates = parseDates(s);
	if (dates) {
		rule.dates = dates.items;
		s = dates.rest;
	}
	const tokens = s ? s.split(" ") : [];
	let t = tokens.shift();
	const sel = t ? parseDaySelector(t) : null;
	if (sel) {
		Object.assign(rule, sel);
		t = tokens.shift();
	}
	const times = t ? parseTimes(t) : null;
	if (times) {
		rule.times = times;
		t = tokens.shift();
	}
	if (t === "off" || t === "closed") {
		rule.closed = true;
		t = tokens.shift();
	} else if (t === "open") t = tokens.shift();
	if (t !== undefined) unsupported(`"${t}"`);
	if (rule.closed && rule.times) unsupported("times with off");
	return rule;
}

// ---------------------------------------------------------------------------
// Rules → OpeningHours
// ---------------------------------------------------------------------------

const pad2 = (n: number) => String(n).padStart(2, "0");
const hm = (min: number) => `${pad2(Math.floor(min / 60))}:${pad2(min % 60)}`;

/** A range as a model period: `close ≤ open` runs into the next day. */
function toPeriod(r: Range): Omit<HoursPeriod, "day"> {
	// `18:00-00:00` closes at midnight.
	let close = r.close === 0 ? 1440 : r.close;
	if (close > 1440) {
		close -= 1440;
		// Longer than a day (`10:00-36:00`): the model has no such period.
		if (close > r.open) unsupported("a range longer than a day");
	}
	return {
		open: hm(r.open),
		close: (close === 1440 ? "24:00" : hm(close)) as HoursPeriod["close"],
	};
}

const isoOf = (y: number, m: number, d: number) => `${y}-${pad2(m)}-${pad2(d)}`;

/** `YYYY-MM-DD` + n days (UTC arithmetic: cheap in the per-day loops). */
export function addDays(iso: string, n: number): string {
	const t = new Date(
		Date.UTC(
			Number(iso.slice(0, 4)),
			Number(iso.slice(5, 7)) - 1,
			Number(iso.slice(8, 10)) + n,
		),
	);
	return isoOf(t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate());
}

function validDate(y: number, m: number, d: number): string | null {
	const dt = new Date(Date.UTC(y, m - 1, d));
	return dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d
		? isoOf(y, m, d)
		: null;
}

/** The dates of `items` inside [first, last] (ISO), oldest first. */
function expandDates(
	items: readonly DateItem[],
	first: string,
	last: string,
): string[] {
	const out = new Set<string>();
	const y0 = Number(first.slice(0, 4));
	const y1 = Number(last.slice(0, 4));
	for (const item of items) {
		const years = item.from.y !== undefined ? [item.from.y] : [];
		if (!years.length) for (let y = y0 - 1; y <= y1; y++) years.push(y);
		for (const y of years) {
			const from = validDate(y, item.from.m, item.from.d);
			if (!from) {
				// Feb 29 in a common year: that year has no such day.
				if (item.from.m === 2 && item.from.d === 29 && !item.to) continue;
				return unsupported("date");
			}
			let to = from;
			if (item.to) {
				const wraps =
					item.to.m < item.from.m ||
					(item.to.m === item.from.m && item.to.d < item.from.d);
				const ty = item.to.y ?? (wraps ? y + 1 : y);
				const v = validDate(ty, item.to.m, item.to.d);
				if (!v || v < from) return unsupported("date range");
				to = v;
			}
			let steps = 0;
			for (let d = from; d <= to; d = addDays(d, 1)) {
				if (++steps > 400) unsupported("a date range this long");
				if (d >= first && d <= last) out.add(d);
			}
		}
	}
	return [...out].sort();
}

type Built = Omit<OpeningHours, "updatedAt" | "source">;

function build(rules: readonly Rule[], first: string, last: string): Built {
	const ALL = [0, 1, 2, 3, 4, 5, 6];
	const whole: Range[] = [{ open: 0, close: 1440 }];
	let week: (Range[] | undefined)[] = Array(7).fill(undefined);
	let holiday: Range[] | "same" | "closed" = "same";
	let nth: { day: number; nth: number }[] = [];
	let exceptions = new Map<string, { ranges: Range[]; label?: string }>();
	const notes: string[] = [];
	let alwaysOpen = false;

	const resetAll = (ranges: Range[]) => {
		week = ALL.map(() => [...ranges]);
		holiday = "same";
		nth = [];
		exceptions = new Map();
	};

	for (const r of rules) {
		const ranges = r.closed ? [] : (r.times ?? whole);
		if (r.always) {
			if (r.additional) unsupported("an additional 24/7");
			if (rules.length === 1) alwaysOpen = true;
			else resetAll(whole);
			if (r.comment) notes.push(r.comment);
			continue;
		}
		if (r.dates) {
			if (r.days || r.nth || r.ph) unsupported("dates with weekdays");
			if (r.additional) unsupported("an additional date rule");
			for (const date of expandDates(r.dates, first, last))
				exceptions.set(date, {
					ranges,
					...(r.comment ? { label: r.comment.slice(0, 60) } : {}),
				});
			continue;
		}
		if (r.comment) notes.push(r.comment);
		const everyDay = !r.days && !r.nth && !r.ph;
		if (r.additional) {
			if (r.nth || r.ph || r.closed) unsupported("this additional rule");
			for (const d of r.days ?? ALL) week[d] = [...(week[d] ?? []), ...ranges];
			continue;
		}
		if (everyDay) {
			resetAll(ranges);
			continue;
		}
		for (const d of r.days ?? []) week[d] = [...ranges];
		if (r.ph) holiday = ranges.length ? [...ranges] : "closed";
		if (r.nth) {
			if (ranges.length) unsupported("hours on an nth weekday");
			nth.push(...r.nth);
		}
	}

	const note = [...new Set(notes)].join(" · ");
	const noteField = note ? { note: clip(note, 200) } : {};
	if (alwaysOpen) return { alwaysOpen: true, periods: [], ...noteField };

	const periods: HoursPeriod[] = [];
	week.forEach((list, day) => {
		for (const r of list ?? []) periods.push({ day, ...toPeriod(r) });
	});
	if (!periods.length) unsupported("never open");
	const hol = holiday;
	if (Array.isArray(hol))
		for (const r of hol) periods.push({ day: 7, ...toPeriod(r) });
	const out: Built = { periods, ...noteField };
	const allDay = week.every(
		(l) => l?.length === 1 && l[0]?.open === 0 && l[0]?.close === 1440,
	);
	if (allDay && hol === "same" && !nth.length && !exceptions.size)
		return { alwaysOpen: true, periods: [], ...noteField };
	if (hol === "closed") out.closedOnHolidays = true;
	const uniqueNth = nth.filter(
		(n, i) => nth.findIndex((x) => x.day === n.day && x.nth === n.nth) === i,
	);
	if (uniqueNth.length)
		out.closedNth = uniqueNth as NonNullable<OpeningHours["closedNth"]>;
	if (exceptions.size) {
		out.exceptions = [...exceptions]
			.sort(([a], [b]) => a.localeCompare(b))
			.map(([date, e]): HoursException => {
				if (e.ranges.length > 4) unsupported("too many ranges on a date");
				return {
					date,
					closed: !e.ranges.length,
					...(e.ranges.length ? { periods: e.ranges.map(toPeriod) } : {}),
					...(e.label ? { label: e.label } : {}),
				};
			});
	}
	if (
		periods.length > 40 ||
		(out.closedNth?.length ?? 0) > 4 ||
		(out.exceptions?.length ?? 0) > 60
	)
		unsupported("more than the model holds");
	periods.sort((a, b) => a.day - b.day || a.open.localeCompare(b.open));
	return out;
}

function clip(s: string, max: number): string {
	return s.length <= max ? s : `${s.slice(0, max - 1).trimEnd()}…`;
}

// ---------------------------------------------------------------------------
// The check: the model against opening_hours.js, minute by minute
// ---------------------------------------------------------------------------

const DAY_MIN = 1440;
const localDate = (iso: string, plusDays = 0) =>
	new Date(
		Number(iso.slice(0, 4)),
		Number(iso.slice(5, 7)) - 1,
		Number(iso.slice(8, 10)) + plusDays,
	);

const holidayMemo = new Map<string, Map<string, Holiday>>();

/** The probe calendar's holidays in the window (as the model's `Holiday`s). */
function probeHolidays(first: string, days: number): Map<string, Holiday> {
	const k = `${first}/${days}`;
	const hit = holidayMemo.get(k);
	if (hit) return hit;
	const out = new Map<string, Holiday>();
	const ph = new OpeningHoursJs("PH", PROBE_PLACE, CONF);
	for (const [a] of ph.getOpenIntervals(
		localDate(first, -1),
		localDate(first, days),
	)) {
		const iso = isoOf(a.getFullYear(), a.getMonth() + 1, a.getDate());
		out.set(iso, { date: iso, name: "Holiday" });
	}
	if (holidayMemo.size > 8) holidayMemo.clear();
	holidayMemo.set(k, out);
	return out;
}

/** Whether `hours` opens exactly when the library says the tag opens. */
function matchesLibrary(
	hours: OpeningHours,
	oh: OpeningHoursJs,
	first: string,
	days: number,
): boolean {
	const holidays = probeHolidays(first, days);
	const holidayOf = (d: string) => holidays.get(d) ?? null;
	const start = localDate(first);
	const lib = new Uint8Array(days * DAY_MIN);
	const dayIndex = (d: Date) =>
		Math.round(
			(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) -
				Date.UTC(start.getFullYear(), start.getMonth(), start.getDate())) /
				86_400_000,
		);
	const at = (d: Date) =>
		dayIndex(d) * DAY_MIN + d.getHours() * 60 + d.getMinutes();
	for (const [a, b, unknown] of oh.getOpenIntervals(
		start,
		localDate(first, days),
	)) {
		if (unknown) return false;
		lib.fill(1, Math.max(0, at(a)), Math.min(lib.length, at(b)));
	}
	// Host-zone DST days are 23 or 25 hours long: not comparable minute by minute.
	const irregular = (i: number) =>
		localDate(first, i + 1).getTime() - localDate(first, i).getTime() !==
		86_400_000;

	// Where last night's rule may reach into a day (its overnight close), per
	// weekday and for holiday hours: the "spill zone" of the next morning.
	const spillOf = (day: number) => {
		let end = 0;
		for (const p of hours.periods) {
			if (p.day !== day || p.close === "24:00") continue;
			const open = toMinutes(p.open);
			const close = toMinutes(p.close);
			if (close <= open) end = Math.max(end, close);
		}
		return end;
	};
	const spill = Array.from({ length: 8 }, (_, d) => spillOf(d));

	const own = new Uint8Array(DAY_MIN);
	const carry = new Uint8Array(DAY_MIN);
	let carryConfirmed = false;
	let hasCarry = false;
	for (let i = 0; i < days; i++) {
		if (irregular(i) || (i > 0 && irregular(i - 1))) continue;
		const date = addDays(first, i);
		const prevDate = addDays(date, -1);
		const today = hoursOnDate(hours, date, holidayOf(date));
		const prev = hoursOnDate(hours, prevDate, holidayOf(prevDate));
		if (today.state === "unknown") return false;
		own.fill(0);
		carry.fill(0);
		if (today.state === "always") own.fill(1);
		else if (today.state === "open")
			for (const p of today.periods)
				own.fill(1, p.open, Math.min(DAY_MIN, p.close));
		// Like `checkVisit`: the previous date's late hours cover the early ones.
		let carryEnd = 0;
		if (prev.state === "always") carryEnd = DAY_MIN;
		else if (prev.state === "open")
			for (const p of prev.periods)
				if (p.close > DAY_MIN) carryEnd = Math.max(carryEnd, p.close - DAY_MIN);
		carry.fill(1, 0, carryEnd);
		// By the letter of the spec, last night's rule reaches into this day
		// unless a later rule names this day, whatever happened to last night
		// itself (a holiday, a date): the app follows last night instead, as
		// mappers mean it. Inside that zone the two may differ only there.
		const zone = Math.max(
			carryEnd,
			spill[weekdayOf(prevDate)] ?? 0,
			holidayOf(prevDate) ? (spill[7] ?? 0) : 0,
		);
		let exact = true;
		let carries = false;
		const base = i * DAY_MIN;
		for (let m = 0; m < DAY_MIN; m++) {
			const l = lib[base + m] as number;
			const o = own[m] as number;
			const c = carry[m] as number;
			if (c && !o) carries = true;
			if (l === (o | c)) continue;
			exact = false;
			// Outside the zone, or the day's own hours: no difference allowed.
			if (m >= zone || o) return false;
		}
		if (carries) {
			hasCarry = true;
			if (exact) carryConfirmed = true;
		}
	}
	// A late close the library never confirmed would be the model's guess.
	return !hasCarry || carryConfirmed;
}

// ---------------------------------------------------------------------------
// Entry points
// ---------------------------------------------------------------------------

/**
 * One OSM `opening_hours` value → hours (`source: 'osm'`), or the raw tag
 * kept as a note when the model can't say it faithfully. `today` (ISO date,
 * UTC) starts the window dated rules are expanded into.
 */
export function convertOsmHours(
	tag: string,
	opts: { updatedAt: string; today: string },
): OsmConversion {
	const raw = tag.trim();
	const skipped = (reason: string): OsmConversion => ({
		kind: "skipped",
		reason,
		hours: {
			source: "osm",
			periods: [],
			note: clip(raw, 200),
			updatedAt: opts.updatedAt,
		},
	});
	if (!raw) return skipped("empty");
	if (raw.length > 255) return skipped("longer than OSM allows");
	let oh: OpeningHoursJs;
	try {
		oh = new OpeningHoursJs(raw, PROBE_PLACE, CONF);
	} catch {
		return skipped("invalid");
	}
	const days = OSM_HOURS_WINDOW_DAYS;
	const first = opts.today;
	const last = addDays(first, days - 1);
	try {
		const canonical = oh.prettifyValue();
		const rules = splitRules(canonical).map((r) =>
			parseRule(r.text, r.additional),
		);
		if (!rules.length) return skipped("no rules");
		const built = build(rules, first, last);
		const hours: OpeningHours = {
			source: "osm",
			...built,
			updatedAt: opts.updatedAt,
		};
		if (!matchesLibrary(hours, oh, first, days))
			return skipped("differs from the reference parser");
		return { kind: "hours", hours };
	} catch (e) {
		if (e instanceof Unsupported) return skipped(e.message);
		return skipped(
			`evaluation failed: ${e instanceof Error ? e.message : String(e)}`.slice(
				0,
				200,
			),
		);
	}
}

/** What one OSM fetch found for a node: its tag (null: none, or the object is gone). */
export type OsmFetch = { ref: string; tag: string | null; fetchedAt: string };

/**
 * The node's details after an OSM fetch, or null when they must not change
 * (E1 precedence):
 *
 * - manual hours are never touched (a person confirmed them), nor are Google
 *   hours (another source; OSM doesn't replace them);
 * - OSM hours, or none, take the new fetch: its hours, the raw tag as a note
 *   when the model can't say it, or nothing when OSM has no hours (the tag
 *   was removed, or the node now points at another object);
 * - `openingHoursFetchedAt` / `openingHoursRef` record the fetch either way.
 *
 * A manual edit (`node.hours`) stores `source: 'manual'`, so an edited OSM
 * record is never overwritten again.
 */
export function mergeOsmHours(
	details: NodeDetails,
	fetch: OsmFetch,
	opts: { today: string },
): NodeDetails | null {
	const current = details.openingHours;
	if (current && current.source !== "osm") return null;
	const next: NodeDetails = {
		...details,
		openingHoursFetchedAt: fetch.fetchedAt,
		openingHoursRef: fetch.ref,
	};
	const conv = fetch.tag?.trim()
		? convertOsmHours(fetch.tag, {
				updatedAt: fetch.fetchedAt,
				today: opts.today,
			})
		: null;
	if (conv) {
		// Unchanged hours keep their date (the week didn't change).
		const same =
			current &&
			stableJson({ ...current, updatedAt: "" }) ===
				stableJson({ ...conv.hours, updatedAt: "" });
		next.openingHours = same ? current : conv.hours;
	} else delete next.openingHours;
	return next;
}

/** Whether the merge changed the hours themselves (not just the fetch stamp). */
export function hoursChanged(before: NodeDetails, after: NodeDetails): boolean {
	return (
		stableJson(before.openingHours ?? null) !==
		stableJson(after.openingHours ?? null)
	);
}

/** JSON with sorted keys: Postgres `jsonb` doesn't keep the key order. */
function stableJson(v: unknown): string {
	return JSON.stringify(v, (_k, x: unknown) =>
		x && typeof x === "object" && !Array.isArray(x)
			? Object.fromEntries(
					Object.entries(x as Record<string, unknown>).sort(([a], [b]) =>
						a < b ? -1 : a > b ? 1 : 0,
					),
				)
			: x,
	);
}
