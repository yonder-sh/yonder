/**
 * Pure geometry for the live-cursor layer (FB-17a): smoothing, "is it on
 * screen", and where an off-screen cursor's edge arrow goes. No DOM.
 */

export type Pt = { x: number; y: number };
export type Box = { left: number; top: number; right: number; bottom: number };

/** Time constant of the exponential smoothing (ms): ~95 % of the way in 3τ. */
export const SMOOTH_TAU_MS = 70;
/** A jump longer than this (px) snaps instead of flying across the screen. */
export const SNAP_DISTANCE = 480;
/** Closer than this (px) counts as arrived. */
const SETTLED_PX = 0.35;

/**
 * One step of frame-rate independent exponential smoothing from `cur` toward
 * `target` over `dtMs`: the same path at 30, 60 or 144 fps.
 */
export function smoothToward(
	cur: number,
	target: number,
	dtMs: number,
	tauMs = SMOOTH_TAU_MS,
): number {
	if (!(dtMs > 0)) return cur;
	const k = 1 - Math.exp(-dtMs / tauMs);
	return cur + (target - cur) * k;
}

/**
 * A remote cursor's on-screen position, eased toward the latest target. The
 * target arrives at ~20 Hz; `step` runs every animation frame, so the cursor
 * glides instead of jumping 50 ms at a time. With reduced motion (or a long
 * jump, or the first position) it snaps.
 */
export class Track {
	x = 0;
	y = 0;
	tx = 0;
	ty = 0;
	private placed = false;

	/** A new target. Returns true when it snapped. */
	aim(target: Pt, reduced: boolean): boolean {
		this.tx = target.x;
		this.ty = target.y;
		const far = Math.hypot(this.tx - this.x, this.ty - this.y) > SNAP_DISTANCE;
		if (!this.placed || reduced || far) {
			this.x = this.tx;
			this.y = this.ty;
			this.placed = true;
			return true;
		}
		return false;
	}

	/** Forget the position: the next `aim` snaps (the cursor was hidden). */
	reset(): void {
		this.placed = false;
	}

	/** Advances by `dtMs`; true once it sits on its target. */
	step(dtMs: number, reduced: boolean): boolean {
		if (reduced) {
			this.x = this.tx;
			this.y = this.ty;
			return true;
		}
		this.x = smoothToward(this.x, this.tx, dtMs);
		this.y = smoothToward(this.y, this.ty, dtMs);
		if (
			Math.abs(this.tx - this.x) < SETTLED_PX &&
			Math.abs(this.ty - this.y) < SETTLED_PX
		) {
			this.x = this.tx;
			this.y = this.ty;
			return true;
		}
		return false;
	}
}

export function inside(p: Pt, b: Box, tolerance = 1): boolean {
	return (
		p.x >= b.left - tolerance &&
		p.x <= b.right + tolerance &&
		p.y >= b.top - tolerance &&
		p.y <= b.bottom + tolerance
	);
}

export function intersect(a: Box, b: Box): Box {
	return {
		left: Math.max(a.left, b.left),
		top: Math.max(a.top, b.top),
		right: Math.min(a.right, b.right),
		bottom: Math.min(a.bottom, b.bottom),
	};
}

export function isEmpty(b: Box): boolean {
	return b.right - b.left < 1 || b.bottom - b.top < 1;
}

export type EdgeArrow = {
	/** Where the arrow sits (inside `clip`, `inset` from its edge). */
	x: number;
	y: number;
	/** Direction toward the off-screen point, radians (0 = right, π/2 = down). */
	angle: number;
	side: "top" | "bottom" | "left" | "right";
};

/**
 * The edge arrow for a point outside `clip` (a scrolled timeline, the map):
 * where the ray from the box's centre to the point leaves the box (inset),
 * pointing at the point. Null when the point is inside.
 */
export function edgeArrow(p: Pt, clip: Box, inset = 16): EdgeArrow | null {
	if (inside(p, clip, 0)) return null;
	const inner: Box = {
		left: clip.left + inset,
		top: clip.top + inset,
		right: clip.right - inset,
		bottom: clip.bottom - inset,
	};
	if (inner.right < inner.left)
		inner.left = inner.right = (clip.left + clip.right) / 2;
	if (inner.bottom < inner.top)
		inner.top = inner.bottom = (clip.top + clip.bottom) / 2;
	const cx = (inner.left + inner.right) / 2;
	const cy = (inner.top + inner.bottom) / 2;
	const dx = p.x - cx;
	const dy = p.y - cy;
	const angle = Math.atan2(dy, dx);
	// Scale the ray so it just touches the inner box.
	const hw = (inner.right - inner.left) / 2;
	const hh = (inner.bottom - inner.top) / 2;
	const sx = dx === 0 ? Number.POSITIVE_INFINITY : hw / Math.abs(dx);
	const sy = dy === 0 ? Number.POSITIVE_INFINITY : hh / Math.abs(dy);
	const s = Math.min(sx, sy, 1);
	const side: EdgeArrow["side"] =
		sx < sy ? (dx > 0 ? "right" : "left") : dy > 0 ? "bottom" : "top";
	return { x: cx + dx * s, y: cy + dy * s, angle, side };
}

/** `[0, 1]`. */
export function clamp01(v: number): number {
	return v < 0 ? 0 : v > 1 ? 1 : v;
}
