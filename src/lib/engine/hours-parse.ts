/**
 * E1 parser for the sheet's free-text hours (EXTENSIONS §4.2), WP-Insights.
 * Pure; its tests use the sheet's real strings (the §4.2 table plus every
 * "Open Hours" value of the Asia 2027 itinerary).
 *
 * How a string is read:
 * - Top-level parentheses are overrides or notes of the clause they sit in
 *   ("(Fri–Sat to 22:00)", "(last adm 21:20)", "(some sources list closed Wed
 *   — confirm)"). The rest splits into clauses on `;`, `,` and a spaced `—`.
 * - The first clause with a time range is the base (all week unless it names
 *   days). Later clauses or parentheses that name days override those days
 *   ("Sun/hol to 19:00", "wknd/hol from 10:00"). A range with some other
 *   label ("prayers 9:00–16:00", "diner to 22:00") is not the venue's hours
 *   and goes to `unparsed`, as does anything else the parser can't read.
 * - "24h" is `alwaysOpen`; a labelled one ("Grounds 24h", "Park 24h") wins
 *   over other ranges but is only medium confidence.
 * - Hedges (`~ usually some many verify check confirm`) make the result
 *   medium confidence; a hedged closure is only approximate (info).
 * - Tour or timed-slot wording ("tour", "timed", "slots", "departure",
 *   "start") drops that clause's range into `unparsed`.
 */
import type { HoursPeriod, OpeningHours } from "@/lib/schemas/hours";
import type { HoursConfidence } from "./hours";

export type ParsedHours = {
	hours: OpeningHours | null;
	confidence: HoursConfidence;
	/** Weekdays (0 Sun … 6 Sat) with an approximate closure (info only). */
	approxClosures: number[];
	/** What the parser couldn't read ("prayers 9:00–16:00"). */
	unparsed: string;
};

/** `updatedAt` of hours derived from the sheet (never stored). */
export const SHEET_HOURS_UPDATED_AT = "1970-01-01T00:00:00.000Z";

const ALL_WEEK = [0, 1, 2, 3, 4, 5, 6];

const HEDGE_RE =
	/~|\b(usually|some|many|verify|check|confirm|about|approx(?:imately)?|roughly|around|mostly|typically|generally)\b/i;
const TOUR_RE =
	/\b(tours?|timed|slots?|departures?|departs?|timetable|starts?|sessions?|shows?|bus|buses|ferry|ferries|check-?in|check-?out|reserve[ds]?|reservations?)\b/i;
const ALWAYS_RE = /(?:^|[^\d:])24\s?(?:h|hrs?|hours)\b|\b24\/7\b/i;
const TIME = String.raw`\d{1,2}(?::\d{2})?(?:\s*[ap]\.?m\.?)?`;
const RANGE_RE = new RegExp(
	String.raw`(~\s*)?(${TIME})\s*-\s*(~\s*)?(${TIME})(\+)?`,
	"i",
);
const FROM_RE = new RegExp(String.raw`\bfrom\s+(~\s*)?(${TIME})`, "i");
const TO_RE = new RegExp(
	String.raw`\b(?:to|until|till)\s+(~\s*)?(${TIME})`,
	"i",
);
const LAST_ENTRY_RE = new RegExp(
	String.raw`\blast\s+(?:entry|entrance|adm(?:ission|ittance)?|admission|order)\b\.?\s*:?\s*(?:(-?\s*\d{1,3})\s*min(?:ute)?s?(?:\s+before(?:\s+clos(?:e|ing))?)?|(?:at\s+)?~?\s*(${TIME}))`,
	"i",
);
/** A unit right after a range means it isn't a time of day ("2–3 hrs"). */
const UNIT_AFTER_RE = /^\s*(h\b|hrs?\b|hours?\b|min|km|%|x\b|\/|nights?\b)/i;

const DAY_WORDS: [RegExp, number[]][] = [
	[/^sun(?:day)?s?$/, [0]],
	[/^mon(?:day)?s?$/, [1]],
	[/^(?:tue|tues|tuesday)s?$/, [2]],
	[/^(?:wed|weds|wednesday)s?$/, [3]],
	[/^(?:thu|thur|thurs|thursday)s?$/, [4]],
	[/^fri(?:day)?s?$/, [5]],
	[/^sat(?:urday)?s?$/, [6]],
	[/^(?:hol|hols|holidays?|ph)$/, [7]],
	[/^(?:wknd|wknds|weekends?)$/, [0, 6]],
	[/^(?:weekdays?|wkdys?)$/, [1, 2, 3, 4, 5]],
	[/^daily$/, ALL_WEEK],
];
const WEEKDAY_STEMS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
const DAY_ALT =
	"(sun(?:day)?|mon(?:day)?|tue(?:s(?:day)?)?|wed(?:s|nesday)?|thu(?:r(?:s(?:day)?)?)?|fri(?:day)?|sat(?:urday)?)";
const DAY_RANGE_RE = new RegExp(
	String.raw`\b${DAY_ALT}\.?\s*-\s*${DAY_ALT}\b`,
	"i",
);
const NTH_WORDS: Record<string, number> = {
	"1st": 1,
	first: 1,
	"2nd": 2,
	second: 2,
	"3rd": 3,
	third: 3,
	"4th": 4,
	fourth: 4,
	"5th": 5,
	fifth: 5,
	last: -1,
};
/** Words that carry no venue label ("from", months, hedges, "public"). */
const FILLER = new Set([
	"from",
	"to",
	"until",
	"till",
	"open",
	"opens",
	"opening",
	"hours",
	"hrs",
	"h",
	"every",
	"day",
	"days",
	"and",
	"or",
	"the",
	"in",
	"on",
	"at",
	"of",
	"am",
	"pm",
	"a",
	"p",
	"m",
	"approx",
	"approximately",
	"around",
	"about",
	"roughly",
	"usually",
	"some",
	"many",
	"mostly",
	"typically",
	"generally",
	"verify",
	"check",
	"confirm",
	"public",
	"also",
	"sunrise",
	"sunset",
	"noon",
	"midnight",
	"jan",
	"january",
	"feb",
	"february",
	"mar",
	"march",
	"apr",
	"april",
	"may",
	"jun",
	"june",
	"jul",
	"july",
	"aug",
	"august",
	"sep",
	"sept",
	"september",
	"oct",
	"october",
	"nov",
	"november",
	"dec",
	"december",
]);

type Closure = { days: number[]; nth: number[]; hedged: boolean };

type Clause = {
	/** The clause as written (for `unparsed`). */
	text: string;
	hedged: boolean;
	tour: boolean;
	/** A venue part other than the whole ("prayers", "diner", "Main hall"). */
	label: string | null;
	days: number[] | null;
	range: { open: string; close: string } | null;
	from: string | null;
	to: string | null;
	always: boolean;
	closure: Closure | null;
	lastEntry: string | null;
	lastEntryMin: number | null;
	/** Parenthesised overrides and notes (only on top-level clauses). */
	parens: Clause[];
	/** Nothing but hedge words ("(verify)"). */
	hedgeOnly: boolean;
};

const pad2 = (n: number) => String(n).padStart(2, "0");

/** "9", "9:30", "5 PM", "12am", "24:00" → "HH:mm" (null when invalid). */
function toHHmm(raw: string): string | null {
	const m = /^(\d{1,2})(?::(\d{2}))?\s*(?:([ap])\.?m\.?)?$/i.exec(raw.trim());
	if (!m) return null;
	let h = Number(m[1]);
	const min = m[2] === undefined ? 0 : Number(m[2]);
	const ap = m[3]?.toLowerCase();
	if (min > 59) return null;
	if (ap) {
		if (h < 1 || h > 12) return null;
		if (ap === "p" && h !== 12) h += 12;
		if (ap === "a" && h === 12) h = 0;
	}
	if (h > 24 || (h === 24 && min > 0)) return null;
	return `${pad2(h)}:${pad2(min)}`;
}

const isBare = (raw: string) => /^\d{1,2}$/.test(raw.trim());

/** Every day number named in `text` ("Mon–Sat", "Sun/hol", "Wed & Fri", "wknd"). */
function daysIn(text: string): number[] | null {
	const out = new Set<number>();
	let rest = text.toLowerCase();
	for (;;) {
		const r = DAY_RANGE_RE.exec(rest);
		if (!r) break;
		const a = WEEKDAY_STEMS.indexOf(r[1]?.toLowerCase().slice(0, 3) ?? "");
		const b = WEEKDAY_STEMS.indexOf(r[2]?.toLowerCase().slice(0, 3) ?? "");
		if (a >= 0 && b >= 0)
			for (let d = a; ; d = (d + 1) % 7) {
				out.add(d);
				if (d === b) break;
			}
		rest =
			rest.slice(0, r.index) +
			" ".repeat(r[0].length) +
			rest.slice(r.index + r[0].length);
	}
	for (const word of rest.split(/[^a-z]+/)) {
		if (!word) continue;
		for (const [re, days] of DAY_WORDS)
			if (re.test(word)) for (const d of days) out.add(d);
	}
	return out.size ? [...out].sort((x, y) => x - y) : null;
}

const isDayWord = (w: string) => DAY_WORDS.some(([re]) => re.test(w));

/** The words left once times, days, hedges and fillers are gone: a venue label. */
function labelOf(text: string): string | null {
	const words = text
		.replace(new RegExp(TIME, "gi"), " ")
		.toLowerCase()
		.split(/[^a-z]+/)
		.filter(
			(w) =>
				w.length > 0 &&
				!FILLER.has(w) &&
				!isDayWord(w) &&
				!WEEKDAY_STEMS.includes(w) &&
				!NTH_WORDS[w] &&
				w !== "closed" &&
				w !== "last" &&
				w !== "entry" &&
				w !== "adm" &&
				w !== "admission" &&
				w !== "min" &&
				w !== "mins",
		);
	return words.length ? words.join(" ") : null;
}

/** "closed 2nd Tue", "closed Wed & Fri", "many closed Sun" → the closure, and the text without it. */
function takeClosure(text: string): { closure: Closure | null; rest: string } {
	const at = text.search(/\bclosed\b/i);
	if (at < 0) return { closure: null, rest: text };
	const after = text.slice(at + "closed".length);
	const tail = after.split(/\b(?:except|but|or|if)\b/i)[0] ?? after;
	const nth: number[] = [];
	for (const w of tail.toLowerCase().split(/[^a-z0-9]+/)) {
		const n = NTH_WORDS[w];
		if (n !== undefined && !nth.includes(n)) nth.push(n);
	}
	const days = (daysIn(tail) ?? []).filter((d) => d <= 7);
	if (!days.length) return { closure: null, rest: text };
	return {
		closure: { days, nth, hedged: HEDGE_RE.test(text) },
		rest: text.slice(0, at),
	};
}

function parseClause(text: string, parens: string[]): Clause {
	const hedged = HEDGE_RE.test(text);
	let body = text;
	const { closure, rest } = takeClosure(body);
	body = rest;

	let lastEntry: string | null = null;
	let lastEntryMin: number | null = null;
	const le = LAST_ENTRY_RE.exec(body);
	if (le) {
		if (le[1] !== undefined)
			lastEntryMin = Math.abs(Number(le[1].replace(/\s/g, "")));
		else if (le[2] !== undefined) lastEntry = toHHmm(le[2]);
		body = `${body.slice(0, le.index)} ${body.slice(le.index + le[0].length)}`;
	}

	const always = ALWAYS_RE.test(` ${body}`);
	if (always) body = ` ${body}`.replace(ALWAYS_RE, " ");

	let range: Clause["range"] = null;
	const r = RANGE_RE.exec(body);
	if (r) {
		const a = r[2] ?? "";
		const b = r[4] ?? "";
		const after = body.slice(r.index + r[0].length);
		const bareBoth = isBare(a) && isBare(b);
		const open = toHHmm(a);
		let close = toHHmm(b);
		// "8:30–9 AM": the meridiem of the end applies to a bare start.
		const okShape =
			!UNIT_AFTER_RE.test(after) && (!bareBoth || Number(a) <= 24);
		if (open && close && okShape) {
			if (close === "00:00") close = "24:00";
			range = { open, close };
			body = `${body.slice(0, r.index)} ${after}`;
		}
	}
	let from: string | null = null;
	let to: string | null = null;
	if (!range) {
		const f = FROM_RE.exec(body);
		if (f?.[2]) {
			from = toHHmm(f[2]);
			body = `${body.slice(0, f.index)} ${body.slice(f.index + f[0].length)}`;
		}
		const t = TO_RE.exec(body);
		if (t?.[2]) {
			to = toHHmm(t[2]);
			if (to === "00:00") to = "24:00";
			body = `${body.slice(0, t.index)} ${body.slice(t.index + t[0].length)}`;
		}
	}

	const tourHere = TOUR_RE.test(text);
	const parsedParens = parens.map((p) => parseClause(p, []));
	const label = labelOf(body.replace(/[⚠+~]/g, " "));
	const hedgeOnly =
		!range &&
		!from &&
		!to &&
		!always &&
		!closure &&
		!lastEntry &&
		lastEntryMin === null &&
		hedged &&
		label === null;
	return {
		text: text.trim(),
		hedged,
		tour: tourHere || parsedParens.some((p) => p.tour && !p.range),
		label,
		days: daysIn(body),
		range,
		from,
		to,
		always,
		closure,
		lastEntry,
		lastEntryMin,
		parens: parsedParens,
		hedgeOnly,
	};
}

/** Dashes and minus signs → "-" for the regexes (the written text keeps them). */
const normDashes = (s: string) =>
	s.replace(/[\u2010-\u2014\u2212\uFE58\uFE63\uFF0D]/g, "-");

/** Splits into top-level clauses, each with the parentheses written inside it. */
function clausesOf(text: string): Clause[] {
	const norm = text.replace(/\s+/g, " ").trim();
	// Pull out top-level parentheses, leaving a marker per group.
	const groups: string[] = [];
	let main = "";
	let depth = 0;
	let cur = "";
	for (const ch of norm) {
		if (ch === "(") {
			if (depth === 0) cur = "";
			else cur += ch;
			depth++;
		} else if (ch === ")" && depth > 0) {
			depth--;
			if (depth === 0) {
				main += ` \uE000${groups.length}\uE000 `;
				groups.push(cur.trim());
			} else cur += ch;
		} else if (depth > 0) cur += ch;
		else main += ch;
	}
	if (depth > 0) main += ` ${cur}`;
	const out: Clause[] = [];
	for (const raw of main.split(/;|,\s|\s\u2014\s/)) {
		const parens: string[] = [];
		const text = raw
			.replace(/\uE000(\d+)\uE000/g, (_m, i: string) => {
				parens.push(groups[Number(i)] ?? "");
				return "";
			})
			.replace(/\s+/g, " ")
			.trim();
		if (!text && !parens.length) continue;
		const written = [text, ...parens.map((p) => `(${p})`)].join(" ").trim();
		const c = parseClause(
			normDashes(text),
			// Inside parentheses a dash is punctuation ("closed Wed — confirm").
			parens.map((p) => normDashes(p.replace(/\s\u2014\s|\u2014/g, " "))),
		);
		c.text = written;
		c.parens.forEach((pc, i) => {
			pc.text = `(${parens[i] ?? ""})`;
		});
		out.push(c);
	}
	return out;
}

const NULL_RESULT = (text: string): ParsedHours => ({
	hours: null,
	confidence: "low",
	approxClosures: [],
	unparsed: text.trim(),
});

export function parseOpeningHours(text: string): ParsedHours {
	if (!text?.trim()) return NULL_RESULT("");
	const clauses = clausesOf(text.slice(0, 1000));

	// A range written only inside the parentheses ("Sunrise–sunset (~6:00–17:00 in Oct)").
	for (const c of clauses) {
		if (c.range || c.always || c.tour) continue;
		const p = c.parens.find((x) => x.range && !x.days && !x.label && !x.tour);
		if (p?.range) {
			c.range = p.range;
			c.hedged ||= p.hedged;
			c.parens = c.parens.filter((x) => x !== p);
		}
	}

	const unparsed: string[] = [];
	const approx = new Set<number>();
	const closedDays = new Set<number>();
	const closedNth: { day: number; nth: number }[] = [];
	let hedged = false;
	let lastEntry: string | null = null;
	let lastEntryMin: number | null = null;

	const closureOf = (c: Closure) => {
		if (c.hedged) {
			hedged = true;
			for (const d of c.days) if (d <= 6) approx.add(d);
			return;
		}
		if (c.nth.length) {
			for (const d of c.days)
				for (const n of c.nth)
					if (
						d <= 6 &&
						closedNth.length < 4 &&
						!closedNth.some((x) => x.day === d && x.nth === n)
					)
						closedNth.push({ day: d, nth: n });
			return;
		}
		for (const d of c.days) if (d <= 6) closedDays.add(d);
	};
	const noteOf = (c: Clause) => {
		if (c.closure) closureOf(c.closure);
		if (c.lastEntry) lastEntry = c.lastEntry;
		if (c.lastEntryMin !== null) lastEntryMin = c.lastEntryMin;
		const usedSomething = c.closure || c.lastEntry || c.lastEntryMin !== null;
		if (c.hedgeOnly) hedged = true;
		else if (!usedSomething) unparsed.push(c.text);
	};

	const alwaysClause = clauses.find((c) => c.always && !c.tour);
	const dayMap = new Map<number, { open: string; close: string }[]>();
	let alwaysOpen = false;
	let labelledAlways = false;

	if (alwaysClause) {
		alwaysOpen = true;
		labelledAlways = alwaysClause.label !== null;
		for (const c of clauses) {
			if (c === alwaysClause) {
				for (const p of c.parens) if (p.closure || p.hedgeOnly) noteOf(p);
				if (c.closure) closureOf(c.closure);
				continue;
			}
			if (c.closure && !c.range && !c.label) closureOf(c.closure);
			else if (c.text) unparsed.push(c.text);
		}
	} else {
		const primary = clauses.find((c) => c.range && !c.tour);
		const baseDays = primary?.days ?? ALL_WEEK;
		const base = primary?.range ?? null;
		const override = (
			days: number[],
			open: string | null,
			close: string | null,
		) => {
			if (!base) return;
			for (const d of days)
				dayMap.set(d, [
					{ open: open ?? base.open, close: close ?? base.close },
				]);
		};
		if (primary && base) {
			hedged ||= primary.hedged;
			for (const d of baseDays) dayMap.set(d, [{ ...base }]);
			if (primary.lastEntry) lastEntry = primary.lastEntry;
			if (primary.lastEntryMin !== null) lastEntryMin = primary.lastEntryMin;
			if (primary.closure) closureOf(primary.closure);
		}
		const overrideOrNote = (c: Clause) => {
			const timed = c.range || c.from || c.to;
			if (base && timed && c.days && !c.label && !c.tour) {
				override(c.days, c.range?.open ?? c.from, c.range?.close ?? c.to);
				hedged ||= c.hedged;
				if (c.closure) closureOf(c.closure);
				return;
			}
			if (base && c.range && !c.days && !c.label && !c.tour && !c.closure) {
				// A second shift for the same days ("10:00–12:00; 13:00–17:00").
				for (const d of baseDays) {
					const list = dayMap.get(d);
					if (list && list.length < 4) list.push({ ...c.range });
				}
				hedged ||= c.hedged;
				return;
			}
			if (timed) {
				unparsed.push(c.text);
				if (c.closure && !c.label) closureOf(c.closure);
				return;
			}
			noteOf(c);
		};
		for (const c of clauses) {
			if (c === primary) {
				for (const p of c.parens) overrideOrNote(p);
				continue;
			}
			if (c.tour && (c.range || c.from || c.to || !c.closure)) {
				unparsed.push(c.text);
				if (c.closure) closureOf(c.closure);
				continue;
			}
			overrideOrNote(c);
			for (const p of c.parens) if (p.closure || p.hedgeOnly) noteOf(p);
		}
	}

	const periods: HoursPeriod[] = [];
	if (dayMap.size) {
		for (const d of closedDays) dayMap.delete(d);
		for (const [day, list] of [...dayMap.entries()].sort((a, b) => a[0] - b[0]))
			for (const p of list) {
				const period: HoursPeriod = {
					day,
					open: p.open,
					close: p.close as HoursPeriod["close"],
				};
				if (lastEntry) period.lastEntry = lastEntry;
				periods.push(period);
			}
	}
	const unparsedText = [...new Set(unparsed.filter(Boolean))].join("; ");
	if (!alwaysOpen && !periods.length && !closedDays.size && !closedNth.length)
		return {
			...NULL_RESULT(unparsedText || text),
			approxClosures: [...approx].sort((a, b) => a - b),
		};

	const hours: OpeningHours = {
		source: "manual",
		periods: periods.slice(0, 40),
		updatedAt: SHEET_HOURS_UPDATED_AT,
	};
	if (alwaysOpen) hours.alwaysOpen = true;
	if (!periods.length && closedDays.size)
		hours.closedDays = [...closedDays].sort((a, b) => a - b);
	if (closedNth.length)
		hours.closedNth = closedNth.map((x) => ({
			day: x.day,
			nth: x.nth as -1 | 1 | 2 | 3 | 4 | 5,
		}));
	if (lastEntryMin !== null && !lastEntry)
		hours.lastEntryBeforeCloseMin = Math.min(240, lastEntryMin);
	const medium = hedged || labelledAlways || /⚠/.test(unparsedText);
	return {
		hours,
		confidence: medium ? "medium" : "high",
		approxClosures: [...approx].sort((a, b) => a - b),
		unparsed: unparsedText,
	};
}

/** Google Places (New) `regularOpeningHours.periods` → OpeningHours (`source: 'google'`). */
export function fromGooglePeriods(
	periods: readonly {
		open: { day: number; hour: number; minute?: number };
		close?: { day: number; hour: number; minute?: number };
	}[],
	updatedAt: string,
): OpeningHours {
	const hm = (h: number, m = 0) => `${pad2(h)}:${pad2(m)}`;
	// Open around the clock: one period that opens Sunday 00:00 and never closes.
	if (periods.length === 1 && !periods[0]?.close && periods[0]?.open.hour === 0)
		return { source: "google", alwaysOpen: true, periods: [], updatedAt };
	const out: HoursPeriod[] = [];
	const push = (day: number, open: string, close: string) => {
		if (out.length < 40 && day >= 0 && day <= 6)
			out.push({ day, open, close: close as HoursPeriod["close"] });
	};
	for (const p of periods) {
		const d1 = p.open.day;
		const open = hm(p.open.hour, p.open.minute);
		if (!p.close) {
			push(d1, open, "24:00");
			continue;
		}
		const d2 = p.close.day;
		const close = hm(p.close.hour, p.close.minute);
		const span = (d2 - d1 + 7) % 7;
		if (span === 0) {
			if (close > open) push(d1, open, close);
			else push(d1, open, close === "00:00" ? "24:00" : close);
		} else if (span === 1 && (close <= open || close === "00:00")) {
			push(d1, open, close === "00:00" ? "24:00" : close);
		} else {
			push(d1, open, "24:00");
			for (let k = 1; k < span; k++) push((d1 + k) % 7, "00:00", "24:00");
			if (close !== "00:00") push(d2, "00:00", close);
		}
	}
	out.sort((a, b) => a.day - b.day || a.open.localeCompare(b.open));
	return { source: "google", periods: out, updatedAt };
}
