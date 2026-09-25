/** What each tab is for: the lead of an empty tab, and each tab's tooltip. */
import { render, screen } from "@testing-library/react";
import { beforeAll, describe, expect, it } from "vitest";
import { EmptyState } from "@/components/common/empty-state";
import { PlacesTab } from "@/features/places/tab/PlacesTab";
import { demoGraph } from "@/lib/fixtures/demo";
import { renderWithWorkspace } from "@/test/render-workspace";
import { CenterTabBar } from "./CenterPanel";
import { TAB_PURPOSE, TabPurpose } from "./TabPurpose";

beforeAll(() => {
	const g = globalThis as unknown as Record<string, unknown>;
	class Noop {
		observe() {}
		unobserve() {}
		disconnect() {}
	}
	g.ResizeObserver ??= Noop;
	g.IntersectionObserver ??= Noop;
});

describe("tab purpose", () => {
	it("leads the Places tab while it has no places", () => {
		renderWithWorkspace(<PlacesTab />, {
			graph: { ...demoGraph, nodes: [], items: [] },
			search: { tab: "places" },
		});
		expect(screen.getByTestId("tab-purpose")).toHaveTextContent(
			"What you want to do. Add places, rate them together, keep the favourites.",
		);
	});

	it("an empty state's lead", () => {
		render(
			<EmptyState
				lead={<TabPurpose tab="plan" />}
				line="Set the trip dates to plan your days."
			/>,
		);
		expect(screen.getByTestId("tab-purpose")).toHaveTextContent(
			"When and where you'll be, day by day.",
		);
	});

	it("is every tab's tooltip", () => {
		renderWithWorkspace(<CenterTabBar />);
		for (const tab of screen.getAllByRole("tab"))
			expect(tab).toHaveAttribute(
				"title",
				TAB_PURPOSE[tab.dataset.tab as keyof typeof TAB_PURPOSE],
			);
	});
});
