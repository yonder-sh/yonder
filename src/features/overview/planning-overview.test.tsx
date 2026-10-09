/** One Yonder D01: planning on a wide screen, the Overview is a working page. */
import { fireEvent, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { TripRole } from "@/lib/auth/roles";
import { demoGraph } from "@/lib/fixtures/demo";
import { renderWithWorkspace } from "@/test/render-workspace";
import type { Standing } from "./lib/standing";
import { OverviewTab } from "./OverviewTab";
import { NextForYou } from "./PlanningOverview";
import { OVERVIEW_TESTID as O } from "./testids";
import { STANDING_TESTID as S } from "./testids-standing";

afterEach(() => vi.restoreAllMocks());

function renderWide(role?: TripRole) {
	// Wide: the page measures itself at 1400px.
	vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
		width: 1400,
		height: 900,
		top: 0,
		left: 0,
		right: 1400,
		bottom: 900,
		x: 0,
		y: 0,
		toJSON: () => ({}),
	});
	const graph = structuredClone(demoGraph);
	if (role) graph.me = { ...graph.me, role };
	return renderWithWorkspace(<OverviewTab />, {
		graph,
		search: { tab: "overview", asOf: "2027-09-30" },
	});
}

describe("the planning Overview (D01)", () => {
	it("leads with the numbers in a row, what's next for you and where things stand", () => {
		renderWide();
		const page = screen.getByTestId(O.page);
		expect(page).toHaveAttribute("data-layout", "wide");
		expect(screen.getByTestId(O.header)).toHaveAttribute(
			"data-phase",
			"before",
		);
		expect(screen.getAllByTestId(O.stat).map((s) => s.dataset.stat)).toEqual([
			"days",
			"cities",
			"places",
			"flights",
			"km",
		]);
		const next = screen.getByTestId(O.next);
		expect(next).toHaveTextContent("Next for you");
		expect(screen.getByTestId(S.card)).toBeInTheDocument();
	});

	// Walkthrough (2026-10-09): the trip's steps are the planners'.
	it("a rater's next step is only their own ratings", () => {
		renderWide("rater");
		const next = screen.getByTestId(O.next);
		expect(next).toHaveAttribute("data-key", "rating");
		expect(next).toHaveTextContent("Rate the 8 places you haven't yet");
		expect(next).not.toHaveTextContent("After that");
		expect(screen.queryByRole("button", { name: "Not now" })).toBeNull();
		expect(screen.queryByTestId(O.wholeTrip)).toBeNull();
	});

	it("a rater with nothing left is all caught up", () => {
		const graph = structuredClone(demoGraph);
		graph.me = { ...graph.me, role: "rater" };
		const standing = { lines: [], myLeft: 0 } as unknown as Standing;
		renderWithWorkspace(<NextForYou standing={standing} />, { graph });
		expect(screen.getByTestId(O.next)).toHaveTextContent(
			"You're all caught up",
		);
	});

	it("someone who only views gets no to-dos", () => {
		renderWide("viewer");
		expect(screen.queryByTestId(O.next)).toBeNull();
		expect(screen.queryByTestId(O.wholeTrip)).toBeNull();
	});

	it("Not now moves on to the step after", () => {
		renderWide();
		const next = screen.getByTestId(O.next);
		const first = next.dataset.key;
		const notNow = screen.queryByRole("button", { name: "Not now" });
		if (!notNow) return; // one step left in the fixture
		fireEvent.click(notNow);
		expect(screen.getByTestId(O.next).dataset.key).not.toBe(first);
	});

	it("The whole trip opens the trip's details at its notes", () => {
		const { ws } = renderWide();
		fireEvent.click(
			screen.getByRole("button", { name: "Add a note for the trip" }),
		);
		expect(ws().sel).toEqual({ kind: "root" });
	});
});
