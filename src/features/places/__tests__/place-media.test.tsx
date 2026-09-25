/**
 * The rate card's media (ADDENDUM §10: "each rating card shows ALL the
 * place's media"): photos, videos and TikTok / Reels / YouTube embeds in the
 * viewer (embeds built from allowlisted hosts and parsed ids only, in a
 * sandboxed frame), guide links with their previews, and PDFs, from the
 * place and its visits. No server: the media list is seeded in the cache.
 */
import { QueryClient } from "@tanstack/react-query";
import { fireEvent, screen, within } from "@testing-library/react";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { MediaDto } from "@/features/media/media.functions";
import { MEDIA_TESTID } from "@/features/media/testids";
import { indexGraph } from "@/lib/engine/graph-index";
import type { GraphNode } from "@/lib/engine/types";
import { demoGraph, N } from "@/lib/fixtures/demo";
import { tripKeys } from "@/lib/query/keys";
import { renderWithWorkspace } from "@/test/render-workspace";
import { embedOf, mediaOfNode, PlaceMedia } from "../rate/PlaceMedia";
import { PLACES_TESTID } from "../testids";

const sensoji = demoGraph.nodes.find((n) => n.id === N.sensoji) as GraphNode;
const visit = demoGraph.items.find((i) => i.nodeId === N.sensoji);

// Embeds are real iframes: happy-dom would load them from the network, so
// every request from this file gets an empty page instead.
type HappyDom = {
	settings: {
		fetch: {
			interceptor: {
				beforeAsyncRequest?: (ctx: {
					window: { Response: typeof Response };
				}) => Promise<Response>;
			} | null;
		};
	};
};
const happyDOM = (window as unknown as { happyDOM?: HappyDom }).happyDOM;
beforeAll(() => {
	if (happyDOM)
		happyDOM.settings.fetch.interceptor = {
			beforeAsyncRequest: async ({ window: w }) =>
				new w.Response("<!doctype html><title>embed</title>", {
					status: 200,
					headers: { "content-type": "text/html" },
				}),
		};
});
afterAll(() => {
	if (happyDOM) happyDOM.settings.fetch.interceptor = null;
});

let seq = 0;
function media(p: Partial<MediaDto>): MediaDto {
	seq += 1;
	return {
		id: `00000000-0000-7000-8000-${String(seq).padStart(12, "0")}`,
		target: { kind: "node", nodeId: sensoji.id },
		kind: "photo",
		status: "ready",
		visibility: "everyone",
		mime: null,
		width: null,
		height: null,
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
		hasThumb: false,
		hasImage: false,
		hasFavicon: false,
		aspect: null,
		pages: 0,
		pageCount: null,
		igType: null,
		license: null,
		licenseUrl: null,
		sourceUrl: null,
		fetch: null,
		mine: false,
		...p,
	};
}

const list: MediaDto[] = [
	media({ kind: "photo", caption: "The gate" }),
	media({
		kind: "embed",
		provider: "youtube",
		embedId: "dQw4w9WgXcQ",
		url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
		title: "Senso-ji at dawn",
	}),
	media({
		kind: "link",
		url: "https://www.tiktok.com/@tokyo/video/7212345678901234567",
		title: "Nakamise snacks",
	}),
	media({
		kind: "link",
		url: "https://www.japan-guide.com/e/e3001.html",
		title: "Sensoji Temple",
		siteName: "japan-guide.com",
	}),
	media({ kind: "pdf", title: "Asakusa walking map" }),
	// A video from the visit (item target) counts too.
	...(visit
		? [media({ kind: "video", target: { kind: "item", itemId: visit.id } })]
		: []),
	// Failed uploads and other places' media don't.
	media({ kind: "photo", status: "failed" }),
	media({ kind: "photo", target: { kind: "node", nodeId: N.itoya as string } }),
];

function renderMedia() {
	const queryClient = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	queryClient.setQueryData(tripKeys.media(demoGraph.trip.id), list);
	return renderWithWorkspace(<PlaceMedia node={sensoji} />, { queryClient });
}

describe("embedOf", () => {
	it("builds embeds for the allowlisted providers from parsed ids", () => {
		expect(
			embedOf({
				provider: null,
				embedId: null,
				url: "https://youtu.be/dQw4w9WgXcQ",
			}),
		).toMatchObject({
			provider: "youtube",
			src: "https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ?playsinline=1&rel=0",
			aspect: "16/9",
		});
		expect(
			embedOf({
				provider: null,
				embedId: null,
				url: "https://www.youtube.com/shorts/dQw4w9WgXcQ",
			})?.aspect,
		).toBe("9/16");
		expect(
			embedOf({
				provider: null,
				embedId: null,
				url: "https://www.instagram.com/reel/C0abcDEF123/",
			}),
		).toMatchObject({
			provider: "instagram",
			src: "https://www.instagram.com/reel/C0abcDEF123/embed/",
		});
	});
	it("never passes a stored id or URL through unchecked", () => {
		expect(
			embedOf({
				provider: "youtube",
				embedId: '"><script>',
				url: "https://example.com/",
			}),
		).toBeNull();
		expect(
			embedOf({ provider: "tiktok", embedId: "../../x", url: null }),
		).toBeNull();
		expect(
			embedOf({ provider: null, embedId: null, url: "https://vimeo.com/1" }),
		).toBeNull();
	});
});

describe("PlaceMedia", () => {
	it("collects the place's and its visits' media, never failed ones", () => {
		const ix = indexGraph(demoGraph);
		const mine = mediaOfNode(list, ix, sensoji.id);
		expect(mine.map((m) => m.kind)).toEqual(
			visit
				? ["photo", "embed", "link", "link", "pdf", "video"]
				: ["photo", "embed", "link", "link", "pdf"],
		);
	});

	it("shows photos, videos and embeds as slides, and links and PDFs below", () => {
		renderMedia();
		const box = screen.getByTestId(PLACES_TESTID.rateMedia);
		// The first slide (the photo) is up; a thumbnail per slide.
		const thumbs = within(box).getAllByRole("button", { name: /^Show / });
		expect(thumbs).toHaveLength(visit ? 4 : 3);
		// The YouTube embed plays inline in a sandboxed, allowlisted frame.
		fireEvent.click(
			within(box).getByRole("button", { name: "Show youtube video" }),
		);
		const frame = box.querySelector("iframe");
		expect(frame?.getAttribute("src")).toMatch(
			/^https:\/\/www\.youtube-nocookie\.com\/embed\/dQw4w9WgXcQ\?/,
		);
		expect(frame?.getAttribute("sandbox")).toContain("allow-scripts");
		expect(frame?.getAttribute("sandbox")).not.toContain(
			"allow-top-navigation",
		);
		// A TikTok link is an embed too.
		fireEvent.click(
			within(box).getByRole("button", { name: "Show tiktok video" }),
		);
		expect(box.querySelector("iframe")?.getAttribute("src")).toMatch(
			/^https:\/\/www\.tiktok\.com\/player\/v1\/7212345678901234567\?/,
		);
		// Guide links with their preview, and PDFs that open.
		const links = within(box).getByTestId(PLACES_TESTID.rateLinks);
		const guide = within(links).getByText("Sensoji Temple").closest("a");
		expect(guide).toHaveAttribute(
			"href",
			"https://www.japan-guide.com/e/e3001.html",
		);
		expect(guide).toHaveAttribute("rel", expect.stringContaining("noopener"));
		expect(guide).toHaveTextContent("japan-guide.com");
		// PLAN-I2-17: a PDF opens WP-Media's in-app viewer (Download, "Hide
		// from guests"), not a new browser tab.
		const pdf = within(links).getByTestId(PLACES_TESTID.ratePdf);
		expect(pdf).toHaveTextContent("Asakusa walking map");
		expect(pdf.closest("a")).toBeNull();
		fireEvent.click(pdf);
		const viewer = screen.getByTestId(MEDIA_TESTID.pdfViewer);
		expect(viewer).toHaveTextContent("Asakusa walking map");
		expect(
			within(viewer).getByTestId(MEDIA_TESTID.pdfDownload),
		).toHaveAttribute(
			"href",
			expect.stringMatching(/^\/media\/[\w-]+\/original\?download=1$/),
		);
		fireEvent.click(within(viewer).getByRole("button", { name: "Close" }));
		expect(screen.queryByTestId(MEDIA_TESTID.pdfViewer)).toBeNull();
	});

	it("with nothing visual, the hero is the location", () => {
		const queryClient = new QueryClient();
		queryClient.setQueryData(tripKeys.media(demoGraph.trip.id), []);
		renderWithWorkspace(<PlaceMedia node={sensoji} />, { queryClient });
		const box = screen.getByTestId(PLACES_TESTID.rateMedia);
		expect(
			within(box).queryAllByRole("button", { name: /^Show / }),
		).toHaveLength(0);
		expect(within(box).queryByTestId(PLACES_TESTID.rateLinks)).toBeNull();
	});
});
