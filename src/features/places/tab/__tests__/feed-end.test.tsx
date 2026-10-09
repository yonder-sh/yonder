/**
 * The end of the Rate feed leads to Decide: "Next: decide" (the shortlist,
 * the split ones, not going) and, when the group disagrees on some places,
 * a link there too.
 */
import { fireEvent, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { TripGraph } from "@/lib/engine/types";
import { DEMO_MEMBERS, demoGraph, N } from "@/lib/fixtures/demo";
import { renderWithWorkspace } from "@/test/render-workspace";
import { isRateable } from "../../lib/rate";
import { PlacesTab } from "../PlacesTab";
import { PLACES_TAB_TESTID as T } from "../testids";

// Everything rated (the pile is empty: the feed is its end); Senso-ji split.
const graph: TripGraph = {
	...demoGraph,
	nodes: demoGraph.nodes.map((n) =>
		isRateable(n)
			? {
					...n,
					priorities:
						n.id === N.sensoji
							? { [DEMO_MEMBERS.dennis]: "nah", [DEMO_MEMBERS.audrey]: "must" }
							: { [DEMO_MEMBERS.dennis]: "want" },
				}
			: n,
	),
};

describe("the end of the Rate feed", () => {
	it("goes on to Decide, and to the places the group disagrees on", async () => {
		const { ws } = renderWithWorkspace(<PlacesTab phone />, {
			graph,
			search: { tab: "places", pv: "rate" },
		});
		const review = await screen.findByTestId(
			T.feedReview,
			{},
			{ timeout: 5000 },
		);
		expect(review).toHaveTextContent("Next: decide");
		const talk = screen.getByTestId(T.feedTalk);
		expect(talk).toHaveTextContent("1 place the group disagrees on");

		fireEvent.click(talk);
		expect(ws().search).toMatchObject({ pv: "decide" });
	});

	it("a split place marked decided isn't one to talk through", async () => {
		renderWithWorkspace(<PlacesTab phone />, {
			graph: {
				...graph,
				nodes: graph.nodes.map((n) =>
					n.id === N.tokyo ? { ...n, decidedAt: "2030-01-01T00:00:00Z" } : n,
				),
			},
			search: { tab: "places", pv: "rate" },
		});
		await screen.findByTestId(T.feedReview, {}, { timeout: 5000 });
		expect(screen.queryByTestId(T.feedTalk)).toBeNull();
	});

	it("the next button opens Decide unfiltered", async () => {
		const { ws } = renderWithWorkspace(<PlacesTab phone />, {
			graph,
			search: { tab: "places", pv: "rate" },
		});
		fireEvent.click(
			await screen.findByTestId(T.feedReview, {}, { timeout: 5000 }),
		);
		expect(ws().search.pv).toBe("decide");
		expect(ws().search.talk).toBeUndefined();
	});
});
