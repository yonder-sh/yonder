import { describe, expect, it } from "vitest";
import {
	clamp01,
	edgeArrow,
	inside,
	intersect,
	isEmpty,
	SNAP_DISTANCE,
	smoothToward,
	Track,
} from "./geometry";

describe("cursor interpolation (FB-17a)", () => {
	it("smooths toward the target independently of the frame rate", () => {
		// 60 fps for 100 ms vs 30 fps for 100 ms: the same place.
		let a = 0;
		for (let i = 0; i < 6; i++) a = smoothToward(a, 100, 1000 / 60);
		let b = 0;
		for (let i = 0; i < 3; i++) b = smoothToward(b, 100, 1000 / 30);
		expect(a).toBeCloseTo(b, 6);
		expect(a).toBeGreaterThan(70);
		expect(a).toBeLessThan(100);
		expect(smoothToward(5, 100, 0)).toBe(5);
		expect(smoothToward(5, 100, Number.NaN)).toBe(5);
	});

	it("a track snaps the first time, glides after, settles exactly", () => {
		const t = new Track();
		expect(t.aim({ x: 10, y: 20 }, false)).toBe(true);
		expect([t.x, t.y]).toEqual([10, 20]);
		expect(t.aim({ x: 110, y: 20 }, false)).toBe(false);
		t.step(16, false);
		expect(t.x).toBeGreaterThan(10);
		expect(t.x).toBeLessThan(110);
		let settled = false;
		for (let i = 0; i < 200 && !settled; i++) settled = t.step(16, false);
		expect(settled).toBe(true);
		expect([t.x, t.y]).toEqual([110, 20]);
	});

	it("snaps with reduced motion, on long jumps and after a reset", () => {
		const t = new Track();
		t.aim({ x: 0, y: 0 }, false);
		expect(t.aim({ x: 50, y: 0 }, true)).toBe(true);
		expect(t.x).toBe(50);
		expect(t.aim({ x: 50 + SNAP_DISTANCE + 1, y: 0 }, false)).toBe(true);
		t.reset();
		expect(t.aim({ x: 60, y: 0 }, false)).toBe(true);
		expect(t.x).toBe(60);
		t.aim({ x: 90, y: 0 }, false);
		expect(t.step(16, true)).toBe(true);
		expect(t.x).toBe(90);
	});
});

describe("off-screen edge arrows (FB-17a)", () => {
	const box = { left: 0, top: 100, right: 400, bottom: 700 };

	it("no arrow for a point inside", () => {
		expect(edgeArrow({ x: 200, y: 400 }, box)).toBeNull();
	});

	it("an arrow on the bottom edge for a card scrolled below", () => {
		const a = edgeArrow({ x: 200, y: 2000 }, box);
		expect(a?.side).toBe("bottom");
		expect(a?.y).toBeCloseTo(700 - 16, 5);
		expect(a?.angle).toBeCloseTo(Math.PI / 2, 5);
		expect(inside(a ?? { x: -1, y: -1 }, box)).toBe(true);
	});

	it("above, left and right; always inside the box", () => {
		expect(edgeArrow({ x: 200, y: -500 }, box)?.side).toBe("top");
		expect(edgeArrow({ x: -900, y: 400 }, box)?.side).toBe("left");
		const r = edgeArrow({ x: 5000, y: 420 }, box);
		expect(r?.side).toBe("right");
		expect(r?.x).toBeCloseTo(384, 5);
		for (const p of [
			{ x: -300, y: -300 },
			{ x: 900, y: 1300 },
			{ x: 1e6, y: -1e6 },
		]) {
			const a = edgeArrow(p, box);
			expect(a).not.toBeNull();
			expect(inside(a ?? { x: -1, y: -1 }, box, 0.01)).toBe(true);
		}
	});

	it("box helpers", () => {
		const i = intersect(box, { left: 300, top: 0, right: 900, bottom: 200 });
		expect(i).toEqual({ left: 300, top: 100, right: 400, bottom: 200 });
		expect(isEmpty(i)).toBe(false);
		expect(
			isEmpty(intersect(box, { left: 500, top: 0, right: 600, bottom: 50 })),
		).toBe(true);
		expect(clamp01(-1)).toBe(0);
		expect(clamp01(2)).toBe(1);
		expect(clamp01(0.3)).toBe(0.3);
	});
});
