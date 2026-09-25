/**
 * QA PERF-05 (ADDENDUM §10), WP-Insights' share: the full 35-day Asia 2027
 * trip (125 places, 245 stops) with hours on every place must stay inside the
 * SPEC §19 budget ("a lens change on the Asia 2027 data takes < 50 ms of
 * scripting"). Everything WP-Insights adds to a render runs once per
 * schedule (WeakMap memos), so the budget below is for that one pass:
 * hours issues for every card, the sun for every day header, and the what-if
 * recompute (a stepper click). Medians of several runs; the limits leave
 * room for a busy CI box while failing on a real regression (an O(n²) walk).
 */
import "./__fixtures__/host-tz";
import { describe, expect, it } from "vitest";
import { type DaySpec, scenario } from "./__fixtures__/demo";
import { dateChangeImpact } from "./date-impact";
import { dayPlace } from "./day-place";
import { indexGraph } from "./graph-index";
import { effectiveHours, hoursIssues } from "./hours";
import { computeSchedule } from "./schedule";
import { sunTimes } from "./sun";

/** Real sheet strings (EXTENSIONS §4.2), cycled over the places. */
const SHEET = [
	"11:00–21:00 daily",
	"Mon–Sat 10:00–20:00; Sun/hol to 19:00",
	"10:30–19:00; closed 2nd Tue",
	"11:00–20:00 (wknd/hol from 10:00); last entry 19:00",
	"9:00–22:00 (last entry −60 min); timed",
	"11:00–21:00 (Fri–Sat to 22:00)",
	"18:00–03:00 (some sources list closed Wed — confirm)",
	"~10–17, many closed Sun",
	"Earliest tour 9:30–11:40 (reserve); closed Wed & Fri",
	"Grounds 24h; prayers 9:00–16:00",
];
const CITIES: [key: string, lat: number, lng: number][] = [
	["tokyo", 35.68, 139.76],
	["kyoto", 35.01, 135.77],
	["osaka", 34.69, 135.5],
	["seoul", 37.57, 126.98],
	["taipei", 25.03, 121.56],
];
const CATEGORIES = [
	"museum",
	"shopping",
	"temple_shrine",
	"restaurant",
	"viewpoint",
	"bar",
	"park",
] as const;

function fullTrip() {
	const nodes = Array.from({ length: 125 }, (_, i) => {
		const [parent, lat, lng] = CITIES[i % CITIES.length] as [
			string,
			number,
			number,
		];
		return {
			key: `p${i}`,
			parent,
			type: "place" as const,
			category: CATEGORIES[i % CATEGORIES.length],
			name: `Place ${i}`,
			at: [lat + (i % 7) * 0.004, lng + (i % 5) * 0.004] as [number, number],
		};
	});
	const days: DaySpec[] = Array.from({ length: 35 }, (_, d) => ({
		items: Array.from({ length: 7 }, (_, j) => ({
			k: `i${d}-${j}`,
			node: `p${(d * 7 + j) % 125}`,
			min: 45 + ((d + j) % 4) * 15,
			...(j === 3 && d % 3 === 0 ? { pin: "14:30" } : {}),
		})),
	}));
	const s = scenario({ firstDate: "2027-09-24", nodes, days });
	s.graph.nodes.forEach((n, i) => {
		if (n.type === "place")
			n.details = { openHoursText: SHEET[i % SHEET.length] as string };
	});
	return s;
}

const median = (xs: number[]) =>
	[...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] ?? 0;

function time(runs: number, fn: () => void): number {
	const out: number[] = [];
	for (let i = 0; i < runs; i++) {
		const t = performance.now();
		fn();
		out.push(performance.now() - t);
	}
	return median(out);
}

describe("PERF-05: WP-Insights on the full trip", () => {
	it("hours issues, the sun on every day and the what-if stay well inside 50 ms", () => {
		const s = fullTrip();
		const settings = s.graph.trip.settings;
		expect(s.graph.items).toHaveLength(245);
		expect(s.graph.days).toHaveLength(35);

		const hoursOf = (() => {
			const byId = new Map(s.graph.nodes.map((n) => [n.id, n]));
			return (id: string) => {
				const n = byId.get(id);
				return n ? effectiveHours(n, settings) : null;
			};
		})();
		// Each run gets a fresh schedule, like a lens change or an edit (the
		// memos key on the schedule object); index + schedule are F's cost.
		const fresh = () => {
			const ix = indexGraph(s.graph);
			return { ix, schedule: computeSchedule(ix) };
		};
		const pass = ({ ix, schedule }: ReturnType<typeof fresh>) => {
			const sun = new Map<string, { sunset: string } | null>();
			const sunOf = (dayId: string) => {
				if (sun.has(dayId)) return sun.get(dayId) ?? null;
				const day = ix.day(dayId);
				const place = day ? dayPlace(ix, schedule, dayId) : null;
				const at = place ? ix.coordOf(place) : null;
				const out =
					day && place && at
						? sunTimes(day.date, at[1], at[0], ix.tzOf(place))
						: null;
				sun.set(dayId, out);
				return out;
			};
			const issues = hoursIssues(ix, schedule, {
				hoursOf,
				holidays: [],
				sunOf,
			});
			for (const d of s.graph.days) sunOf(d.id);
			return issues;
		};
		const issues = pass(fresh());
		// The fixture really produces issues on the plan (not an empty walk).
		expect(Object.keys(issues.byItem).length).toBeGreaterThan(10);

		const inputs = Array.from({ length: 9 }, fresh);
		let k = 0;
		const plan = time(9, () => pass(inputs[k++] ?? fresh()));
		const holidays: [] = [];
		let delta = 0;
		const whatIf = time(9, () => {
			delta = (delta % 7) + 1;
			dateChangeImpact(
				s.graph,
				{ deltaDays: delta },
				{ hoursOf, holidays, today: "2026-09-23" },
			);
		});
		console.info(
			`PERF-05 (WP-Insights): plan pass ${plan.toFixed(1)} ms · what-if ${whatIf.toFixed(1)} ms (medians)`,
		);
		// WP-Insights' share of the 50 ms lens-change budget.
		expect(plan).toBeLessThan(15);
		// A stepper click: shift, index + schedule the shifted copy, its issues, the diff.
		expect(whatIf).toBeLessThan(50);
	});
});
