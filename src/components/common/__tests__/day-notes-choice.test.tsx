/**
 * A removed day's shared note: the remover picks keep (the default) or delete;
 * nothing shows when no removed day has one.
 */
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { DayNotesChoiceField } from "../day-notes-choice";

describe("the removed day's note choice", () => {
	it("names the day, keeps by default, and reports a switch to delete", () => {
		const onChange = vi.fn();
		render(
			<DayNotesChoiceField
				dates={["2027-10-05"]}
				value="keep"
				onChange={onChange}
			/>,
		);
		expect(screen.getByText("Tue 5 Oct has a note.")).toBeInTheDocument();
		expect(
			screen.getByRole("radio", { name: "Keep it in the trip's notes" }),
		).toBeChecked();
		fireEvent.click(screen.getByRole("radio", { name: "Delete it" }));
		expect(onChange).toHaveBeenCalledWith("delete");
	});

	it("shows nothing when no removed day has a note", () => {
		const { container } = render(
			<DayNotesChoiceField dates={[]} value="keep" onChange={() => {}} />,
		);
		expect(container).toBeEmptyDOMElement();
	});
});
