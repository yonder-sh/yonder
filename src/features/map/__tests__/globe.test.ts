/**
 * The whole-trip globe (owner feedback FB-10, QA MAP-01, PLAN-R3-04): which
 * trips get a globe, and a camera that frames every country on the visible
 * side of the Earth, inside the part of the map the inspector doesn't cover.
 * The e2e run (`map-owner-r1.spec.ts`) checks the same against MapLibre.
 */
import type { Position } from "geojson";
import { describe, expect, it } from "vitest";
import {
	CAMERA_DISTANCE_PER_HEIGHT,
	GLOBE_MAX_CAP,
	globeCamera,
	globeRadiusAt,
	horizonAngle,
	type Insets,
	perspectiveRadius,
	sphericalCap,
} from "../geo-utils";
import { fitPointsFor, type PinView, wantsGlobe } from "../map-data";

// Country pins roughly where the QA fixture and the real trip put them.
const USA: Position = [-98.6, 39.8];
const TURKIYE: Position = [35.2, 39.0];
const JAPAN: Position = [138.3, 36.2];
const KOREA: Position = [127.8, 35.9];
const TAIWAN: Position = [121.0, 23.7];
const VIETNAM: Position = [105.8, 16.0];
const QA_SIX = [USA, TURKIYE, JAPAN, KOREA, TAIWAN, VIETNAM];
const EAST_ASIA = [JAPAN, KOREA, TAIWAN, VIETNAM];

const rad = (d: number) => (d * Math.PI) / 180;
const deg = (r: number) => (r * 180) / Math.PI;

/** Angle between two points, degrees. */
function between(a: Position, b: Position): number {
	const [l1 = 0, p1 = 0] = a.map(rad);
	const [l2 = 0, p2 = 0] = b.map(rad);
	const c =
		Math.sin(p1) * Math.sin(p2) +
		Math.cos(p1) * Math.cos(p2) * Math.cos(l2 - l1);
	return deg(Math.acos(Math.max(-1, Math.min(1, c))));
}

/** Where MapLibre's vertical perspective draws `p` (px from the centre). */
function screen(
	cam: { center: Position; zoom: number },
	p: Position,
	H: number,
): { x: number; y: number; theta: number } {
	const c = cam.center as [number, number];
	const R = globeRadiusAt(cam.zoom, c[1]);
	const D = CAMERA_DISTANCE_PER_HEIGHT * H;
	const f1 = rad(c[1]);
	const f2 = rad(p[1] ?? 0);
	const dl = rad((p[0] ?? 0) - c[0]);
	const az = Math.atan2(
		Math.sin(dl) * Math.cos(f2),
		Math.cos(f1) * Math.sin(f2) - Math.sin(f1) * Math.cos(f2) * Math.cos(dl),
	);
	const theta = rad(between(c, p));
	const r = perspectiveRadius(theta, R, D);
	return { x: r * Math.sin(az), y: -r * Math.cos(az), theta };
}

// The desktop map at 1440 × 900: 656 × 848, the controls column on the right.
const W = 656;
const H = 848;
const OPEN: Insets = { top: 36, right: 76, bottom: 36, left: 36 };
// A leg inspector open: only ~223px on the left stay uncovered.
const INSPECTOR: Insets = { top: 20, right: 453, bottom: 20, left: 20 };

function expectFramed(
	pts: readonly Position[],
	pad: Insets,
	cam: NonNullable<ReturnType<typeof globeCamera>>,
) {
	const bw = W - pad.left - pad.right;
	const bh = H - pad.top - pad.bottom;
	const R = globeRadiusAt(cam.zoom, cam.center[1]);
	const D = CAMERA_DISTANCE_PER_HEIGHT * H;
	for (const p of pts) {
		const s = screen(cam, p, H);
		// On the visible side, clear of the limb (MapLibre fades occluded markers to 20%).
		expect(deg(s.theta)).toBeLessThan(deg(horizonAngle(R, D)) - 5);
		// Inside the uncovered box (the centre sits in its middle).
		expect(Math.abs(s.x)).toBeLessThanOrEqual(bw / 2 + 0.5);
		expect(Math.abs(s.y)).toBeLessThanOrEqual(bh / 2 + 0.5);
	}
	// The camera padding is the one-sided part of `pad` (the globe slides, never turns).
	expect(Math.min(cam.padding.left, cam.padding.right)).toBe(0);
	expect(Math.min(cam.padding.top, cam.padding.bottom)).toBe(0);
}

describe("sphericalCap", () => {
	it("puts the QA trip's six countries within ~70° of a point over the Arctic side (MAP-01)", () => {
		const cap = sphericalCap(QA_SIX);
		if (!cap) throw new Error("no cap");
		expect(cap.radius).toBeLessThan(72);
		expect(cap.center[1]).toBeGreaterThan(45);
		for (const p of QA_SIX)
			expect(between(cap.center, p)).toBeLessThanOrEqual(cap.radius + 1e-6);
	});

	it("is small for East Asia and wraps the antimeridian", () => {
		expect(sphericalCap(EAST_ASIA)?.radius).toBeLessThan(25);
		const fiji = sphericalCap([
			[178, -18],
			[-176, -14],
		]);
		expect(fiji?.radius).toBeLessThan(5);
		expect(Math.abs(fiji?.center[0] ?? 0)).toBeGreaterThan(175);
		expect(sphericalCap([])).toBeNull();
	});
});

describe("globeCamera (FB-10, MAP-01, PLAN-R3-04)", () => {
	it("frames the QA trip's six countries on the visible side, USA and Türkiye included", () => {
		const cam = globeCamera(QA_SIX, {
			width: W,
			height: H,
			pad: OPEN,
			maxZoom: 7,
		});
		if (!cam) throw new Error("expected a globe");
		expectFramed(QA_SIX, OPEN, cam);
		// Not the old camera over the Pacific (148°E, 28°N, USA and Türkiye at 88–89°).
		for (const p of QA_SIX) expect(between(cam.center, p)).toBeLessThan(75);
	});

	it("keeps them clear of an open inspector by shrinking the globe, and never throws", () => {
		const open = globeCamera(QA_SIX, {
			width: W,
			height: H,
			pad: OPEN,
			maxZoom: 7,
		});
		const covered = globeCamera(QA_SIX, {
			width: W,
			height: H,
			pad: INSPECTOR,
			maxZoom: 7,
		});
		if (!open || !covered) throw new Error("expected a globe");
		expectFramed(QA_SIX, INSPECTOR, covered);
		expect(covered.zoom).toBeLessThan(open.zoom);
		expect(covered.padding.right).toBeGreaterThan(400);
		// A padding wider than the map (the case MapLibre threw on) still gives a camera.
		const tiny = globeCamera(QA_SIX, {
			width: 300,
			height: 300,
			pad: { top: 10, right: 420, bottom: 10, left: 10 },
			maxZoom: 7,
		});
		expect(tiny).not.toBeNull();
		expect(Number.isFinite(tiny?.zoom)).toBe(true);
	});

	it("shows the real trip (Japan with days, three idea countries) as a whole globe", () => {
		const cam = globeCamera(EAST_ASIA, {
			width: W,
			height: H,
			pad: OPEN,
			maxZoom: 7,
			globeScale: 1.1,
		});
		if (!cam) throw new Error("expected a globe");
		expectFramed(EAST_ASIA, OPEN, cam);
		// The sphere, not a curved map: its silhouette about fills the free width.
		const R = globeRadiusAt(cam.zoom, cam.center[1]);
		const D = CAMERA_DISTANCE_PER_HEIGHT * H;
		const silhouette = R * Math.sqrt(D / (D + 2 * R));
		const free = Math.min(
			W - OPEN.left - OPEN.right,
			H - OPEN.top - OPEN.bottom,
		);
		expect(silhouette).toBeLessThanOrEqual((1.1 * free) / 2 + 1);
		expect(silhouette).toBeGreaterThan((0.9 * free) / 2);
		// Looking at East Asia.
		expect(cam.center[0]).toBeGreaterThan(110);
		expect(cam.center[0]).toBeLessThan(135);
	});

	it("reveal (no globe cap): one point is centred at up to the current zoom", () => {
		const cam = globeCamera([JAPAN], {
			width: W,
			height: H,
			pad: OPEN,
			maxZoom: 3,
			globeScale: Number.POSITIVE_INFINITY,
		});
		expect(cam?.zoom).toBeCloseTo(3, 5);
		expect(between(cam?.center ?? [0, 0], JAPAN)).toBeLessThan(0.01);
	});

	it("goes flat for a trip round the world", () => {
		const world: Position[] = [
			USA,
			[-0.1, 51.5],
			JAPAN,
			[-47.9, -15.8],
			[149.1, -35.3],
		];
		expect((sphericalCap(world)?.radius ?? 0) > GLOBE_MAX_CAP).toBe(true);
		expect(
			globeCamera(world, { width: W, height: H, pad: OPEN, maxZoom: 7 }),
		).toBeNull();
	});
});

describe("wantsGlobe / fitPointsFor (FB-10)", () => {
	const pin = (
		name: string,
		at: Position,
		extra: Partial<PinView> = {},
	): PinView =>
		({
			repId: name,
			name,
			lng: at[0],
			lat: at[1],
			hollow: false,
			filteredOut: false,
			countryCode: name.slice(0, 2).toUpperCase(),
			...extra,
		}) as PinView;

	it("a globe for more than one country (ideas count), flat for one or round the world", () => {
		const japan = pin("jp", JAPAN);
		const ideas = [
			pin("kr", KOREA, { hollow: true }),
			pin("tw", TAIWAN, { hollow: true }),
			pin("vn", VIETNAM, { hollow: true }),
		];
		expect(wantsGlobe([japan])).toBe(false);
		expect(wantsGlobe([japan, ...ideas])).toBe(true);
		// Ideas hidden by the shared filter don't make it a multi-country trip.
		expect(
			wantsGlobe([
				japan,
				pin("kr", KOREA, { hollow: true, filteredOut: true }),
			]),
		).toBe(false);
		expect(
			wantsGlobe([
				pin("us", USA),
				pin("gb", [-0.1, 51.5]),
				japan,
				pin("br", [-47.9, -15.8]),
				pin("au", [149.1, -35.3]),
			]),
		).toBe(false);
	});

	it("frames every country on the whole trip, only visited pins elsewhere", () => {
		const pins = [pin("jp", JAPAN), pin("kr", KOREA, { hollow: true })];
		expect(fitPointsFor(pins)).toEqual([JAPAN]);
		expect(fitPointsFor(pins, { all: true })).toEqual([JAPAN, KOREA]);
	});
});
