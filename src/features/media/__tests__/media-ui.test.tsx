/**
 * The Media surfaces render in the workspace harness (fixture mode: no
 * server): the empty states name the scope, the Add control follows the
 * edit guard, and tiles show the right affordances.
 */
import { QueryClient } from "@tanstack/react-query";
import { screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";
import { DEMO_TRIP_ID, N } from "@/lib/fixtures/demo";
import { tripKeys } from "@/lib/query/keys";
import type { ProposalDto } from "@/lib/schemas/proposals";
import { TESTID } from "@/lib/testids";
import { renderWithWorkspace } from "@/test/render-workspace";
import { CoverStrip } from "../CoverStrip";
import { MediaTile } from "../components/media-tile";
import { MediaPanel } from "../MediaPanel";
import { MediaTab } from "../MediaTab";
import { MEDIA_TESTID } from "../testids";
import type { MediaDto } from "../types";

const base: MediaDto = {
	id: "00000000-0000-7000-8000-00000000a001",
	target: { kind: "trip" },
	kind: "pdf",
	status: "ready",
	visibility: "members",
	mime: "application/pdf",
	width: 480,
	height: 679,
	durationSec: null,
	thumbhash: null,
	takenAt: null,
	url: null,
	provider: null,
	embedId: null,
	title: "E-ticket NH9.pdf",
	siteName: null,
	caption: null,
	position: "a0",
	createdAt: "2026-09-23T00:00:00.000Z",
	updatedAt: "2026-09-23T00:00:00.000Z",
	description: null,
	author: null,
	sizeBytes: 245_000,
	hasThumb: true,
	hasImage: false,
	hasFavicon: false,
	aspect: null,
	pages: 3,
	pageCount: 3,
	igType: null,
	license: null,
	licenseUrl: null,
	sourceUrl: null,
	fetch: null,
	mine: true,
};

describe("Media UI", () => {
	it("the tab's empty state names the scope and offers Add", () => {
		renderWithWorkspace(<MediaTab />, { splat: "japan/tokyo" });
		expect(screen.getByTestId(TESTID.mediaTab)).toBeTruthy();
		expect(
			screen.getByText("No photos, videos, PDFs or links in Tokyo yet."),
		).toBeTruthy();
		expect(
			screen.getAllByTestId(MEDIA_TESTID.addButton).length,
		).toBeGreaterThan(0);
	});

	it("the inspector panel offers Everything inside / Only for a node", () => {
		renderWithWorkspace(
			<MediaPanel
				target={{
					kind: "node",
					nodeId: "00000000-0000-7000-8000-000000000101",
				}}
			/>,
			{ splat: "japan" },
		);
		expect(screen.getByTestId(TESTID.mediaPanel)).toBeTruthy();
		expect(screen.getByText("Everything inside")).toBeTruthy();
		expect(screen.getByText(/^Only /)).toBeTruthy();
	});

	it("a day panel offers This day / Everything that day", () => {
		renderWithWorkspace(
			<MediaPanel
				target={{ kind: "day", dayId: "00000000-0000-7000-8000-000000000001" }}
			/>,
		);
		expect(screen.getByText("This day")).toBeTruthy();
		expect(screen.getByText("Everything that day")).toBeTruthy();
	});

	it("the cover strip renders nothing without photos", () => {
		const { container } = renderWithWorkspace(
			<CoverStrip
				target={{
					kind: "node",
					nodeId: "00000000-0000-7000-8000-000000000101",
				}}
			/>,
		);
		expect(
			container.querySelector(`[data-testid=${TESTID.coverStrip}]`),
		).toBeNull();
	});

	it("a hidden PDF tile shows its lock, page count and size", () => {
		renderWithWorkspace(
			<TooltipProvider>
				<MediaTile item={base} onOpen={() => {}} />
			</TooltipProvider>,
		);
		const tile = screen.getByTestId(TESTID.galleryItem);
		expect(tile.getAttribute("data-visibility")).toBe("members");
		expect(screen.getByTestId(MEDIA_TESTID.hiddenChip)).toBeTruthy();
		expect(tile.textContent).toContain("E-ticket NH9.pdf");
		expect(tile.textContent).toContain("3 pages · 239 KB");
	});

	it("a guide link opens in a new tab with noopener", () => {
		renderWithWorkspace(
			<MediaTile
				item={{
					...base,
					kind: "link",
					visibility: "everyone",
					url: "https://www.japan-guide.com/e/e2172.html",
					title: "Mt. Fuji",
					siteName: "japan-guide.com",
				}}
				onOpen={() => {}}
			/>,
		);
		const a = screen.getByRole("link");
		expect(a.getAttribute("href")).toBe(
			"https://www.japan-guide.com/e/e2172.html",
		);
		expect(a.getAttribute("target")).toBe("_blank");
		expect(a.getAttribute("rel")).toContain("noopener");
	});

	it("COLLAB-R3-05: a suggested link and the attachment it became render one tile, no duplicate keys", () => {
		const id = "00000000-0000-7000-8000-00000000a0a1";
		const target = { kind: "node" as const, nodeId: N.tokyo as string };
		const url = "https://www.japan-guide.com/e/e3007.html";
		// The accept's media refetch landed; the proposals refetch hasn't yet.
		const qc = new QueryClient({
			defaultOptions: { queries: { retry: false } },
		});
		qc.setQueryData(tripKeys.media(DEMO_TRIP_ID), [
			{ ...base, id, target, kind: "link", visibility: "everyone", url },
		]);
		const open = {
			id: "00000000-0000-7000-8000-00000000b0b1",
			tripId: DEMO_TRIP_ID,
			op: "attachment.link",
			payload: { tripId: DEMO_TRIP_ID, id, target, url },
			entityKind: "att",
			entityId: id,
			createdIds: [id],
			requires: [],
			summary: "added a link to Tokyo",
			message: null,
			status: "open",
			author: {
				userId: null,
				memberId: null,
				name: "Maya Chen",
				color: 3,
				isGuest: false,
			},
			fields: [],
			before: {},
			reviewedBy: null,
			reviewedAt: null,
			reviewNote: null,
			lastError: null,
			dependants: [],
			createdAt: base.createdAt,
			updatedAt: base.updatedAt,
		} satisfies ProposalDto;
		const errors = vi.spyOn(console, "error").mockImplementation(() => {});
		try {
			renderWithWorkspace(<MediaTab />, {
				splat: "japan/tokyo",
				queryClient: qc,
				proposals: [open],
			});
			const tiles = screen
				.getAllByTestId(TESTID.galleryItem)
				.filter((t) => t.getAttribute("data-id") === id);
			expect(tiles).toHaveLength(1);
			expect(errors.mock.calls.flat().join(" ")).not.toMatch(/same key/);
		} finally {
			errors.mockRestore();
		}
	});
});
