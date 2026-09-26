/**
 * Follow the view, not just the pointer: the pure rules (no DOM).
 *
 * The leader publishes, for each scrolling area, the items at the top and
 * bottom edges of what they see (`edgesOf`), by item id; the follower finds
 * the same items in ITS layout (two columns or one) and scrolls with
 * `followScroll`:
 * 1. the pointer wins: their pointer item off my screen → scroll just enough
 *    to bring it in, with a margin;
 * 2. otherwise centre on the middle of their range (a shorter screen loses a
 *    little off both ends);
 * 3. a taller screen just sees more;
 * 4. no jitter: only scroll when the pointer or their range leaves my view.
 */
import type { LookFocus } from "@/lib/realtime/view-protocol";
import { type Box, clamp01 } from "./geometry";

/** At most one follow scroll per area per this long (ms). */
export const FOLLOW_EVERY_MS = 650;
/** Room kept between the pointer and my view's edge (px, at most a quarter of it). */
export const FOLLOW_MARGIN = 56;
/** Smaller moves than this aren't worth a scroll (px). */
const MIN_SCROLL = 4;

export type Span = { top: number; bottom: number };

/**
 * How far to scroll (px, positive = down) so I see what they see. `view`
 * is my visible part of the area; `pointer` the y of their pointer on my
 * screen (null without one); `range` their visible range on my screen.
 * `tap`: the pointer is their last tap, which stays put while a finger
 * scrolls away, so it only counts inside their range.
 */
export function followScroll(o: {
	view: Span;
	pointer: number | null;
	range: Span | null;
	margin?: number;
	tap?: boolean;
}): number {
	const h = o.view.bottom - o.view.top;
	if (!(h > 8)) return 0;
	const m = Math.min(o.margin ?? FOLLOW_MARGIN, h / 4);
	const range = o.range
		? {
				top: Math.min(o.range.top, o.range.bottom),
				bottom: Math.max(o.range.top, o.range.bottom),
			}
		: null;
	// A tap outside their own range is stale (they scrolled away since).
	const pointer =
		o.pointer !== null &&
		(!o.tap ||
			!range ||
			(o.pointer >= range.top - m && o.pointer <= range.bottom + m))
			? o.pointer
			: null;
	let dy = 0;
	if (pointer !== null) {
		if (pointer < o.view.top + m) dy = pointer - (o.view.top + m);
		else if (pointer > o.view.bottom - m) dy = pointer - (o.view.bottom - m);
	} else if (range) {
		const inside =
			range.bottom - range.top <= h
				? range.top >= o.view.top && range.bottom <= o.view.bottom
				: o.view.top >= range.top && o.view.bottom <= range.bottom;
		if (!inside)
			dy = (range.top + range.bottom) / 2 - (o.view.top + o.view.bottom) / 2;
	}
	return Math.abs(dy) < MIN_SCROLL ? 0 : dy;
}

/** A candidate item on the leader's screen (client px). */
export type Cand = {
	id: string;
	top: number;
	bottom: number;
	left: number;
	right: number;
};

export type Spot = { id: string; fy: number };

const round2 = (v: number) => Math.round(v * 100) / 100;

/**
 * The items at the top and bottom edges of `box`. `cands` are the visible
 * innermost items in document order. The top is the first; the bottom the
 * last one in the same column (items overlapping the first narrow item
 * horizontally, or spanning the box), so a desktop's side column doesn't
 * stretch the range on a phone, where it comes after the main one.
 */
export function edgesOf(
	cands: readonly Cand[],
	box: Box,
): { t: Spot; b: Spot } | null {
	const first = cands[0];
	if (!first) return null;
	const width = box.right - box.left;
	const wide = (c: Cand) => c.right - c.left >= width * 0.8;
	const ref = cands.find((c) => !wide(c)) ?? first;
	let last = first;
	for (const c of cands) {
		if (wide(c) || (c.left < ref.right - 1 && c.right > ref.left + 1)) last = c;
	}
	const fy = (c: Cand, y: number) =>
		round2(clamp01((y - c.top) / Math.max(1, c.bottom - c.top)));
	return {
		t: { id: first.id, fy: fy(first, box.top) },
		b: { id: last.id, fy: fy(last, box.bottom) },
	};
}

/** Where an edge spot is on my screen, from the item's box there. */
export function spotY(r: Span, fy: number): number {
	return r.top + fy * (r.bottom - r.top);
}

// ---------------------------------------------------------------------------
// Map or panel (a phone follower's sheet)
// ---------------------------------------------------------------------------

export type Snaps = readonly [
	string | number,
	string | number,
	string | number,
];
/** The phone sheet's snaps: the peek, half and full (MobileWorkspace). */
export const SHEET_SNAPS: Snaps = ["120px", 0.5, 0.92];

/** What a phone leader's sheet says about where they look. */
export function focusOfSnap(
	snap: string | number | null,
	snaps: Snaps,
): LookFocus {
	if (snap === snaps[2]) return "full";
	if (snap === snaps[1]) return "half";
	return "map";
}

/**
 * Where a phone follower's sheet goes for the leader's focus: the map →
 * the peek; a phone's half or full → the same; a desktop's panel → at
 * least half (a full sheet stays full).
 */
export function snapForFocus(
	focus: LookFocus,
	current: string | number | null,
	snaps: Snaps,
): string | number {
	switch (focus) {
		case "map":
			return snaps[0];
		case "half":
			return snaps[1];
		case "full":
			return snaps[2];
		case "panel":
			return current === snaps[2] ? snaps[2] : snaps[1];
	}
}
