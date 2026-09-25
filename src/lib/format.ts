/**
 * Display formatting (DESIGN §12 "Voice"): 24-hour times, "45m" / "1h 30m"
 * durations, "Thu 15 Apr" dates, metric distances. Pure and SSR-safe: no
 * `toLocaleString()` of instants without an explicit zone (SPEC §0 rule 10).
 *
 * ADDENDUM §7.2 view settings: `setDisplayPrefs({ clock, units })` switches
 * `formatTime` / `TimeText` to 12-hour and `formatDistance` to miles for this
 * page (WP-Shell calls it from the synced prefs). The default is 24 h / km, and
 * the server never calls it, so server output is always 24 h / km.
 */
import { flightTimes } from "@/lib/engine/flights";
import { hhmm } from "@/lib/engine/time";
import type { GraphLeg } from "@/lib/engine/types";
import { type FlightDetails, readLegDetails } from "@/lib/schemas/legs";

// ---------------------------------------------------------------------------
// Display prefs (12/24 h, km/mi)
// ---------------------------------------------------------------------------

export type DisplayPrefs = { clock: "12h" | "24h"; units: "km" | "mi" };

export const DEFAULT_DISPLAY_PREFS: DisplayPrefs = {
	clock: "24h",
	units: "km",
};

let displayPrefs: DisplayPrefs = DEFAULT_DISPLAY_PREFS;
const displayListeners = new Set<() => void>();

/** The current page-wide display prefs (a stable object until they change). */
export function getDisplayPrefs(): DisplayPrefs {
	return displayPrefs;
}

/**
 * Sets the page-wide clock/units (missing or null keys keep their value).
 * Subscribers (`useDisplayPrefs`, `TimeText`) re-render when something changed.
 */
export function setDisplayPrefs(
	p: Partial<{
		clock: DisplayPrefs["clock"] | null;
		units: DisplayPrefs["units"] | null;
	}>,
): void {
	const next: DisplayPrefs = {
		clock: p.clock ?? displayPrefs.clock,
		units: p.units ?? displayPrefs.units,
	};
	if (next.clock === displayPrefs.clock && next.units === displayPrefs.units)
		return;
	displayPrefs = next;
	for (const fn of displayListeners) fn();
}

/** For `useSyncExternalStore`; returns the unsubscribe function. */
export function subscribeDisplayPrefs(fn: () => void): () => void {
	displayListeners.add(fn);
	return () => {
		displayListeners.delete(fn);
	};
}

// ---------------------------------------------------------------------------
// Durations
// ---------------------------------------------------------------------------

/** 45 → "45m", 90 → "1h 30m" (compact: "1h30"), 120 → "2h". */
export function formatDuration(
	minutes: number | null | undefined,
	opts: { compact?: boolean } = {},
): string {
	if (minutes === null || minutes === undefined || !Number.isFinite(minutes))
		return "–";
	const m = Math.max(0, Math.round(minutes));
	const h = Math.floor(m / 60);
	const r = m % 60;
	if (h === 0) return `${r}m`;
	if (r === 0) return `${h}h`;
	return opts.compact ? `${h}h${String(r).padStart(2, "0")}` : `${h}h ${r}m`;
}

/**
 * Typed durations → minutes (QA A-23): "90", "90m", "1h30", "1h 30m", "1.5h",
 * "1:30", "2h". Null for 0, negatives, non-numbers and more than 3 days.
 */
export function parseDuration(input: string): number | null {
	const s = input.trim().toLowerCase().replace(/\s+/g, "");
	if (!s) return null;
	for (const [re, toMinutes] of DURATION_FORMATS) {
		const m = s.match(re);
		if (!m) continue;
		const minutes = toMinutes(Number(m[1]), Number(m[2] ?? 0));
		if (!Number.isFinite(minutes) || minutes <= 0 || minutes > 4320)
			return null;
		return minutes;
	}
	return null;
}

const DURATION_FORMATS: [RegExp, (a: number, b: number) => number][] = [
	[/^(\d{1,4})(?:m|min|mins)?$/, (a) => a], // "90", "90m"
	[/^(\d{1,2}):([0-5]\d)$/, (h, m) => h * 60 + m], // "1:30"
	[/^(\d{1,2}(?:\.\d+)?)h$/, (h) => Math.round(h * 60)], // "1.5h", "2h"
	[/^(\d{1,2})h(\d{1,2})(?:m|min)?$/, (h, m) => h * 60 + m], // "1h30", "1h 30m"
];

/** 900 → "0.9 km", 12 400 → "12 km", 450 → "450 m". */
export function formatDistance(meters: number | null | undefined): string {
	if (meters === null || meters === undefined) return "";
	if (displayPrefs.units === "mi") {
		const mi = meters / 1609.344;
		// Under a tenth of a mile, feet (≈ 528 ft).
		if (mi < 0.1) return `${Math.round(meters / 0.3048)} ft`;
		return `${mi < 10 ? mi.toFixed(1) : Math.round(mi)} mi`;
	}
	if (meters < 1000) return `${Math.round(meters)} m`;
	const km = meters / 1000;
	return `${km < 10 ? km.toFixed(1) : Math.round(km)} km`;
}

// ---------------------------------------------------------------------------
// Dates and times
// ---------------------------------------------------------------------------

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
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

/** A calendar date (`YYYY-MM-DD`) as UTC midnight, so no host zone can shift it. */
function calendar(date: string): Date {
	return new Date(`${date}T00:00:00Z`);
}

/** "2027-04-15" → "Thu 15 Apr" (add the year with `{ year: true }`). */
export function formatDayDate(
	date: string,
	opts: { year?: boolean; weekday?: boolean } = {},
): string {
	const d = calendar(date);
	if (Number.isNaN(d.getTime())) return date;
	const parts = [
		opts.weekday === false ? null : WEEKDAYS[d.getUTCDay()],
		String(d.getUTCDate()),
		MONTHS[d.getUTCMonth()],
		opts.year ? String(d.getUTCFullYear()) : null,
	];
	return parts.filter(Boolean).join(" ");
}

/** "5–7 Oct", "30 Sep – 2 Oct", "2 Oct – 5 Nov 2027" (with `{ year: true }`). */
export function formatDateRange(
	from: string | null | undefined,
	to: string | null | undefined,
	opts: { year?: boolean } = {},
): string {
	if (!from) return "";
	const a = calendar(from);
	const b = calendar(to ?? from);
	const year = opts.year ? ` ${b.getUTCFullYear()}` : "";
	const sameYear = a.getUTCFullYear() === b.getUTCFullYear();
	if (from === (to ?? from))
		return `${a.getUTCDate()} ${MONTHS[a.getUTCMonth()]}${year}`;
	if (sameYear && a.getUTCMonth() === b.getUTCMonth())
		return `${a.getUTCDate()}–${b.getUTCDate()} ${MONTHS[b.getUTCMonth()]}${year}`;
	const left = `${a.getUTCDate()} ${MONTHS[a.getUTCMonth()]}${sameYear ? "" : ` ${a.getUTCFullYear()}`}`;
	return `${left} – ${b.getUTCDate()} ${MONTHS[b.getUTCMonth()]}${year}`;
}

/** Whole days from `today` to `date` (both `YYYY-MM-DD`); negative = past. */
export function daysUntil(date: string, today: string): number {
	return Math.round(
		(calendar(date).getTime() - calendar(today).getTime()) / 86_400_000,
	);
}

/** Today's calendar date in a zone (the browser's by default). Client-only. */
export function todayIn(tz?: string): string {
	const zone = tz ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
	const parts = new Intl.DateTimeFormat("en-CA", {
		timeZone: zone,
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
	}).format(new Date());
	return parts;
}

/** An instant as "11:42" in its zone. */
export function formatTime(at: Date | number, tz: string): string {
	const t = hhmm(at, tz);
	return displayPrefs.clock === "12h" ? to12h(t) : t;
}

/** "17:05" → "5:05pm", "00:30" → "12:30am" (the 12-hour view setting). */
export function to12h(hhmmText: string): string {
	const m = /^(\d{1,2}):(\d{2})$/.exec(hhmmText);
	if (!m) return hhmmText;
	const h = Number(m[1]);
	const h12 = h % 12 === 0 ? 12 : h % 12;
	return `${h12}:${m[2]}${h < 12 ? "am" : "pm"}`;
}

// ---------------------------------------------------------------------------
// People and places
// ---------------------------------------------------------------------------

/** "Maya Chen" → "MC"; "Guest Heron" → "GH"; "Sam" → "S". */
export function initials(name: string): string {
	const words = name.trim().split(/\s+/).filter(Boolean);
	const first = words[0]?.[0] ?? "?";
	const last = words.length > 1 ? (words.at(-1)?.[0] ?? "") : "";
	return (first + last).toUpperCase();
}

/** The `lang` of local names in a country (DESIGN §2.6: Han glyph forms). */
export function langFor(
	countryCode: string | null | undefined,
): string | undefined {
	switch (countryCode?.toUpperCase()) {
		case "JP":
			return "ja";
		case "KR":
			return "ko";
		case "TW":
		case "HK":
		case "MO":
			return "zh-Hant";
		case "CN":
			return "zh-Hans";
		case "VN":
			return "vi";
		case "TH":
			return "th";
		default:
			return undefined;
	}
}

/** "JP" → 🇯🇵 (regional indicator symbols). Empty for anything else. */
export function flagEmoji(countryCode: string | null | undefined): string {
	const cc = countryCode?.toUpperCase();
	if (!cc || !/^[A-Z]{2}$/.test(cc)) return "";
	return String.fromCodePoint(
		...[...cc].map((c) => 0x1f1e6 + c.charCodeAt(0) - 65),
	);
}

// ---------------------------------------------------------------------------
// Legs, flights, due dates
// ---------------------------------------------------------------------------

const MODE_LABEL = {
	walk: "walk",
	transit: "transit",
	flight: "flight",
	other: "other",
} as const;

/** "walk · 12m · 0.9 km", "transit · 1h 43m est.", "flight · NH9 KIX→ICN". */
export function formatLeg(
	leg: Pick<
		GraphLeg,
		"mode" | "durationMin" | "distanceM" | "source" | "estimateMin" | "details"
	>,
): string {
	if (!leg.mode) return "Not set";
	const details = readLegDetails(leg.details);
	if (details.kind === "flight") {
		// FB-18: a flight without times reads "~14h 5m est. · times TBD".
		const t = flightTimes(details.flight);
		return t.estimate
			? `flight · ${formatFlight(details.flight)} · ~${formatDuration(t.minutes)} est.${t.untimed ? " · times TBD" : ""}`
			: `flight · ${formatFlight(details.flight)}`;
	}
	const minutes = leg.durationMin ?? leg.estimateMin;
	const est = leg.durationMin === null && leg.estimateMin !== null;
	const parts: string[] = [MODE_LABEL[leg.mode]];
	if (minutes !== null)
		parts.push(`${formatDuration(minutes)}${est ? " est." : ""}`);
	if (leg.distanceM) parts.push(formatDistance(leg.distanceM));
	return parts.join(" · ");
}

/** "NH 9 KIX→ICN" (the flight number is stored without the space). */
export function formatFlight(
	f: Pick<FlightDetails, "flightNumber" | "from" | "to">,
): string {
	const num = f.flightNumber?.replace(/^([A-Z0-9]{2})(\d+)/, "$1 $2");
	return [num, `${f.from.iata}→${f.to.iata}`].filter(Boolean).join(" ");
}

/** "by Day 4", "Opens Wed 30 Sep · 20:00", "Due Wed 30 Sep". */
export function formatDue(item: {
	dueDayNumber?: number | null;
	dueDate?: string | null;
	dueTime?: string | null;
	opens?: boolean;
}): string {
	if (item.dueDayNumber) return `by Day ${item.dueDayNumber}`;
	if (!item.dueDate) return "";
	const when = `${formatDayDate(item.dueDate)}${item.dueTime ? ` · ${item.dueTime}` : ""}`;
	return `${item.opens ? "Opens" : "Due"} ${when}`;
}
