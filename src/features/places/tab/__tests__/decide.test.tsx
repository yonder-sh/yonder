/** One Yonder D08: Decide sorts the places into Shortlist, Disagreements and Not going. */
import { screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
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
});
