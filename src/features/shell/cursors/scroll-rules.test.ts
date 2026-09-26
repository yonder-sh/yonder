/**
 * Follow the view (pure rules): the pointer wins, else centre on their
 * range; no scroll while it's in view; shorter and taller followers; two
 * layouts matched by item ids; the phone sheet for map or panel.
 */
import { describe, expect, it } from "vitest";
import {
	type Cand,
	edgesOf,
	focusOfSnap,
	followScroll,
	SHEET_SNAPS,
	type Span,
	snapForFocus,
	spotY,
} from "./scroll-rules";

const view = (top: number, bottom: number): Span => ({ top, bottom });

describe("followScroll", () => {
	it("the pointer wins: just enough to bring it in, with a margin", () => {
		// Below my view: scroll down so it sits a margin above the bottom.
		expect(
			followScroll({
				view: view(0, 600),
				pointer: 900,
				range: null,
				margin: 50,
			}),
		).toBe(350);
		// Above: scroll up.
		expect(
			followScroll({
				view: view(0, 600),
				pointer: -200,
				range: null,
				margin: 50,
			}),
		).toBe(-250);
		// Even when their range would centre elsewhere.
		expect(
			followScroll({
				view: view(0, 600),
				pointer: 1_000,
				range: { top: 700, bottom: 1_600 },
				margin: 50,
			}),
		).toBe(450);
	});

	it("no scroll while the pointer is in view (their range may spill)", () => {
		expect(
			followScroll({
				view: view(0, 600),
				pointer: 300,
				range: { top: -400, bottom: 900 },
			}),
		).toBe(0);
	});

	it("a stale tap (outside their own range) doesn't count; a mouse always does", () => {
		// They tapped at 2000, then scrolled with a finger to 0–500.
		expect(
			followScroll({
				view: view(0, 600),
				pointer: 2_000,
				range: { top: 0, bottom: 500 },
				tap: true,
			}),
		).toBe(0);
		// A mouse on a desktop's second column: outside the main column's range, still theirs.
		expect(
			followScroll({
				view: view(0, 600),
				pointer: 2_000,
				range: { top: 0, bottom: 500 },
				margin: 50,
			}),
		).toBe(1_450);
	});

	it("without a pointer: centre on the middle of their range", () => {
		// A shorter screen (600) than their range (900): loses a little off both ends.
		const dy = followScroll({
			view: view(0, 600),
			pointer: null,
			range: { top: 1_000, bottom: 1_900 },
		});
		expect(dy).toBe(1_450 - 300);
		const after = { top: 1_000 - dy, bottom: 1_900 - dy };
		expect(after.top).toBe(-150);
		expect(after.bottom).toBe(750);
	});

	it("a taller screen just sees more, and moves only when their range leaves it", () => {
		// Their 500px range inside my 1000px view: nothing to do.
		expect(
			followScroll({
				view: view(0, 1_000),
				pointer: null,
				range: { top: 200, bottom: 700 },
			}),
		).toBe(0);
		// It left the bottom: centre it (more above and below).
		expect(
			followScroll({
				view: view(0, 1_000),
				pointer: null,
				range: { top: 900, bottom: 1_400 },
			}),
		).toBe(650);
	});

	it("no jitter: a range taller than my view, while I'm inside it, stays", () => {
		expect(
			followScroll({
				view: view(0, 600),
				pointer: null,
				range: { top: -100, bottom: 800 },
			}),
		).toBe(0);
		// A few px off centre never scrolls.
		expect(
			followScroll({
				view: view(0, 600),
				pointer: null,
				range: { top: 2, bottom: 601 },
			}),
		).toBe(0);
	});

	it("nothing to go by, or no view: nothing", () => {
		expect(
			followScroll({ view: view(0, 600), pointer: null, range: null }),
		).toBe(0);
		expect(followScroll({ view: view(0, 0), pointer: 900, range: null })).toBe(
			0,
		);
	});
});

describe("edgesOf", () => {
	const box = { left: 0, top: 100, right: 1_000, bottom: 900 };
	it("the first item and the last one, with how far the edges cut into them", () => {
		const cands: Cand[] = [
			{ id: "item:a", top: 50, bottom: 150, left: 0, right: 1_000 },
			{ id: "item:b", top: 150, bottom: 500, left: 0, right: 1_000 },
			{ id: "item:c", top: 500, bottom: 1_100, left: 0, right: 1_000 },
		];
		expect(edgesOf(cands, box)).toEqual({
			t: { id: "item:a", fy: 0.5 },
			b: { id: "item:c", fy: 0.67 },
		});
		expect(edgesOf([], box)).toBeNull();
	});

	it("two columns: the bottom stays in the first column (the main one)", () => {
		// Desktop Overview: days on the left (0–600), cards on the right (620–1000).
		const cands: Cand[] = [
			{ id: "day:1", top: 100, bottom: 400, left: 0, right: 600 },
			{ id: "day:2", top: 400, bottom: 950, left: 0, right: 600 },
			{ id: "sec:ov.climate", top: 100, bottom: 500, left: 620, right: 1_000 },
			{ id: "sec:ov.people", top: 500, bottom: 900, left: 620, right: 1_000 },
		];
		const e = edgesOf(cands, box);
		expect(e?.t.id).toBe("day:1");
		expect(e?.b.id).toBe("day:2");
	});
});

describe("the same items in another layout", () => {
	it("the leader's range lands on the same items on a one-column phone", () => {
		// Desktop (two columns) sees day:2 … day:3 on the left.
		const desktop: Cand[] = [
			{ id: "day:2", top: 0, bottom: 400, left: 0, right: 600 },
			{ id: "day:3", top: 400, bottom: 800, left: 0, right: 600 },
			{ id: "sec:ov.climate", top: 0, bottom: 800, left: 620, right: 1_000 },
		];
		const edges = edgesOf(desktop, {
			left: 0,
			top: 200,
			right: 1_000,
			bottom: 700,
		});
		if (!edges) throw new Error("no edges");
		// The phone stacks them: day:1 0–300, day:2 300–600, day:3 600–900, climate 1800–2400.
		const phone: Record<string, Span> = {
			"day:1": { top: 0, bottom: 300 },
			"day:2": { top: 300, bottom: 600 },
			"day:3": { top: 600, bottom: 900 },
			"sec:ov.climate": { top: 1_800, bottom: 2_400 },
		};
		const at = (s: { id: string; fy: number }) =>
			spotY(phone[s.id] as Span, s.fy);
		const range = { top: at(edges.t), bottom: at(edges.b) };
		expect(range).toEqual({ top: 450, bottom: 825 });
		// The phone at the top (0–400) scrolls so that range is in view.
		const dy = followScroll({ view: view(0, 400), pointer: null, range });
		const shown = { top: dy, bottom: 400 + dy };
		expect(shown.top).toBeLessThanOrEqual(450);
		expect(shown.bottom).toBeGreaterThanOrEqual(825);
		// Their pointer on the climate card: the phone goes there instead.
		const pointer = spotY(phone["sec:ov.climate"] as Span, 0.5);
		const toCard = followScroll({
			view: view(0, 400),
			pointer,
			range: null,
			margin: 40,
		});
		expect(pointer - toCard).toBeGreaterThanOrEqual(40);
		expect(pointer - toCard).toBeLessThanOrEqual(400 - 40);
	});
});

describe("map or panel (the phone sheet)", () => {
	it("a phone leader's snap says where they look", () => {
		expect(focusOfSnap("120px", SHEET_SNAPS)).toBe("map");
		expect(focusOfSnap(null, SHEET_SNAPS)).toBe("map");
		expect(focusOfSnap(0.5, SHEET_SNAPS)).toBe("half");
		expect(focusOfSnap(0.92, SHEET_SNAPS)).toBe("full");
	});
	it("a phone follower's sheet goes there", () => {
		const [peek, half, full] = SHEET_SNAPS;
		expect(snapForFocus("map", half, SHEET_SNAPS)).toBe(peek);
		expect(snapForFocus("half", full, SHEET_SNAPS)).toBe(half);
		expect(snapForFocus("full", peek, SHEET_SNAPS)).toBe(full);
		// A desktop's panel: at least half; a full sheet stays full.
		expect(snapForFocus("panel", peek, SHEET_SNAPS)).toBe(half);
		expect(snapForFocus("panel", full, SHEET_SNAPS)).toBe(full);
	});
});
