import { describe, expect, it } from "vitest";
import {
	GridIndex,
	haversineM,
	polylineLengthM,
	simplify,
} from "../geo.server";

describe("geo", () => {
	it("haversine: Tokyo Station → Kyoto Station ≈ 372 km (straight line)", () => {
		const m = haversineM(35.6812, 139.7671, 34.9858, 135.7588);
		expect(m / 1000).toBeGreaterThan(370);
		expect(m / 1000).toBeLessThan(374);
	});
	it("polyline length sums segments", () => {
		const m = polylineLengthM([
			[139.7, 35.0],
			[139.71, 35.0],
			[139.72, 35.0],
		]);
		expect(m).toBeCloseTo(haversineM(35, 139.7, 35, 139.72), 0);
	});
	it("Douglas–Peucker keeps ends and drops collinear points", () => {
		const pts: [number, number][] = Array.from({ length: 50 }, (_, i) => [
			139 + i * 0.001,
			35,
		]);
		expect(simplify(pts, 5)).toEqual([pts[0], pts[49]]);
		const bent: [number, number][] = [
			[139, 35],
			[139.01, 35.01],
			[139.02, 35],
		];
		expect(simplify(bent, 5)).toHaveLength(3);
	});
	it("grid radius query returns ids sorted by distance", () => {
		const g = new GridIndex(500);
		g.add(0, 35.0, 139.0);
		g.add(1, 35.001, 139.0);
		g.add(2, 35.02, 139.0);
		const r = g.within(35.0, 139.0, 500);
		expect(r.map((x) => x.id)).toEqual([0, 1]);
		expect(r[1]?.m).toBeGreaterThan(100);
	});
});
