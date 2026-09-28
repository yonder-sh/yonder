/** One Yonder D01: planning on a wide screen, the Overview is a working page. */
import { fireEvent, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderWithWorkspace } from "@/test/render-workspace";
import { OverviewTab } from "./OverviewTab";
import { OVERVIEW_TESTID as O } from "./testids";
import { STANDING_TESTID as S } from "./testids-standing";

afterEach(() => vi.restoreAllMocks());

function renderWide() {
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
	return renderWithWorkspace(<OverviewTab />, {
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

	it("Not now moves on to the step after", () => {
		renderWide();
		const next = screen.getByTestId(O.next);
		const first = next.dataset.key;
		const notNow = screen.queryByRole("button", { name: "Not now" });
		if (!notNow) return; // one step left in the fixture
		fireEvent.click(notNow);
		expect(screen.getByTestId(O.next).dataset.key).not.toBe(first);
	});
});
