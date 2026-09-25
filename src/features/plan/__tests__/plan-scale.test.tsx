/**
 * The Plan at trip scale (QA PERF-01/04/05): a 35-day, ~300-card trip renders
 * only the days near the viewport (`plan-window.ts`), keeps every day's header
 * and height, renders a day as it comes into view, always renders the day of
 * the selection, and builds its rows cheaply.
 */
import { act, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { indexGraph } from "@/lib/engine/graph-index";
import { computeSchedule } from "@/lib/engine/schedule";
import { buildModel } from "@/lib/engine/visits";
import { TESTID } from "@/lib/testids";
import { renderWithWorkspace } from "@/test/render-workspace";
import { PlanTab } from "../PlanTab";
import { buildDaySection, buildPlanEntries } from "../plan-rows";
import { PLAN_TESTID } from "../testids";
import { bigTrip } from "./big-trip";

/** An IntersectionObserver the test drives by hand. */
class FakeIO {
	static last: FakeIO | null = null;
	readonly els = new Set<Element>();
	constructor(readonly cb: IntersectionObserverCallback) {
		FakeIO.last = this;
	}
	observe(el: Element) {
		this.els.add(el);
	}
	unobserve(el: Element) {
		this.els.delete(el);
	}
	disconnect() {
		this.els.clear();
	}
	/** Report every observed day: near when `near(dayId)`. */
	report(near: (dayId: string) => boolean) {
		const entries = [...this.els].map(
			(el) =>
				({
					target: el,
					isIntersecting: near(el.getAttribute("data-day-id") ?? ""),
				}) as unknown as IntersectionObserverEntry,
		);
		act(() => this.cb(entries, this as unknown as IntersectionObserver));
	}
}

const trip = bigTrip();
const cardsOf = (dayId: string) => {
	const section = screen
		.getAllByTestId(PLAN_TESTID.daySection)
		.find((s) => s.getAttribute("data-day-id") === dayId);
	if (!section) throw new Error(`no section for ${dayId}`);
	return within(section).queryAllByTestId(TESTID.timelineItem);
};

describe("PlanTab at trip scale", () => {
	beforeEach(() => {
		vi.stubGlobal("IntersectionObserver", FakeIO);
	});
	afterEach(() => {
		vi.unstubAllGlobals();
		FakeIO.last = null;
	});

	it("renders the first screens of a 35-day trip; every other day keeps its header and height", () => {
		renderWithWorkspace(<PlanTab />, {
			graph: trip.graph,
			counts: trip.counts,
			search: { lens: "place" },
		});
		const sections = screen.getAllByTestId(PLAN_TESTID.daySection);
		expect(sections).toHaveLength(35);
		expect(screen.getAllByTestId(PLAN_TESTID.dayHeader)).toHaveLength(35);
		const windowed = sections.filter((s) => s.hasAttribute("data-windowed"));
		expect(windowed.length).toBeGreaterThan(25);
		for (const s of windowed)
			expect(Number.parseInt(s.style.minHeight, 10)).toBeGreaterThan(100);
		expect(screen.getAllByTestId(TESTID.timelineItem).length).toBeLessThan(80);
		expect(cardsOf(trip.D.d1 as string)).toHaveLength(8);
	});

	it("renders a day as it comes into view and drops one that leaves", () => {
		renderWithWorkspace(<PlanTab />, {
			graph: trip.graph,
			counts: trip.counts,
			search: { lens: "place" },
		});
		const d1 = trip.D.d1 as string;
		const d20 = trip.D.d20 as string;
		expect(cardsOf(d20)).toHaveLength(0);
		FakeIO.last?.report((id) => id === d20);
		expect(cardsOf(d20)).toHaveLength(8);
		expect(cardsOf(d1)).toHaveLength(0);
		expect(
			screen
				.getAllByTestId(PLAN_TESTID.daySection)
				.find((s) => s.getAttribute("data-day-id") === d1)
				?.hasAttribute("data-windowed"),
		).toBe(true);
	});

	it("always renders the day of the selection (a pin clicked on the map)", () => {
		const far = trip.I.d29i2 as string;
		const { ws } = renderWithWorkspace(<PlanTab />, {
			graph: trip.graph,
			counts: trip.counts,
			search: { lens: "place", sel: `i.${far}` },
		});
		expect(
			screen
				.getAllByTestId(TESTID.timelineItem)
				.some((c) => c.getAttribute("data-item-id") === far),
		).toBe(true);
		// Even when the observer says it's far away.
		FakeIO.last?.report(() => false);
		expect(cardsOf(trip.D.d30 as string)).toHaveLength(8);
		act(() => ws().nav.select(null));
		expect(cardsOf(trip.D.d30 as string)).toHaveLength(0);
	});

	it("builds the rows of all 35 days in well under a frame budget per day", () => {
		const ix = indexGraph(trip.graph);
		const ctx = {
			ix,
			model: buildModel(ix, null, "place", null),
			schedule: computeSchedule(ix),
			scopeId: null,
			lens: "place" as const,
			days: null,
			who: null,
		};
		const t0 = performance.now();
		const entries = buildPlanEntries(ctx);
		let rows = 0;
		for (const d of ix.days) rows += buildDaySection(ctx, d.id).rows.length;
		const ms = performance.now() - t0;
		expect(entries.filter((e) => e.kind === "day")).toHaveLength(35);
		expect(rows).toBeGreaterThan(280);
		// ~1 ms locally; generous for a loaded CI box.
		expect(ms).toBeLessThan(250);
	});
});
