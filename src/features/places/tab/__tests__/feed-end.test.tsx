/**
 * The end of the Rate feed leads to Review: "Next: review the ratings" (the
 * scores, highest first) and, when the group disagrees on some places, a
 * link to them (Review's "Talk about it").
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
	it("goes on to Review, and to the places the group disagrees on", async () => {
		const { ws } = renderWithWorkspace(<PlacesTab phone />, {
			graph,
			search: { tab: "places", pv: "rate" },
		});
		const review = await screen.findByTestId(
			T.feedReview,
			{},
			{ timeout: 5000 },
		);
		expect(review).toHaveTextContent("Next: review the ratings");
		const talk = screen.getByTestId(T.feedTalk);
		expect(talk).toHaveTextContent("1 place the group disagrees on");

		fireEvent.click(talk);
		expect(ws().search).toMatchObject({ pv: "table", talk: 1 });
	});

	it("the review button opens Review unfiltered", async () => {
		const { ws } = renderWithWorkspace(<PlacesTab phone />, {
			graph,
			search: { tab: "places", pv: "rate" },
		});
		fireEvent.click(
			await screen.findByTestId(T.feedReview, {}, { timeout: 5000 }),
		);
		expect(ws().search.pv).toBe("table");
		expect(ws().search.talk).toBeUndefined();
	});
});
