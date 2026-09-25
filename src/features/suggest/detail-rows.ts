/**
 * Before → after rows for the nested `details.*` fields a proposal changes
 * (EXTENSIONS §3.7 ProposalOverview; COLLAB-R2-07): a place's opening hours
 * (`node.hours`), a leg's flight (`flight.save`), custom route, reserved
 * times and booking (`transit.*`). One stored object becomes the rows a
 * reviewer can read: "Opening hours: Mon–Sat 19:00–02:00 · Closed Sun",
 * "Special dates: Tue 5 Oct closed (Private event)", "Aircraft: Boeing
 * 777-300ER → Airbus A380". Pure; payloads are shape-checked, and guests'
 * payloads and graph arrive already redacted (no ref, cost, points, fees or
 * real seats), so nothing here can reveal them.
 */
import { rulesInWords, weekSummary } from "@/features/insights/hours-format";
import { formatMoney as fmtMinor, toMinor } from "@/lib/engine/money";
import { formatFlightNumber } from "@/lib/engine/schedule";
import {
	formatDayDate,
	formatDuration,
	getDisplayPrefs,
	to12h,
} from "@/lib/format";
import type { OpeningHours } from "@/lib/schemas/hours";
import type { Json } from "@/lib/schemas/proposals";

export type FieldRow = {
	field: string;
	label: string;
	/** null: no "before" to show (a create, or unknown). */
	before: string | null;
	after: string;
};

type Obj = Record<string, Json>;

const isObj = (v: Json | undefined): v is Obj =>
	!!v && typeof v === "object" && !Array.isArray(v);
const str = (v: Json | undefined): string | null =>
	typeof v === "string" && v.trim() ? v.trim() : null;
const num = (v: Json | undefined): number | null =>
	typeof v === "number" && Number.isFinite(v) ? v : null;

/** The label of a whole `details.*` field ("Opening hours", "Flight"). */
export const DETAIL_LABELS: Record<string, string> = {
	openingHours: "Opening hours",
	flight: "Flight",
	route: "Route",
	fixed: "Reserved times",
	booking: "Booking",
};

/** Where a `details.<key>` value sits in the op's payload, when not under `<key>`. */
const PAYLOAD_KEY: Record<string, string> = { openingHours: "hours" };

/** The proposed value of `details.<key>` (null = removed; undefined = unknown). */
export function proposedDetail(
	op: string,
	payload: Obj,
	key: string,
): Json | undefined {
	if (op.endsWith(".delete")) return null;
	const k = PAYLOAD_KEY[key] ?? key;
	return k in payload ? (payload[k] ?? null) : undefined;
}

function clock(hhmm: string): string {
	return getDisplayPrefs().clock === "12h" ? to12h(hhmm) : hhmm;
}

/** "2027-10-02T11:30" → "Sat 2 Oct 11:30". */
function localText(v: Json | undefined): string | null {
	const s = str(v);
	if (!s) return null;
	const m = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})/.exec(s);
	return m ? `${formatDayDate(m[1] as string)} ${clock(m[2] as string)}` : s;
}

/**
 * A flight end (FB-18): "Sat 12 Dec 02:00", or its date alone while the time
 * is unknown, "Sat 12 Dec · time TBD".
 */
function flightEndText(local: Json | undefined, date: Json | undefined) {
	const at = localText(local);
	if (at) return at;
	const d = str(date);
	return d && /^\d{4}-\d{2}-\d{2}$/.test(d)
		? `${formatDayDate(d)} · time TBD`
		: null;
}
const flightEndKey = (local: Json | undefined, date: Json | undefined) =>
	str(local) ?? str(date);

function moneyText(v: Json | undefined): string | null {
	if (!isObj(v)) return null;
	const amount = num(v.amount);
	const currency = str(v.currency);
	if (amount === null || !currency) return str(v.text);
	try {
		return fmtMinor(toMinor(amount, currency), currency);
	} catch {
		return `${amount} ${currency}`;
	}
}

// ---------------------------------------------------------------------------
// Opening hours
// ---------------------------------------------------------------------------

/** A stored/proposed hours object, if it has the shape the week needs. */
function readHours(v: Json | undefined): OpeningHours | null {
	if (!isObj(v) || !Array.isArray(v.periods)) return null;
	const periods = v.periods.filter(
		(p): p is Obj =>
			isObj(p) &&
			typeof p.day === "number" &&
			typeof p.open === "string" &&
			typeof p.close === "string",
	);
	return {
		...(v as unknown as OpeningHours),
		periods: periods as unknown as OpeningHours["periods"],
		source: v.source === "google" ? "google" : "manual",
		updatedAt: typeof v.updatedAt === "string" ? v.updatedAt : "",
	};
}

/** The week in one line, holidays included: "Mon–Sat 19:00–02:00 · Closed Sun". */
function weekText(h: OpeningHours): string {
	const holiday = h.alwaysOpen
		? []
		: h.periods.filter((p) => p.day === 7).map((p) => `${p.open}–${p.close}`);
	const week = weekSummary(h);
	if (h.closedOnHolidays) return `${week} · Closed on holidays`;
	return holiday.length ? `${week} · Holidays ${holiday.join(", ")}` : week;
}

/** "Closed 2nd Tue · Last entry 30 min before close"; null when there are none. */
function rulesText(h: OpeningHours): string | null {
	const lines = rulesInWords({ hours: h }).filter(
		(l) => !l.startsWith("Hours unknown"),
	);
	return lines.length ? lines.join(" · ") : null;
}

const MAX_DATES = 4;

/** "Tue 5 Oct closed (Private event) · Sat 9 Oct 12:00–18:00". */
function datesText(h: OpeningHours): string | null {
	const list = [...(h.exceptions ?? [])]
		.filter((e) => typeof e?.date === "string")
		.sort((a, b) => a.date.localeCompare(b.date));
	if (!list.length) return null;
	const one = (e: (typeof list)[number]) => {
		const hours =
			e.closed || !e.periods?.length
				? "closed"
				: e.periods.map((p) => `${p.open}–${p.close}`).join(", ");
		const label = e.label?.trim() ? ` (${e.label.trim()})` : "";
		return `${formatDayDate(e.date)} ${hours}${label}`;
	};
	const shown = list.slice(0, MAX_DATES).map(one);
	if (list.length > MAX_DATES) shown.push(`+${list.length - MAX_DATES} more`);
	return shown.join(" · ");
}

/**
 * The week, then only what else differs (rules, special dates, the note).
 * `before === undefined`: unknown (a closed proposal), so rows are after-only.
 */
function hoursRows(
	field: string,
	before: Json | undefined,
	after: Json | undefined,
): FieldRow[] {
	const a = readHours(after);
	const b = readHours(before);
	const known = before !== undefined;
	if (!a && after !== null && after !== undefined)
		return [
			{
				field,
				label: DETAIL_LABELS.openingHours as string,
				before: null,
				after: "Changed",
			},
		];

	const facets: [string, string, (h: OpeningHours) => string | null][] = [
		["rules", "Rules", rulesText],
		["exceptions", "Special dates", datesText],
		["note", "Note", (h) => h.note?.trim() || null],
	];
	const rows: FieldRow[] = [];
	const weekA = a ? weekText(a) : "No hours";
	const weekB = known ? (b ? weekText(b) : "No hours") : null;
	rows.push({
		field,
		label: DETAIL_LABELS.openingHours as string,
		// The week unchanged: no strike-through, just the week for context.
		before: weekB !== null && weekB !== weekA ? weekB : null,
		after: weekA,
	});
	if (!a) return rows;
	for (const [key, label, text] of facets) {
		const at = text(a);
		const bt = b ? text(b) : null;
		if (at === bt || (at === null && !known)) continue;
		rows.push({
			field: `${field}.${key}`,
			label,
			before: known ? (bt ?? "None") : null,
			after: at ?? "None",
		});
	}
	return rows;
}

// ---------------------------------------------------------------------------
// Flights
// ---------------------------------------------------------------------------

const CABIN: Record<string, string> = {
	economy: "Economy",
	premium_economy: "Premium economy",
	business: "Business",
	first: "First",
};

function airportText(v: Json | undefined): string | null {
	if (!isObj(v)) return null;
	const iata = str(v.iata);
	const name = str(v.name);
	const where =
		name && iata && name !== iata ? `${name} (${iata})` : (name ?? iata);
	const extra = [
		str(v.terminal)
			? `T${(str(v.terminal) as string).replace(/^T/i, "")}`
			: null,
		str(v.gate) ? `Gate ${str(v.gate)}` : null,
	].filter(Boolean);
	return [where, ...extra].filter(Boolean).join(" · ") || null;
}

/**
 * One flight detail: its row label, its text, and (when the text isn't a fair
 * comparison) what "the same" means. The payload is the form's input and the
 * stored flight is the server's normalised one ("nh 9" → "NH9", canonical
 * airport names, an upper-cased ref), so those compare by what is normalised.
 */
type Facet = [
	key: string,
	label: string,
	text: (f: Obj) => string | null,
	same?: (f: Obj) => string | null,
];

/** "nh 009" and "NH9" are one flight number. */
const flightNumberKey = (f: Obj) =>
	str(f.flightNumber)
		?.toUpperCase()
		.replace(/[\s-]+/g, "")
		.replace(/^([A-Z0-9]{2}[A-Z]?)0+(?=\d)/, "$1") ?? null;

/** An airport is its code, terminal and gate (the server supplies the name). */
const airportKey = (v: Json | undefined) =>
	isObj(v)
		? [str(v.iata)?.toUpperCase(), str(v.terminal), str(v.gate)].join("|")
		: null;

function flightFacets(memberName: (id: string) => string): Facet[] {
	return [
		[
			"flightNumber",
			"Flight",
			(f) => formatFlightNumber(flightNumberKey(f)),
			flightNumberKey,
		],
		[
			"airline",
			"Airline",
			(f) => (isObj(f.airline) ? str(f.airline.name) : null),
		],
		["from", "From", (f) => airportText(f.from), (f) => airportKey(f.from)],
		["to", "To", (f) => airportText(f.to), (f) => airportKey(f.to)],
		[
			"depLocal",
			"Departs",
			(f) => flightEndText(f.depLocal, f.depDate),
			(f) => flightEndKey(f.depLocal, f.depDate),
		],
		[
			"arrLocal",
			"Arrives",
			(f) => flightEndText(f.arrLocal, f.arrDate),
			(f) => flightEndKey(f.arrLocal, f.arrDate),
		],
		[
			"cabin",
			"Cabin",
			(f) => {
				const c = str(f.cabin);
				return c ? (CABIN[c] ?? c) : null;
			},
		],
		["seats", "Seats", (f) => seatsText(f.seats, memberName)],
		["aircraft", "Aircraft", (f) => str(f.aircraft)],
		["baggage", "Baggage", (f) => str(f.baggage)],
		[
			"bookingRef",
			"Booking ref",
			(f) => str(f.bookingRef),
			(f) => str(f.bookingRef)?.toUpperCase() ?? null,
		],
		["cost", "Cost", (f) => moneyText(f.cost)],
		[
			"points",
			"Points",
			(f) => {
				if (!isObj(f.points)) return null;
				const n = num(f.points.amount);
				return n === null
					? null
					: `${n.toLocaleString("en")} ${str(f.points.program) ?? ""}`.trim();
			},
		],
		["fees", "Fees", (f) => moneyText(f.fees)],
	];
}

/** "12A Dennis, 12B Maya" (guests get "••" from the server). */
function seatsText(
	v: Json | undefined,
	memberName: (id: string) => string,
): string | null {
	if (!Array.isArray(v) || !v.length) return null;
	return v
		.filter(isObj)
		.map((s) => {
			const who = str(s.memberId);
			return [str(s.seat), who ? memberName(who) : null]
				.filter(Boolean)
				.join(" ");
		})
		.filter(Boolean)
		.join(", ");
}

/**
 * One row per flight detail that differs ("Aircraft: Boeing 777-300ER →
 * Airbus A380"). No flight before: the details it sets, after-only. Nothing
 * differs: the flight itself, so the overview is never empty.
 */
function flightRows(
	field: string,
	before: Json | undefined,
	after: Json | undefined,
	memberName: (id: string) => string,
): FieldRow[] {
	if (!isObj(after))
		return [
			{
				field,
				label: DETAIL_LABELS.flight as string,
				before: null,
				after: after === null ? "Removed" : "Changed",
			},
		];
	const b = isObj(before) ? before : null;
	const rows: FieldRow[] = [];
	for (const [key, label, text, same = text] of flightFacets(memberName)) {
		const at = text(after);
		if (!b) {
			if (at)
				rows.push({ field: `${field}.${key}`, label, before: null, after: at });
			continue;
		}
		const bt = text(b);
		if (same(after) === same(b)) continue;
		rows.push({
			field: `${field}.${key}`,
			label,
			before: bt ?? "—",
			after: at ?? "—",
		});
	}
	if (rows.length) return rows;
	const number = formatFlightNumber(flightNumberKey(after));
	const route = [after.from, after.to]
		.map((a) => (isObj(a) ? str(a.iata) : null))
		.filter(Boolean)
		.join("→");
	return [
		{
			field,
			label: DETAIL_LABELS.flight as string,
			before: null,
			after:
				[number, route, flightEndText(after.depLocal, after.depDate)]
					.filter(Boolean)
					.join(" · ") || "No change",
		},
	];
}

// ---------------------------------------------------------------------------
// Transit: custom route, reserved times, booking
// ---------------------------------------------------------------------------

/** "Fuji Excursion 7 · 1h 52m", "Ginza → JY · 34m". */
function routeText(v: Json | undefined): string | null {
	if (!isObj(v)) return null;
	const dur = num(v.durationMin);
	const rides = Array.isArray(v.segments)
		? v.segments
				.filter(isObj)
				.filter((s) => s.mode !== "walk")
				.map((s) => str(s.lineShort) ?? str(s.lineName) ?? str(s.vehicleType))
				.filter((x): x is string => !!x)
		: [];
	const name =
		str(v.label) ?? (rides.length ? rides.join(" → ") : "Custom route");
	return dur === null ? name : `${name} · ${formatDuration(dur)}`;
}

/** "Sat 2 Oct 11:30 → Sat 2 Oct 13:45". */
function fixedText(v: Json | undefined): string | null {
	if (!isObj(v)) return null;
	const dep = localText(v.departLocal);
	const arr = localText(v.arriveLocal);
	if (!dep && !arr) return null;
	const sameDay =
		typeof v.departLocal === "string" &&
		typeof v.arriveLocal === "string" &&
		v.departLocal.slice(0, 10) === v.arriveLocal.slice(0, 10);
	const arrShort = sameDay && arr ? arr.replace(/^.* (\S+)$/, "$1") : arr;
	return [dep, arrShort].filter(Boolean).join(" → ");
}

/** "Nozomi 21 · Green · Car 7 · 7A Dennis". */
function bookingText(
	v: Json | undefined,
	memberName: (id: string) => string,
): string | null {
	if (!isObj(v)) return null;
	const parts = [
		str(v.trainNumber),
		str(v.class),
		str(v.car) ? `Car ${str(v.car)}` : null,
		seatsText(v.seats, memberName),
		str(v.ref) ? `Ref ${str(v.ref)}` : null,
	].filter(Boolean);
	return parts.length ? parts.join(" · ") : null;
}

function oneRow(
	field: string,
	label: string,
	before: Json | undefined,
	after: Json | undefined,
	text: (v: Json | undefined) => string | null,
	none: string,
): FieldRow[] {
	const at = text(after) ?? (after === null ? none : "Changed");
	const bt = before === undefined ? null : (text(before) ?? none);
	return [{ field, label, before: bt === at ? null : bt, after: at }];
}

// ---------------------------------------------------------------------------

/**
 * The rows for one `details.<key>` field, or null when the key isn't one we
 * know (the caller falls back to a generic row). `before === undefined` means
 * unknown: the rows then show only the proposed values.
 */
export function detailRows(
	field: string,
	before: Json | undefined,
	after: Json | undefined,
	memberName: (id: string) => string,
): FieldRow[] | null {
	const key = field.slice("details.".length);
	switch (key) {
		case "openingHours":
			return hoursRows(field, before, after);
		case "flight":
			return flightRows(field, before, after, memberName);
		case "route":
			return oneRow(field, "Route", before, after, routeText, "None");
		case "fixed":
			return oneRow(
				field,
				"Reserved times",
				before,
				after,
				fixedText,
				"Not reserved",
			);
		case "booking":
			return oneRow(
				field,
				"Booking",
				before,
				after,
				(v) => bookingText(v, memberName),
				"None",
			);
		default:
			return null;
	}
}
