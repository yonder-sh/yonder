/**
 * The flow in the UI (owner, 2026-09-25): the Places tab's three steps with
 * their counts and the dot, the step Places picks (and writes into the URL)
 * when none is named, and the phone's Rate pill (shown only when you have
 * places to rate, never over the feed).
 */
import { fireEvent, screen, within } from "@testing-library/react";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { isRateable } from "@/features/places/lib/rate";
import type { TripGraph } from "@/lib/engine/types";
import { DEMO_MEMBERS, demoGraph, N } from "@/lib/fixtures/demo";
import { renderWithWorkspace } from "@/test/render-workspace";
import { PlacesTab } from "../PlacesTab";
import { RatePill } from "../RatePill";
import { PLACES_TAB_TESTID as T } from "../testids";
import { lastReviewView } from "../use-places";

beforeAll(() => {
	// The feed and the table measure and observe; happy-dom has neither.
	const g = globalThis as unknown as Record<string, unknown>;
	class Noop {
		observe() {}
		unobserve() {}
		disconnect() {}
		takeRecords() {
			return [];
		}
	}
	g.ResizeObserver ??= Noop;
	g.IntersectionObserver ??= Noop;
});

// The Add view is remembered for the session: each test starts on the table.
beforeEach(() => {
	lastReviewView.current = "table";
});

const rateable = demoGraph.nodes.filter((n) => isRateable(n)).length;

/** Dennis rated everything: nothing left to rate. */
const allRated: TripGraph = {
	...demoGraph,
	nodes: demoGraph.nodes.map((n) =>
		isRateable(n) ? { ...n, priorities: { [DEMO_MEMBERS.dennis]: "want" } } : n,
	),
};

/** Dennis as a plain viewer (can't rate). */
const asViewer: TripGraph = {
	...demoGraph,
	me: { ...demoGraph.me, role: "viewer" },
	members: demoGraph.members.map((m) =>
		m.id === DEMO_MEMBERS.dennis ? { ...m, role: "viewer" } : m,
	),
};

describe("the Places tab's steps", () => {
	it("1 Rate · 2 Review · 3 Schedule with their counts; the dot on Rate", () => {
		renderWithWorkspace(<PlacesTab />, {
			search: { tab: "places", pv: "table" },
		});
		const bar = screen.getByTestId(T.steps);
		expect(bar).toHaveAttribute("data-step", "review");
		const steps = within(bar).getAllByTestId(T.step);
		expect(steps.map((s) => s.dataset.step)).toEqual([
			"rate",
			"review",
			"schedule",
		]);
		expect(steps[1]).toHaveAttribute("aria-current", "step");
		expect(steps.map((s) => s.textContent?.match(/^\d(\D+?)\d/)?.[1])).toEqual([
			"Rate",
			"Review",
			"Schedule",
		]);
		const counts = within(bar)
			.getAllByTestId(T.stepCount)
			.map((c) => c.textContent);
		// Every demo place is on a day (scheduled counts as shortlisted).
		expect(counts).toEqual([
			`${rateable} to rate`,
			`${rateable} places`,
			`${rateable} shortlisted · all on a day`,
		]);
		expect(steps[0]).toHaveAttribute("data-next", "true");
		expect(
			within(steps[0] as HTMLElement).getByTestId(T.stepDot),
		).toBeInTheDocument();
		// Adding sits at the end of the steps' bar, on every step.
		expect(within(bar).getByTestId(T.addPlace)).toHaveAccessibleName(
			"Add a place",
		);
	});

	it("a step click changes the view in the URL; Rate and Schedule drop the status pill", () => {
		const { navigations } = renderWithWorkspace(<PlacesTab />, {
			search: { tab: "places", pv: "board", pst: "shortlist" },
		});
		fireEvent.click(
			screen
				.getAllByTestId(T.step)
				.find((s) => s.dataset.step === "schedule") as HTMLElement,
		);
		expect(navigations.at(-1)?.search).toMatchObject({
			tab: "places",
			pv: "schedule",
		});
		expect(navigations.at(-1)?.search.pst).toBeUndefined();
		expect(screen.getByTestId(T.schedule)).toHaveAttribute("data-waiting", "0");
		// Back to Review: the board it was on.
		fireEvent.click(
			screen
				.getAllByTestId(T.step)
				.find((s) => s.dataset.step === "review") as HTMLElement,
		);
		expect(navigations.at(-1)?.search.pv).toBe("board");
	});

	it("no step in the URL: Rate when you have places to rate, written into the URL", () => {
		const { navigations } = renderWithWorkspace(<PlacesTab />, {
			search: { tab: "places" },
		});
		expect(navigations.at(-1)?.search).toMatchObject({
			tab: "places",
			pv: "rate",
		});
		expect(screen.getByTestId(T.tab)).toHaveAttribute("data-step", "rate");
	});

	it("…else Review; a link to one place opens the list; a phone never opens the feed by itself", () => {
		const done = renderWithWorkspace(<PlacesTab />, {
			graph: allRated,
			search: { tab: "places" },
		});
		expect(done.navigations.at(-1)?.search.pv).toBe("table");
		done.unmount();
		const link = renderWithWorkspace(<PlacesTab />, {
			search: { tab: "places", sel: `n.${N.sensoji}` },
		});
		expect(link.navigations.at(-1)?.search.pv).toBe("table");
		link.unmount();
		const phone = renderWithWorkspace(<PlacesTab phone />, {
			search: { tab: "places" },
		});
		expect(phone.navigations.at(-1)?.search.pv).toBe("table");
	});

	it("a viewer sees Rate as view only, with no dot", () => {
		renderWithWorkspace(<PlacesTab />, {
			graph: asViewer,
			search: { tab: "places", pv: "table" },
		});
		const rate = screen
			.getAllByTestId(T.step)
			.find((s) => s.dataset.step === "rate");
		expect(rate).toHaveTextContent("View only");
		expect(screen.queryByTestId(T.stepDot)).toBeNull();
	});
});

describe("the phone's Rate pill", () => {
	it("★ Rate N while you have places to rate; it opens the feed", () => {
		const { navigations } = renderWithWorkspace(<RatePill />, {
			search: { tab: "plan" },
		});
		const pill = screen.getByTestId(T.ratePill);
		expect(pill).toHaveTextContent(`Rate${rateable}`);
		fireEvent.click(pill);
		expect(navigations.at(-1)?.search).toMatchObject({
			tab: "places",
			pv: "rate",
		});
		// Inside the feed itself it's gone.
		expect(screen.queryByTestId(T.ratePill)).toBeNull();
	});
	it("hidden at 0 and for people who can't rate", () => {
		const a = renderWithWorkspace(<RatePill />, { graph: allRated });
		expect(screen.queryByTestId(T.ratePill)).toBeNull();
		a.unmount();
		renderWithWorkspace(<RatePill />, { graph: asViewer });
		expect(screen.queryByTestId(T.ratePill)).toBeNull();
	});
});
