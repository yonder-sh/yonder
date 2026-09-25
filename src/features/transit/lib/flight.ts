/**
 * Flight input rules shared by the form and the server (SPEC §7.9, QA
 * FLT-02/03): "nh9" → "NH9" (shown "NH 9"), IATA upper-cased, local times
 * compared as instants in each airport's zone, tight connections.
 */
import {
	type FlightLike,
	flightOwnMinutes,
	flightTimes,
} from "@/lib/engine/flights";
import {
	hhmm,
	localDateTimeToEpoch,
	tzLabel,
	wallToEpoch,
} from "@/lib/engine/time";
import { formatDayDate, formatDuration } from "@/lib/format";
import { type FlightDetails, readLegDetails } from "@/lib/schemas/legs";

/** "nh 9", "NH-009" → "NH9"; null when it doesn't look like a flight number. */
export function normalizeFlightNumber(
	input: string | null | undefined,
): string | null {
	if (!input) return null;
	const s = input.toUpperCase().replace(/[\s-]+/g, "");
	const m = /^([A-Z0-9]{2})([A-Z]?)0*(\d{1,4})([A-Z]?)$/.exec(s);
	if (!m) return null;
	return `${m[1]}${m[2]}${m[3]}${m[4]}`.slice(0, 12);
}

/** "NH9" → "NH 9". */
export function displayFlightNumber(n: string | null | undefined): string {
	if (!n) return "";
	return n.replace(/^([A-Z0-9]{2})(\d)/, "$1 $2");
}

export const normalizeIata = (s: string | null | undefined): string =>
	(s ?? "").trim().toUpperCase();

/** Which of a repeated local time (clocks go back) is meant (QA TZ-07). */
export type Fold = "earlier" | "later";

/** Minutes between two local times in their zones; null if either is invalid. */
export function flightMinutes(
	dep: { local: string; tz: string; fold?: Fold },
	arr: { local: string; tz: string; fold?: Fold },
): number | null {
	const a = localDateTimeToEpoch(dep.local, dep.tz, dep.fold);
	const b = localDateTimeToEpoch(arr.local, arr.tz, arr.fold);
	if (a === null || b === null) return null;
	return Math.round((b - a) / 60_000);
}

export type FlightFieldError =
	| { field: "flightNumber"; message: "Not a flight number" }
	| { field: "from" | "to"; message: "Unknown airport" | "Required" }
	| { field: "depLocal"; message: "Required" | "Add the departure time too" }
	| { field: "arrLocal"; message: "Arrival is before departure" };

/**
 * Inline validation (QA FLT-02; FEEDBACK-3 FB-18). `known(iata)` answers the
 * airport lookup. Only the airports and the departure date are required: the
 * number, the airline and both times are optional ("we fly JFK → HND on Dec
 * 12"). An arrival time needs a departure time.
 */
export function validateFlight(
	f: {
		flightNumber?: string | null;
		from?: string | null;
		to?: string | null;
		/** The departure date ("YYYY-MM-DD"). */
		depDate?: string | null;
		/** "YYYY-MM-DDTHH:mm" when the departure time is known. */
		depLocal?: string | null;
		arrLocal?: string | null;
		depFold?: Fold;
		arrFold?: Fold;
	},
	known: (iata: string) => { tz: string } | null,
): FlightFieldError[] {
	const errors: FlightFieldError[] = [];
	if (f.flightNumber?.trim() && !normalizeFlightNumber(f.flightNumber))
		errors.push({ field: "flightNumber", message: "Not a flight number" });
	const from = normalizeIata(f.from);
	const to = normalizeIata(f.to);
	const a = from ? known(from) : null;
	const b = to ? known(to) : null;
	if (!from) errors.push({ field: "from", message: "Required" });
	else if (!a) errors.push({ field: "from", message: "Unknown airport" });
	if (!to) errors.push({ field: "to", message: "Required" });
	else if (!b) errors.push({ field: "to", message: "Unknown airport" });
	if (!f.depDate && !f.depLocal)
		errors.push({ field: "depLocal", message: "Required" });
	else if (f.arrLocal && !f.depLocal)
		errors.push({ field: "depLocal", message: "Add the departure time too" });
	if (a && b && f.depLocal && f.arrLocal) {
		const min = flightMinutes(
			{ local: f.depLocal, tz: a.tz, fold: f.depFold },
			{ local: f.arrLocal, tz: b.tz, fold: f.arrFold },
		);
		if (min !== null && min <= 0)
			errors.push({
				field: "arrLocal",
				message: "Arrival is before departure",
			});
	}
	return errors;
}

/** A flight's own time, departure to arrival (the ticket's "14h"); null without both times. */
export function flightTimeMin(f: FlightLike): number | null {
	return flightOwnMinutes(f);
}

/**
 * The schedule a one-line leg summary shows (VIS3-05): a flight names its
 * own time ("NH 9 JFK→HND 14h", as on its ticket), never the plan's total
 * with the airport time around it (16h); every other leg is unchanged. A
 * flight without both times shows the great-circle estimate, "est." (FB-18).
 */
export function withFlightTime<
	S extends { minutes: number; estimate: boolean },
>(
	leg: { details: unknown } | null | undefined,
	schedule: S | null | undefined,
): S | null | undefined {
	const d = leg ? readLegDetails(leg.details) : null;
	if (d?.kind !== "flight" || !schedule) return schedule;
	const t = flightTimes(d.flight);
	return { ...schedule, minutes: t.minutes, estimate: t.estimate };
}

/**
 * "Flight JFK → HND · ~14h 5m est. · times TBD" (FB-18): the one line a
 * flight reads as when some of it is unknown. Never blank or "undefined".
 */
export function flightLine(
	f: FlightLike & Pick<FlightDetails, "flightNumber" | "airline">,
): string {
	const t = flightTimes(f);
	const name =
		displayFlightNumber(f.flightNumber) || f.airline?.name || "Flight";
	const parts = [
		`${name} ${f.from.iata} → ${f.to.iata}`,
		t.estimate
			? `~${formatDuration(t.minutes)} est.`
			: formatDuration(t.minutes),
	];
	if (t.untimed) parts.push("times TBD");
	else if (t.arrEstimated) parts.push("arrival TBD");
	return parts.join(" · ");
}

/** §7.9 tight connection: < 60 min international (either segment), < 45 domestic. */
export function tightConnection(
	inbound: Pick<FlightDetails, "from" | "to" | "arrLocal" | "arrFold">,
	outbound: Pick<FlightDetails, "from" | "to" | "depLocal" | "depFold">,
): { minutes: number; tight: boolean } | null {
	if (!inbound.arrLocal || !outbound.depLocal) return null;
	const min = flightMinutes(
		{ local: inbound.arrLocal, tz: inbound.to.tz, fold: inbound.arrFold },
		{ local: outbound.depLocal, tz: outbound.from.tz, fold: outbound.depFold },
	);
	if (min === null) return null;
	const intl =
		(inbound.from.country ?? "") !== (inbound.to.country ?? "") ||
		(outbound.from.country ?? "") !== (outbound.to.country ?? "");
	return { minutes: min, tight: min < (intl ? 60 : 45) };
}

/**
 * QA TZ-07: a local time the clocks skip or repeat in `tz`. Ambiguous times
 * count as the first of the two (Temporal "compatible", as stored by the
 * server); skipped ones move forward. Null for an ordinary time.
 */
export function dstNote(date: string, time: string, tz: string): string | null {
	if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^\d{2}:\d{2}$/.test(time) || !tz)
		return null;
	let r: ReturnType<typeof wallToEpoch>;
	try {
		r = wallToEpoch(date, time, tz);
	} catch {
		return null;
	}
	const day = formatDayDate(date);
	if (r.kind === "ambiguous") {
		const first = tzLabel(tz, r.epochMs);
		const second = tzLabel(tz, r.epochMs + 3_600_000);
		return `${time} happens twice on ${day} (clocks go back). It counts as ${time} ${first}${second !== first ? `, not ${second}` : ""}.`;
	}
	if (r.kind === "nonexistent")
		return `${time} doesn't exist on ${day} (clocks go forward). It counts as ${hhmm(r.epochMs, tz)} ${tzLabel(tz, r.epochMs)}.`;
	return null;
}

/**
 * QA TZ-07: a local time the clocks repeat in `tz` (01:30 on Sun 7 Nov 2027
 * in New York): the zone labels of its first and second occurrence ("EDT",
 * "EST"), so the form can ask which one. Null for any other time.
 */
export function repeatedTime(
	date: string,
	time: string,
	tz: string,
): { day: string; first: string; second: string } | null {
	if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^\d{2}:\d{2}$/.test(time) || !tz)
		return null;
	let r: ReturnType<typeof wallToEpoch>;
	try {
		r = wallToEpoch(date, time, tz);
	} catch {
		return null;
	}
	if (r.kind !== "ambiguous") return null;
	const later = localDateTimeToEpoch(`${date}T${time}`, tz, "later");
	if (later === null) return null;
	const first = tzLabel(tz, r.epochMs);
	const second = tzLabel(tz, later);
	return {
		day: formatDayDate(date),
		first,
		second: second !== first ? second : `${second} (2nd)`,
	};
}

/**
 * The fold to store: only "later" on a time the clocks repeat; anything else
 * (the default, or a time that isn't repeated) is left out.
 */
export function storedFold(
	local: string,
	tz: string,
	fold: Fold | undefined,
): Fold | undefined {
	if (fold !== "later") return undefined;
	return repeatedTime(local.slice(0, 10), local.slice(11), tz)
		? "later"
		: undefined;
}
