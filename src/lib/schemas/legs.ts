/**
 * JSONB shapes stored on `legs.details` and `legs.alternatives` (SPEC §6.5).
 * These schemas are the source of truth: the Drizzle columns are typed with the
 * inferred types, and every server write parses through them first.
 */
import { z } from "zod";
import { Id, IsoDate, LocalDT, Tz } from "./common";

/** Upper bounds for every string and list in leg JSON (SECURITY §1/§3: max lengths and counts). */
export const LEG_LIMITS = {
	/** Points in one LineString as sent; the server simplifies to ≤ 200 on write (§6.6). */
	linePoints: 2000,
	segments: 40,
	alternatives: 10,
	seats: 20,
	/** The largest serialized `details` a write may store. */
	detailsBytes: 65_536,
} as const;

const Str = (max: number) => z.string().max(max);

/** GeoJSON LineString, `[lng, lat]` pairs. Simplified to ≤ 200 points on write (§6.6). */
export const LineString = z.object({
	type: z.literal("LineString"),
	coordinates: z
		.array(
			z.tuple([z.number().min(-180).max(180), z.number().min(-90).max(90)]),
		)
		.max(LEG_LIMITS.linePoints),
});
export type LineString = z.infer<typeof LineString>;

export const Money = z.object({
	amount: z.number().min(-1e12).max(1e12),
	currency: z.string().length(3),
	text: Str(80).optional(),
});
export type Money = z.infer<typeof Money>;

export const SegmentMode = z.enum([
	"walk",
	"bus",
	"subway",
	"train",
	"rail",
	"high_speed",
	"tram",
	"ferry",
	"cable",
	"other",
]);
export type SegmentMode = z.infer<typeof SegmentMode>;

const HexColor = z.string().regex(/^#[0-9a-fA-F]{6}$/);
const Stop = z.object({
	name: Str(200),
	lat: z.number().min(-90).max(90).optional(),
	lng: z.number().min(-180).max(180).optional(),
});

export const TransitSegment = z.object({
	mode: SegmentMode,
	vehicleType: Str(60).optional(),
	lineName: Str(200).optional(),
	lineShort: Str(40).optional(),
	color: HexColor.optional(),
	textColor: HexColor.optional(),
	agency: Str(200).optional(),
	headsign: Str(200).optional(),
	stopCount: z.number().int().min(0).max(1000).optional(),
	from: Stop.optional(),
	to: Stop.optional(),
	departAt: z.iso.datetime({ offset: true }).optional(),
	arriveAt: z.iso.datetime({ offset: true }).optional(),
	durationMin: z.number().int().nonnegative().max(10_080),
	geometry: LineString.optional(),
});
export type TransitSegment = z.infer<typeof TransitSegment>;

export const TransitRoute = z.object({
	id: Str(100),
	source: z.enum(["google", "navitime", "manual", "estimate"]),
	departAt: z.iso.datetime({ offset: true }).optional(),
	arriveAt: z.iso.datetime({ offset: true }).optional(),
	/** Door to door, excluding the initial wait. */
	durationMin: z.number().int().nonnegative().max(10_080),
	walkMin: z.number().int().nonnegative().max(10_080).default(0),
	transfers: z.number().int().nonnegative().max(100).default(0),
	fare: Money.optional(),
	segments: z.array(TransitSegment).max(LEG_LIMITS.segments).default([]),
	geometry: LineString.optional(),
	/** Google proxy-date query (§14.2.2). */
	scheduleEstimate: z.boolean().optional(),
	/** NAVITIME average times (D8): never a timetable. */
	typical: z.boolean().optional(),
	/** e.g. "Fuji Excursion 7". */
	label: z.string().max(80).optional(),
	/**
	 * `estimate` routes (ADDENDUM §5, JAPAN_TRANSIT §3): the likely door-to-door
	 * range in minutes, e.g. `{ lo: 104, hi: 121 }`.
	 */
	range: z
		.object({
			lo: z.number().int().nonnegative(),
			hi: z.number().int().nonnegative(),
		})
		.optional(),
	/** `estimate` routes: caveats such as "bus likely faster" or "long walk". */
	warnings: z.array(z.string().max(120)).max(10).optional(),
	/** `estimate` routes: the rail-data build id (`src/data/jp-rail/manifest.json`). */
	dataBuild: z.string().max(80).optional(),
});
export type TransitRoute = z.infer<typeof TransitRoute>;

/** A reserved departure (train, bus, ferry): pins the leg's own times. */
export const FixedTimes = z.object({
	departLocal: LocalDT,
	arriveLocal: LocalDT,
	fromTz: Tz,
	toTz: Tz,
	/** Be at the platform this long before departure. */
	accessMin: z.number().int().min(0).max(180).default(10),
	/** Time from arrival to the next stop's door. */
	egressMin: z.number().int().min(0).max(180).default(0),
});
export type FixedTimes = z.infer<typeof FixedTimes>;

/** `memberId` is a `trip_members.id` of the same trip (validated by the server). Guests see `seat` as `'••'`. */
export const Seat = z.object({
	memberId: Id.optional(),
	seat: z.string().max(20),
});
export type Seat = z.infer<typeof Seat>;

export const TransitBooking = z.object({
	ref: z.string().max(40).optional(),
	trainNumber: z.string().max(40).optional(),
	class: z.string().max(40).optional(),
	car: z.string().max(20).optional(),
	seats: z.array(Seat).max(LEG_LIMITS.seats).default([]),
});
export type TransitBooking = z.infer<typeof TransitBooking>;

/** The server REPLACES tz/lat/lng from airports.json by IATA (D14). */
export const Airport = z.object({
	iata: z.string().length(3),
	name: Str(200),
	city: Str(200).optional(),
	country: z.string().length(2).optional(),
	tz: Tz,
	lat: z.number().min(-90).max(90),
	lng: z.number().min(-180).max(180),
	terminal: z.string().max(20).optional(),
	gate: z.string().max(20).optional(),
});
export type Airport = z.infer<typeof Airport>;

export const Cabin = z.enum([
	"economy",
	"premium_economy",
	"business",
	"first",
]);
export type Cabin = z.infer<typeof Cabin>;

/**
 * A flight (SPEC §6.5; FEEDBACK-3 FB-18): only the two airports and the
 * departure date are needed. Airline, number and both times are optional;
 * `depDate`/`arrDate` hold the local dates while the times are unknown (the
 * server keeps them equal to the dates of `depLocal`/`arrLocal` when those
 * are set). Read the dates through `flightDepDate`/`flightArrDate`
 * (`src/lib/engine/flights.ts`): rows written before FB-18 have only the
 * local date-times.
 */
export const FlightDetails = z.object({
	airline: z.object({ iata: Str(3).optional(), name: Str(200) }).optional(),
	/** "NH 9" is stored as "NH9". */
	flightNumber: z.string().max(12).optional(),
	from: Airport,
	to: Airport,
	/** Local departure date-time in `from.tz`; absent while the time is unknown. */
	depLocal: LocalDT.optional(),
	/** Local arrival date-time in `to.tz`; absent while unknown (then estimated). */
	arrLocal: LocalDT.optional(),
	/** Local departure date (FB-18), for a flight without a departure time. */
	depDate: IsoDate.optional(),
	/** Local arrival date (FB-18), for a flight without an arrival time. */
	arrDate: IsoDate.optional(),
	/**
	 * QA TZ-07: a local time the clocks repeat (DST ends) means the first of
	 * the two unless "later" (01:30 EST, not 01:30 EDT). Ignored otherwise.
	 */
	depFold: z.enum(["earlier", "later"]).optional(),
	arrFold: z.enum(["earlier", "later"]).optional(),
	cabin: Cabin.optional(),
	seats: z.array(Seat).max(LEG_LIMITS.seats).default([]),
	bookingRef: z.string().max(40).optional(),
	baggage: Str(200).optional(),
	aircraft: Str(100).optional(),
	cost: Money.optional(),
	points: z
		.object({ amount: z.number().min(0).max(1e9), program: Str(80) })
		.optional(),
	fees: Money.optional(),
	/** Set by the server for connecting segments (§7.9). */
	connection: z
		.object({ prevLegId: Id.optional(), nextLegId: Id.optional() })
		.optional(),
});
export type FlightDetails = z.infer<typeof FlightDetails>;

/**
 * What a link guest reads instead of a flight's booking ref (QA COLLAB-R3-06):
 * it IS booked (the what-if lists it under "Needs rebooking"), but the ref
 * itself stays hidden, like seats ("••"). Read path only: every guest write
 * strips it again (`redactLegDetails`), so it can never be stored.
 */
export const REDACTED_BOOKING_REF = "••••••";
export const isRedactedRef = (ref: string | null | undefined): boolean =>
	ref === REDACTED_BOOKING_REF;

export const OtherKind = z.enum([
	"taxi",
	"car",
	"ferry",
	"bike",
	"bus",
	"other",
]);
export type OtherKind = z.infer<typeof OtherKind>;

const LegDetailsUnion = z.discriminatedUnion("kind", [
	z.object({ kind: z.literal("none") }),
	z.object({ kind: z.literal("walk"), geometry: LineString.optional() }),
	z.object({
		kind: z.literal("transit"),
		route: TransitRoute.optional(),
		chosenId: Str(100).optional(),
		fixed: FixedTimes.optional(),
		booking: TransitBooking.optional(),
	}),
	z.object({ kind: z.literal("flight"), flight: FlightDetails }),
	z.object({
		kind: z.literal("other"),
		otherKind: OtherKind,
		label: z.string().max(80).optional(),
		geometry: LineString.optional(),
	}),
]);
/** Leg details, capped at LEG_LIMITS.detailsBytes serialized. */
export const LegDetails = LegDetailsUnion.refine(
	(d) => JSON.stringify(d).length <= LEG_LIMITS.detailsBytes,
	{ message: `details are larger than ${LEG_LIMITS.detailsBytes} bytes` },
);
export type LegDetails = z.infer<typeof LegDetailsUnion>;

/**
 * What `legs.details` holds in the database: a LegDetails, or the column
 * default `{}`, which means `{ kind: 'none' }`. Read through `readLegDetails`.
 */
export type StoredLegDetails = LegDetails | Record<string, never>;

/**
 * Normalises a stored `legs.details` value. `{}` (the DB default) reads as
 * `{ kind: 'none' }`. Writes are always parsed with `LegDetails`, so a value
 * that no longer parses can only come from a later schema change; it also reads
 * as `none` rather than breaking the whole trip graph.
 */
export function readLegDetails(stored: unknown): LegDetails {
	const parsed = LegDetails.safeParse(stored);
	return parsed.success ? parsed.data : { kind: "none" };
}
