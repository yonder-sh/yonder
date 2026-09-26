/**
 * A place's media can be deleted from its panel: a photo from the viewer the
 * photo strip opens (which moves on to the next one), a PDF from its viewer
 * and a link from its ⋯ menu in the Media tab. The media list is seeded in
 * the cache; the server calls are mocked.
 */
import { QueryClient } from "@tanstack/react-query";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MediaDto } from "@/features/media/media.functions";
import { MEDIA_TESTID } from "@/features/media/testids";
import { InspectorBody } from "@/features/shell/InspectorBody";
import { demoGraph, N } from "@/lib/fixtures/demo";
import { tripKeys } from "@/lib/query/keys";
import { TESTID } from "@/lib/testids";
import { renderWithWorkspace } from "@/test/render-workspace";

const calls = vi.hoisted(() => ({ deleted: [] as string[] }));
vi.mock("@/features/media/media.functions", async (orig) => ({
	...(await orig<typeof import("@/features/media/media.functions")>()),
	deleteAttachment: async (opts: { data: { id: string } }) => {
		calls.deleted.push(opts.data.id);
		return { ok: true };
	},
}));

beforeEach(() => {
	calls.deleted.length = 0;
});

let seq = 0;
function media(p: Partial<MediaDto>): MediaDto {
	seq += 1;
	return {
		id: `00000000-0000-7000-8000-${String(seq).padStart(12, "0")}`,
		target: { kind: "node", nodeId: N.sensoji as string },
		kind: "photo",
		status: "ready",
		visibility: "everyone",
		mime: null,
		width: 800,
		height: 600,
		durationSec: null,
		thumbhash: null,
		takenAt: null,
		url: null,
		provider: null,
		embedId: null,
		title: null,
		siteName: null,
		caption: null,
		position: `a${seq}`,
		createdAt: "2026-09-01T00:00:00.000Z",
		updatedAt: "2026-09-01T00:00:00.000Z",
		description: null,
		author: null,
		sizeBytes: null,
		hasThumb: true,
		hasImage: true,
		hasFavicon: false,
		aspect: null,
		pages: 0,
		pageCount: null,
		igType: null,
		license: null,
		licenseUrl: null,
		sourceUrl: null,
		fetch: null,
		mine: true,
		...p,
	};
}

const gate = media({ caption: "The gate" });
const hall = media({ caption: "The hall" });
const guide = media({
	kind: "link",
	url: "https://www.japan-guide.com/e/e3001.html",
	title: "Sensoji Temple",
	hasThumb: false,
	hasImage: false,
});
const map = media({
	kind: "pdf",
	title: "Asakusa walking map",
	hasThumb: false,
	hasImage: false,
});

function render(itab?: "media") {
	const queryClient = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	queryClient.setQueryData(tripKeys.media(demoGraph.trip.id), [
		gate,
		hall,
		guide,
		map,
	]);
	return renderWithWorkspace(<InspectorBody onClose={() => {}} />, {
		queryClient,
		search: {
			tab: "places",
			pv: "table",
			sel: `n.${N.sensoji}`,
			...(itab ? { itab } : {}),
		},
	});
}

describe("deleting a place's media", () => {
	it("a photo from the viewer, which shows the next one", async () => {
		render();
		fireEvent.click(
			await screen.findByRole("button", { name: "Open The gate" }),
		);
		fireEvent.click(
			await screen.findByTestId(
				MEDIA_TESTID.lightboxDelete,
				{},
				{ timeout: 5000 },
			),
		);
		await waitFor(() => expect(calls.deleted).toEqual([gate.id]));
		// Still open, on the hall; the gate is gone from the strip.
		expect(screen.getByTestId(MEDIA_TESTID.lightbox)).toBeInTheDocument();
		expect(screen.queryByRole("button", { name: "Open The gate" })).toBeNull();
	});

	it("a PDF from its viewer", async () => {
		render("media");
		fireEvent.click(
			await screen.findByRole("button", { name: "Open Asakusa walking map" }),
		);
		fireEvent.click(await screen.findByTestId(MEDIA_TESTID.pdfDelete));
		await waitFor(() => expect(calls.deleted).toEqual([map.id]));
		expect(screen.queryByTestId(MEDIA_TESTID.pdfViewer)).toBeNull();
	});

	it("a link from its ⋯ menu", async () => {
		render("media");
		const tile = (await screen.findAllByTestId(TESTID.galleryItem)).find(
			(t) => t.getAttribute("data-id") === guide.id,
		) as HTMLElement;
		fireEvent.pointerDown(within(tile).getByTestId(MEDIA_TESTID.tileMenu), {
			button: 0,
			pointerType: "mouse",
		});
		fireEvent.click(await screen.findByRole("menuitem", { name: /Delete/ }));
		await waitFor(() => expect(calls.deleted).toEqual([guide.id]));
	});
});
