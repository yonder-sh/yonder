import { describe, expect, it } from "vitest";
import { isNoteOnlyHours } from "@/lib/engine/hours";
import { OpeningHours } from "@/lib/schemas/hours";
import type { NodeDetails } from "@/lib/schemas/nodes";
import {
	convertOsmHours,
	hoursChanged,
	mergeOsmHours,
} from "./osm-hours.server";
import {
	enqueueOsmHours,
	OSM_HOURS_JOB_DELAY_MS,
} from "./osm-hours-queue.server";

const AT = "2026-09-25T08:00:00.000Z";
const TODAY = "2026-09-25";
const DAY = ["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa", "PH"];

/** "Mo 09:00-18:00" per period, in stored order. */
const week = (h: OpeningHours) =>
	h.periods.map((p) => `${DAY[p.day]} ${p.open}-${p.close}`);
const on = (days: string[], range: string) => days.map((d) => `${d} ${range}`);
const MO_FR = ["Mo", "Tu", "We", "Th", "Fr"];
const ALL = ["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"];

function convert(tag: string) {
	const r = convertOsmHours(tag, { updatedAt: AT, today: TODAY });
	// Whatever comes out is a valid stored value.
	OpeningHours.parse(r.hours);
	expect(r.hours.source).toBe("osm");
	expect(r.hours.updatedAt).toBe(AT);
	return r;
}
function hoursOf(tag: string): OpeningHours {
	const r = convert(tag);
	if (r.kind !== "hours") throw new Error(`skipped: ${r.reason}`);
	return r.hours;
}

describe("OSM opening_hours → OpeningHours (real-world tags)", () => {
	it.each<[string, string[]]>([
		[
			"Mo-Fr 09:00-18:00; Sa 10:00-14:00",
			[...on(MO_FR, "09:00-18:00"), "Sa 10:00-14:00"],
		],
		["Mo-Su 18:00-02:00", on(ALL, "18:00-02:00")],
		["10:00-18:00", on(ALL, "10:00-18:00")],
		["Mo,We,Fr 10:00-16:00", on(["Mo", "We", "Fr"], "10:00-16:00")],
		["Sa-Mo 10:00-16:00", on(["Su", "Mo", "Sa"], "10:00-16:00")],
		// Sloppy input comes back canonical from opening_hours.js.
		["mo-fr 9-18", on(MO_FR, "09:00-18:00")],
		["Mo-Fr 9am-5pm", on(MO_FR, "09:00-17:00")],
		["Mo - Fr 09:00 - 18:00;", on(MO_FR, "09:00-18:00")],
		[
			"Mo-Fr 9:00-12:00,13:00-18:00",
			MO_FR.flatMap((d) => [`${d} 09:00-12:00`, `${d} 13:00-18:00`]),
		],
		// Additional rules add to the days they name.
		[
			"Mo-Fr 08:00-12:00, We 14:00-18:00",
			[
				"Mo 08:00-12:00",
				"Tu 08:00-12:00",
				"We 08:00-12:00",
				"We 14:00-18:00",
				"Th 08:00-12:00",
				"Fr 08:00-12:00",
			],
		],
		[
			"Mo-Fr 11:30-14:00, 17:00-22:00; Sa,Su 11:30-22:00",
			[
				"Su 11:30-22:00",
				...MO_FR.flatMap((d) => [`${d} 11:30-14:00`, `${d} 17:00-22:00`]),
				"Sa 11:30-22:00",
			],
		],
		["Mo-Fr 09:00-18:00; We off", on(["Mo", "Tu", "Th", "Fr"], "09:00-18:00")],
		// A later rule replaces the day (the spec), it doesn't add to it.
		["Mo-Su 11:00-15:00; Mo-Su 17:00-22:00", on(ALL, "17:00-22:00")],
		// Overnight: past midnight, OSM's extended time, midnight itself.
		[
			"Mo-Th 10:00-24:00; Fr,Sa 10:00-03:00",
			[
				...on(["Mo", "Tu", "We", "Th"], "10:00-24:00"),
				"Fr 10:00-03:00",
				"Sa 10:00-03:00",
			],
		],
		["Mo-Su 22:00-26:00", on(ALL, "22:00-02:00")],
		["Mo-Fr 18:00-00:00", on(MO_FR, "18:00-24:00")],
		// Bars: by the letter of the spec Friday's rule ends Thursday night at
		// midnight; the app keeps Thursday open until 01:00, as meant.
		[
			"Mo-Th 17:00-01:00; Fr-Sa 17:00-03:00",
			[
				...on(["Mo", "Tu", "We", "Th"], "17:00-01:00"),
				"Fr 17:00-03:00",
				"Sa 17:00-03:00",
			],
		],
		["Mo-Fr", on(MO_FR, "00:00-24:00")],
	])("%s", (tag, expected) => {
		const h = hoursOf(tag);
		expect(week(h)).toEqual(expected);
		expect(h.alwaysOpen).toBeUndefined();
		expect(h.closedOnHolidays).toBeUndefined();
	});

	it("24/7 and a whole week of 00:00-24:00 are always open", () => {
		expect(hoursOf("24/7")).toMatchObject({ alwaysOpen: true, periods: [] });
		expect(hoursOf("Mo-Su 00:00-24:00")).toMatchObject({
			alwaysOpen: true,
			periods: [],
		});
		// With a comment (and a state: a bare comment is `unknown`), the note.
		expect(hoursOf('24/7 open "self-service"')).toMatchObject({
			alwaysOpen: true,
			note: "self-service",
		});
		expect(convert('24/7 "call first"').kind).toBe("skipped");
	});

	it("PH: own hours become day 7, `PH off` closes on holidays", () => {
		const closed = hoursOf("Tu-Su 10:00-17:00; Mo off; PH off");
		expect(week(closed)).toEqual(
			on(["Su", "Tu", "We", "Th", "Fr", "Sa"], "10:00-17:00"),
		);
		expect(closed.closedOnHolidays).toBe(true);

		expect(week(hoursOf("Mo-Fr 09:00-18:00; PH 10:00-14:00"))).toEqual([
			...on(MO_FR, "09:00-18:00"),
			"PH 10:00-14:00",
		]);
		expect(week(hoursOf("Mo-Fr 08:30-17:00; Sa,Su,PH 09:00-17:00"))).toEqual([
			"Su 09:00-17:00",
			...on(MO_FR, "08:30-17:00"),
			"Sa 09:00-17:00",
			"PH 09:00-17:00",
		]);
		// A Japanese museum: closed Mondays, open on holidays.
		expect(
			week(hoursOf("Tu-Su 09:30-17:00; Mo off; PH 09:30-17:00")),
		).toContain("PH 09:30-17:00");
		expect(hoursOf("Mo-Sa 10:00-20:00; Su,PH off").closedOnHolidays).toBe(true);
		expect(hoursOf("Mo-Fr 07:00-19:00; PH closed").closedOnHolidays).toBe(true);
		expect(hoursOf("Mo-Su 18:00-02:00; PH off")).toMatchObject({
			closedOnHolidays: true,
		});
		const always = hoursOf("24/7; PH off");
		expect(week(always)).toEqual(on(ALL, "00:00-24:00"));
		expect(always).toMatchObject({ closedOnHolidays: true });
		expect(always.alwaysOpen).toBeUndefined();
	});

	it("nth weekday closures become closedNth", () => {
		expect(hoursOf("Mo-Fr 09:00-17:00; Tu[2] off").closedNth).toEqual([
			{ day: 2, nth: 2 },
		]);
		expect(hoursOf("Mo-Fr 09:00-18:00; Tu[2],Th[-1] off").closedNth).toEqual([
			{ day: 2, nth: 2 },
			{ day: 4, nth: -1 },
		]);
		expect(hoursOf("Mo-Fr 09:00-18:00; Mo[1-2] off").closedNth).toEqual([
			{ day: 1, nth: 1 },
			{ day: 1, nth: 2 },
		]);
	});

	it("dates become exceptions inside the two-year window", () => {
		expect(hoursOf("Mo-Sa 10:00-20:00; 2027 Dec 25 off").exceptions).toEqual([
			{ date: "2027-12-25", closed: true },
		]);
		// Every year: this year's and next year's.
		expect(
			hoursOf("Mo-Su 10:00-18:00; Dec 24-26 off").exceptions?.map(
				(e) => e.date,
			),
		).toEqual([
			"2026-12-24",
			"2026-12-25",
			"2026-12-26",
			"2027-12-24",
			"2027-12-25",
			"2027-12-26",
		]);
		expect(
			hoursOf('Mo-Fr 09:00-18:00; Jan 01 off "New year"').exceptions,
		).toEqual([
			{ date: "2027-01-01", closed: true, label: "New year" },
			{ date: "2028-01-01", closed: true, label: "New year" },
		]);
		expect(
			hoursOf("Mo-Fr 10:00-19:00; Dec 31 10:00-15:00").exceptions?.[0],
		).toEqual({
			date: "2026-12-31",
			closed: false,
			periods: [{ open: "10:00", close: "15:00" }],
		});
		// Across the new year, and a past date (ignored).
		expect(
			hoursOf("Mo-Su 10:00-18:00; Dec 31-Jan 02 off").exceptions?.map(
				(e) => e.date,
			),
		).toEqual([
			"2026-12-31",
			"2027-01-01",
			"2027-01-02",
			"2027-12-31",
			"2028-01-01",
			"2028-01-02",
		]);
		expect(
			hoursOf("Mo-Fr 09:00-18:00; 2020 Dec 25 off").exceptions,
		).toBeUndefined();
	});

	it("a comment on a rule with an explicit state becomes the note", () => {
		expect(hoursOf('Mo-Fr 09:00-18:00 open "cash only"')).toMatchObject({
			note: "cash only",
		});
	});

	it.each<[string, string]>([
		["sunrise-sunset", "variable times"],
		["Mo-Fr 10:00+", "open end"],
		["Jan-Mar Mo-Fr 10:00-16:00; Apr-Dec Mo-Fr 09:00-18:00", "seasons"],
		["Mo-Fr 09:00-18:00; SH off", "school holidays"],
		["Mo-Sa 10:00-20:00; Su 11:00-18:00; easter off", "easter"],
		["week 01-53/2 Fr 09:00-12:00", "week numbers"],
		['Mo-Fr 09:00-18:00 || "by appointment"', "fallback rule"],
		// A comment without a state is `unknown` in the spec.
		['Mo-Fr 09:00-17:00 "by appointment"', "unknown state"],
		["Mo-Fr 09:00-18:00; Sa 10:00-14:00 unknown", "unknown state"],
		["Mo-Fr 09:00-17:00; Su[-1] 10:00-12:00", "hours on an nth weekday"],
		["Mo-Fr 09:00-18:00; Tu 12:00-14:00 off", "a closed break"],
		// The weekday rule reopens weekday holidays: the model can't say that.
		["PH off; Mo-Fr 09:00-18:00", "rule order"],
		["off", "never open"],
		["Dec 25 off", "never open"],
		["open when we feel like it", "invalid"],
	])("skips %s (%s), keeping the raw tag as the note", (tag) => {
		const r = convert(tag);
		expect(r.kind).toBe("skipped");
		expect(r.hours.note).toBe(tag);
		expect(r.hours.periods).toEqual([]);
		expect(isNoteOnlyHours(r.hours)).toBe(true);
	});

	it("keeps a long unreadable tag's note within the model's 200 characters", () => {
		const tag =
			`Mo-Fr 09:00-18:00; SH off; ${"Sa 10:00-12:00; ".repeat(12)}`.trim();
		const r = convert(tag);
		expect(r.kind).toBe("skipped");
		expect(r.hours.note?.length).toBeLessThanOrEqual(200);
	});
});

describe("OSM hours precedence (mergeOsmHours)", () => {
	const fetchedAt = "2026-10-01T03:00:00.000Z";
	const fetch = (tag: string | null, ref = "N42") => ({
		ref,
		tag,
		fetchedAt,
	});
	const osm = (tag: string): OpeningHours =>
		convertOsmHours(tag, { updatedAt: AT, today: TODAY }).hours;
	const manual: OpeningHours = {
		source: "manual",
		periods: [{ day: 1, open: "08:00", close: "12:00" }],
		updatedAt: AT,
	};

	it("fills empty hours and stamps the fetch", () => {
		const d = mergeOsmHours(
			{ website: "https://x.example" },
			fetch("Mo-Fr 09:00-18:00"),
			{ today: TODAY },
		);
		expect(d).toMatchObject({
			website: "https://x.example",
			openingHoursFetchedAt: fetchedAt,
			openingHoursRef: "N42",
			openingHours: { source: "osm", updatedAt: fetchedAt },
		});
		expect(d?.openingHours && week(d.openingHours)).toEqual(
			on(MO_FR, "09:00-18:00"),
		);
	});

	it("never overwrites manual hours (a person's edit), nor Google's", () => {
		expect(
			mergeOsmHours({ openingHours: manual }, fetch("24/7"), { today: TODAY }),
		).toBeNull();
		expect(
			mergeOsmHours(
				{ openingHours: { ...manual, source: "google" } },
				fetch("24/7"),
				{ today: TODAY },
			),
		).toBeNull();
	});

	it("a newer OSM fetch replaces OSM hours", () => {
		const before: NodeDetails = {
			openingHours: osm("Mo-Fr 09:00-18:00"),
			openingHoursFetchedAt: AT,
			openingHoursRef: "N42",
		};
		const after = mergeOsmHours(before, fetch("Mo-Sa 10:00-20:00"), {
			today: TODAY,
		});
		expect(after?.openingHours && week(after.openingHours)).toEqual(
			on([...MO_FR, "Sa"], "10:00-20:00"),
		);
		expect(after && hoursChanged(before, after)).toBe(true);
	});

	it("the same tag keeps the hours (and their date); only the stamp moves", () => {
		const before: NodeDetails = {
			openingHours: osm("Mo-Fr 09:00-18:00"),
			openingHoursFetchedAt: AT,
			openingHoursRef: "N42",
		};
		const after = mergeOsmHours(before, fetch("Mo-Fr 09:00-18:00"), {
			today: TODAY,
		});
		expect(after?.openingHours).toBe(before.openingHours);
		expect(after?.openingHoursFetchedAt).toBe(fetchedAt);
		expect(after && hoursChanged(before, after)).toBe(false);
		// Also when the stored copy came back from jsonb with its keys reordered.
		const reordered = Object.fromEntries(
			Object.entries(before.openingHours ?? {}).reverse(),
		) as OpeningHours;
		const again = mergeOsmHours(
			{ ...before, openingHours: reordered },
			fetch("Mo-Fr 09:00-18:00"),
			{ today: TODAY },
		);
		expect(again?.openingHours).toBe(reordered);
	});

	it("OSM without hours removes OSM hours (tag gone, or another object)", () => {
		const before: NodeDetails = {
			openingHours: osm("Mo-Fr 09:00-18:00"),
			openingHoursRef: "N42",
			openingHoursFetchedAt: AT,
		};
		const after = mergeOsmHours(before, fetch(null, "W7"), { today: TODAY });
		expect(after?.openingHours).toBeUndefined();
		expect(after).toMatchObject({
			openingHoursRef: "W7",
			openingHoursFetchedAt: fetchedAt,
		});
		expect(after && hoursChanged(before, after)).toBe(true);
		// Nothing before, nothing now: just the stamp.
		const none = mergeOsmHours({}, fetch(null), { today: TODAY });
		expect(none).toEqual({
			openingHoursFetchedAt: fetchedAt,
			openingHoursRef: "N42",
		});
		expect(none && hoursChanged({}, none)).toBe(false);
	});

	it("a tag the model can't say is kept as the note", () => {
		const d = mergeOsmHours({}, fetch("sunrise-sunset"), { today: TODAY });
		expect(d?.openingHours).toMatchObject({
			source: "osm",
			periods: [],
			note: "sunrise-sunset",
		});
	});
});

describe("enqueueOsmHours (node cores)", () => {
	const outbox = () => {
		const jobs: unknown[][] = [];
		return {
			jobs,
			out: {
				tripId: "0190a000-0000-7000-8000-000000000001",
				job: (...args: unknown[]) => {
					jobs.push(args);
					return undefined as never;
				},
			},
		};
	};

	it("queues the trip's job, a moment later, for a place with an OSM ref", () => {
		const { jobs, out } = outbox();
		enqueueOsmHours(out as never, { type: "place", osmRef: "N123" });
		expect(jobs).toEqual([
			[
				"hours",
				"hours.osm",
				{ tripId: out.tripId },
				{
					delay: OSM_HOURS_JOB_DELAY_MS,
					dedupeId: `hours:osm:${out.tripId}`,
					dedupeKeepLast: true,
				},
			],
		]);
	});

	it("skips cities, places without a ref and junk refs", () => {
		const { jobs, out } = outbox();
		enqueueOsmHours(out as never, { type: "city", osmRef: "R1" });
		enqueueOsmHours(out as never, { type: "place" });
		enqueueOsmHours(out as never, { type: "place", osmRef: null });
		enqueueOsmHours(out as never, { type: "place", osmRef: "ChIJxyz" });
		expect(jobs).toEqual([]);
	});
});
