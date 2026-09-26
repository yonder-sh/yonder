/**
 * Media order: a tile moves to the front, one earlier or one later among the
 * media on the same thing, shown at once; the server keys it from its
 * neighbour. The Rate feed shows a place's photos in this order.
 */
import { QueryClient } from "@tanstack/react-query";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MediaDto } from "@/features/media/media.functions";
import { InspectorBody } from "@/features/shell/InspectorBody";
import { demoGraph, N } from "@/lib/fixtures/demo";
import { tripKeys } from "@/lib/query/keys";
import { TESTID } from "@/lib/testids";
import { renderWithWorkspace } from "@/test/render-workspace";
import { applyReorder, reorderMoves, siblingsOf } from "../order";
import { MEDIA_TESTID } from "../testids";

const calls = vi.hoisted(() => ({ updated: [] as unknown[] }));
vi.mock("@/features/media/media.functions", async (orig) => ({
	...(await orig<typeof import("@/features/media/media.functions")>()),
	updateAttachment: async (opts: { data: unknown }) => {
		calls.updated.push(opts.data);
		return { updatedAt: new Date().toISOString() };
	},
}));

beforeEach(() => {
	calls.updated.length = 0;
});

let seq = 0;
function photo(caption: string, nodeId = N.sensoji as string): MediaDto {
	seq += 1;
	return {
		id: `00000000-0000-7000-8000-${String(seq).padStart(12, "0")}`,
		target: { kind: "node", nodeId },
		kind: "photo",
		status: "ready",
		visibility: "everyone",
		caption,
		position: `a${seq}`,
		hasThumb: true,
		hasImage: true,
		width: 800,
		height: 600,
		mine: true,
	} as unknown as MediaDto;
}

const a = photo("A");
const b = photo("B");
const c = photo("C");
const elsewhere = photo("X", N.itoya as string);

describe("the order functions", () => {
	it("siblings are the media on the same thing; moves name a neighbour", () => {
		const sibs = siblingsOf([a, elsewhere, b, c], c);
		expect(sibs.map((m) => m.caption)).toEqual(["A", "B", "C"]);
		expect(reorderMoves(sibs, c.id)).toEqual({
			front: { id: c.id, beforeId: a.id },
			earlier: { id: c.id, beforeId: b.id },
			later: null,
		});
		expect(reorderMoves(sibs, a.id)).toMatchObject({
			front: null,
			earlier: null,
			later: { id: a.id, afterId: b.id },
		});
	});

	it("the move shows at once", () => {
		const out = applyReorder([a, b, c], { id: c.id, beforeId: a.id });
		expect(out.map((m) => m.caption)).toEqual(["C", "A", "B"]);
		expect(
			applyReorder([a, b, c], { id: a.id, afterId: b.id }).map(
				(m) => m.caption,
			),
		).toEqual(["B", "A", "C"]);
	});
});

describe("a tile's menu", () => {
	it("Show first moves the photo to the front", async () => {
		const queryClient = new QueryClient({
			defaultOptions: { queries: { retry: false } },
		});
		queryClient.setQueryData(tripKeys.media(demoGraph.trip.id), [a, b, c]);
		renderWithWorkspace(<InspectorBody onClose={() => {}} />, {
			queryClient,
			search: { tab: "places", sel: `n.${N.sensoji}`, itab: "media" },
		});
		const tiles = async () =>
			(await screen.findAllByTestId(TESTID.galleryItem)).map((t) =>
				t.getAttribute("data-id"),
			);
		const tile = (await screen.findAllByTestId(TESTID.galleryItem)).find(
			(t) => t.getAttribute("data-id") === c.id,
		) as HTMLElement;
		fireEvent.pointerDown(within(tile).getByTestId(MEDIA_TESTID.tileMenu), {
			button: 0,
			pointerType: "mouse",
		});
		fireEvent.click(
			await screen.findByRole("menuitem", { name: /Show first/ }),
		);
		await waitFor(() =>
			expect(calls.updated).toEqual([{ id: c.id, beforeId: a.id }]),
		);
		expect(await tiles()).toEqual([c.id, a.id, b.id]);
	});
});
