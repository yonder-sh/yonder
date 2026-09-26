/**
 * Day windowing (QA PERF-01/04/05): a 35-day trip is ~300 cards, and every
 * mounted card re-renders on every graph change. Only the days within about
 * two screens of the Plan's scroll viewport render their rows; the others keep
 * a light header and a spacer of their last measured (else estimated) height,
 * so the scrollbar, the sticky headers and "Day 12" in the page stay right.
 *
 * - One `IntersectionObserver` per Plan, rooted at the nearest scrolling
 *   ancestor (an implicit root would be clipped by it, so a margin would never
 *   see the next day coming).
 * - A section measures itself as it leaves the window, so coming back is exact.
 * - No `IntersectionObserver` (tests, old browsers): everything renders.
 * - The server and the first client render agree: the first days that fit
 *   `INITIAL_BUDGET_PX` render, the rest start as spacers.
 */
import { createContext } from "react";
import type { GraphIndex } from "@/lib/engine/graph-index";

type Listener = (near: boolean) => void;

/** Rows mount this far above and below the visible part of the Plan. */
export const WINDOW_MARGIN_PX = 1600;
/** What renders before the observer reports (SSR and the first paint). */
export const INITIAL_BUDGET_PX = 3200;

export type PlanWindow = {
	/** False without `IntersectionObserver`: every day renders. */
	readonly supported: boolean;
	/** Last measured height of a day section, by section key. */
	readonly heights: Map<string, number>;
	/** Watch a day section; `cb(true)` when it comes within the window, `cb(false)` when it leaves. */
	observe(el: Element, cb: Listener): () => void;
	/** Start observing inside `root` (the scroll viewport; null = the page). */
	attach(root: Element | null): void;
	detach(): void;
};

export function createPlanWindow(): PlanWindow {
	const listeners = new Map<Element, Listener>();
	let io: IntersectionObserver | null = null;
	const supported = typeof IntersectionObserver !== "undefined";
	return {
		supported,
		heights: new Map(),
		observe(el, cb) {
			listeners.set(el, cb);
			io?.observe(el);
			return () => {
				listeners.delete(el);
				io?.unobserve(el);
			};
		},
		attach(root) {
			if (!supported) return;
			io?.disconnect();
			io = new IntersectionObserver(
				(entries) => {
					for (const e of entries) listeners.get(e.target)?.(e.isIntersecting);
				},
				{ root, rootMargin: `${WINDOW_MARGIN_PX}px 0px` },
			);
			for (const el of listeners.keys()) io.observe(el);
		},
		detach() {
			io?.disconnect();
			io = null;
		},
	};
}

export const PlanWindowContext = createContext<PlanWindow | null>(null);

/** The element that scrolls the Plan (a ScrollArea viewport, the sheet), else null for the page. */
export function scrollParent(el: Element | null): Element | null {
	let cur = el?.parentElement ?? null;
	while (cur && cur !== document.body && cur !== document.documentElement) {
		const oy = getComputedStyle(cur).overflowY;
		if (oy === "auto" || oy === "scroll" || oy === "overlay") return cur;
		cur = cur.parentElement;
	}
	return null;
}

/** A day's height before it was ever measured: header, cards with their legs, the add row. */
export function estimateDayHeight(
	ix: GraphIndex,
	dayId: string,
	compact: boolean,
): number {
	const n = ix.itemsByDay.get(dayId)?.length ?? 0;
	return 100 + n * (compact ? 76 : 100) + (n ? 40 : 64);
}

/**
 * Scroll the Plan's viewport just enough to show `el` (below the sticky day
 * header), without touching any other scroller on the page (the mobile sheet,
 * the document).
 */
export function revealInPlan(el: Element, root: Element | null): void {
	const scroller = scrollParent(root ?? el);
	const box = el.getBoundingClientRect();
	const view = scroller
		? scroller.getBoundingClientRect()
		: { top: 0, bottom: window.innerHeight, height: window.innerHeight };
	if (view.height <= 0) return;
	const topGap = 72;
	const bottomGap = 16;
	const offscreen = box.bottom < view.top || box.top > view.bottom;
	let delta = 0;
	if (offscreen)
		// A jump: land it a third of the way down, with its neighbours in view.
		delta = box.top - view.top - Math.max(topGap, view.height / 3);
	else if (box.top < view.top + topGap) delta = box.top - view.top - topGap;
	else if (box.bottom > view.bottom - bottomGap)
		delta = Math.min(
			box.bottom - view.bottom + bottomGap,
			box.top - view.top - topGap,
		);
	if (Math.abs(delta) < 1) return;
	// Far jumps are instant (days mount on the way and would move a smooth target).
	const behavior: ScrollBehavior =
		Math.abs(delta) > view.height * 1.5 ? "auto" : "smooth";
	if (scroller) scroller.scrollBy({ top: delta, behavior });
	else window.scrollBy({ top: delta, behavior });
}
