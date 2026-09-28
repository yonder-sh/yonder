/** One Yonder D08: Decide sorts the places into Shortlist, Disagreements and Not going. */
import { screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { demoGraph } from "@/lib/fixtures/demo";
import { renderWithWorkspace } from "@/test/render-workspace";
import { decideColumn } from "../PlacesDecide";
import { PlacesTab } from "../PlacesTab";
import { PLACES_TAB_TESTID as T } from "../testids";

const row = (r: Partial<{ status: string; split: boolean }>) =>
	({ status: "idea", split: false, ...r }) as Parameters<
		typeof decideColumn
	>[0];

describe("Decide (D08)", () => {
	it("puts a split rating under Disagreements before the shortlist, and dropped ones out", () => {
		expect(decideColumn(row({ status: "shortlist" }))).toBe("shortlist");
		expect(decideColumn(row({ status: "scheduled" }))).toBe("shortlist");
		expect(decideColumn(row({ status: "shortlist", split: true }))).toBe(
			"talk",
		);
		expect(decideColumn(row({ status: "dropped", split: true }))).toBe("out");
		expect(decideColumn(row({ status: "idea" }))).toBeNull();
	});

	it("shows its three columns from ?pv=decide", () => {
		renderWithWorkspace(<PlacesTab />, {
			search: { tab: "places", pv: "decide" },
		});
		const view = screen.getByTestId(T.decide);
		expect(
			within(view)
				.getAllByTestId(T.decideColumn)
				.map((c) => c.dataset.column),
		).toEqual(["shortlist", "talk", "out"]);
		expect(screen.getByTestId(T.steps)).toHaveAttribute("data-step", "decide");
	});

	it("says who the rest are waiting on", () => {
		const graph = structuredClone(demoGraph);
		const other = graph.members.find((m) => m.id !== graph.me.memberId);
		if (!other) throw new Error("fixture: one member");
		for (const n of graph.nodes) {
			const { [other.id]: _, ...rest } = n.priorities;
			n.priorities = rest;
		}
		renderWithWorkspace(<PlacesTab />, {
			graph,
			search: { tab: "places", pv: "decide" },
		});
		const name = other.firstName ?? other.name.split(/\s+/)[0];
		expect(
			screen
				.getAllByTestId(T.decideWaiting)
				.some((w) =>
					new RegExp(`\\d+ more (is|are) waiting on ${name}'s rating`).test(
						w.textContent ?? "",
					),
				),
		).toBe(true);
	});
});
