import "./__fixtures__/host-tz";
import { describe, expect, it } from "vitest";
import { scenario } from "./__fixtures__/demo";
import { dayPlace } from "./day-place";
import { indexGraph } from "./graph-index";
import { computeSchedule } from "./schedule";
import { sunTimes } from "./sun";

const minutes = (hm: string) => {
	const [h = "0", m = "0"] = hm.split(":");
	return Number(h) * 60 + Number(m);
};
const near = (actual: string | undefined, expected: string, tol = 3) =>
	expect(
		Math.abs(minutes(actual ?? "99:99") - minutes(expected)),
	).toBeLessThanOrEqual(tol);

describe("sunTimes", () => {
	it("Tokyo on 2027-10-15: 05:47 / 17:07 ±3 min (SUN-01)", () => {
		const t = sunTimes("2027-10-15", 35.6762, 139.6503, "Asia/Tokyo");
		near(t?.sunrise, "05:47");
		near(t?.sunset, "17:07");
		expect(t && minutes(t.goldenStart)).toBeLessThan(t ? minutes(t.sunset) : 0);
	});

	it("Hanoi on 2027-10-15: 05:52 / 17:33 ±3 min (SUN-02)", () => {
		const t = sunTimes("2027-10-15", 21.0285, 105.8542, "Asia/Bangkok");
		near(t?.sunrise, "05:52");
		near(t?.sunset, "17:33");
	});

	it("reports polar days and nights instead of times", () => {
		expect(
			sunTimes("2027-06-21", 78.22, 15.65, "Arctic/Longyearbyen")?.polar,
		).toBe("day");
		expect(
			sunTimes("2027-12-21", 78.22, 15.65, "Arctic/Longyearbyen")?.polar,
		).toBe("night");
	});

	it("is null for bad coordinates", () => {
		expect(sunTimes("2027-10-15", Number.NaN, 0, "UTC")).toBeNull();
	});
});

describe("dayPlace", () => {
	const s = scenario({
		firstDate: "2027-10-03",
		days: [
			{
				items: [
					{ k: "hands", node: "hands", min: 45 },
					{ k: "kiyo", node: "kiyomizu", min: 120 },
				],
			},
			{ night: "ryokan", items: [] },
			{ items: [{ k: "lunch", title: "Lunch", min: 60 }] },
		],
	});
	const ix = indexGraph(s.graph);
	const schedule = computeSchedule(ix);

	it("picks the city with the most scheduled minutes", () => {
		expect(dayPlace(ix, schedule, s.D.d1 ?? "")).toBe(s.N.kyoto);
	});

	it("falls back to that night's stay (the area when there is no city)", () => {
		expect(dayPlace(ix, schedule, s.D.d2 ?? "")).toBe(s.N.kawaguchiko);
	});

	it("then to the previous day's place", () => {
		expect(dayPlace(ix, schedule, s.D.d3 ?? "")).toBe(s.N.kawaguchiko);
	});

	it("after a flight day, the empty days that follow are where the flight landed (COLLAB-2)", () => {
		// KIX → ICN as two zero-length airport items (the QA seed's shape), then
		// four days with nothing planned and no stay.
		const f = scenario({
			firstDate: "2027-10-14",
			days: [
				{
					items: [
						{ k: "kix", node: "kix", min: 0 },
						{ k: "icn", node: "icn", min: 0 },
					],
				},
				{ items: [] },
				{ items: [{ k: "lunch", title: "Lunch", min: 60 }] },
				{ items: [] },
				{ items: [{ k: "tpe", node: "tpe", min: 0 }] },
				{ items: [] },
			],
		});
		const fix = indexGraph(f.graph);
		const fs = computeSchedule(fix);
		// A tie goes to the city the day reaches later.
		expect(dayPlace(fix, fs, f.D.d1 ?? "")).toBe(f.N.seoul);
		expect(dayPlace(fix, fs, f.D.d2 ?? "")).toBe(f.N.seoul);
		expect(dayPlace(fix, fs, f.D.d3 ?? "")).toBe(f.N.seoul);
		expect(dayPlace(fix, fs, f.D.d4 ?? "")).toBe(f.N.seoul);
		expect(dayPlace(fix, fs, f.D.d5 ?? "")).toBe(f.N.taipei);
		expect(dayPlace(fix, fs, f.D.d6 ?? "")).toBe(f.N.taipei);
	});

	it("a flight day spent mostly in the departure city stays there, but the next day is at the arrival", () => {
		const f = scenario({
			firstDate: "2027-10-31",
			days: [
				{
					items: [
						{ k: "osakaMorning", node: "osaka", min: 180 },
						{ k: "kix", node: "kix", min: 0 },
						{ k: "icn", node: "icn", min: 0 },
					],
				},
				{ items: [] },
			],
		});
		const fix = indexGraph(f.graph);
		const fs = computeSchedule(fix);
		expect(dayPlace(fix, fs, f.D.d1 ?? "")).toBe(f.N.osaka);
		expect(dayPlace(fix, fs, f.D.d2 ?? "")).toBe(f.N.seoul);
		// The sun on the day after is Seoul's, in KST.
		expect(fix.tzOf(dayPlace(fix, fs, f.D.d2 ?? ""))).toBe("Asia/Seoul");
	});

	it("an empty day after a stay night is at the stay, whatever the day's last item was", () => {
		const f = scenario({
			days: [
				{ night: "ryokan", items: [{ k: "kiyo", node: "kiyomizu", min: 120 }] },
				{ items: [] },
			],
		});
		const fix = indexGraph(f.graph);
		const fs = computeSchedule(fix);
		expect(dayPlace(fix, fs, f.D.d1 ?? "")).toBe(f.N.kyoto);
		expect(dayPlace(fix, fs, f.D.d2 ?? "")).toBe(f.N.kawaguchiko);
	});

	it("is null when nothing places the day", () => {
		const empty = scenario({ days: [{ items: [{ k: "l", title: "Lunch" }] }] });
		const eix = indexGraph(empty.graph);
		expect(dayPlace(eix, computeSchedule(eix), empty.D.d1 ?? "")).toBeNull();
	});
});
