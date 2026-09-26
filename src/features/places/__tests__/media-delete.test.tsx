/**
 * A place's media can be deleted from its details: a photo from the viewer
 * (which moves on to the next one), a PDF from its viewer, a link from its
 * row. The media list is seeded in the cache; the server calls are mocked.
 */
import { QueryClient } from "@tanstack/react-query";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MediaDto } from "@/features/media/media.functions";
import { MEDIA_TESTID } from "@/features/media/testids";
import { demoGraph, N } from "@/lib/fixtures/demo";
import { tripKeys } from "@/lib/query/keys";
import { renderWithWorkspace } from "@/test/render-workspace";
import { PlacesSelectionDetails } from "../tab/PlacesTab";

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

function render() {
	const queryClient = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	queryClient.setQueryData(tripKeys.media(demoGraph.trip.id), [
		gate,
		hall,
		guide,
		map,
	]);
	return renderWithWorkspace(<PlacesSelectionDetails onClose={() => {}} />, {
		queryClient,
		search: { tab: "places", pv: "table", sel: `n.${N.sensoji}` },
	});
}

describe("deleting a place's media", () => {
	it("a photo from the viewer, which shows the next one", async () => {
		render();
		fireEvent.click(
			await screen.findByRole("button", { name: "Open photo 1" }),
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
		expect(screen.queryByRole("button", { name: "Open photo 2" })).toBeNull();
	});

	it("a PDF from its viewer", async () => {
		render();
		fireEvent.click(await screen.findByText("Asakusa walking map"));
		fireEvent.click(await screen.findByTestId(MEDIA_TESTID.pdfDelete));
		await waitFor(() => expect(calls.deleted).toEqual([map.id]));
		expect(screen.queryByTestId(MEDIA_TESTID.pdfViewer)).toBeNull();
	});

	it("a link from its row", async () => {
		render();
		fireEvent.click(
			await screen.findByRole("button", { name: "Delete link Sensoji Temple" }),
		);
		await waitFor(() => expect(calls.deleted).toEqual([guide.id]));
		expect(screen.queryByText("Sensoji Temple")).toBeNull();
	});
});
