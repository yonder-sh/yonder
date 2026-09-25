/**
 * The circular crop's geometry (owner FB-16), kept pure so it is tested
 * without a canvas. The stage is a square of `stage` CSS px with a circle of
 * diameter `circle` in its middle; the picture is drawn at `baseScale × zoom`
 * with its centre `(x, y)` px from the circle's centre. The picture always
 * covers the circle (zoom ≥ 1, offsets clamped), and what gets saved is the
 * square bounding the circle.
 */

export type ImageSize = { w: number; h: number };
/** `zoom` ≥ 1 (1 = the short side just fills the circle); `x`/`y` in stage px. */
export type Crop = { zoom: number; x: number; y: number };

export const MIN_ZOOM = 1;
export const MAX_ZOOM = 4;
/** The saved square (px): the server keeps 64/128/256 px copies of it. */
export const OUTPUT_PX = 512;

const clamp = (v: number, lo: number, hi: number) =>
	Math.min(hi, Math.max(lo, v));

/** Stage px per image px at zoom 1: the short side spans the circle. */
export function baseScale(img: ImageSize, circle: number): number {
	return circle / Math.max(1, Math.min(img.w, img.h));
}

/** Keeps zoom in range and the circle inside the picture. */
export function clampCrop(img: ImageSize, circle: number, c: Crop): Crop {
	const zoom = clamp(Number.isFinite(c.zoom) ? c.zoom : 1, MIN_ZOOM, MAX_ZOOM);
	const scale = baseScale(img, circle) * zoom;
	const mx = Math.max(0, (img.w * scale - circle) / 2);
	const my = Math.max(0, (img.h * scale - circle) / 2);
	return {
		zoom,
		x: clamp(Number.isFinite(c.x) ? c.x : 0, -mx, mx),
		y: clamp(Number.isFinite(c.y) ? c.y : 0, -my, my),
	};
}

/**
 * Zooms to `zoom` around a point `(px, py)` given from the circle's centre
 * (the wheel or pinch position), so what is under it stays put.
 */
export function zoomAround(
	img: ImageSize,
	circle: number,
	c: Crop,
	zoom: number,
	px = 0,
	py = 0,
): Crop {
	const z = clamp(zoom, MIN_ZOOM, MAX_ZOOM);
	const k = z / c.zoom;
	return clampCrop(img, circle, {
		zoom: z,
		x: px - (px - c.x) * k,
		y: py - (py - c.y) * k,
	});
}

/** Where the picture sits on the stage: its top-left and drawn size (stage px). */
export function drawRect(
	img: ImageSize,
	stage: number,
	circle: number,
	c: Crop,
): { left: number; top: number; width: number; height: number } {
	const scale = baseScale(img, circle) * c.zoom;
	const width = img.w * scale;
	const height = img.h * scale;
	return {
		left: stage / 2 + c.x - width / 2,
		top: stage / 2 + c.y - height / 2,
		width,
		height,
	};
}

/** The square of the source picture (image px) that the circle bounds: what gets saved. */
export function sourceSquare(
	img: ImageSize,
	circle: number,
	c: Crop,
): { sx: number; sy: number; size: number } {
	const scale = baseScale(img, circle) * c.zoom;
	const size = circle / scale;
	return {
		sx: img.w / 2 - c.x / scale - size / 2,
		sy: img.h / 2 - c.y / scale - size / 2,
		size,
	};
}
