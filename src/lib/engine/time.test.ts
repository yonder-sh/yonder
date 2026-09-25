import "./__fixtures__/host-tz";
import { Temporal } from "temporal-polyfill";
import { describe, expect, it } from "vitest";
import {
	addDays,
	daysBetween,
	endOfLocalDate,
	hhmm,
	isValidTimeZone,
	localDateTimeToEpoch,
	nextWallOccurrence,
	normalizeTimeZone,
	parseDate,
	parseTime,
	parseWallTime,
	safeTimeZone,
	TZ_ABBREVIATIONS,
	toZonedTime,
	tzLabel,
	tzOffsetMin,
	wallToEpoch,
	zonedEpoch,
} from "./time";

describe("parsing", () => {
	it("parses dates strictly", () => {
		expect(parseDate("2027-10-08")).toBe("2027-10-08");
		expect(parseDate("2027-02-30")).toBeNull();
		expect(parseDate("2027-10-8")).toBeNull();
		expect(parseDate("")).toBeNull();
		expect(parseDate(null)).toBeNull();
	});

	it("parses times and zero-pads", () => {
		expect(parseTime("9:00")).toBe("09:00");
		expect(parseTime("23:59")).toBe("23:59");
		expect(parseTime(" 07:05 ")).toBe("07:05");
		expect(parseTime("24:00")).toBeNull();
		expect(parseTime("12:60")).toBeNull();
		expect(parseTime("noon")).toBeNull();
		expect(parseTime(undefined)).toBeNull();
	});

	it("parses wall times with or without a date", () => {
		expect(parseWallTime("17:30", "2027-10-08")).toEqual({
			date: "2027-10-08",
			time: "17:30",
			hasDate: false,
		});
		expect(parseWallTime("2027-10-09T01:00", "2027-10-08")).toEqual({
			date: "2027-10-09",
			time: "01:00",
			hasDate: true,
		});
		expect(parseWallTime("2027-10-09 1:00", "2027-10-08")).toEqual({
			date: "2027-10-09",
			time: "01:00",
			hasDate: true,
		});
		expect(parseWallTime("2027-13-09T01:00", "2027-10-08")).toBeNull();
		expect(parseWallTime("tomorrow", "2027-10-08")).toBeNull();
		expect(parseWallTime(null, "2027-10-08")).toBeNull();
	});
});

describe("time zones", () => {
	it("validates and canonicalizes IANA ids", () => {
		expect(normalizeTimeZone("Asia/Tokyo")).toBe("Asia/Tokyo");
		expect(normalizeTimeZone("asia/ho_chi_minh")).toBe("Asia/Ho_Chi_Minh");
		expect(normalizeTimeZone("Mars/Base")).toBeNull();
		expect(normalizeTimeZone("")).toBeNull();
		expect(isValidTimeZone("America/New_York")).toBe(true);
		expect(isValidTimeZone("EST5EDT_nope")).toBe(false);
	});
});

describe("wall time <-> instant", () => {
	it("resolves a plain wall time", () => {
		const r = wallToEpoch("2027-10-22", "10:25", "Asia/Seoul");
		expect(r.kind).toBe("exact");
		expect(new Date(r.epochMs).toISOString()).toBe("2027-10-22T01:25:00.000Z");
	});

	it("flags the ambiguous hour at the US fall-back (Nov 7 2027) and picks the earlier one", () => {
		const r = wallToEpoch("2027-11-07", "01:30", "America/New_York");
		expect(r.kind).toBe("ambiguous");
		expect(toZonedTime(r.epochMs, "America/New_York").offset).toBe("-04:00");
	});

	it("flags the skipped hour at the US spring-forward and shifts forward", () => {
		const r = wallToEpoch("2027-03-14", "02:30", "America/New_York");
		expect(r.kind).toBe("nonexistent");
		expect(toZonedTime(r.epochMs, "America/New_York").time).toBe("03:30");
	});

	it("finds the next occurrence of a wall time (airline +1)", () => {
		const depart = wallToEpoch(
			"2027-10-29",
			"21:40",
			"Asia/Ho_Chi_Minh",
		).epochMs;
		const next = nextWallOccurrence("05:30", "Asia/Ho_Chi_Minh", depart);
		expect(toZonedTime(next.epochMs, "Asia/Ho_Chi_Minh").local).toBe(
			"2027-10-30T05:30",
		);
		const sameDay = nextWallOccurrence("23:00", "Asia/Ho_Chi_Minh", depart);
		expect(toZonedTime(sameDay.epochMs, "Asia/Ho_Chi_Minh").local).toBe(
			"2027-10-29T23:00",
		);
		const exact = nextWallOccurrence("21:40", "Asia/Ho_Chi_Minh", depart);
		expect(exact.epochMs).toBe(depart);
	});

	it("computes local midnight at the end of a date", () => {
		const m = endOfLocalDate("2027-10-10", "Asia/Tokyo");
		expect(toZonedTime(m, "Asia/Tokyo").local).toBe("2027-10-11T00:00");
	});

	it("does date arithmetic", () => {
		expect(addDays("2027-10-31", 1)).toBe("2027-11-01");
		expect(daysBetween("2027-10-08", "2027-10-10")).toBe(2);
		expect(daysBetween("2027-10-10", "2027-10-08")).toBe(-2);
	});
});

describe("ZonedTime output", () => {
	it("is plain data that round-trips through Temporal", () => {
		const ms = wallToEpoch("2027-10-22", "13:20", "Asia/Ho_Chi_Minh").epochMs;
		const z = toZonedTime(ms, "Asia/Ho_Chi_Minh", "2027-10-21");
		expect(z).toEqual({
			local: "2027-10-22T13:20",
			date: "2027-10-22",
			time: "13:20",
			timezone: "Asia/Ho_Chi_Minh",
			offset: "+07:00",
			offsetMin: 420,
			epochMs: ms,
			iso: "2027-10-22T13:20+07:00[Asia/Ho_Chi_Minh]",
			dayOffset: 1,
		});
		expect(JSON.parse(JSON.stringify(z))).toEqual(z);
		expect(Temporal.ZonedDateTime.from(z.iso).epochMilliseconds).toBe(ms);
	});

	it("reports negative offsets", () => {
		const z = toZonedTime(Date.UTC(2027, 10, 7, 18, 40), "America/New_York");
		expect(z.offset).toBe("-05:00");
		expect(z.offsetMin).toBe(-300);
		expect(z.local).toBe("2027-11-07T13:40");
	});
});

// ---------------------------------------------------------------------------
// App additions (SPEC §7.4, §9.2)
// ---------------------------------------------------------------------------

describe("zone helpers for the schedule", () => {
	it("resolves zoned wall times and formats them back in any zone", () => {
		const ms = zonedEpoch("2027-10-07", "08:30", "Asia/Tokyo");
		expect(new Date(ms).toISOString()).toBe("2027-10-06T23:30:00.000Z");
		expect(hhmm(ms, "Asia/Tokyo")).toBe("08:30");
		expect(hhmm(new Date(ms), "Asia/Seoul")).toBe("08:30");
		expect(hhmm(ms, "Asia/Ho_Chi_Minh")).toBe("06:30");
		expect(localDateTimeToEpoch("2027-10-07T08:30", "Asia/Tokyo")).toBe(ms);
		expect(localDateTimeToEpoch("08:30", "Asia/Tokyo")).toBeNull();
		expect(localDateTimeToEpoch("2027-10-07T08:30", "Nope/Nope")).toBeNull();
	});

	it("reports UTC offsets, including US DST", () => {
		expect(tzOffsetMin("Asia/Tokyo", Date.UTC(2027, 9, 7))).toBe(540);
		expect(tzOffsetMin("America/New_York", Date.UTC(2027, 10, 5))).toBe(-240);
		expect(tzOffsetMin("America/New_York", Date.UTC(2027, 10, 8))).toBe(-300);
	});

	it("falls back through candidate zones to UTC", () => {
		expect(safeTimeZone("Bad/Zone", "asia/tokyo")).toBe("Asia/Tokyo");
		expect(safeTimeZone(null, undefined, "Nope")).toBe("UTC");
	});

	it("labels zones from the map first, else ICU short names (EDT/EST)", () => {
		const at = Date.UTC(2027, 9, 7);
		expect(tzLabel("Asia/Tokyo", at)).toBe("JST");
		expect(tzLabel("asia/seoul", at)).toBe("KST");
		expect(tzLabel("Europe/Istanbul", at)).toBe("TRT");
		expect(tzLabel("America/New_York", Date.UTC(2027, 10, 5))).toBe("EDT");
		expect(tzLabel("America/New_York", new Date(Date.UTC(2027, 10, 8)))).toBe(
			"EST",
		);
		expect(tzLabel("Not/AZone", at)).toBe("Not/AZone");
		expect(Object.keys(TZ_ABBREVIATIONS)).toHaveLength(9);
	});
});
