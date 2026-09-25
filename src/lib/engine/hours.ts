/**
 * E1 hours issues (EXTENSIONS §4.1, §4.3), WP-Insights. Pure.
 *
 * - `effectiveHours`: manual > google > the sheet's `openHoursText`, parsed
 *   (memoised, never stored).
 * - `hoursOnDate`: what a place does on one local date: exceptions >
 *   `closedNth` > closed weekdays > weekday periods (holidays use day 7 when
 *   it has periods).
 * - `hoursIssues`: every scheduled visit checked in the NODE's zone. Past-
 *   midnight periods cover the early hours of the next day. Warn: `closed`,
 *   `after_close` (start ≥ close, or after the last entry), `closes_during`
 *   (ends after close). Info: `before_open`, `maybe_closed` (a hedged
 *   closure), `after_dark` (outdoor places starting ≥ sunset + 15 min).
 *   Medium confidence keeps its hedge ("Closes ~17:00 · 25m short"); low
 *   confidence raises only `closed` from explicit closures. Unlocated items,
 *   lodging, stations, airports and ports are skipped.
 * - `hoursFixes`: ≤ 2 fixes, "Move to Thu 8 Oct" (the nearest day of the same
 *   visit where the place is open at the current start) and "Unschedule".
 */
import type { HoursPeriod, OpeningHours } from "@/lib/schemas/hours";
import type { Holiday } from "@/lib/schemas/trips";
import { dayPlace } from "./day-place";
import type { GraphIndex } from "./graph-index";
import { type ParsedHours, parseOpeningHours } from "./hours-parse";
import { addDays, hhmm, localDateOf } from "./time";
import type {
	GraphNode,
	PlaceCategory,
	ScheduleResult,
	TripSettings,
} from "./types";

export type HoursSource = "manual" | "google" | "sheet";
export type HoursConfidence = "high" | "medium" | "low";

export type EffectiveHours = {
	hours: OpeningHours;
	source: HoursSource;
	confidence: HoursConfidence;
	/** The sheet text the hours were parsed from. */
	raw?: string;
	/** Sheet only: weekdays with a hedged closure ("many closed Sun"), info only. */
	approxClosures?: number[];
	/** Sheet only: what the parser couldn't read. */
	unparsed?: string;
};

export type HoursIssue = {
	kind:
		| "closed"
		| "after_close"
		| "closes_during"
		| "before_open"
		| "maybe_closed"
		| "after_dark";
	severity: "warn" | "info";
	label: string;
	close?: string;
	open?: string;
	source: HoursSource;
	hedged?: true;
};

export type HoursIssues = {
	byItem: Record<string, HoursIssue[]>;
	byDay: Record<string, { warn: number; info: number }>;
};

export type HoursFix =
	| {
			kind: "move";
			label: string;
			dayId: string;
			/** Where on that day, so the visit lands near its current time. */
			afterItemId?: string;
			beforeItemId?: string;
	  }
	| { kind: "unschedule"; label: string };

export const WEEKDAY_SHORT = [
	"Sun",
	"Mon",
	"Tue",
	"Wed",
	"Thu",
	"Fri",
	"Sat",
] as const;
const MONTH_SHORT = [
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
const NTH_LABEL: Record<number, string> = {
	1: "1st",
	2: "2nd",
	3: "3rd",
	4: "4th",
	5: "5th",
	[-1]: "last",
};

/** Places whose hours never matter for a visit (you sleep or travel there). */
const NO_HOURS_CATEGORIES = new Set<PlaceCategory>([
	"lodging",
	"station",
	"airport",
	"port",
]);
/** Outdoor places that are pointless after dark. */
const DAYLIGHT_CATEGORIES = new Set<PlaceCategory>([
	"viewpoint",
	"nature",
	"park",
	"beach",
]);

/** 0 Sun … 6 Sat of a calendar date (no zone involved). */
export function weekdayOf(date: string): number {
	return new Date(`${date}T00:00:00Z`).getUTCDay();
}

/** "Thu 8 Oct". */
export function shortDate(date: string): string {
	const d = new Date(`${date}T00:00:00Z`);
	if (Number.isNaN(d.getTime())) return date;
	return `${WEEKDAY_SHORT[d.getUTCDay()]} ${d.getUTCDate()} ${MONTH_SHORT[d.getUTCMonth()]}`;
}

/** "HH:mm" → minutes after midnight ("24:00" → 1440). */
export function toMinutes(hm: string): number {
	const [h = "0", m = "0"] = hm.split(":");
	return Number(h) * 60 + Number(m);
}

/** Minutes after midnight → "HH:mm" (wrapping past midnight). */
export function fromMinutes(min: number): string {
	const m = ((Math.round(min) % 1440) + 1440) % 1440;
	if (min === 1440) return "24:00";
	return `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
}

/** 25 → "25m", 70 → "1h 10m". */
function shortDuration(min: number): string {
	const h = Math.floor(min / 60);
	const m = Math.round(min % 60);
	return h ? (m ? `${h}h ${m}m` : `${h}h`) : `${m}m`;
}

// ---------------------------------------------------------------------------
// Effective hours
// ---------------------------------------------------------------------------

const sheetMemo = new Map<string, ParsedHours>();

/** `parseOpeningHours`, memoised by text (sheet hours are derived, never stored). */
export function parseSheetHours(text: string): ParsedHours {
	let hit = sheetMemo.get(text);
	if (!hit) {
		hit = parseOpeningHours(text);
		if (sheetMemo.size > 2000) sheetMemo.clear();
		sheetMemo.set(text, hit);
	}
	return hit;
}

/** manual > google > parsed sheet text (`details.openHoursText`). */
export function effectiveHours(
	node: GraphNode,
	_settings: TripSettings,
): EffectiveHours | null {
	const h = node.details?.openingHours;
	if (h) return { hours: h, source: h.source, confidence: "high" };
	const text = node.details?.openHoursText;
	if (!text?.trim()) return null;
	const p = parseSheetHours(text);
	if (!p.hours) return null;
	return {
		hours: p.hours,
		source: "sheet",
		confidence: p.confidence,
		raw: text,
		approxClosures: p.approxClosures,
		unparsed: p.unparsed,
	};
}

// ---------------------------------------------------------------------------
// One date
// ---------------------------------------------------------------------------

export type OpenPeriod = {
	/** Minutes after the date's local midnight. */
	open: number;
	/** May pass 1440 (closes after midnight). */
	close: number;
	lastEntry: number | null;
};

export type DayHours =
	| { state: "always" }
	| {
			state: "closed";
			label: string;
			/** `weekday`: no period that weekday; the others are explicit closures. */
			why: "exception" | "nth" | "closedDays" | "weekday";
	  }
	| {
			state: "open";
			periods: OpenPeriod[];
			holiday: boolean;
			exception?: string;
	  }
	/** Only closures are known (no periods). */
	| { state: "unknown" };

function nthMatches(date: string, nth: number): boolean {
	const d = new Date(`${date}T00:00:00Z`);
	const dom = d.getUTCDate();
	if (nth === -1) {
		const next = new Date(d);
		next.setUTCDate(dom + 7);
		return next.getUTCMonth() !== d.getUTCMonth();
	}
	return Math.ceil(dom / 7) === nth;
}

function toOpenPeriods(
	list: readonly Pick<HoursPeriod, "open" | "close" | "lastEntry">[],
	beforeCloseMin: number | undefined,
): OpenPeriod[] {
	return list.map((p) => {
		const open = toMinutes(p.open);
		let close = p.close === "24:00" ? 1440 : toMinutes(p.close);
		if (close <= open) close += 1440;
		let lastEntry: number | null = null;
		if (p.lastEntry) {
			lastEntry = toMinutes(p.lastEntry);
			if (lastEntry < open) lastEntry += 1440;
		} else if (beforeCloseMin) lastEntry = close - beforeCloseMin;
		return { open, close, lastEntry };
	});
}

/** What a place does on one local `date` (EXTENSIONS §4.3 order). */
export function hoursOnDate(
	h: OpeningHours,
	date: string,
	holiday: Holiday | null,
): DayHours {
	const ex = h.exceptions?.find((e) => e.date === date);
	if (ex) {
		if (ex.closed || !ex.periods?.length)
			return {
				state: "closed",
				label: ex.label ? `Closed · ${ex.label}` : `Closed ${shortDate(date)}`,
				why: "exception",
			};
		return {
			state: "open",
			periods: toOpenPeriods(ex.periods, h.lastEntryBeforeCloseMin),
			holiday: false,
			...(ex.label ? { exception: ex.label } : {}),
		};
	}
	if (h.alwaysOpen) return { state: "always" };
	const wd = weekdayOf(date);
	for (const n of h.closedNth ?? [])
		if (n.day === wd && nthMatches(date, n.nth))
			return {
				state: "closed",
				label: `Closed ${NTH_LABEL[n.nth] ?? ""} ${WEEKDAY_SHORT[wd]}`,
				why: "nth",
			};
	if (h.closedDays?.includes(wd))
		return {
			state: "closed",
			label: `Closed ${WEEKDAY_SHORT[wd]}`,
			why: "closedDays",
		};
	if (!h.periods.length) return { state: "unknown" };
	const hol = holiday ? h.periods.filter((p) => p.day === 7) : [];
	const list = hol.length ? hol : h.periods.filter((p) => p.day === wd);
	if (!list.length)
		return {
			state: "closed",
			label: `Closed ${WEEKDAY_SHORT[wd]}`,
			why: "weekday",
		};
	return {
		state: "open",
		periods: toOpenPeriods(list, h.lastEntryBeforeCloseMin),
		holiday: hol.length > 0,
	};
}

// ---------------------------------------------------------------------------
// One visit
// ---------------------------------------------------------------------------

export type VisitCheck = {
	eh: EffectiveHours;
	/** The local date the visit starts on, in the node's zone. */
	date: string;
	/** Minutes after that date's midnight. */
	startMin: number;
	endMin: number;
	holidayOf: (date: string) => Holiday | null;
};

/** The hours issues of one visit (no `after_dark`; that needs the sun). */
export function checkVisit({
	eh,
	date,
	startMin,
	endMin,
	holidayOf,
}: VisitCheck): HoursIssue[] {
	const h = eh.hours;
	const source = eh.source;
	const hedged = eh.confidence === "medium";
	const t = (min: number) => `${hedged ? "~" : ""}${fromMinutes(min)}`;
	const extra = hedged ? ({ hedged: true } as const) : {};
	const out: HoursIssue[] = [];
	const wd = weekdayOf(date);
	if (eh.approxClosures?.includes(wd) && eh.confidence !== "low")
		out.push({
			kind: "maybe_closed",
			severity: "info",
			label: `May be closed ${WEEKDAY_SHORT[wd]}`,
			source,
			...extra,
		});

	const today = hoursOnDate(h, date, holidayOf(date));
	if (today.state === "always" || today.state === "unknown") return out;

	// Periods of the previous date that run past midnight cover the early hours.
	const prevDate = addDays(date, -1);
	const prev = hoursOnDate(h, prevDate, holidayOf(prevDate));
	const carry: OpenPeriod[] =
		prev.state === "open"
			? prev.periods
					.filter((p) => p.close > 1440)
					.map((p) => ({
						open: 0,
						close: p.close - 1440,
						lastEntry:
							p.lastEntry !== null && p.lastEntry >= 1440
								? p.lastEntry - 1440
								: null,
					}))
			: prev.state === "always"
				? [{ open: 0, close: 1440, lastEntry: null }]
				: [];

	if (eh.confidence === "low") {
		// Only explicit closures count at low confidence.
		if (
			today.state === "closed" &&
			today.why !== "weekday" &&
			!carry.some((p) => startMin < p.close)
		)
			out.push({
				kind: "closed",
				severity: "warn",
				label: today.label,
				source,
			});
		return out;
	}

	const intervals = [
		...carry,
		...(today.state === "open" ? today.periods : []),
	];
	const covering = intervals
		.filter((p) => p.open <= startMin && startMin < p.close)
		.sort((a, b) => b.close - a.close)[0];

	if (!covering) {
		if (today.state === "closed") {
			out.push({
				kind: "closed",
				severity: "warn",
				label: today.label,
				source,
			});
			return out;
		}
		const later = intervals
			.filter((p) => p.open > startMin)
			.sort((a, b) => a.open - b.open)[0];
		if (later) {
			out.push({
				kind: "before_open",
				severity: "info",
				label: `Opens ${t(later.open)}`,
				open: fromMinutes(later.open),
				source,
				...extra,
			});
			return out;
		}
		const last = intervals.sort((a, b) => b.close - a.close)[0];
		if (last)
			out.push({
				kind: "after_close",
				severity: "warn",
				label: `Closes ${t(last.close)}`,
				close: fromMinutes(last.close),
				source,
				...extra,
			});
		return out;
	}
	if (covering.lastEntry !== null && startMin > covering.lastEntry) {
		out.push({
			kind: "after_close",
			severity: "warn",
			label: `Last entry ${t(covering.lastEntry)}`,
			close: fromMinutes(covering.close),
			source,
			...extra,
		});
		return out;
	}
	if (endMin > covering.close)
		out.push({
			kind: "closes_during",
			severity: "warn",
			label: `Closes ${t(covering.close)} · ${shortDuration(endMin - covering.close)} short`,
			close: fromMinutes(covering.close),
			source,
			...extra,
		});
	return out;
}

// ---------------------------------------------------------------------------
// The trip
// ---------------------------------------------------------------------------

/** The country code of a node or its nearest ancestor. */
export function countryOf(ix: GraphIndex, nodeId: string): string | null {
	const path = ix.path(nodeId);
	for (let i = path.length - 1; i >= 0; i--) {
		const cc = path[i]?.countryCode;
		if (cc) return cc;
	}
	return null;
}

export function holidayFinder(
	ix: GraphIndex,
	holidays: readonly Holiday[],
	nodeId: string,
): (date: string) => Holiday | null {
	if (!holidays.length) return () => null;
	const cc = countryOf(ix, nodeId);
	return (date) =>
		holidays.find(
			(h) => h.date === date && (!h.countryCode || !cc || h.countryCode === cc),
		) ?? null;
}

/** Whether a node's hours are checked at all (not lodging or transport). */
export function hoursApply(node: GraphNode | undefined): node is GraphNode {
	return !!node && !(node.category && NO_HOURS_CATEGORIES.has(node.category));
}

type Ctx = {
	hoursOf: (nodeId: string) => EffectiveHours | null;
	holidays: readonly Holiday[];
	sunOf?: (dayId: string) => { sunset: string } | null;
};

/** The local start of a scheduled item in its node's zone. */
function visitTimes(
	ix: GraphIndex,
	schedule: ScheduleResult,
	itemId: string,
	nodeId: string,
) {
	const s = schedule.items[itemId];
	if (!s) return null;
	const tz = ix.tzOf(nodeId);
	const date = localDateOf(s.start, tz);
	const startMin = toMinutes(hhmm(s.start, tz));
	const endMin =
		startMin +
		Math.max(0, Math.round((s.end.getTime() - s.start.getTime()) / 60_000));
	return { date, startMin, endMin, tz };
}

export function hoursIssues(
	ix: GraphIndex,
	schedule: ScheduleResult,
	ctx: Ctx,
): HoursIssues {
	const byItem: Record<string, HoursIssue[]> = {};
	const byDay: Record<string, { warn: number; info: number }> = {};
	for (const [dayId, items] of ix.itemsByDay) {
		const day = ix.day(dayId);
		if (!day) continue;
		for (const item of items) {
			if (!item.nodeId) continue;
			const node = ix.node(item.nodeId);
			if (!hoursApply(node)) continue;
			const v = visitTimes(ix, schedule, item.id, node.id);
			if (!v) continue;
			const issues: HoursIssue[] = [];
			const eh = ctx.hoursOf(node.id);
			if (eh)
				issues.push(
					...checkVisit({
						eh,
						date: v.date,
						startMin: v.startMin,
						endMin: v.endMin,
						holidayOf: holidayFinder(ix, ctx.holidays, node.id),
					}),
				);
			if (
				ctx.sunOf &&
				node.category &&
				DAYLIGHT_CATEGORIES.has(node.category)
			) {
				const sun = ctx.sunOf(dayId);
				if (sun?.sunset) {
					const late =
						v.date > day.date || v.startMin >= toMinutes(sun.sunset) + 15;
					if (late)
						issues.push({
							kind: "after_dark",
							severity: "info",
							label: `After dark · sunset ${sun.sunset}`,
							source: eh?.source ?? "sheet",
						});
				}
			}
			if (!issues.length) continue;
			byItem[item.id] = issues;
			const c = byDay[dayId] ?? { warn: 0, info: 0 };
			byDay[dayId] = c;
			if (issues.some((i) => i.severity === "warn")) c.warn++;
			else c.info++;
		}
	}
	return { byItem, byDay };
}

/** Warn issues first, then info; stable otherwise. */
export function worstIssue(
	issues: readonly HoursIssue[] | undefined,
): HoursIssue | null {
	if (!issues?.length) return null;
	return issues.find((i) => i.severity === "warn") ?? issues[0] ?? null;
}

/** ≤ 2 fixes: "Move to Thu 8 Oct" (same visit, fits at the current start) and "Unschedule". */
export function hoursFixes(
	ix: GraphIndex,
	schedule: ScheduleResult,
	itemId: string,
	issue: HoursIssue,
	ctx?: Partial<Ctx>,
): HoursFix[] {
	if (issue.severity !== "warn") return [];
	const item = ix.item(itemId);
	if (!item?.dayId || !item.nodeId) return [];
	const node = ix.node(item.nodeId);
	const hoursOf =
		ctx?.hoursOf ??
		((id: string) => {
			const n = ix.node(id);
			return n ? effectiveHours(n, ix.trip.settings) : null;
		});
	const holidays = ctx?.holidays ?? ix.trip.settings.holidays ?? [];
	const eh = node ? hoursOf(node.id) : null;
	const v = node ? visitTimes(ix, schedule, item.id, node.id) : null;
	const fixes: HoursFix[] = [];
	const days = ix.days;
	const at = days.findIndex((d) => d.id === item.dayId);
	if (node && eh && v && at >= 0) {
		const city = dayPlace(ix, schedule, item.dayId);
		// The same visit: the contiguous run of days around this one in the same place.
		let lo = at;
		let hi = at;
		while (lo > 0 && dayPlace(ix, schedule, days[lo - 1]?.id ?? "") === city)
			lo--;
		while (
			hi < days.length - 1 &&
			dayPlace(ix, schedule, days[hi + 1]?.id ?? "") === city
		)
			hi++;
		const dayShift = v.date > (days[at]?.date ?? v.date) ? 1 : 0;
		const holidayOf = holidayFinder(ix, holidays, node.id);
		for (let dist = 1; dist <= Math.max(at - lo, hi - at); dist++) {
			const found = [at + dist, at - dist].find((k) => {
				if (k < lo || k > hi) return false;
				const d = days[k];
				if (!d) return false;
				return !checkVisit({
					eh,
					date: addDays(d.date, dayShift),
					startMin: v.startMin,
					endMin: v.endMin,
					holidayOf,
				}).some((i) => i.severity === "warn");
			});
			if (found === undefined) continue;
			const target = days[found];
			if (!target) break;
			const fix: HoursFix = {
				kind: "move",
				label: `Move to ${shortDate(target.date)}`,
				dayId: target.id,
			};
			const others = (ix.itemsByDay.get(target.id) ?? []).filter(
				(x) => x.id !== item.id,
			);
			let after: string | undefined;
			for (const o of others) {
				const s = schedule.items[o.id];
				if (!s) continue;
				const tz = o.nodeId ? ix.tzOf(o.nodeId) : v.tz;
				const oStart =
					toMinutes(hhmm(s.start, tz)) +
					(localDateOf(s.start, tz) > target.date ? 1440 : 0);
				if (oStart <= v.startMin + dayShift * 1440) after = o.id;
			}
			if (after) fix.afterItemId = after;
			else if (others[0]) fix.beforeItemId = others[0].id;
			fixes.push(fix);
			break;
		}
	}
	fixes.push({ kind: "unschedule", label: "Unschedule" });
	return fixes.slice(0, 2);
}
