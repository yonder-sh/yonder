/**
 * WP-Shell chrome on the fixture: guests never get a Money tab, suggest mode
 * shows its rule, a located item's inspector tabs count its place's bundle
 * (the panels own "This visit only"), and tab counts are rollup sums.
 */
import { act, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { Counts, TripCounts, TripGraph } from "@/lib/engine/types";
import { demo, demoGraph, N } from "@/lib/fixtures/demo";
import { TESTID } from "@/lib/testids";
import { useUi } from "@/lib/workspace/ui-store";
import { renderWithWorkspace } from "@/test/render-workspace";
import { CenterTabBar, SuggestRule } from "./CenterPanel";
import { InspectorBody } from "./InspectorBody";
import { SHELL_TESTID } from "./testids";
import { inOpenLayer } from "./use-workspace-hotkeys";

const guestGraph: TripGraph = {
	...demoGraph,
	me: { ...demoGraph.me, memberId: null, role: "viewer", isGuest: true },
};

const c = (p: Partial<Counts>): Counts => ({
	media: 0,
	links: 0,
	docs: 0,
	todoOpen: 0,
	todo: 0,
	shopOpen: 0,
	shop: 0,
	hasNote: false,
	...p,
});

afterEach(() => {
	act(() => useUi.getState().resetUi());
});

describe("centre tabs", () => {
	it("members get Money; link guests never do", () => {
		renderWithWorkspace(<CenterTabBar />);
		expect(screen.getByRole("tab", { name: "Money" })).toBeInTheDocument();
	});

	it("hides Money for guests even when the URL asks for it", () => {
		renderWithWorkspace(<CenterTabBar />, {
			graph: guestGraph,
			search: { tab: "money" },
		});
		expect(screen.queryByRole("tab", { name: "Money" })).toBeNull();
		expect(screen.getByRole("tab", { name: "Plan" })).toHaveAttribute(
			"aria-selected",
			"true",
		);
	});

	it("counts are summed over the scope's rollup", () => {
		const counts: TripCounts = {
			root: c({}),
			byNode: {
				[N.shibuyaSky as string]: c({ media: 2 }),
				[N.kiyomizu as string]: c({ media: 5 }),
			},
			byItem: {},
			byLeg: {},
			byDay: {},
		};
		renderWithWorkspace(<CenterTabBar />, { splat: "japan/tokyo", counts });
		expect(screen.getByRole("tab", { name: /Media/ })).toHaveTextContent(
			"Media2",
		);
	});

	it("suggest mode shows its rule; edit mode doesn't", () => {
		const { unmount } = renderWithWorkspace(<SuggestRule />);
		expect(screen.queryByTestId(SHELL_TESTID.suggestRule)).toBeNull();
		unmount();
		act(() => useUi.getState().setSuggesting(demoGraph.trip.id, true));
		renderWithWorkspace(<SuggestRule />);
		expect(screen.getByTestId(SHELL_TESTID.suggestRule)).toHaveTextContent(
			"Suggesting — your changes need approval",
		);
	});
});

describe("inspector", () => {
	it("a located item's tabs count its place's whole bundle, the visit included", () => {
		const sky = demo.I.sky ?? "";
		const counts: TripCounts = {
			root: c({}),
			byNode: { [N.shibuyaSky as string]: c({ media: 3 }) },
			byItem: { [sky]: c({ media: 1, todoOpen: 1, hasNote: true }) },
			byLeg: {},
			byDay: {},
		};
		renderWithWorkspace(<InspectorBody />, {
			search: { sel: `i.${sky}` },
			counts,
		});
		const tabs = screen.getByTestId(SHELL_TESTID.inspectorTabs);
		expect(within(tabs).getByRole("tab", { name: /Media/ })).toHaveTextContent(
			/Media\s*4/,
		);
		expect(within(tabs).getByRole("tab", { name: /Lists/ })).toHaveTextContent(
			/Lists\s*1/,
		);
		// The Notes tab opens on the place's own note, which is empty.
		expect(within(tabs).queryByLabelText("has notes")).toBeNull();
	});

	it("a day counts its own bundle", () => {
		const day = demoGraph.days[1]?.id ?? "";
		const counts: TripCounts = {
			root: c({ media: 9 }),
			byNode: {},
			byItem: {},
			byLeg: {},
			byDay: { [day]: c({ media: 2, hasNote: true }) },
		};
		renderWithWorkspace(<InspectorBody />, {
			search: { sel: `d.${day}` },
			counts,
		});
		const tabs = screen.getByTestId(SHELL_TESTID.inspectorTabs);
		expect(within(tabs).getByRole("tab", { name: /Media/ })).toHaveTextContent(
			/Media\s*2/,
		);
		expect(within(tabs).getByLabelText("has notes")).toBeInTheDocument();
	});

	it("guests get no Money tab in the inspector", () => {
		renderWithWorkspace(<InspectorBody />, {
			graph: guestGraph,
			search: { sel: `n.${N.tokyo}` },
		});
		const tabs = screen.getByTestId(SHELL_TESTID.inspectorTabs);
		expect(within(tabs).queryByRole("tab", { name: "Money" })).toBeNull();
		expect(screen.getByTestId(TESTID.nodeOverview)).toBeInTheDocument();
	});
});

describe("hotkeys stay out of open layers", () => {
	it("a key inside a dialog or menu belongs to it", () => {
		document.body.innerHTML =
			'<div role="dialog"><button id="in">x</button></div><button id="out">y</button>';
		expect(inOpenLayer(document.getElementById("in"))).toBe(true);
		expect(inOpenLayer(document.getElementById("out"))).toBe(false);
		expect(inOpenLayer(null)).toBe(false);
	});
});
