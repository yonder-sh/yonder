/**
 * The phone's Rate feed shows a place's notes like the desktop does: the
 * shared note's first line (tap for the rest, "More"), "Your note" for my
 * private one, and both in a box above the name that "Less" closes; the
 * rating buttons stay in the card.
 */
import { QueryClient } from "@tanstack/react-query";
import { fireEvent, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { NoteDto } from "@/features/notes/notes.functions";
import { demoGraph } from "@/lib/fixtures/demo";
import { tripKeys } from "@/lib/query/keys";
import { renderWithWorkspace } from "@/test/render-workspace";
import { PlacesTab } from "../PlacesTab";
import { PLACES_TAB_TESTID as T } from "../testids";

const note = (nodeId: string, text: string, owner: string | null): NoteDto => ({
	name: `node:${nodeId}`,
	ownerUserId: owner,
	nodeId,
	legId: null,
	itemId: null,
	dayId: null,
	json: null,
	plainText: text,
	updatedAt: "2026-09-01T00:00:00.000Z",
	updatedBy: null,
});

function render() {
	const queryClient = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	queryClient.setQueryData(
		tripKeys.notes(demoGraph.trip.id),
		demoGraph.nodes.flatMap((n) => [
			note(n.id, "Go early, before the tour buses.\nClosed on Mondays.", null),
			note(n.id, "Ask Audrey about tickets", "user-dennis"),
		]),
	);
	return renderWithWorkspace(<PlacesTab phone />, {
		queryClient,
		search: { tab: "places", pv: "rate" },
	});
}

/** The card in view (the feed is lazy: wait for it). */
async function activeCard(): Promise<HTMLElement> {
	const cards = await screen.findAllByTestId(T.feedCard, {}, { timeout: 5000 });
	return (cards.find((c) => c.hasAttribute("data-active")) ??
		cards[0]) as HTMLElement;
}

describe("notes on the phone's Rate feed", () => {
	it("the first line with More and Your note; open, both in full; Less closes", async () => {
		render();
		const card = await activeCard();
		const teaser = within(card).getByTestId(T.feedNote);
		expect(teaser).toHaveTextContent("Go early, before the tour buses.");
		expect(teaser).toHaveTextContent("More");
		expect(
			within(card).getByRole("button", { name: /Your note/ }),
		).toBeInTheDocument();

		fireEvent.click(teaser);
		const box = within(card).getByTestId(T.feedNotes);
		expect(box).toHaveTextContent("Shared note");
		expect(box).toHaveTextContent("Closed on Mondays.");
		expect(box).toHaveTextContent("Your private note");
		expect(box).toHaveTextContent("Ask Audrey about tickets");
		// The rating stays in reach.
		expect(
			within(card).getAllByRole("button", { name: /Must/ }).length,
		).toBeGreaterThan(0);

		fireEvent.click(within(box).getByRole("button", { name: "Less" }));
		expect(within(card).queryByTestId(T.feedNotes)).toBeNull();
	});
});
