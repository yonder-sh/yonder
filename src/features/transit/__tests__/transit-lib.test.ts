/**
 * WP-Transit's pure rules: flight input (QA FLT-02/03), leg ends and the
 * "Open in Google Maps" link (ADDENDUM §5), the Google proxy date and
 * normaliser (SPEC §14.2.2, QA TR-03/05), the option view helpers, line chips
 * and geometry caps.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("@/server/cache.server", () => ({
	cacheGet: async () => null,
	cacheSet: async () => undefined,
}));

import { indexGraph } from "@/lib/engine/graph-index";
import { localDateTimeToEpoch } from "@/lib/engine/time";
import { demo } from "@/lib/fixtures/demo";
import type { TransitRoute } from "@/lib/schemas/legs";
import { mergeRide, type RideFields, stationLabel } from "../lib/custom-route";
import {
	countryOf,
	googleMapsDirectionsUrl,
	isJapan,
	legEnds,
	touchesJapan,
} from "../lib/endpoints";
import {
	displayFlightNumber,
	dstNote,
	flightLine,
	flightMinutes,
	normalizeFlightNumber,
	repeatedTime,
	storedFold,
	tightConnection,
	validateFlight,
} from "../lib/flight";
import {
	bookingLine,
	doorToDoor,
	fastestId,
	listedRoutes,
	rangeText,
	routeSummary,
	segmentStrip,
} from "../lib/route-view";
import { operatorEn } from "../server/jp/line-names.server";
import { lineColor, shortLineName } from "../server/jp/line-style.server";
import { capPoints } from "../server/jp/transit-route.server";
import {
	normalizeGoogleRoute,
	rankRoutes,
	transitQueryTime,
} from "../server/providers/google.server";

const AIRPORTS: Record<string, { tz: string }> = {
	JFK: { tz: "America/New_York" },
	HND: { tz: "Asia/Tokyo" },
	KIX: { tz: "Asia/Tokyo" },
};
const known = (iata: string) => AIRPORTS[iata.toUpperCase()] ?? null;

describe("flight input", () => {
	it("normalises flight numbers (nh9 → NH9, shown NH 9)", () => {
		expect(normalizeFlightNumber("nh9")).toBe("NH9");
		expect(normalizeFlightNumber("NH 009")).toBe("NH9");
		expect(normalizeFlightNumber("tk-25")).toBe("TK25");
		expect(normalizeFlightNumber("hello world")).toBeNull();
		expect(displayFlightNumber("NH9")).toBe("NH 9");
	});

	it("validates inline: Required, Unknown airport, Arrival is before departure", () => {
		const base = {
			flightNumber: "NH 9",
			from: "JFK",
			to: "HND",
			depLocal: "2027-10-02T02:00",
			arrLocal: "2027-10-03T05:00",
		};
		expect(validateFlight(base, known)).toEqual([]);
		// FB-18: the number is optional, but a bad one is still refused.
		expect(validateFlight({ ...base, flightNumber: "" }, known)).toEqual([]);
		expect(validateFlight({ ...base, flightNumber: "hello" }, known)).toEqual([
			{ field: "flightNumber", message: "Not a flight number" },
		]);
		expect(validateFlight({ ...base, from: "JFKK" }, known)).toEqual([
			{ field: "from", message: "Unknown airport" },
		]);
		expect(
			validateFlight({ ...base, arrLocal: "2027-10-02T05:00" }, known),
		).toEqual([{ field: "arrLocal", message: "Arrival is before departure" }]);
	});

	it("needs only the airports and the date; times are optional (FB-18)", () => {
		const route = { from: "JFK", to: "HND" };
		expect(validateFlight({ ...route, depDate: "2026-12-12" }, known)).toEqual(
			[],
		);
		// Only a departure time: fine, the arrival is estimated.
		expect(
			validateFlight(
				{ ...route, depDate: "2026-12-12", depLocal: "2026-12-12T02:00" },
				known,
			),
		).toEqual([]);
		// No date at all.
		expect(validateFlight(route, known)).toEqual([
			{ field: "depLocal", message: "Required" },
		]);
		// An arrival time without a departure time.
		expect(
			validateFlight(
				{ ...route, depDate: "2026-12-12", arrLocal: "2026-12-13T05:00" },
				known,
			),
		).toEqual([{ field: "depLocal", message: "Add the departure time too" }]);
	});

	it("reads an untimed flight as 'Flight JFK → HND · ~14h 5m est. · times TBD' (FB-18)", () => {
		const f = {
			from: {
				iata: "JFK",
				name: "John F Kennedy International Airport",
				tz: "America/New_York",
				lat: 40.6398,
				lng: -73.7789,
			},
			to: {
				iata: "HND",
				name: "Tokyo Haneda International Airport",
				tz: "Asia/Tokyo",
				lat: 35.5523,
				lng: 139.78,
			},
			depDate: "2026-12-12",
			arrDate: "2026-12-13",
		};
		expect(flightLine(f)).toBe("Flight JFK → HND · ~14h 5m est. · times TBD");
		expect(flightLine({ ...f, flightNumber: "NH10" })).toBe(
			"NH 10 JFK → HND · ~14h 5m est. · times TBD",
		);
		// Only the departure: the arrival is the estimate.
		expect(flightLine({ ...f, depLocal: "2026-12-12T02:00" })).toBe(
			"Flight JFK → HND · ~14h 5m est. · arrival TBD",
		);
		expect(
			flightLine({
				...f,
				depLocal: "2026-12-12T02:00",
				arrLocal: "2026-12-13T05:30",
			}),
		).toBe("Flight JFK → HND · 13h 30m");
	});

	it("computes the duration across zones (JFK 02:00 EDT → HND 05:00⁺¹ JST = 14 h)", () => {
		expect(
			flightMinutes(
				{ local: "2027-10-02T02:00", tz: "America/New_York" },
				{ local: "2027-10-03T05:00", tz: "Asia/Tokyo" },
			),
		).toBe(14 * 60);
	});

	it("flags a tight connection under 60 min when a segment is international", () => {
		const a = (iata: string, country: string, tz: string) => ({
			iata,
			name: iata,
			country,
			tz,
			lat: 0,
			lng: 0,
		});
		const tpe = a("TPE", "TW", "Asia/Taipei");
		const ist = a("IST", "TR", "Europe/Istanbul");
		const ewr = a("EWR", "US", "America/New_York");
		expect(
			tightConnection(
				{ from: tpe, to: ist, arrLocal: "2027-11-05T07:35" },
				{ from: ist, to: ewr, depLocal: "2027-11-05T09:55" },
			),
		).toEqual({ minutes: 140, tight: false });
		expect(
			tightConnection(
				{ from: tpe, to: ist, arrLocal: "2027-11-05T09:10" },
				{ from: ist, to: ewr, depLocal: "2027-11-05T09:55" },
			),
		).toEqual({ minutes: 45, tight: true });
	});

	it("names times the clocks repeat or skip (QA TZ-07)", () => {
		// US DST ends Sun 7 Nov 2027: 01:30 happens twice in New York.
		expect(dstNote("2027-11-07", "01:30", "America/New_York")).toBe(
			"01:30 happens twice on Sun 7 Nov (clocks go back). It counts as 01:30 EDT, not EST.",
		);
		// US DST starts Sun 14 Mar 2027: 02:30 is skipped.
		expect(dstNote("2027-03-14", "02:30", "America/New_York")).toBe(
			"02:30 doesn't exist on Sun 14 Mar (clocks go forward). It counts as 03:30 EDT.",
		);
		expect(dstNote("2027-11-07", "05:00", "America/New_York")).toBeNull();
		expect(dstNote("2027-10-03", "05:00", "Asia/Tokyo")).toBeNull();
		expect(dstNote("", "05:00", "Asia/Tokyo")).toBeNull();
	});

	it("lets a repeated time be the second one: IST 19:30 → EWR 01:30 is 13 h as EDT, 14 h as EST (QA TZ-07)", () => {
		expect(repeatedTime("2027-11-07", "01:30", "America/New_York")).toEqual({
			day: "Sun 7 Nov",
			first: "EDT",
			second: "EST",
		});
		expect(repeatedTime("2027-11-07", "03:30", "America/New_York")).toBeNull();
		expect(repeatedTime("2027-10-03", "05:00", "Asia/Tokyo")).toBeNull();
		const dep = { local: "2027-11-06T19:30", tz: "Europe/Istanbul" };
		const arr = { local: "2027-11-07T01:30", tz: "America/New_York" };
		expect(flightMinutes(dep, arr)).toBe(13 * 60);
		expect(flightMinutes(dep, { ...arr, fold: "later" })).toBe(14 * 60);
		expect(
			localDateTimeToEpoch("2027-11-07T01:30", "America/New_York", "later"),
		).toBe(Date.parse("2027-11-07T06:30:00Z"));
		// A fold only means something on a repeated time.
		expect(
			localDateTimeToEpoch("2027-11-07T05:00", "America/New_York", "later"),
		).toBe(Date.parse("2027-11-07T10:00:00Z"));
		expect(storedFold(arr.local, arr.tz, "later")).toBe("later");
		expect(storedFold(arr.local, arr.tz, "earlier")).toBeUndefined();
		expect(storedFold("2027-11-07T05:00", arr.tz, "later")).toBeUndefined();
	});
});

describe("leg ends and Google Maps", () => {
	const ix = indexGraph(demo.graph);
	it("a Tokyo pair is in Japan, with the country inherited from the tree", () => {
		const ends = legEnds(ix, {
			kind: "pair",
			fromItemId: demo.I.loft as string,
			toItemId: demo.I.meiji as string,
		});
		expect(ends.from?.country).toBe("JP");
		expect(ends.to?.country).toBe("JP");
		expect(ends.from?.tz).toBe("Asia/Tokyo");
		expect(isJapan(ends)).toBe(true);
		expect(touchesJapan(ends)).toBe(true);
	});
	it("KIX → ICN touches Japan but isn't inside it", () => {
		const ends = legEnds(ix, {
			kind: "pair",
			fromItemId: demo.I.kix as string,
			toItemId: demo.I.icn as string,
		});
		expect(isJapan(ends)).toBe(false);
		expect(touchesJapan(ends)).toBe(true);
		expect(countryOf(ix, ends.to?.nodeId)).toBe("KR");
	});
	it("builds the SPEC §14.2.1 link", () => {
		expect(
			googleMapsDirectionsUrl(
				{ lat: 35.4983, lng: 138.769 },
				{ lat: 35.1265, lng: 138.911 },
			),
		).toBe(
			"https://www.google.com/maps/dir/?api=1&origin=35.4983,138.769&destination=35.1265,138.911&travelmode=transit",
		);
	});
});

describe("Google Routes (proxy date and normaliser)", () => {
	it("moves a 2027 departure into the window, same weekday and local time (QA TR-05)", () => {
		const depart = new Date("2027-10-05T01:10:00.000Z"); // Tue 10:10 JST
		const now = new Date("2026-09-22T12:00:00.000Z");
		const { queryAt, shiftMs } = transitQueryTime(depart, "Asia/Tokyo", now);
		expect(queryAt.getTime()).toBeGreaterThanOrEqual(now.getTime());
		expect(queryAt.getTime()).toBeLessThanOrEqual(
			now.getTime() + 95 * 86_400_000,
		);
		const jst = new Date(queryAt.getTime() + 9 * 3_600_000);
		expect(jst.getUTCDay()).toBe(2);
		expect(jst.getUTCHours()).toBe(10);
		expect(jst.getUTCMinutes()).toBe(10);
		expect(Math.abs(shiftMs % (7 * 86_400_000))).toBe(0);
		// Inside the window: unchanged.
		const soon = new Date("2026-10-01T00:00:00.000Z");
		expect(transitQueryTime(soon, "Asia/Tokyo", now).shiftMs).toBe(0);
	});

	it("keeps the wall time across a DST change (New York)", () => {
		const depart = new Date("2027-07-06T13:00:00.000Z"); // Tue 09:00 EDT
		const now = new Date("2026-12-01T12:00:00.000Z"); // EST season
		const { queryAt } = transitQueryTime(depart, "America/New_York", now);
		const est = new Date(queryAt.getTime() - 5 * 3_600_000);
		expect(est.getUTCHours()).toBe(9);
		expect(est.getUTCDay()).toBe(2);
	});

	const step = (
		travelMode: string,
		min: number,
		t?: {
			line: string;
			short?: string;
			dep: string;
			arr: string;
			vehicle?: string;
		},
	) => ({
		travelMode,
		staticDuration: `${min * 60}s`,
		...(t
			? {
					transitDetails: {
						stopDetails: {
							departureStop: { name: "Ogikubo" },
							arrivalStop: { name: "Nakano" },
							departureTime: t.dep,
							arrivalTime: t.arr,
						},
						transitLine: {
							name: t.line,
							nameShort: t.short,
							color: "#f15a22",
							vehicle: { type: t.vehicle ?? "HEAVY_RAIL" },
						},
						stopCount: 1,
					},
				}
			: {}),
	});

	it("normalises routes, drops walk-only ones, ranks by arrival (QA TR-03)", () => {
		const shift = 0;
		const rapid = normalizeGoogleRoute(
			{
				duration: "900s",
				legs: [
					{
						steps: [
							step("WALK", 4),
							step("TRANSIT", 5, {
								line: "JR Chuo Rapid",
								short: "Chuo",
								dep: "2027-10-05T01:14:00Z",
								arr: "2027-10-05T01:19:00Z",
							}),
							step("WALK", 6),
						],
					},
				],
			},
			0,
			shift,
		);
		const bus = normalizeGoogleRoute(
			{
				duration: "1800s",
				legs: [
					{
						steps: [
							step("TRANSIT", 30, {
								line: "Kanto Bus",
								dep: "2027-10-05T01:10:00Z",
								arr: "2027-10-05T01:40:00Z",
								vehicle: "BUS",
							}),
						],
					},
				],
			},
			1,
			shift,
		);
		const walkOnly = normalizeGoogleRoute(
			{ duration: "1200s", legs: [{ steps: [step("WALK", 20)] }] },
			2,
			shift,
		);
		expect(walkOnly).toBeNull();
		expect(rapid?.segments.map((s) => s.mode)).toEqual([
			"walk",
			"train",
			"walk",
		]);
		expect(rapid?.walkMin).toBe(10);
		expect(rapid?.segments[1]?.color).toBe("#F15A22");
		expect(bus?.segments[0]?.mode).toBe("bus");
		const ranked = rankRoutes([bus as TransitRoute, rapid as TransitRoute]);
		expect(
			ranked[0]?.segments.some((s) => s.lineName === "JR Chuo Rapid"),
		).toBe(true);
		// A proxy-date query is labelled and shifted back.
		const shifted = normalizeGoogleRoute(
			{
				duration: "900s",
				legs: [
					{
						steps: [
							step("TRANSIT", 15, {
								line: "Line 2",
								dep: "2026-10-06T01:00:00Z",
								arr: "2026-10-06T01:15:00Z",
							}),
						],
					},
				],
			},
			0,
			52 * 7 * 86_400_000,
		);
		expect(shifted?.scheduleEstimate).toBe(true);
		expect(shifted?.segments[0]?.departAt).toBe("2025-10-07T01:00:00.000Z");
	});
});

describe("option view helpers", () => {
	const fuji: TransitRoute = {
		id: "m:fuji",
		source: "manual",
		durationMin: 136,
		walkMin: 10,
		transfers: 0,
		label: "Fuji Excursion 7",
		segments: [
			{ mode: "walk", durationMin: 10 },
			{ mode: "train", lineName: "Fuji Excursion 7", durationMin: 116 },
			{ mode: "other", vehicleType: "TAXI", durationMin: 10 },
		],
	};
	it("reads like QA TR-07: Walk · Fuji Excursion 7 · Taxi", () => {
		expect(routeSummary(fuji)).toBe("Walk · Fuji Excursion 7 · Taxi");
	});
	it("splits the strip by time and marks walking", () => {
		const parts = segmentStrip(fuji);
		expect(parts.reduce((t, p) => t + p.share, 0)).toBeCloseTo(1, 6);
		expect(parts[0]?.walk).toBe(true);
		expect(parts[1]?.share).toBeCloseTo(116 / 136, 6);
	});
	it("shows an estimate's range and picks the fastest", () => {
		expect(rangeText({ range: { lo: 104, hi: 121 } })).toBe("1h44–2h01");
		const a = { ...fuji, id: "a", durationMin: 50 };
		const b = { ...fuji, id: "b", durationMin: 40 };
		expect(fastestId([a, b])).toBe("b");
	});
	it("writes the booking line (refs masked upstream for guests)", () => {
		expect(
			bookingLine({
				trainNumber: "Fuji Excursion 7",
				car: "3",
				ref: "E7K2Q9",
				seats: [{ seat: "5A" }, { seat: "5B" }],
			}),
		).toBe("Fuji Excursion 7 · Car 3 · Seats 5A, 5B · ref E7K2Q9");
	});
});

describe("imported manual routes stay listed (QA MT-01)", () => {
	const sheet: TransitRoute = {
		id: "sheet",
		source: "manual",
		durationMin: 10,
		walkMin: 0,
		transfers: 0,
		label: "Keikyu",
		segments: [{ mode: "train", lineName: "Keikyu", durationMin: 10 }],
	};
	const est = (id: string, durationMin: number): TransitRoute => ({
		id,
		source: "estimate",
		durationMin,
		walkMin: 2,
		transfers: 0,
		segments: [{ mode: "train", lineName: "Keikyu Airport Line", durationMin }],
	});
	it("lists the chosen manual route next to fetched estimates it isn't in", () => {
		const ids = listedRoutes([est("e1", 7), est("e2", 9)], sheet).map(
			(r) => r.id,
		);
		expect(ids).toEqual(["sheet", "e1", "e2"]);
	});
	it("shows the chosen route alone before any fetch, and never twice", () => {
		expect(listedRoutes([], sheet).map((r) => r.id)).toEqual(["sheet"]);
		expect(listedRoutes([sheet, est("e1", 7)], sheet)).toHaveLength(2);
		// A fetched route that was replaced by a refresh isn't resurrected.
		expect(listedRoutes([est("e2", 9)], est("e1", 7)).map((r) => r.id)).toEqual(
			["e2"],
		);
		expect(listedRoutes([est("e2", 9)], undefined)).toHaveLength(1);
	});
});

describe("a reserved route's wait (QA MT-07, TR-07)", () => {
	const at = (hhmm: string, date = "2027-10-06") =>
		new Date(`${date}T${hhmm}:00+09:00`);
	it("Breakfast ends 08:00, platform at 08:20, door at 10:36: 2h36m incl. 20m wait", () => {
		expect(
			doorToDoor(at("08:20"), at("10:36"), at("08:00"), "Asia/Tokyo"),
		).toEqual({ minutes: 156, waitMin: 20 });
	});
	it("no idle time: the platform minutes are never counted as a wait (SP3)", () => {
		expect(
			doorToDoor(
				at("21:50"),
				at("06:10", "2027-10-07"),
				at("21:50"),
				"Asia/Tokyo",
			),
		).toEqual({ minutes: 500, waitMin: 0 });
	});
	it("late (the stop ends after the leg starts) or no stop before: the leg's own span", () => {
		expect(
			doorToDoor(at("08:20"), at("10:36"), at("08:40"), "Asia/Tokyo"),
		).toEqual({ minutes: 136, waitMin: 0 });
		expect(doorToDoor(at("08:20"), at("10:36"), null, "Asia/Tokyo")).toEqual({
			minutes: 136,
			waitMin: 0,
		});
	});
	it("last night's stop isn't a wait for a morning train", () => {
		expect(
			doorToDoor(
				at("08:20"),
				at("10:36"),
				at("21:00", "2027-10-05"),
				"Asia/Tokyo",
			),
		).toEqual({ minutes: 136, waitMin: 0 });
	});
});

describe("custom route builder rules (QA MT-05)", () => {
	const step: RideFields & { key: string } = {
		key: "s1",
		mode: "train",
		line: "Fuji Excursion 7",
		minutes: "",
	};
	const ride = {
		durationMin: 117,
		segment: {
			mode: "train" as const,
			lineName: "JR Chuo Line (Central)",
			lineShort: "JR Chuo",
			agency: "JR East",
			color: "#F15A22",
			textColor: "#181D2F",
			stopCount: 24,
			durationMin: 117,
			geometry: {
				type: "LineString" as const,
				coordinates: [
					[139.7, 35.69],
					[138.77, 35.5],
				] as [number, number][],
			},
		},
	};
	it("stores picked stations readable in English", () => {
		expect(stationLabel({ name: "新宿", nameEn: "Shinjuku" })).toBe(
			"Shinjuku (新宿)",
		);
		expect(stationLabel({ name: "河口湖" })).toBe("河口湖");
	});
	it("a typed line keeps its own name and chip; minutes, stops and track come from the network", () => {
		const out = mergeRide(step, ride);
		expect(out.line).toBe("Fuji Excursion 7");
		expect(out.lineShort).toBeUndefined();
		expect(out.agency).toBeUndefined();
		expect(out.color).toBeUndefined();
		expect(out.minutes).toBe("117");
		expect(out.autoMinutes).toBe(true);
		expect(out.stopCount).toBe(24);
		expect(out.geometry?.coordinates).toHaveLength(2);
	});
	it("an empty or picked line takes the network's line, chip and operator", () => {
		const empty = mergeRide({ ...step, line: "" }, ride);
		expect(empty.line).toBe("JR Chuo Line (Central)");
		expect(empty.lineShort).toBe("JR Chuo");
		expect(empty.agency).toBe("JR East");
		const picked = mergeRide(
			{
				...step,
				line: "JR Chuo Line (Central)",
				lineKey: "東日本旅客鉄道|中央線",
			},
			ride,
		);
		expect(picked.lineShort).toBe("JR Chuo");
		// Minutes typed by hand are never replaced.
		expect(mergeRide({ ...step, minutes: "120" }, ride).minutes).toBe("120");
	});
	it("names operators in English", () => {
		expect(operatorEn("東日本旅客鉄道")).toBe("JR East");
		expect(operatorEn("富士山麓電気鉄道")).toBe("Fujikyu");
		expect(operatorEn("どこか鉄道")).toBe("どこか鉄道");
	});
});

describe("line chips and geometry", () => {
	it("names and colours lines people recognise", () => {
		expect(shortLineName("Tokyo Metro Ginza Line", "3号線銀座線")).toBe(
			"Ginza",
		);
		expect(shortLineName("JR Chuo Line (Central)", "中央線")).toBe("JR Chuo");
		expect(shortLineName(undefined, "3号線銀座線")).toBe("銀座線");
		expect(lineColor("東京地下鉄|3号線銀座線")?.bg).toBe("#FF9500");
		expect(lineColor("東京地下鉄|3号線銀座線")?.fg).toBe("#181D2F");
		expect(lineColor("東京都|12号線大江戸線")?.fg).toBe("#FFFFFF");
		expect(lineColor("nope|none")).toBeNull();
	});
	it("caps stored lines at 200 points", () => {
		const coords = Array.from(
			{ length: 1500 },
			(_, i) =>
				[139 + i * 0.001, 35 + Math.sin(i / 10) * 0.01] as [number, number],
		);
		const out = capPoints(coords);
		expect(out.length).toBeLessThanOrEqual(200);
		expect(out[0]).toEqual([139, 35]);
	});
});
