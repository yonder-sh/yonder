/**
 * A first rating moves the Rate feed on to the next place, after a beat;
 * changing a rating later, or touching the card, doesn't.
 */
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderWithWorkspace } from "@/test/render-workspace";
import { PlacesTab } from "../PlacesTab";
import { PLACES_TAB_TESTID as T } from "../testids";

vi.mock("@/functions/nodes.functions", async (orig) => ({
	...(await orig<typeof import("@/functions/nodes.functions")>()),
	setNodePriority: async () => ({ ok: true }),
}));

afterEach(() => {
	vi.restoreAllMocks();
});

function feed() {
	const scrolled: string[] = [];
	vi.spyOn(Element.prototype, "scrollIntoView").mockImplementation(function (
		this: Element,
	) {
		scrolled.push(this.getAttribute("data-key") ?? "");
	});
	renderWithWorkspace(<PlacesTab phone />, {
		cached: true,
		search: { tab: "places", pv: "rate" },
	});
	return scrolled;
}

describe("rating in the feed", () => {
	it("a first rating moves on to the next place", async () => {
		const scrolled = feed();
		const cards = await screen.findAllByTestId(
			T.feedCard,
			{},
			{ timeout: 5000 },
		);
		const [first, second] = cards as [HTMLElement, HTMLElement];
		fireEvent.keyDown(document.body, { key: "1" });
		await waitFor(() => expect(first).toHaveAttribute("data-rated", "must"));
		await waitFor(
			() => expect(scrolled).toContain(second.getAttribute("data-key")),
			{ timeout: 3000 },
		);
	});

	it("a quick change still moves on once; a later change doesn't move", async () => {
		const scrolled = feed();
		const cards = await screen.findAllByTestId(
			T.feedCard,
			{},
			{ timeout: 5000 },
		);
		const [first, second] = cards as [HTMLElement, HTMLElement];
		fireEvent.keyDown(document.body, { key: "1" });
		fireEvent.keyDown(document.body, { key: "2" });
		await waitFor(() =>
			expect(first).toHaveAttribute("data-rated", "really_want"),
		);
		await waitFor(
			() => expect(scrolled).toContain(second.getAttribute("data-key")),
			{ timeout: 3000 },
		);
		expect(
			scrolled.filter((k) => k === second.getAttribute("data-key")),
		).toHaveLength(1);
		// Still on the first card (nothing scrolls in jsdom): a change waits.
		scrolled.length = 0;
		fireEvent.keyDown(document.body, { key: "3" });
		await waitFor(() => expect(first).toHaveAttribute("data-rated", "want"));
		await new Promise((r) => setTimeout(r, 1700));
		expect(scrolled).toEqual([]);
	});

	it("touching the rated card (Add a comment) keeps it there", async () => {
		const scrolled = feed();
		const cards = await screen.findAllByTestId(
			T.feedCard,
			{},
			{ timeout: 5000 },
		);
		const [first] = cards as [HTMLElement];
		fireEvent.keyDown(document.body, { key: "1" });
		await waitFor(() => expect(first).toHaveAttribute("data-rated", "must"));
		fireEvent.pointerDown(
			within(first).getAllByRole("button", {
				name: "Add a comment",
			})[0] as Element,
		);
		await new Promise((r) => setTimeout(r, 1900));
		expect(scrolled).toEqual([]);
	});
});
