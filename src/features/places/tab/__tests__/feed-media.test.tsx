/**
 * The rate card's media with more than one photo: dots along the bottom, a
 * track that scrolls sideways (a swipe; the only way on a touch screen), with
 * a mouse the left third goes back and the rest forward, and ← / → on the
 * card in view.
 */
import { QueryClient } from "@tanstack/react-query";
import { act, fireEvent, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { MediaDto } from "@/features/media/media.functions";
import type { GraphNode } from "@/lib/engine/types";
import { demoGraph, N } from "@/lib/fixtures/demo";
import { tripKeys } from "@/lib/query/keys";
import { renderWithWorkspace } from "@/test/render-workspace";
import { PLACES_TESTID } from "../../testids";
import type { PlaceRow } from "../model";
import { FeedMedia } from "../RateFeed";

const sensoji = demoGraph.nodes.find((n) => n.id === N.sensoji) as GraphNode;

const photo = (k: number) =>
	({
		id: `00000000-0000-7000-8000-${String(k).padStart(12, "0")}`,
		target: { kind: "node", nodeId: sensoji.id },
		kind: "photo",
		status: "ready",
		visibility: "everyone",
		caption: `Photo ${k}`,
		position: `a${k}`,
		thumbhash: null,
		createdAt: "2026-09-01T00:00:00.000Z",
		updatedAt: "2026-09-01T00:00:00.000Z",
	}) as unknown as MediaDto;

function render(photos: number, active = true) {
	const queryClient = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	queryClient.setQueryData(
		tripKeys.media(demoGraph.trip.id),
		Array.from({ length: photos }, (_, i) => photo(i + 1)),
	);
	return renderWithWorkspace(
		<FeedMedia row={{ node: sensoji } as PlaceRow} active={active} near />,
		{ queryClient },
	);
}

const dots = () => screen.getByTestId(PLACES_TESTID.rateMediaDots);
const realMatchMedia = window.matchMedia;
afterEach(() => {
	vi.unstubAllGlobals();
	vi.useRealTimers();
	window.matchMedia = realMatchMedia;
});

/** A swipe: the track scrolls sideways and settles on slide `j` (400 px wide). */
function swipeTo(j: number) {
	const track = screen.getByTestId(PLACES_TESTID.rateMediaTrack);
	Object.defineProperty(track, "clientWidth", {
		value: 400,
		configurable: true,
	});
	track.scrollLeft = j * 400;
	fireEvent.scroll(track);
	act(() => vi.advanceTimersByTime(120));
}

describe("the rate card's photos", () => {
	it("shows a dot per photo; with a mouse the right of the photo goes forward, the left back, round the ends", () => {
		render(3);
		expect(dots().children).toHaveLength(3);
		expect(dots()).toHaveAccessibleName("Photo 1 of 3");
		fireEvent.click(screen.getByRole("button", { name: "Next photo" }));
		expect(dots()).toHaveAccessibleName("Photo 2 of 3");
		fireEvent.click(screen.getByRole("button", { name: "Previous photo" }));
		fireEvent.click(screen.getByRole("button", { name: "Previous photo" }));
		expect(dots()).toHaveAccessibleName("Photo 3 of 3");
	});

	it("follows the sideways track where a swipe settles", () => {
		vi.useFakeTimers();
		render(3);
		swipeTo(1);
		expect(dots()).toHaveAccessibleName("Photo 2 of 3");
		swipeTo(0);
		expect(dots()).toHaveAccessibleName("Photo 1 of 3");
	});

	it("takes ← / → only on the card in view", () => {
		const a = render(3);
		fireEvent.keyDown(document.body, { key: "ArrowRight" });
		expect(dots()).toHaveAccessibleName("Photo 2 of 3");
		a.unmount();
		render(3, false);
		fireEvent.keyDown(document.body, { key: "ArrowRight" });
		expect(dots()).toHaveAccessibleName("Photo 1 of 3");
	});

	it("on a touch screen, swipes only: no tap zones", () => {
		const coarse = (q: string) => ({
			matches: q === "(pointer: coarse)",
			media: q,
			addEventListener: () => {},
			removeEventListener: () => {},
		});
		vi.stubGlobal("matchMedia", coarse);
		window.matchMedia = coarse as unknown as typeof window.matchMedia;
		vi.useFakeTimers();
		render(3);
		expect(screen.queryByRole("button", { name: "Next photo" })).toBeNull();
		expect(screen.queryByRole("button", { name: "Previous photo" })).toBeNull();
		swipeTo(2);
		expect(dots()).toHaveAccessibleName("Photo 3 of 3");
	});

	it("has no dots, track or tap zones for a single photo", () => {
		render(1);
		expect(screen.queryByTestId(PLACES_TESTID.rateMediaDots)).toBeNull();
		expect(screen.queryByTestId(PLACES_TESTID.rateMediaTrack)).toBeNull();
		expect(screen.queryByRole("button", { name: "Next photo" })).toBeNull();
	});
});
