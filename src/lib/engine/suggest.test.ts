import "./__fixtures__/host-tz";
import { describe, expect, it } from "vitest";
import { demo, N, scenario } from "./__fixtures__/demo";
import {
	bboxCenter,
	concatLines,
	greatCircleLine,
	haversineKm,
	unwrapLongitudes,
} from "./geo";
import { indexGraph } from "./graph-index";
import {
	formatShortDuration,
	RAIL_ESTIMATE_ANCHORS,
	railEstimateMin,
	suggestBetween,
	suggestionLabel,
	walkEstimateMin,
} from "./suggest";

describe("railEstimateMin (§9.3)", () => {
	it("passes through every anchor", () => {
		for (const [km, min] of RAIL_ESTIMATE_ANCHORS)
			expect(railEstimateMin(km)).toBe(min);
	});

	it("interpolates linearly and adds 0.25 min/km past 400 km", () => {
		expect(railEstimateMin(1)).toBe(10);
		expect(railEstimateMin(86)).toBe(102); // Shinjuku → Kawaguchiko in a straight line (spec: ≈ 103)
		expect(railEstimateMin(365)).toBe(177); // Tokyo → Kyoto
		expect(railEstimateMin(500)).toBe(210);
		expect(railEstimateMin(-3)).toBe(8);
	});

	it("walks at 4.5 km/h with a 1.3 detour factor", () => {
		expect(walkEstimateMin(0.9, 4.5)).toBe(16);
		expect(walkEstimateMin(1, 5)).toBe(16);
	});
});

describe("suggestBetween", () => {
	const ix = indexGraph(demo.graph);

	it("walks under 1.5 km", () => {
		const s = suggestBetween(ix, N.hands as string, N.loft as string);
		expect(s.mode).toBe("walk");
		expect(s.distanceKm).toBeLessThan(0.1);
		expect(s.label).toMatch(/^walk ~\d+m\?$/);
	});

	it("suggests transit with the rail estimate inside a country", () => {
		const s = suggestBetween(ix, N.hands as string, N.kiyomizu as string);
		expect(s.mode).toBe("transit");
		expect(s.estimateMin).toBe(railEstimateMin(s.distanceKm as number));
		expect(s.label).toMatch(/^transit ~\dh\d\d est\.\?$/);
	});

	it("suggests a flight between countries, without inventing airport time", () => {
		expect(
			suggestBetween(ix, N.osaka as string, N.seoul as string),
		).toMatchObject({
			mode: "flight",
			estimateMin: null,
			label: "flight?",
		});
	});

	it("between two airports, a flight of the great-circle estimate (FB-19)", () => {
		// KIX → ICN ≈ 840 km: 840 / 800 h + 30 min ≈ 93 → 95 min.
		expect(suggestBetween(ix, N.kix as string, N.icn as string)).toMatchObject({
			mode: "flight",
			estimateMin: 95,
			label: "flight ~1h35 est.?",
		});
	});

	it("knows nothing without coordinates in one country", () => {
		const s = scenario({
			nodes: [{ key: "x", parent: "tokyo", type: "place", name: "Somewhere" }],
			days: [],
		});
		const i2 = indexGraph(s.graph);
		expect(suggestBetween(i2, s.N.x as string, N.hands as string)).toEqual({
			mode: null,
			estimateMin: null,
			distanceKm: null,
			label: "?",
		});
	});

	it("uses the trip's walk speed", () => {
		const s = scenario({ settings: { walkSpeedKmh: 3 }, days: [] });
		const slow = suggestBetween(
			indexGraph(s.graph),
			N.hands as string,
			N.shibuyaSky as string,
		);
		const normal = suggestBetween(
			ix,
			N.hands as string,
			N.shibuyaSky as string,
		);
		expect(slow.estimateMin).toBeGreaterThan(normal.estimateMin as number);
	});
});

describe("labels", () => {
	it("formats compact durations", () => {
		expect(formatShortDuration(12)).toBe("12m");
		expect(formatShortDuration(103)).toBe("1h43");
		expect(formatShortDuration(120)).toBe("2h");
		expect(formatShortDuration(65)).toBe("1h05");
	});

	it("labels suggestions", () => {
		expect(suggestionLabel("walk", 12)).toBe("walk ~12m?");
		expect(suggestionLabel("transit", 103)).toBe("transit ~1h43 est.?");
		expect(suggestionLabel("flight", null)).toBe("flight?");
		expect(suggestionLabel(null, null)).toBe("?");
	});
});

describe("geo helpers", () => {
	it("measures haversine km", () => {
		expect(
			haversineKm([139.7, 35.66], [139.7, 35.66 + 0.9 / 111.19508]),
		).toBeCloseTo(0.9, 6);
	});

	it("unwraps longitudes across the antimeridian", () => {
		expect(
			unwrapLongitudes([
				[170, 0],
				[-170, 0],
				[-160, 0],
			]),
		).toEqual([
			[170, 0],
			[190, 0],
			[200, 0],
		]);
		const arc = greatCircleLine([-74.17, 40.69], [139.78, 35.55]);
		expect(arc.type).toBe("LineString");
		expect(arc.coordinates[0]).toEqual([-74.17, 40.69]);
		const last = arc.coordinates.at(-1) as number[];
		expect(((last[0] as number) + 360) % 360).toBeCloseTo(139.78, 6);
	});

	it("concatenates segment lines and centres bboxes", () => {
		expect(
			concatLines([
				{
					type: "LineString",
					coordinates: [
						[0, 0],
						[1, 1],
					],
				},
				{
					type: "LineString",
					coordinates: [
						[1, 1],
						[2, 2],
					],
				},
			]),
		).toEqual({
			type: "LineString",
			coordinates: [
				[0, 0],
				[1, 1],
				[2, 2],
			],
		});
		expect(concatLines([])).toBeNull();
		expect(
			bboxCenter([
				[0, 0],
				[2, 4],
			]),
		).toEqual([1, 2]);
		expect(bboxCenter([])).toBeNull();
	});
});
