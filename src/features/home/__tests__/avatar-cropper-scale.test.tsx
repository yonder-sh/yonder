/**
 * The crop stage's pointer maths on narrow phones (FB-16 follow-up): each
 * axis is scaled on its own. With one factor taken from the width, a box that
 * wasn't square (240 × 256 on a 320 px phone) moved and zoomed around the
 * wrong point vertically.
 */
import { describe, expect, it } from "vitest";
import { fromCentre, STAGE_PX, stageScale } from "../AvatarCropper";

const canvasAt = (
	left: number,
	top: number,
	width: number,
	height: number,
) => ({
	getBoundingClientRect: () =>
		({
			left,
			top,
			width,
			height,
			right: left + width,
			bottom: top + height,
		}) as DOMRect,
});

describe("stageScale", () => {
	it("is 1 on a full-size stage and grows as the stage shrinks", () => {
		expect(stageScale({ width: STAGE_PX, height: STAGE_PX })).toEqual({
			kx: 1,
			ky: 1,
		});
		expect(stageScale({ width: 200, height: 200 })).toEqual({
			kx: STAGE_PX / 200,
			ky: STAGE_PX / 200,
		});
	});

	it("scales each axis on its own when the box isn't square", () => {
		expect(stageScale({ width: 240, height: 256 })).toEqual({
			kx: STAGE_PX / 240,
			ky: 1,
		});
	});

	it("never divides by zero (a stage not laid out yet)", () => {
		expect(stageScale({ width: 0, height: 0 })).toEqual({ kx: 1, ky: 1 });
	});
});

describe("fromCentre", () => {
	it("maps the box's centre to the circle's centre at any size", () => {
		for (const size of [256, 240, 200])
			expect(
				fromCentre(canvasAt(10, 20, size, size), 10 + size / 2, 20 + size / 2),
			).toEqual({
				x: 0,
				y: 0,
			});
	});

	it("maps the bottom-right corner to the stage corner, per axis", () => {
		// A non-square box: before, y used the width's factor and came out 136.5.
		const p = fromCentre(canvasAt(0, 0, 240, 256), 240, 256);
		expect(p.x).toBeCloseTo(STAGE_PX / 2);
		expect(p.y).toBeCloseTo(STAGE_PX / 2);
		// A square box scaled down (the fix at 320 px): both axes alike.
		const q = fromCentre(canvasAt(0, 0, 200, 200), 200, 150);
		expect(q.x).toBeCloseTo(STAGE_PX / 2);
		expect(q.y).toBeCloseTo((150 * STAGE_PX) / 200 - STAGE_PX / 2);
	});

	it("is the centre when there is no canvas yet", () => {
		expect(fromCentre(null, 5, 5)).toEqual({ x: 0, y: 0 });
	});
});
