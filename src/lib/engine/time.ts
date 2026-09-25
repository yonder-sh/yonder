/**
 * Thin wrapper around Temporal: the ONLY module in the app that does zone
 * arithmetic (SPEC §0 rule 10). Everything else works with epoch milliseconds
 * plus IANA zone ids, and the output is plain, serializable data (`ZonedTime`,
 * or `Date` in the schedule).
 *
 * Ported from `spikes/core/src/time.ts`. `temporal-polyfill` is a ponyfill: it
 * defers to a native `Temporal` global when the runtime has one. Zone data comes
 * from the runtime's ICU, so results follow the tzdata of the browser or Node.
 * Nothing here reads the host's zone: results are identical under any `TZ`.
 */
import { Temporal } from "temporal-polyfill";

export const MS_PER_MINUTE = 60_000;

/** A resolved instant, described in one IANA zone. Plain JSON-safe data. */
export interface ZonedTime {
	/** Local wall-clock date-time, minute precision: "2027-10-22T13:20". */
	local: string;
	/** Local calendar date: "2027-10-22". */
	date: string;
	/** Local wall-clock time: "13:20". */
	time: string;
	/** Canonical IANA zone id: "Asia/Ho_Chi_Minh". */
	timezone: string;
	/** UTC offset at that instant: "+07:00". */
	offset: string;
	/** UTC offset in minutes (420 for +07:00). */
	offsetMin: number;
	/** Epoch milliseconds (the instant). */
	epochMs: number;
	/** RFC 9557 string; round-trips through `Temporal.ZonedDateTime.from`. */
	iso: string;
	/**
	 * Calendar days between `date` and a reference date (the owning timeline day).
	 * 0 = same date, 1 = "+1", -1 = previous date. 0 when no reference was given.
	 */
	dayOffset: number;
}

export type WallTimeKind = "exact" | "ambiguous" | "nonexistent";

export interface WallResolution {
	epochMs: number;
	/**
	 * "ambiguous": the wall time occurs twice (DST fall-back); the EARLIER one is used.
	 * "nonexistent": the wall time is skipped (DST spring-forward); it is pushed forward
	 * by the gap length. Both follow Temporal's "compatible" disambiguation (same as Date).
	 */
	kind: WallTimeKind;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^(\d{1,2}):(\d{2})$/;
const DATETIME_RE = /^(\d{4}-\d{2}-\d{2})[T ](\d{1,2}:\d{2})$/;

const tzCache = new Map<string, string | null>();

/**
 * Returns the canonical-cased IANA id ("asia/tokyo" -> "Asia/Tokyo"), or null when
 * the runtime does not know the zone. Never throws.
 */
export function normalizeTimeZone(
	tz: string | null | undefined,
): string | null {
	if (!tz) return null;
	const cached = tzCache.get(tz);
	if (cached !== undefined) return cached;
	let result: string | null;
	try {
		result =
			Temporal.Instant.fromEpochMilliseconds(0).toZonedDateTimeISO(
				tz,
			).timeZoneId;
	} catch {
		result = null;
	}
	tzCache.set(tz, result);
	return result;
}

export function isValidTimeZone(tz: string | null | undefined): boolean {
	return normalizeTimeZone(tz) !== null;
}

/**
 * The first candidate that is a valid zone (canonical casing), else "UTC".
 * `tzOf()` uses it so bad data never throws inside the schedule (SPEC §7.4).
 */
export function safeTimeZone(
	...candidates: (string | null | undefined)[]
): string {
	for (const c of candidates) {
		const tz = normalizeTimeZone(c);
		if (tz) return tz;
	}
	return "UTC";
}

/** Validates "YYYY-MM-DD" (including calendar validity). Returns null when invalid. */
export function parseDate(value: string | null | undefined): string | null {
	if (!value || !DATE_RE.test(value)) return null;
	try {
		return Temporal.PlainDate.from(value, { overflow: "reject" }).toString();
	} catch {
		return null;
	}
}

/** Validates "H:mm" / "HH:mm" (00:00-23:59). Returns zero-padded "HH:mm" or null. */
export function parseTime(value: string | null | undefined): string | null {
	if (!value) return null;
	const m = TIME_RE.exec(value.trim());
	if (!m) return null;
	const hour = Number(m[1]);
	const minute = Number(m[2]);
	if (hour > 23 || minute > 59) return null;
	return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

export interface WallTime {
	/** "YYYY-MM-DD" */
	date: string;
	/** "HH:mm" */
	time: string;
	/** true when the input carried its own date ("YYYY-MM-DDTHH:mm"). */
	hasDate: boolean;
}

/**
 * Parses a local wall time: either "HH:mm" (placed on `defaultDate`) or a full
 * "YYYY-MM-DDTHH:mm" (a space instead of "T" is accepted). Returns null when invalid.
 */
export function parseWallTime(
	value: string | null | undefined,
	defaultDate: string,
): WallTime | null {
	if (!value) return null;
	const trimmed = value.trim();
	const full = DATETIME_RE.exec(trimmed);
	if (full) {
		const date = parseDate(full[1]);
		const time = parseTime(full[2]);
		return date && time ? { date, time, hasDate: true } : null;
	}
	const time = parseTime(trimmed);
	return time ? { date: defaultDate, time, hasDate: false } : null;
}

function plainDateTime(date: string, time: string): Temporal.PlainDateTime {
	return Temporal.PlainDateTime.from(`${date}T${time}`);
}

/** Resolves a local wall time in `tz` to an instant, reporting DST ambiguity/gaps. */
export function wallToEpoch(
	date: string,
	time: string,
	tz: string,
): WallResolution {
	const pdt = plainDateTime(date, time);
	const earlier = pdt.toZonedDateTime(tz, { disambiguation: "earlier" });
	const later = pdt.toZonedDateTime(tz, { disambiguation: "later" });
	const compatible = pdt.toZonedDateTime(tz, { disambiguation: "compatible" });
	let kind: WallTimeKind = "exact";
	if (earlier.epochMilliseconds !== later.epochMilliseconds) {
		// In a gap, neither candidate round-trips to the requested wall time.
		kind =
			Temporal.PlainDateTime.compare(compatible.toPlainDateTime(), pdt) === 0
				? "ambiguous"
				: "nonexistent";
	}
	return { epochMs: compatible.epochMilliseconds, kind };
}

/**
 * The instant of wall time `date` + `time` ("HH:mm") in `tz` (SPEC §9.2 `zoned`).
 * Ambiguous and skipped times use Temporal's "compatible" mode, like `Date`.
 */
export function zonedEpoch(date: string, time: string, tz: string): number {
	return wallToEpoch(date, time, tz).epochMs;
}

/**
 * First instant at or after `notBeforeMs` whose wall time in `tz` is `time`.
 * This is how an airline-style "arrives 06:10" (implicitly "+1") is resolved.
 */
export function nextWallOccurrence(
	time: string,
	tz: string,
	notBeforeMs: number,
): WallResolution {
	const localDate = localDateOf(notBeforeMs, tz);
	const sameDay = wallToEpoch(localDate, time, tz);
	if (sameDay.epochMs >= notBeforeMs) return sameDay;
	return wallToEpoch(addDays(localDate, 1), time, tz);
}

function zdt(epochMs: number, tz: string): Temporal.ZonedDateTime {
	return Temporal.Instant.fromEpochMilliseconds(epochMs).toZonedDateTimeISO(tz);
}

const toMs = (at: number | Date): number =>
	typeof at === "number" ? at : at.getTime();

export function localDateOf(epochMs: number | Date, tz: string): string {
	return zdt(toMs(epochMs), tz).toPlainDate().toString();
}

/** Local wall-clock "HH:mm" of an instant in `tz`. */
export function hhmm(at: number | Date, tz: string): string {
	return zdt(toMs(at), tz).toPlainTime().toString({ smallestUnit: "minute" });
}

/** UTC offset of `tz` at an instant, in minutes (+540 for Asia/Tokyo). */
export function tzOffsetMin(tz: string, at: number | Date): number {
	return Math.round(zdt(toMs(at), tz).offsetNanoseconds / 60e9);
}

export function addDays(date: string, days: number): string {
	return Temporal.PlainDate.from(date).add({ days }).toString();
}

/** Whole calendar days from `from` to `to` ("2027-10-08" -> "2027-10-10" = 2). */
export function daysBetween(from: string, to: string): number {
	return Temporal.PlainDate.from(from).until(Temporal.PlainDate.from(to), {
		largestUnit: "days",
	}).days;
}

/** Instant of local midnight at the END of `date` (i.e. `date`+1 00:00) in `tz`. */
export function endOfLocalDate(date: string, tz: string): number {
	return wallToEpoch(addDays(date, 1), "00:00", tz).epochMs;
}

export function addMinutes(epochMs: number, minutes: number): number {
	return epochMs + minutes * MS_PER_MINUTE;
}

export function diffMinutes(fromMs: number, toMs: number): number {
	return Math.round((toMs - fromMs) / MS_PER_MINUTE);
}

/** Converts an instant to a JSON-safe `ZonedTime` in `tz`. */
export function toZonedTime(
	epochMs: number,
	tz: string,
	referenceDate?: string,
): ZonedTime {
	const z = zdt(epochMs, tz);
	const pdt = z.toPlainDateTime();
	const date = pdt.toPlainDate().toString();
	const time = pdt.toPlainTime().toString({ smallestUnit: "minute" });
	return {
		local: `${date}T${time}`,
		date,
		time,
		timezone: z.timeZoneId,
		offset: z.offset,
		offsetMin: Math.round(z.offsetNanoseconds / 60e9),
		epochMs,
		iso: z.toString({ smallestUnit: "minute" }),
		dayOffset: referenceDate ? daysBetween(referenceDate, date) : 0,
	};
}

/**
 * Parses a local date-time "YYYY-MM-DDTHH:mm" (the `LocalDT` of flights and
 * fixed transit) in `tz`. The server uses it to write `legs.depAt/arrAt`; the
 * client never derives those (SPEC §9.2). Null for malformed input. A wall
 * time the clocks repeat (DST ends) is the first of the two unless `fold` is
 * "later" (QA TZ-07: 01:30 EST rather than 01:30 EDT).
 */
export function localDateTimeToEpoch(
	local: string,
	tz: string,
	fold: "earlier" | "later" = "earlier",
): number | null {
	const wall = parseWallTime(local, "1970-01-01");
	const zone = normalizeTimeZone(tz);
	if (!wall?.hasDate || !zone) return null;
	const r = wallToEpoch(wall.date, wall.time, zone);
	if (fold === "later" && r.kind === "ambiguous")
		return plainDateTime(wall.date, wall.time).toZonedDateTime(zone, {
			disambiguation: "later",
		}).epochMilliseconds;
	return r.epochMs;
}

/**
 * Short labels for zones whose ICU "short" name is only "GMT+9" (ICU 76 in Node
 * 22 and Chrome). None of these zones observes DST, so a fixed label is right
 * all year (SPEC §7.4).
 */
export const TZ_ABBREVIATIONS: Readonly<Record<string, string>> = {
	"Asia/Tokyo": "JST",
	"Asia/Seoul": "KST",
	"Asia/Taipei": "CST",
	"Asia/Shanghai": "CST",
	"Asia/Ho_Chi_Minh": "ICT",
	"Asia/Bangkok": "ICT",
	"Asia/Hong_Kong": "HKT",
	"Asia/Singapore": "SGT",
	"Europe/Istanbul": "TRT",
};

const labelCache = new Map<string, string>();

/**
 * A short zone label at an instant ("JST", "EDT", "EST", "GMT+7"). Memoized
 * per zone and UTC offset, so DST zones get the right label on each side of a
 * change. Unknown zones return the input unchanged.
 *
 * `at` is required (FEEDBACK-3 FB-20): pass the moment being shown (the
 * item's or flight's time, the day, the due date), never "now" by default —
 * a December JFK flight is EST even while New York is on EDT today.
 */
export function tzLabel(zone: string, at: number | Date): string {
	const tz = normalizeTimeZone(zone);
	if (!tz) return zone;
	const fixed = TZ_ABBREVIATIONS[tz];
	if (fixed) return fixed;
	const ms = toMs(at);
	const key = `${tz}|${tzOffsetMin(tz, ms)}`;
	let label = labelCache.get(key);
	if (label === undefined) {
		const part = new Intl.DateTimeFormat("en-US", {
			timeZone: tz,
			timeZoneName: "short",
		})
			.formatToParts(ms)
			.find((p) => p.type === "timeZoneName");
		label = part?.value ?? tz;
		labelCache.set(key, label);
	}
	return label;
}
