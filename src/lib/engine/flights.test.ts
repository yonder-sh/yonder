/**
 * FEEDBACK-3 flight rules (FB-18, FB-19, FB-20): the great-circle estimate,
 * what a flight knows at each stage, airport detection by coordinates plus
 * name, and zone labels at the flight's own moment (DST).
 */
import "./__fixtures__/host-tz";
import { describe, expect, it } from "vitest";
import type { FlightDetails, LegDetails } from "@/lib/schemas/legs";
import {
	AUTO_FLIGHT_MIN_KM,
	airportNameScore,
	bookedWith,
	bookingFlights,
	bookingRoute,
	flightArrDate,
	flightDepDate,
	flightEstimateBetween,
	flightEstimateMin,
	flightTimes,
	isAutoFlight,
	looksLikeAirportNode,
	nodeIsAirport,
	shiftFlight,
} from "./flights";
import { haversineKm } from "./geo";
import {
	hhmm,
	localDateOf,
	localDateTimeToEpoch,
	tzLabel,
	tzOffsetMin,
	wallToEpoch,
} from "./time";
import type { GraphLeg } from "./types";

const JFK = {
	iata: "JFK",
	name: "John F Kennedy International Airport",
	tz: "America/New_York",
	lat: 40.6398,
	lng: -73.7789,
};
const HND = {
	iata: "HND",
	name: "Tokyo Haneda International Airport",
	tz: "Asia/Tokyo",
	lat: 35.5523,
	lng: 139.78,
};
const EWR = {
	iata: "EWR",
	name: "Newark Liberty International Airport",
	tz: "America/New_York",
	lat: 40.6925,
	lng: -74.1687,
};
const IST = {
	iata: "IST",
	name: "Istanbul Airport",
	tz: "Europe/Istanbul",
	lat: 41.2753,
	lng: 28.7519,
};
const SYD = {
	iata: "SYD",
	name: "Sydney Kingsford Smith International Airport",
	tz: "Australia/Sydney",
	lat: -33.9461,
	lng: 151.1772,
};

describe("the great-circle estimate (FB-18)", () => {
	it("is km ÷ 800 km/h + 30 min, rounded to 5 min", () => {
		expect(flightEstimateMin(0)).toBe(30);
		expect(flightEstimateMin(800)).toBe(90);
		expect(flightEstimateMin(1000)).toBe(105); // 75 + 30
		expect(flightEstimateMin(1010)).toBe(105); // 105.75 → 105
		expect(flightEstimateMin(1040)).toBe(110); // 108 → 110
	});

	it("JFK → HND is ~14h 5m (≈ 10,870 km)", () => {
		const km = haversineKm([JFK.lng, JFK.lat], [HND.lng, HND.lat]);
		expect(Math.round(km / 10) * 10).toBeGreaterThan(10_800);
		expect(Math.round(km / 10) * 10).toBeLessThan(10_900);
		expect(flightEstimateBetween(JFK, HND)).toBe(14 * 60 + 5);
	});
});

describe("what a flight knows (FB-18)", () => {
	const base = {
		from: JFK,
		to: HND,
		depDate: "2026-12-12",
		arrDate: "2026-12-13",
	};

	it("only airports and dates: untimed, the estimate, labelled as such", () => {
		expect(flightTimes(base)).toEqual({
			depMs: null,
			arrMs: null,
			minutes: 845,
			estimate: true,
			arrEstimated: false,
			untimed: true,
		});
		expect(flightDepDate(base)).toBe("2026-12-12");
		expect(flightArrDate(base)).toBe("2026-12-13");
	});

	it("a departure time only: the arrival is dep + estimate", () => {
		const t = flightTimes({ ...base, depLocal: "2026-12-12T02:00" });
		expect(t.untimed).toBe(false);
		expect(t.arrEstimated).toBe(true);
		expect(t.estimate).toBe(true);
		// 02:00 EST (UTC−5 in December) = 07:00Z; + 14h 5m = 21:05Z = 06:05 JST.
		expect(new Date(t.depMs as number).toISOString()).toBe(
			"2026-12-12T07:00:00.000Z",
		);
		expect(hhmm(t.arrMs as number, "Asia/Tokyo")).toBe("06:05");
		expect(localDateOf(t.arrMs as number, "Asia/Tokyo")).toBe("2026-12-13");
	});

	it("both times: the ticket's own minutes, not an estimate", () => {
		const t = flightTimes({
			...base,
			depLocal: "2026-12-12T02:00",
			arrLocal: "2026-12-13T05:25",
		});
		expect(t).toMatchObject({ estimate: false, untimed: false, minutes: 805 });
	});

	it("shifts with its days, times or not (date moves, what-if)", () => {
		expect(shiftFlight(base, 2)).toMatchObject({
			depDate: "2026-12-14",
			arrDate: "2026-12-15",
		});
		expect(
			shiftFlight({ ...base, depLocal: "2026-12-12T02:00" }, -1),
		).toMatchObject({ depLocal: "2026-12-11T02:00", depDate: "2026-12-11" });
	});
});

describe("airport detection by coordinates + name (FB-19)", () => {
	const node = (
		type: "place" | "area" | "city",
		name: string,
		category: string | null = null,
		details: Record<string, unknown> = {},
	) => ({ type, name, category, details }) as never;

	it("finds airports among places and areas, whatever their category", () => {
		// The owner's test trip: JFK is a `place`, Haneda an `area`.
		expect(
			looksLikeAirportNode(
				node("place", "John F. Kennedy International Airport"),
			),
		).toBe(true);
		expect(looksLikeAirportNode(node("area", "Haneda Airport"))).toBe(true);
		expect(looksLikeAirportNode(node("place", "成田空港"))).toBe(true);
		expect(looksLikeAirportNode(node("place", "Kansai", "airport"))).toBe(true);
		expect(
			looksLikeAirportNode(node("place", "HND T3", null, { iata: "hnd" })),
		).toBe(true);
	});

	it("never a hotel, a station or a city named after the airport", () => {
		expect(
			looksLikeAirportNode(node("place", "Hilton Tokyo Narita Airport Hotel")),
		).toBe(false);
		expect(looksLikeAirportNode(node("place", "Haneda Airport Station"))).toBe(
			false,
		);
		expect(
			looksLikeAirportNode(
				node("place", "TWA Hotel at JFK Airport", "lodging"),
			),
		).toBe(false);
		expect(looksLikeAirportNode(node("city", "Airport City"))).toBe(false);
	});

	it("matches a flight's airport within 5 km by name, or by IATA anywhere", () => {
		const jfkPlace = node("place", "John F. Kennedy International Airport");
		expect(nodeIsAirport(jfkPlace, [-73.7781, 40.6413], JFK)).toBe(true);
		// A name that isn't an airport's, but is part of this one's.
		expect(
			nodeIsAirport(node("area", "Haneda"), [139.7798, 35.5494], HND),
		).toBe(true);
		// Too far away.
		expect(nodeIsAirport(jfkPlace, [-74.1745, 40.6895], JFK)).toBe(false);
		// Close, but a hotel.
		expect(
			nodeIsAirport(
				node("place", "TWA Hotel", "lodging"),
				[-73.7771, 40.6457],
				JFK,
			),
		).toBe(false);
		expect(
			nodeIsAirport(
				node("place", "Somewhere", null, { iata: "JFK" }),
				null,
				JFK,
			),
		).toBe(true);
	});

	it("survives a crafted airport code (no regex from it)", () => {
		const shibuya = node("area", "Shibuya");
		expect(() =>
			airportNameScore(shibuya, { iata: "a(b", name: "Nowhere" }),
		).not.toThrow();
		expect(airportNameScore(node("place", "JFK T4"), JFK)).toBe(2);
	});

	it("keeps ground transfers between airports out of the default", () => {
		const km = haversineKm([JFK.lng, JFK.lat], [EWR.lng, EWR.lat]);
		expect(km).toBeLessThan(AUTO_FLIGHT_MIN_KM);
	});

	it("knows an auto flight from a person's", () => {
		expect(
			isAutoFlight({ mode: "flight", isEdited: false, source: "estimate" }),
		).toBe(true);
		expect(
			isAutoFlight({ mode: "flight", isEdited: true, source: "manual" }),
		).toBe(false);
		expect(
			isAutoFlight({ mode: "transit", isEdited: false, source: "estimate" }),
		).toBe(false);
	});
});

describe("zone labels at the moment shown (FB-20)", () => {
	it("a December JFK flight is EST (UTC−5), even while New York is on EDT today", () => {
		const today = Date.UTC(2026, 8, 24, 12); // Thu 24 Sep 2026
		const dep = localDateTimeToEpoch("2026-12-12T02:00", JFK.tz) as number;
		expect(tzLabel(JFK.tz, today)).toBe("EDT");
		expect(tzLabel(JFK.tz, dep)).toBe("EST");
		expect(tzOffsetMin(JFK.tz, dep)).toBe(-300);
	});

	it("EWR on Sun 7 Nov 2027, when US DST ends: 01:00–02:00 happens twice", () => {
		// TK 11 IST 19:30 TRT Sat 6 Nov → EWR 01:30 Sun 7 Nov.
		const r = wallToEpoch("2027-11-07", "01:30", EWR.tz);
		expect(r.kind).toBe("ambiguous");
		const first = localDateTimeToEpoch("2027-11-07T01:30", EWR.tz) as number;
		const second = localDateTimeToEpoch(
			"2027-11-07T01:30",
			EWR.tz,
			"later",
		) as number;
		expect(second - first).toBe(3_600_000);
		expect(tzLabel(EWR.tz, first)).toBe("EDT");
		expect(tzLabel(EWR.tz, second)).toBe("EST");
		// The flight's length follows the fold: 13h (EDT) or 14h (EST).
		const f = {
			from: IST,
			to: EWR,
			depLocal: "2027-11-06T19:30",
			arrLocal: "2027-11-07T01:30",
		};
		expect(flightTimes(f).minutes).toBe(13 * 60);
		expect(flightTimes({ ...f, arrFold: "later" }).minutes).toBe(14 * 60);
		// The same day at noon is EST; the day before, EDT.
		expect(
			tzLabel(
				EWR.tz,
				localDateTimeToEpoch("2027-11-07T12:00", EWR.tz) as number,
			),
		).toBe("EST");
		expect(
			tzLabel(
				EWR.tz,
				localDateTimeToEpoch("2027-11-06T12:00", EWR.tz) as number,
			),
		).toBe("EDT");
	});

	it("Sydney (southern hemisphere) moves to AEDT on Sun 3 Oct 2027", () => {
		const before = localDateTimeToEpoch("2027-10-02T12:00", SYD.tz) as number;
		const after = localDateTimeToEpoch("2027-10-03T12:00", SYD.tz) as number;
		expect(tzOffsetMin(SYD.tz, before)).toBe(600);
		expect(tzOffsetMin(SYD.tz, after)).toBe(660);
		expect(tzLabel(SYD.tz, before)).not.toBe(tzLabel(SYD.tz, after));
		// 02:30 on the change day doesn't exist (clocks go 02:00 → 03:00).
		expect(wallToEpoch("2027-10-03", "02:30", SYD.tz).kind).toBe("nonexistent");
		// A December SYD flight is in summer time (UTC+11).
		const dec = localDateTimeToEpoch("2026-12-12T10:00", SYD.tz) as number;
		expect(tzOffsetMin(SYD.tz, dec)).toBe(660);
	});
});

describe("bookings: flights bought together", () => {
	const ap = (iata: string, tz: string) => ({
		iata,
		name: iata,
		tz,
		lat: 0,
		lng: 0,
	});
	const PHL = ap("PHL", "America/New_York");
	const CLT = ap("CLT", "America/New_York");
	const DFW = ap("DFW", "America/Chicago");
	const EWR = ap("EWR", "America/New_York");
	type Row = { id: string; flight: FlightDetails };
	const fly = (
		id: string,
		from: typeof PHL,
		to: typeof PHL,
		dep: string,
		more: Partial<FlightDetails> = {},
	): Row => ({
		id,
		flight: { from, to, depDate: dep, seats: [], bookingId: "b1", ...more },
	});
	/** The little of a graph index that bookings read. */
	const reader = (rows: Row[]) => {
		const legs = rows.map((r) => ({ id: r.id }) as GraphLeg);
		const flightOf = (id: string) =>
			rows.find((r) => r.id === id)?.flight as FlightDetails;
		return {
			graph: { legs },
			leg: (id: string | null | undefined) => legs.find((l) => l.id === id),
			legDetails: (leg: GraphLeg): LegDetails => ({
				kind: "flight",
				flight: flightOf(leg.id),
			}),
		};
	};

	it("finds a booking's flights from any one of them, in flying order", () => {
		const ix = reader([
			fly("back", DFW, PHL, "2026-12-31"),
			fly("out2", CLT, DFW, "2026-12-24", { depLocal: "2026-12-24T12:10" }),
			fly("out1", PHL, CLT, "2026-12-24", { depLocal: "2026-12-24T08:00" }),
			fly("other", PHL, EWR, "2026-12-25", { bookingId: "b2" }),
			fly("alone", PHL, EWR, "2026-12-26", { bookingId: undefined }),
		]);
		expect(bookingFlights(ix, "back").map((b) => b.leg.id)).toEqual([
			"out1",
			"out2",
			"back",
		]);
		expect(bookedWith(ix, "out2")).toEqual(["PHL → CLT", "DFW → PHL"]);
		expect(bookedWith(ix, "alone")).toEqual([]);
		expect(bookingFlights(ix, "other")).toHaveLength(1);
		expect(bookingFlights(ix, "alone")).toEqual([]);
		expect(bookingFlights(ix, null)).toEqual([]);
	});

	it("names where a booking goes: one way, there and back, or on to somewhere else", () => {
		const out1 = fly("out1", PHL, CLT, "2026-12-24", {
			depLocal: "2026-12-24T08:00",
			connection: { nextLegId: "out2" },
		});
		const out2 = fly("out2", CLT, DFW, "2026-12-24", {
			depLocal: "2026-12-24T12:10",
			connection: { prevLegId: "out1" },
		});
		const route = (rows: Row[]) =>
			bookingRoute(bookingFlights(reader(rows), rows[0]?.id));
		expect(route([out1, out2])).toBe("PHL → DFW");
		expect(route([out1, out2, fly("back", DFW, PHL, "2026-12-31")])).toBe(
			"PHL ↔ DFW",
		);
		expect(route([out1, out2, fly("on", DFW, EWR, "2026-12-31")])).toBe(
			"PHL → DFW → EWR",
		);
		expect(bookingRoute([])).toBe("");
	});
});
