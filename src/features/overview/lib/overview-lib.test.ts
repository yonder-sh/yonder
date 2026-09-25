/**
 * The Overview's pure pieces (docs/OVERVIEW.md): the phase ("today" in each
 * day's own zone, or `?asOf`), day lines and their sections, highlight
 * selection, label declutter and the globe's projection.
 */
import { describe, expect, it } from "vitest";
import { scenario as buildScenario } from "@/lib/engine/__fixtures__/demo";
import { indexGraph } from "@/lib/engine/graph-index";
import { zonedEpoch } from "@/lib/engine/time";
import { declutterLabels, type LabelCandidate } from "../globe/labels";
import { arcPoints, pathOf, projector } from "../globe/projection";
import { dayLines, daySections } from "./day-lines";
import {
	favourites,
	type HighlightCandidate,
	pickHighlights,
} from "./highlights";
import { tripPhase } from "./phase";
import { tripRoute } from "./trip-route";

describe("tripPhase", () => {
	// Day 1 leaves New York; the rest are in Japan.
	const days = [
		{ id: "d1", date: "2027-10-02", tz: "America/New_York" },
		{ id: "d2", date: "2027-10-03", tz: "Asia/Tokyo" },
		{ id: "d3", date: "2027-10-04", tz: "Asia/Tokyo" },
	];

	it("is empty without days", () => {
		expect(tripPhase([], Date.now())).toEqual({ kind: "empty" });
	});

	it("counts down to Day 1 in Day 1's own zone", () => {
		// 23:00 on 30 Sep in New York is already 1 Oct in Tokyo: still 2 days.
		const now = zonedEpoch("2027-09-30", "23:00", "America/New_York");
		expect(tripPhase(days, now)).toEqual({ kind: "before", daysToGo: 2 });
	});

	it("knows the day of the trip where that day is", () => {
		// 20:00 on 2 Oct in New York is 3 Oct 09:00 in Tokyo: Day 2 there.
		const now = zonedEpoch("2027-10-02", "20:00", "America/New_York");
		expect(tripPhase(days, now)).toEqual({
			kind: "during",
			index: 1,
			today: "2027-10-03",
		});
	});

	it("is after once the last day is over, and `asOf` overrides today", () => {
		const now = zonedEpoch("2027-10-06", "10:00", "Asia/Tokyo");
		expect(tripPhase(days, now)).toEqual({ kind: "after", daysSince: 2 });
		expect(tripPhase(days, now, "2027-10-01")).toEqual({
			kind: "before",
			daysToGo: 1,
		});
		expect(tripPhase(days, now, "2027-10-04")).toMatchObject({
			kind: "during",
			index: 2,
		});
	});
});

// Tokyo 2 nights → Kyoto 1 → (night bus, no stay) → Seoul 1; home by air.
const s = buildScenario({
	nodes: [
		{
			key: "tokyoHotel",
			parent: "shibuya",
			type: "place",
			category: "lodging",
			name: "Tokyo hotel",
			at: [35.66, 139.7],
		},
		{
			key: "kyotoHotel",
			parent: "kyoto",
			type: "place",
			category: "lodging",
			name: "Kyoto hotel",
			at: [35.0, 135.76],
		},
		{
			key: "seoulHotel",
			parent: "seoul",
			type: "place",
			category: "lodging",
			name: "Seoul hotel",
			at: [37.55, 126.97],
		},
	],
	days: [
		{
			night: "tokyoHotel",
			items: [
				{ k: "sensoji", node: "sensoji" },
				{ k: "th1", node: "tokyoHotel" },
			],
		},
		{
			night: "tokyoHotel",
			items: [
				{ k: "meiji", node: "meijiJingu" },
				{ k: "sky", node: "shibuyaSky" },
				{ k: "sky2", node: "shibuyaSky" },
				{ k: "lunch", title: "Lunch" },
			],
		},
		{ night: "kyotoHotel", items: [{ k: "kiyomizu", node: "kiyomizu" }] },
		{
			items: [
				{ k: "kix", node: "kix" },
				{ k: "icn", node: "icn" },
			],
		},
		{ night: "seoulHotel", items: [{ k: "seoulHotel", node: "seoulHotel" }] },
	],
	legs: [
		{ from: "sky2", to: "kiyomizu", mode: "transit" },
		{ from: "kix", to: "icn", mode: "flight" },
	],
});
const ix = indexGraph(s.graph);
const route = tripRoute(ix);

describe("dayLines", () => {
	const lines = dayLines(ix, route);

	it("one line per day: the night's city, its colour and the day's places", () => {
		expect(lines.map((l) => [l.n, l.city, l.stayIndex])).toEqual([
			[1, "Tokyo", 0],
			[2, "Tokyo", 0],
			[3, "Kyoto", 1],
			[4, "Osaka → Seoul", null],
			[5, "Seoul", 2],
		]);
		expect(lines[0]?.color).toBe(route.colors.JP);
		expect(lines[3]?.color).toBe(route.colors.KR);
		// Hotels and "Lunch" are left out; a place visited twice is named once.
		expect(lines[0]?.places).toEqual(["Senso-ji"]);
		expect(lines[1]?.places).toEqual(["Meiji Jingu", "Shibuya Sky"]);
		expect(lines[4]?.places).toEqual([]);
	});

	it("groups by stay, and stays by country row (a travel day goes with where it leads)", () => {
		const secs = daySections(lines, route);
		expect(
			secs.map((x) => [
				x.row?.countryCode,
				x.days,
				x.groups.map((g) => [g.stayIndex, g.lines.length]),
			]),
		).toEqual([
			[
				"JP",
				3,
				[
					[0, 2],
					[1, 1],
				],
			],
			[
				"KR",
				2,
				[
					[null, 1],
					[2, 1],
				],
			],
		]);
	});

	it("an empty trip has no lines", () => {
		const empty = buildScenario({ days: [] });
		const eix = indexGraph(empty.graph);
		expect(dayLines(eix, tripRoute(eix))).toEqual([]);
		expect(daySections([], tripRoute(eix))).toEqual([]);
	});
});

describe("highlights", () => {
	const c = (
		id: string,
		score: number,
		coverId: string | null,
		photos = 0,
	): HighlightCandidate => ({
		id,
		name: id,
		score,
		top: score > 0 ? 3 : null,
		coverId,
		photos,
	});
	const cands = [
		c("a", 6, "p1", 1),
		c("b", 3, null, 0),
		c("c", 4, "p2", 9),
		c("d", -2, "p3", 2),
		c("e", 5, "p4", 0),
	];

	it("before and during: the best-rated places with a photo", () => {
		expect(pickHighlights(cands, { after: false }).map((h) => h.id)).toEqual([
			"a",
			"e",
			"c",
			"d",
		]);
		expect(pickHighlights(cands, { after: false, limit: 2 })).toHaveLength(2);
	});

	it("after: the most-photographed first", () => {
		expect(pickHighlights(cands, { after: true }).map((h) => h.id)).toEqual([
			"c",
			"d",
			"a",
			"e",
		]);
	});

	it("favourites: the best scores above zero, photo or not", () => {
		expect(favourites(cands).map((h) => h.id)).toEqual(["a", "e", "c"]);
	});
});

describe("declutterLabels", () => {
	const cand = (
		id: string,
		x: number,
		y: number,
		priority: number,
		group = "JP",
	): LabelCandidate => ({
		id,
		x,
		y,
		r: 4,
		w: 50,
		h: 14,
		priority,
		group,
	});

	it("at most two per country, biggest stays first", () => {
		const out = declutterLabels(
			[
				cand("tokyo", 100, 100, 4),
				cand("kyoto", 100, 200, 3),
				cand("osaka", 100, 300, 2),
				cand("seoul", 300, 100, 3, "KR"),
			],
			{ width: 600, height: 400 },
		);
		expect(out.map((l) => l.id).sort()).toEqual(["kyoto", "seoul", "tokyo"]);
	});

	it("never overlaps: a close neighbour moves to the other side or goes", () => {
		const out = declutterLabels(
			[
				cand("kyoto", 100, 100, 3),
				cand("osaka", 104, 104, 2, "X"),
				cand("nara", 102, 100, 1, "Y"),
			],
			{ width: 600, height: 400 },
		);
		const boxes = out.map((l) => ({
			x0: l.x,
			y0: l.y,
			x1: l.x + 50,
			y1: l.y + 14,
		}));
		for (let i = 0; i < boxes.length; i++)
			for (let j = i + 1; j < boxes.length; j++) {
				const a = boxes[i];
				const b = boxes[j];
				if (!a || !b) continue;
				expect(a.x0 < b.x1 && b.x0 < a.x1 && a.y0 < b.y1 && b.y0 < a.y1).toBe(
					false,
				);
			}
		expect(out[0]).toMatchObject({ id: "kyoto", side: "right" });
		expect(out.find((l) => l.id === "osaka")?.side).not.toBe("right");
	});

	it("keeps labels inside the frame", () => {
		const out = declutterLabels([cand("edge", 590, 100, 1)], {
			width: 600,
			height: 400,
		});
		expect(out[0]?.side).toBe("left");
	});
});

describe("globe projection", () => {
	const cam = {
		center: [135, 35] as [number, number],
		zoom: 1,
		width: 800,
		height: 600,
	};
	const proj = projector(cam);

	it("puts the centre in the middle and hides the far side", () => {
		expect(proj.project([135, 35])).toMatchObject({
			x: 400,
			y: 300,
			visible: true,
		});
		expect(proj.project([-45, -35]).visible).toBe(false);
		// East is right, north is up.
		expect(proj.project([140, 35]).x).toBeGreaterThan(400);
		expect(proj.project([135, 40]).y).toBeLessThan(300);
	});

	it("a lifted point just behind the limb still shows", () => {
		// ~95° away: behind the horizon on the ground, over it when lifted.
		const behind: [number, number] = [135 + 95, 0];
		const ground = projector({ ...cam, center: [135, 0] }).project(behind);
		const lifted = projector({ ...cam, center: [135, 0] }).project(behind, 0.3);
		expect(ground.visible).toBe(false);
		expect(lifted.visible).toBe(true);
	});

	it("draws a partial arc only as far as asked", () => {
		const pts = arcPoints([139.7, 35.7], [126.9, 37.5]);
		const full = pathOf(pts, proj, null, 1);
		const half = pathOf(pts, proj, null, 0.5);
		expect(full.startsWith("M")).toBe(true);
		expect(half.length).toBeLessThan(full.length);
		expect(pathOf(pts, proj, null, 0)).toMatch(/^M[\d.]+ [\d.]+$/);
	});
});
