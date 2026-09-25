/**
 * FB-16: the circular crop's geometry. The picture always covers the circle,
 * zoom stays in range, zooming keeps the point under the pointer still, and
 * the saved square is exactly the square bounding the circle.
 */
import { describe, expect, it } from "vitest";
import {
	baseScale,
	clampCrop,
	drawRect,
	MAX_ZOOM,
	sourceSquare,
	zoomAround,
} from "../avatar-crop";

const circle = 224;
const stage = 256;
const landscape = { w: 1200, h: 800 };

describe("circular crop geometry (FB-16)", () => {
	it("fits the short side to the circle at zoom 1, centred", () => {
		expect(baseScale(landscape, circle)).toBeCloseTo(224 / 800);
		const c = clampCrop(landscape, circle, { zoom: 1, x: 0, y: 0 });
		const s = sourceSquare(landscape, circle, c);
		expect(s.sx).toBeCloseTo(200);
		expect(s.sy).toBeCloseTo(0);
		expect(s.size).toBeCloseTo(800);
		const r = drawRect(landscape, stage, circle, c);
		expect(r.top).toBeCloseTo(16);
		expect(r.height).toBeCloseTo(224);
		expect(r.left + r.width / 2).toBeCloseTo(stage / 2);
	});

	it("never lets the circle leave the picture, whatever the drag or zoom", () => {
		// At zoom 1 the landscape photo slides sideways only.
		const c = clampCrop(landscape, circle, { zoom: 1, x: 999, y: -999 });
		expect(c.y).toBeCloseTo(0);
		const s = sourceSquare(landscape, circle, c);
		expect(s.sx).toBeCloseTo(0);
		// Zoom is kept between 1 and MAX_ZOOM.
		expect(clampCrop(landscape, circle, { zoom: 0.2, x: 0, y: 0 }).zoom).toBe(
			1,
		);
		expect(clampCrop(landscape, circle, { zoom: 99, x: 0, y: 0 }).zoom).toBe(
			MAX_ZOOM,
		);
		for (const [zoom, x, y] of [
			[2, 500, 500],
			[3.5, -400, 260],
			[1.2, -80, -80],
		] as const) {
			const k = clampCrop(landscape, circle, { zoom, x, y });
			const sq = sourceSquare(landscape, circle, k);
			expect(sq.sx).toBeGreaterThanOrEqual(-1e-9);
			expect(sq.sy).toBeGreaterThanOrEqual(-1e-9);
			expect(sq.sx + sq.size).toBeLessThanOrEqual(landscape.w + 1e-9);
			expect(sq.sy + sq.size).toBeLessThanOrEqual(landscape.h + 1e-9);
		}
	});

	it("zooms around the pointer: the photo point under it stays put", () => {
		const c = clampCrop(landscape, circle, { zoom: 1.5, x: 0, y: 0 });
		const px = 40;
		const py = -30;
		// Image px under (px, py) before and after.
		const under = (k: typeof c) => {
			const scale = baseScale(landscape, circle) * k.zoom;
			return {
				u: landscape.w / 2 + (px - k.x) / scale,
				v: landscape.h / 2 + (py - k.y) / scale,
			};
		};
		const before = under(c);
		const after = under(zoomAround(landscape, circle, c, 2.5, px, py));
		expect(after.u).toBeCloseTo(before.u);
		expect(after.v).toBeCloseTo(before.v);
	});

	it("saves the square bounding the circle: smaller when zoomed in", () => {
		const c = clampCrop(landscape, circle, { zoom: 2, x: 0, y: 0 });
		const s = sourceSquare(landscape, circle, c);
		expect(s.size).toBeCloseTo(400);
		expect(s.sx).toBeCloseTo(400);
		expect(s.sy).toBeCloseTo(200);
	});
});
