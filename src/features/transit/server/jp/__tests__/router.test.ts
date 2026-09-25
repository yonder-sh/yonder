// biome-ignore-all lint/style/noNonNullAssertion: ported verbatim from spikes/japan-transit/estimate (typed arrays, bounds checked by construction).
import { describe, expect, it } from "vitest";
import { buildGraph } from "../build.server";
import {
	estimateRoutes,
	estimateStations,
	googleMapsTransitUrl,
} from "../estimate.server";
import { prepareGraph } from "../graph.server";
import { walkMinutes } from "../profiles.server";
import type { RideSegment, TransferSegment } from "../router.server";
import { toTransitRoute } from "../transit-route.server";
import type { N02Feature } from "../types.server";
import { fc, straightLine } from "./fixtures";

// World: a private all-stops line P (S0..S5, 2 km apart), a "shinkansen" H with only S0 and S5
// 200 m north, and a north–south private line X crossing at S3.
function world() {
	const names = ["S0", "S1", "S2", "S3", "S4", "S5"];
	const groups: Record<string, string> = { S0: "gS0", S3: "gS3", S5: "gS5" };
	const P = straightLine({
		op: "PrivA",
		line: "P線",
		names,
		lng0: 139,
		spacingKm: 2,
		codePrefix: "p",
		groups,
	});
	const H = straightLine({
		op: "HsrCo",
		line: "H新幹線",
		names: ["S0", "S5"],
		lng0: 139,
		lat: 35.0018,
		spacingKm: 10,
		codePrefix: "h",
		railType: "11",
		opType: "1",
		groups,
	});
	// X: runs north from S3's longitude; built east-west then rotated by swapping coords around S3
	const dLng = 2 / (111.32 * Math.cos((35 * Math.PI) / 180));
	const s3lng = 139 + 3 * dLng;
	const Xew = straightLine({
		op: "PrivB",
		line: "X線",
		names: ["S3", "N1", "N2"],
		lng0: 0,
		lat: 0,
		spacingKm: 1.5,
		codePrefix: "x",
		groups,
	});
	const rot = (f: N02Feature): N02Feature => {
		if (f.geometry.type !== "LineString") return f;
		return {
			...f,
			geometry: {
				type: "LineString",
				coordinates: f.geometry.coordinates.map(
					([x, y]) =>
						[s3lng + 0.0005 + y, 35.0004 + x * 0.9] as [number, number],
				),
			},
		};
	};
	const sections = [...P.sections, ...H.sections, ...Xew.sections.map(rot)];
	const stations = [...P.stations, ...H.stations, ...Xew.stations.map(rot)];
	return prepareGraph(buildGraph(fc(sections), fc(stations), { simplifyM: 0 }));
}

describe("router (synthetic world)", () => {
	const g = world();

	it("fastest first: the high-speed line beats the all-stops line, which comes back as an alternative", () => {
		const r = estimateStations(g, "S0", "S5");
		expect(r.routes.length).toBeGreaterThanOrEqual(2);
		const [best, alt] = r.routes;
		expect(best?.segments.find((s) => s.kind === "ride")?.lineName).toBe(
			"H新幹線",
		);
		expect(alt?.signature).toContain("P線");
		expect(best!.durationMin).toBeLessThan(alt!.durationMin);
		expect(new Set(r.routes.map((x) => x.signature)).size).toBe(
			r.routes.length,
		);
		for (const x of r.routes) {
			expect(x.source).toBe("estimate");
			expect(x.confidence).toBe("estimate");
			expect(x.rangeMin[0]).toBeLessThanOrEqual(x.durationMin);
			expect(x.rangeMin[1]).toBeGreaterThanOrEqual(x.durationMin);
		}
	});

	it("durations add up: route = Σ segments; high-speed 10 km at 170 km/h ≈ 3.5 min", () => {
		const r = estimateStations(g, "S0", "S5");
		const best = r.routes[0]!;
		const ride = best.segments[0] as RideSegment;
		expect(ride.durationMin).toBeCloseTo((ride.distanceKm / 170) * 60, 0);
		const sum = best.segments.reduce((t, s) => t + s.durationMin, 0);
		expect(Math.abs(sum - best.durationMin)).toBeLessThanOrEqual(1);
	});

	it("transfers carry walk + fixed penalty + board wait", () => {
		const r = estimateStations(g, "S0", "N2");
		const best = r.routes[0]!;
		const kinds = best.segments.map((s) => s.kind);
		expect(kinds).toEqual(["ride", "transfer", "ride"]);
		const t = best.segments[1] as TransferSegment;
		expect(t.at).toBe("S3");
		expect(t.waitMin).toBe(5); // private board wait
		expect(t.penaltyMin).toBeCloseTo(4, 5); // different operators
		expect(t.walkMin).toBeGreaterThanOrEqual(1);
		expect(best.transfers).toBe(1);
	});

	it("snaps arbitrary coordinates to nearby stations with walking time (4.5 km/h × 1.3)", () => {
		const s0 = { lat: 35.0027, lng: 139.0 }; // ~300 m north of S0
		const dLng = 2 / (111.32 * Math.cos((35 * Math.PI) / 180));
		const s5 = { lat: 34.9973, lng: 139 + 5 * dLng }; // ~300 m south of S5
		const r = estimateRoutes(g, s0, s5);
		const best = r.routes[0]!;
		const first = best.segments[0]!;
		const last = best.segments[best.segments.length - 1]!;
		expect(first.kind).toBe("walk");
		expect(last.kind).toBe("walk");
		if (first.kind === "walk")
			expect(first.durationMin).toBeCloseTo(walkMinutes(first.distanceM), 0);
		expect(r.origin.snapped.length).toBeGreaterThan(0);
		expect(r.googleMapsUrl).toBe(googleMapsTransitUrl(s0, s5));
	});

	it("offers a walk-only route for short hops", () => {
		const a = { lat: 35.0, lng: 139.0 };
		const b = { lat: 35.0, lng: 139.006 }; // ~550 m
		const r = estimateRoutes(g, a, b);
		expect(r.routes.some((x) => x.signature === "walk")).toBe(true);
		expect(r.routes[0]?.signature).toBe("walk");
	});

	it("reports no station near an endpoint instead of inventing a route", () => {
		const r = estimateRoutes(g, { lat: 43, lng: 141 }, { lat: 35, lng: 139 });
		expect(r.routes).toHaveLength(0);
		expect(r.notes).toContain("no-station-near-origin");
	});

	it("adapts to the app's TransitRoute shape (integer minutes, walk/transfer mapping)", () => {
		const r = estimateStations(g, "S0", "N2", { geometry: true });
		const t = toTransitRoute(r.routes[0]!);
		expect(t.source).toBe("estimate");
		expect(t.label).toMatch(/est\.$/);
		for (const s of t.segments) {
			expect(Number.isInteger(s.durationMin)).toBe(true);
			expect([
				"walk",
				"train",
				"high_speed",
				"subway",
				"rail",
				"tram",
				"cable",
				"bus",
			]).toContain(s.mode);
		}
		expect(t.segments.some((s) => s.vehicleType === "TRANSFER")).toBe(true);
		expect(t.geometry?.coordinates.length).toBeGreaterThan(2);
	});
});

describe("through-running (THROUGH_RUNNING table)", () => {
	// Fujikyu Otsuki Line → Kawaguchiko Line at 富士山 is listed with a 3-min switchback
	const A = straightLine({
		op: "富士山麓電気鉄道",
		line: "大月線",
		names: ["大月", "寿", "富士山"],
		lng0: 138.9,
		spacingKm: 5,
		codePrefix: "o",
		groups: { 富士山: "gF" },
	});
	const B = straightLine({
		op: "富士山麓電気鉄道",
		line: "河口湖線",
		names: ["富士山", "河口湖"],
		lng0: 138.9 + 10 / (111.32 * Math.cos((35 * Math.PI) / 180)),
		spacingKm: 3,
		codePrefix: "k",
		groups: { 富士山: "gF" },
	});
	const g = prepareGraph(
		buildGraph(
			fc([...A.sections, ...B.sections]),
			fc([...A.stations, ...B.stations]),
			{ simplifyM: 0 },
		),
	);

	it("stays on board: no transfer segment, second ride flagged through, dwell added", () => {
		const r = estimateStations(g, "大月", "河口湖");
		const best = r.routes[0]!;
		expect(best.transfers).toBe(0);
		const rides = best.segments.filter(
			(s): s is RideSegment => s.kind === "ride",
		);
		expect(rides).toHaveLength(2);
		expect(rides[1]?.through).toBe(true);
		// 3 km at the Fujikyu curve for a 13 km run (29 km/h) + 3 min switchback ≈ 9.2
		expect(rides[1]!.durationMin).toBeGreaterThan(8);
		expect(rides[1]!.durationMin).toBeLessThan(10.5);
	});
});
