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

	it("each button keeps its full name, and Sure, why not has a short label for narrow panels", () => {
		renderWithWorkspace(<RatingButtons value={null} onRate={() => {}} />);
		expect(
			screen.getByRole("button", { name: "Sure, why not" }),
		).toHaveAttribute("data-priority", "sure_why_not");
		expect(button("sure_why_not")).toHaveTextContent(/^Sure/);
		expect(button("sure_why_not").className).toMatch(/\bpx-2\b/);
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

	it("says why on screen (a touch screen never hovers), with its action", () => {
		renderWithWorkspace(
			<RatingButtons
				value={null}
				onRate={() => {}}
				disabled
				reason="Sign in to rate."
				action={<a href="/login">Sign in</a>}
			/>,
		);
		expect(screen.getByTestId(PLACES_TAB_TESTID.rateReason)).toHaveTextContent(
			"Sign in to rate.",
		);
		expect(screen.getByRole("link", { name: "Sign in" })).toBeInTheDocument();
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
