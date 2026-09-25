/**
 * The six rating buttons (docs/PLACES.md §1b/§1c): the current rating is
 * pressed and a second press clears it; disabled buttons don't rate; the
 * reveal puts the others' avatars on the buttons they picked.
 */
import { fireEvent, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { DEMO_MEMBERS } from "@/lib/fixtures/demo";
import { renderWithWorkspace } from "@/test/render-workspace";
import { RatingButtons } from "../RatingButtons";
import { PLACES_TAB_TESTID } from "../testids";

const buttons = () => screen.getAllByTestId(PLACES_TAB_TESTID.feedButton);
const button = (p: string) =>
	buttons().find((b) => b.getAttribute("data-priority") === p) as HTMLElement;

describe("RatingButtons", () => {
	it("marks the current rating and toggles it off on a second press", () => {
		const onRate = vi.fn();
		renderWithWorkspace(<RatingButtons value="want" onRate={onRate} />);
		expect(buttons()).toHaveLength(6);
		expect(button("want")).toHaveAttribute("aria-pressed", "true");
		fireEvent.click(button("want"));
		expect(onRate).toHaveBeenLastCalledWith(null);
		fireEvent.click(button("must"));
		expect(onRate).toHaveBeenLastCalledWith("must");
	});

	it("disabled buttons don't rate", () => {
		const onRate = vi.fn();
		renderWithWorkspace(
			<RatingButtons
				value={null}
				onRate={onRate}
				disabled
				reason="View only"
			/>,
		);
		for (const b of buttons()) expect(b).toBeDisabled();
	});

	it("the reveal: the others' avatars on the buttons they picked", () => {
		renderWithWorkspace(
			<RatingButtons
				variant="filled"
				value="must"
				onRate={() => {}}
				reveal={{ must: [DEMO_MEMBERS.audrey] }}
			/>,
		);
		expect(button("must")).toHaveAttribute(
			"data-picked-by",
			DEMO_MEMBERS.audrey,
		);
		expect(button("nah")).not.toHaveAttribute("data-picked-by");
		expect(screen.getAllByTestId(PLACES_TAB_TESTID.feedReveal)).toHaveLength(1);
	});
});
