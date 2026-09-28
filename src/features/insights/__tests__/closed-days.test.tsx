/**
 * The hours editor's "Only closed days" (EXTENSIONS §4.5): a weekday is the
 * kit's FilterPill, on while that day is closed.
 */
import { act, fireEvent, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { demo, demoGraph } from "@/lib/fixtures/demo";
import { useUi } from "@/lib/workspace/ui-store";
import { renderWithWorkspace } from "@/test/render-workspace";
import { HoursEditorDialog } from "../HoursEditorDialog";
import { INSIGHTS_TESTID } from "../testids";

afterEach(() => useUi.getState().resetUi());

describe("the hours editor's closed days", () => {
	it("a weekday pill turns on and off", () => {
		renderWithWorkspace(<HoursEditorDialog />, {
			graph: structuredClone(demoGraph),
		});
		act(() => useUi.getState().openHoursEditor({ nodeId: demo.N.itoya ?? "" }));
		fireEvent.click(
			within(screen.getByTestId(INSIGHTS_TESTID.hoursEditorMode)).getByRole(
				"radio",
				{ name: "Only closed days" },
			),
		);
		const days = screen.getAllByTestId(INSIGHTS_TESTID.hoursEditorClosedDay);
		expect(days.map((d) => d.textContent)).toEqual([
			"Mon",
			"Tue",
			"Wed",
			"Thu",
			"Fri",
			"Sat",
			"Sun",
		]);
		for (const d of days) {
			expect(d).toHaveAttribute("data-slot", "filter-pill");
			expect(d).toHaveAttribute("aria-pressed", "false");
		}
		const tue = days[1] as HTMLElement;
		expect(tue).toHaveAttribute("data-day", "2");
		fireEvent.click(tue);
		expect(tue).toHaveAttribute("aria-pressed", "true");
		expect(days[0]).toHaveAttribute("aria-pressed", "false");
		fireEvent.click(tue);
		expect(tue).toHaveAttribute("aria-pressed", "false");
	});
});
