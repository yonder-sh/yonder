/**
 * HolidaysEditor inside another form (QA COLLAB-R3-01): Trip settings mounts
 * it inside its own `<form onSubmit>`, so none of its buttons may submit that
 * form, and Enter in a holiday field saves the holidays, not the settings.
 */
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { FormEvent } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { demoGraph } from "@/lib/fixtures/demo";
import { TESTID } from "@/lib/testids";
import { useUi } from "@/lib/workspace/ui-store";
import { renderWithWorkspace } from "@/test/render-workspace";
import { HolidaysEditor } from "../HolidaysEditor";
import { INSIGHTS_TESTID as T } from "../testids";

const fns = vi.hoisted(() => ({ updateTrip: vi.fn() }));
vi.mock("@/functions/trips.functions", () => ({ updateTrip: fns.updateTrip }));

/** HolidaysEditor the way Trip settings mounts it: inside a form with its own Save. */
function renderInSettingsForm() {
	const onSettingsSubmit = vi.fn((e: FormEvent) => e.preventDefault());
	const g = structuredClone(demoGraph);
	g.trip.settings = { ...g.trip.settings, holidays: [] };
	const r = renderWithWorkspace(
		<form onSubmit={onSettingsSubmit}>
			<HolidaysEditor />
			<button type="submit">Save</button>
		</form>,
		{ graph: g },
	);
	return {
		...r,
		onSettingsSubmit,
		editor: screen.getByTestId(TESTID.holidaysEditor),
	};
}

beforeEach(() => {
	fns.updateTrip.mockReset();
	fns.updateTrip.mockResolvedValue({ updatedAt: "2026-09-23T10:00:00Z" });
});
afterEach(() => useUi.getState().resetUi());

describe("HolidaysEditor in the Trip settings form (COLLAB-R3-01)", () => {
	it("'Add holiday' adds a row and never submits the settings form", async () => {
		const user = userEvent.setup();
		const { editor, onSettingsSubmit } = renderInSettingsForm();
		expect(within(editor).queryAllByTestId(T.holidayRow)).toHaveLength(0);
		await user.click(within(editor).getByTestId(T.holidayAdd));
		expect(within(editor).getAllByTestId(T.holidayRow)).toHaveLength(1);
		await user.click(within(editor).getByTestId(T.holidayAdd));
		expect(within(editor).getAllByTestId(T.holidayRow)).toHaveLength(2);
		expect(onSettingsSubmit).not.toHaveBeenCalled();
		expect(fns.updateTrip).not.toHaveBeenCalled();
		// Every button the editor renders is a plain button, never a submit.
		for (const b of within(editor).getAllByRole("button"))
			expect(b.getAttribute("type"), b.textContent ?? "").toBe("button");
	});

	it("'Cancel' drops the draft rows without submitting the settings form", async () => {
		const user = userEvent.setup();
		const { editor, onSettingsSubmit } = renderInSettingsForm();
		await user.click(within(editor).getByTestId(T.holidayAdd));
		await user.click(within(editor).getByRole("button", { name: "Cancel" }));
		expect(within(editor).queryAllByTestId(T.holidayRow)).toHaveLength(0);
		expect(onSettingsSubmit).not.toHaveBeenCalled();
	});

	it("Enter in the holiday name saves the holidays, not the trip settings", async () => {
		const user = userEvent.setup();
		const { editor, onSettingsSubmit } = renderInSettingsForm();
		await user.click(within(editor).getByTestId(T.holidayAdd));
		// Without a date the row is invalid: Enter does nothing at all.
		await user.type(
			within(editor).getByLabelText("Holiday name"),
			"Sports Day{Enter}",
		);
		expect(onSettingsSubmit).not.toHaveBeenCalled();
		expect(fns.updateTrip).not.toHaveBeenCalled();
		expect(within(editor).getByText("Each holiday needs a date.")).toBeTruthy();
		// Pick a date (the calendar is portaled out of the form), then Enter saves.
		await user.click(within(editor).getByLabelText("Holiday date"));
		await user.click(
			await screen.findByRole("button", { name: /October 11th, 2027/ }),
		);
		await user.type(within(editor).getByLabelText("Holiday name"), "{Enter}");
		await waitFor(() => expect(fns.updateTrip).toHaveBeenCalledTimes(1));
		expect(fns.updateTrip.mock.calls[0]?.[0]).toEqual({
			data: {
				tripId: demoGraph.trip.id,
				settings: { holidays: [{ date: "2027-10-11", name: "Sports Day" }] },
			},
		});
		expect(onSettingsSubmit).not.toHaveBeenCalled();
	});

	it("'Save holidays' saves only the holidays and leaves the settings form alone", async () => {
		const user = userEvent.setup();
		const { editor, onSettingsSubmit } = renderInSettingsForm();
		await user.click(within(editor).getByTestId(T.holidayAdd));
		await user.click(within(editor).getByLabelText("Holiday date"));
		await user.click(
			await screen.findByRole("button", { name: /October 4th, 2027/ }),
		);
		await user.type(within(editor).getByLabelText("Holiday name"), "Test Day");
		await user.click(within(editor).getByTestId(T.holidaySave));
		await waitFor(() => expect(fns.updateTrip).toHaveBeenCalledTimes(1));
		expect(fns.updateTrip.mock.calls[0]?.[0]).toEqual({
			data: {
				tripId: demoGraph.trip.id,
				settings: { holidays: [{ date: "2027-10-04", name: "Test Day" }] },
			},
		});
		expect(onSettingsSubmit).not.toHaveBeenCalled();
	});
});
