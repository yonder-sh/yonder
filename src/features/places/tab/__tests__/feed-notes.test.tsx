/**
 * The phone's Rate feed: each place's media full-screen under a thin bar,
 * then its details (the shared note and my private one in full, like the
 * desktop), the rating buttons last, in the thumb zone.
 */
import { QueryClient } from "@tanstack/react-query";
import { screen, within } from "@testing-library/react";
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

describe("the phone's Rate feed", () => {
	it("the media under a thin bar; below it the notes in full and the buttons last", async () => {
		render();
		const card = await activeCard();
		// The media's own stop: only the name and "Rate" over it.
		const bar = within(card).getByTestId(T.feedBar);
		expect(bar).toHaveTextContent("Rate");
		expect(
			within(within(card).getByTestId(T.feedStage)).queryByRole("button", {
				name: /Must/,
			}),
		).toBeNull();

		// One swipe up: the details, both notes in full, the buttons at the bottom.
		const info = within(card).getByTestId(T.feedInfo);
		await within(info).findByText("Shared note");
		expect(info).toHaveTextContent("Go early, before the tour buses.");
		expect(info).toHaveTextContent("Closed on Mondays.");
		expect(info).toHaveTextContent("Your private note");
		expect(info).toHaveTextContent("Ask Audrey about tickets");
		const must = within(info).getAllByRole("button", {
			name: /Must/,
		})[0] as HTMLElement;
		const note = within(info).getByText("Shared note");
		expect(
			note.compareDocumentPosition(must) & Node.DOCUMENT_POSITION_FOLLOWING,
		).toBeTruthy();
	});
});
