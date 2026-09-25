/**
 * The empty map (DESIGN §9.4, §12): "Nothing on the map here yet." with an
 * Add a place button that follows the edit guard (viewers see it disabled).
 */
import { screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { TripGraph } from "@/lib/engine/types";
import { demoGraph } from "@/lib/fixtures/demo";
import { renderWithWorkspace } from "@/test/render-workspace";
import TripMap from "../TripMap";
import { MAP_TESTID } from "../testids";

/** The demo trip with nothing scheduled and no coordinates anywhere. */
function emptyGraph(role: "owner" | "viewer"): TripGraph {
	return {
		...demoGraph,
		me: { ...demoGraph.me, role },
		items: [],
		legs: [],
		days: demoGraph.days.map((d) => ({ ...d, nightNodeId: null })),
		nodes: demoGraph.nodes.map((n) => ({ ...n, lat: null, lng: null })),
	};
}

describe("TripMap empty state", () => {
	it("offers Add a place to editors", async () => {
		renderWithWorkspace(<TripMap variant="desktop" />, {
			graph: emptyGraph("owner"),
		});
		const card = await screen.findByTestId(MAP_TESTID.empty);
		expect(card.textContent).toContain("Nothing on the map here yet.");
		const btn = screen.getByRole("button", {
			name: "Add a place",
		}) as HTMLButtonElement;
		expect(btn.disabled).toBe(false);
	});

	it("keeps Add a place visible but disabled for viewers", async () => {
		renderWithWorkspace(<TripMap variant="desktop" />, {
			graph: emptyGraph("viewer"),
		});
		await screen.findByTestId(MAP_TESTID.empty);
		const btn = screen.getByRole("button", {
			name: "Add a place",
		}) as HTMLButtonElement;
		expect(btn.disabled).toBe(true);
	});
});
