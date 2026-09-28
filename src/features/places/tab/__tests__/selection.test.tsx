/** One Yonder D06: tick places in the table; the bar acts on them together. */
import { fireEvent, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { renderWithWorkspace } from "@/test/render-workspace";
import { PlacesTab } from "../PlacesTab";
import { PLACES_TAB_TESTID as T } from "../testids";

describe("the table's selection (D06)", () => {
	it("ticks rows, names them in the bar, and clears", () => {
		renderWithWorkspace(<PlacesTab />, {
			search: { tab: "places", pv: "table" },
		});
		expect(screen.queryByTestId(T.selectionBar)).toBeNull();
		const rows = screen.getAllByTestId(T.row).slice(0, 2);
		for (const r of rows) fireEvent.click(within(r).getByTestId(T.rowPick));
		const bar = screen.getByTestId(T.selectionBar);
		expect(bar).toHaveTextContent("2 selected");
		expect(within(bar).getByTestId(T.selectionDrop)).toHaveTextContent(
			"Not going",
		);
		// A tick never opens the place.
		expect(rows[0]).toHaveAttribute("aria-selected", "false");
		fireEvent.click(within(bar).getByRole("button", { name: /Clear/ }));
		expect(screen.queryByTestId(T.selectionBar)).toBeNull();
	});

	it("selects every place shown from the header", () => {
		renderWithWorkspace(<PlacesTab />, {
			search: { tab: "places", pv: "table" },
		});
		fireEvent.click(screen.getByTestId(T.pickAll));
		expect(screen.getByTestId(T.selectionBar)).toHaveTextContent(
			`${screen.getAllByTestId(T.row).length} selected`,
		);
	});
});
