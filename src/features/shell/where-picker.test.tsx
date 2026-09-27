import { act, fireEvent, screen, within } from "@testing-library/react";
import { beforeAll, describe, expect, it } from "vitest";
import { indexGraph } from "@/lib/engine/graph-index";
import { demoGraph, N } from "@/lib/fixtures/demo";
import { renderWithWorkspace } from "@/test/render-workspace";
import { SHELL_TESTID } from "./testids";
import { WherePicker } from "./WherePicker";
import { wherePlaces, whereRows } from "./where-rows";

beforeAll(() => {
	// cmdk scrolls the active item into view.
	Element.prototype.scrollIntoView ??= () => {};
});

describe("the Where picker's rows", () => {
	it("the whole trip, then countries › cities › areas with their dates; no places", () => {
		const rows = whereRows(indexGraph(demoGraph));
		expect(rows[0]).toMatchObject({ id: null, name: "Whole trip", depth: 0 });
		const tokyo = rows.find((r) => r.id === N.tokyo);
		expect(tokyo).toMatchObject({ name: "Tokyo", depth: 2, path: "Japan" });
		expect(tokyo?.dates).not.toBe("");
		expect(rows.some((r) => r.id === N.shibuyaSky)).toBe(false);
		expect(
			wherePlaces(indexGraph(demoGraph)).find((p) => p.id === N.shibuyaSky),
		).toMatchObject({ name: "Shibuya Sky", path: "Japan › Tokyo › Shibuya" });
	});
});

describe("the Where picker", () => {
	const open = () => {
		fireEvent.click(screen.getByTestId(SHELL_TESTID.whereButton));
		return screen.getByTestId(SHELL_TESTID.wherePicker);
	};

	it("says where you are and zooms to a city", () => {
		const { navigations } = renderWithWorkspace(<WherePicker />, {
			splat: "japan/tokyo",
		});
		expect(screen.getByTestId(SHELL_TESTID.whereButton)).toHaveTextContent(
			"Japan › Tokyo",
		);
		const picker = open();
		const kyoto = within(picker)
			.getAllByTestId(SHELL_TESTID.whereRow)
			.find((r) => r.getAttribute("data-node-id") === N.kyoto) as HTMLElement;
		act(() => fireEvent.click(kyoto));
		expect(navigations.at(-1)?.splat).toBe("japan/kyoto");
	});

	it("a typed place goes to where it is, selected", () => {
		const { navigations } = renderWithWorkspace(<WherePicker />, {
			splat: "japan/tokyo",
		});
		const picker = open();
		fireEvent.change(
			within(picker).getByPlaceholderText("Find a city, area or place"),
			{ target: { value: "Shibuya Sky" } },
		);
		const sky = within(picker)
			.getAllByTestId(SHELL_TESTID.whereRow)
			.find(
				(r) => r.getAttribute("data-node-id") === N.shibuyaSky,
			) as HTMLElement;
		act(() => fireEvent.click(sky));
		expect(navigations.at(-1)?.splat).toBe("japan/tokyo/shibuya");
		expect(navigations.at(-1)?.search.sel).toBe(`n.${N.shibuyaSky}`);
	});

	it("About opens the place's details", () => {
		const { navigations } = renderWithWorkspace(<WherePicker />, {
			splat: "japan/tokyo",
		});
		const picker = open();
		act(() =>
			fireEvent.click(within(picker).getByTestId(SHELL_TESTID.whereAbout)),
		);
		expect(navigations.at(-1)?.search.sel).toBe(`n.${N.tokyo}`);
	});
});
