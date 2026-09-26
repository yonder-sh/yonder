/**
 * The rate card's media with more than one photo, like stories: bars along
 * the top, with a mouse the left third goes back and the rest forward, a
 * sideways swipe (the only way on a touch screen), and ← / → on the card in
 * view.
 */
import { QueryClient } from "@tanstack/react-query";
import { fireEvent, screen } from "@testing-library/react";
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

const bars = () => screen.getByTestId(PLACES_TESTID.rateMediaBars);
const realMatchMedia = window.matchMedia;
afterEach(() => {
	vi.unstubAllGlobals();
	window.matchMedia = realMatchMedia;
});
const box = () => screen.getByTestId(PLACES_TESTID.feedMedia);

describe("the rate card's photos", () => {
	it("shows a bar per photo; the right of the photo goes forward, the left back, round the ends", () => {
		render(3);
		expect(bars().children).toHaveLength(3);
		expect(bars()).toHaveAccessibleName("Photo 1 of 3");
		fireEvent.click(screen.getByRole("button", { name: "Next photo" }));
		expect(bars()).toHaveAccessibleName("Photo 2 of 3");
		fireEvent.click(screen.getByRole("button", { name: "Previous photo" }));
		fireEvent.click(screen.getByRole("button", { name: "Previous photo" }));
		expect(bars()).toHaveAccessibleName("Photo 3 of 3");
	});

	it("follows a sideways swipe, never an up-and-down one", () => {
		render(3);
		const swipe = (dx: number, dy: number) => {
			fireEvent.touchStart(box(), {
				touches: [{ clientX: 200, clientY: 300 }],
			});
			fireEvent.touchEnd(box(), {
				changedTouches: [{ clientX: 200 + dx, clientY: 300 + dy }],
			});
		};
		swipe(-80, 10);
		expect(bars()).toHaveAccessibleName("Photo 2 of 3");
		swipe(20, -200);
		expect(bars()).toHaveAccessibleName("Photo 2 of 3");
		swipe(90, 0);
		expect(bars()).toHaveAccessibleName("Photo 1 of 3");
	});

	it("takes ← / → only on the card in view", () => {
		const a = render(3);
		fireEvent.keyDown(document.body, { key: "ArrowRight" });
		expect(bars()).toHaveAccessibleName("Photo 2 of 3");
		a.unmount();
		render(3, false);
		fireEvent.keyDown(document.body, { key: "ArrowRight" });
		expect(bars()).toHaveAccessibleName("Photo 1 of 3");
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
		render(3);
		expect(screen.queryByRole("button", { name: "Next photo" })).toBeNull();
		expect(screen.queryByRole("button", { name: "Previous photo" })).toBeNull();
		fireEvent.touchStart(box(), { touches: [{ clientX: 200, clientY: 300 }] });
		fireEvent.touchEnd(box(), {
			changedTouches: [{ clientX: 110, clientY: 305 }],
		});
		expect(bars()).toHaveAccessibleName("Photo 2 of 3");
	});

	it("has no bars or tap zones for a single photo", () => {
		render(1);
		expect(screen.queryByTestId(PLACES_TESTID.rateMediaBars)).toBeNull();
		expect(screen.queryByRole("button", { name: "Next photo" })).toBeNull();
	});
});
