/**
 * Where Today lives (One Yonder phase 5): during the trip it takes the
 * Overview's place in the tab bar and a bare trip link opens it; `tab=overview`
 * still opens the Overview (under Today). Outside the trip nothing changes.
 * Planning prompts step back: no Rate pill but on Places.
 */
import { fireEvent, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { OVERVIEW_TESTID } from "@/features/overview/testids";
import { RatePill } from "@/features/places/tab/RatePill";
import { PLACES_TAB_TESTID } from "@/features/places/tab/testids";
import { CenterTabBar, CenterTabContent } from "@/features/shell/CenterPanel";
import { demo } from "@/lib/fixtures/demo";
import { TESTID } from "@/lib/testids";
import { renderWithWorkspace } from "@/test/render-workspace";
import { StopActions } from "../StopActions";
import { TODAY_TESTID as T } from "../testids";

// The demo trip runs Sun 3 – Thu 7 Oct 2027.
const DURING = "2027-10-05T11:00";

const tabs = () =>
	screen
		.getByTestId(TESTID.centerTabs)
		.querySelectorAll<HTMLElement>("[role=tab]");
const lit = () =>
	[...tabs()].find((t) => t.getAttribute("aria-selected") === "true")?.dataset
		.tab;

describe("the tab bar", () => {
	it("during the trip: Today first, lit on a bare trip link", () => {
		const { ws } = renderWithWorkspace(<CenterTabBar />, {
			search: { asOf: DURING },
		});
		expect(ws().underway).toBe(true);
		expect(ws().tab).toBe("today");
		expect([...tabs()].map((t) => t.dataset.tab)).toEqual([
			"today",
			"plan",
			"places",
			"lists",
			"money",
		]);
		expect(lit()).toBe("today");
	});

	it("the Overview during the trip sits under Today", () => {
		renderWithWorkspace(<CenterTabBar />, {
			search: { tab: "overview", asOf: DURING },
		});
		expect(lit()).toBe("today");
	});

	it("outside the trip nothing changes", () => {
		const { ws } = renderWithWorkspace(<CenterTabBar />, {
			search: { asOf: "2027-09-30" },
		});
		expect(ws().underway).toBe(false);
		expect(tabs()[0]?.dataset.tab).toBe("overview");
		expect(lit()).toBe("overview");
	});
});

describe("the tab's page", () => {
	it("a bare trip link during the trip is Today", () => {
		renderWithWorkspace(<CenterTabContent phone />, {
			search: { asOf: DURING },
		});
		expect(screen.getByTestId(T.page)).toBeInTheDocument();
		expect(screen.queryByTestId(OVERVIEW_TESTID.page)).toBeNull();
	});

	it("tab=overview still opens the Overview", () => {
		renderWithWorkspace(<CenterTabContent phone />, {
			search: { tab: "overview", asOf: DURING },
		});
		expect(screen.getByTestId(OVERVIEW_TESTID.page)).toBeInTheDocument();
		expect(screen.queryByTestId(T.page)).toBeNull();
	});

	it("a Today link after the trip shows the Overview", () => {
		renderWithWorkspace(<CenterTabContent phone />, {
			search: { tab: "today", asOf: "2027-12-01" },
		});
		expect(screen.getByTestId(OVERVIEW_TESTID.page)).toBeInTheDocument();
	});
});

describe("a stop's details on the road (P11)", () => {
	const loft = demo.I.loft as string;

	it("Directions and Address while the trip is on; the driver sheet opens", async () => {
		renderWithWorkspace(<StopActions itemId={loft} />, {
			search: { asOf: DURING },
		});
		expect(screen.getByTestId(T.stopDirections)).toHaveAttribute(
			"href",
			expect.stringContaining("destination=35.6612,139.6987"),
		);
		fireEvent.click(screen.getByTestId(T.stopAddress));
		const sheet = await screen.findByTestId(T.driver);
		expect(sheet).toHaveTextContent("Shibuya Loft");
	});

	it("nothing before the trip", () => {
		renderWithWorkspace(<StopActions itemId={loft} />, {
			search: { asOf: "2027-09-30" },
		});
		expect(screen.queryByTestId(T.stopDirections)).toBeNull();
	});
});

describe("planning prompts step back while you travel", () => {
	it("no Rate pill on Today; it stays on Places", () => {
		const a = renderWithWorkspace(<RatePill />, { search: { asOf: DURING } });
		expect(screen.queryByTestId(PLACES_TAB_TESTID.ratePill)).toBeNull();
		a.unmount();
		renderWithWorkspace(<RatePill />, {
			search: { tab: "places", pv: "table", asOf: DURING },
		});
		expect(screen.getByTestId(PLACES_TAB_TESTID.ratePill)).toBeInTheDocument();
	});

	it("before the trip the pill floats on every tab", () => {
		renderWithWorkspace(<RatePill />, {
			search: { tab: "plan", asOf: "2027-09-30" },
		});
		expect(screen.getByTestId(PLACES_TAB_TESTID.ratePill)).toBeInTheDocument();
	});
});
