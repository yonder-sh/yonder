/**
 * The rate card's media for an area (the gap QA found on Shinjuku): an area
 * or city with no photos or videos of its own shows those of the places
 * inside it, each labelled with its place, one per place first; with nothing
 * at all the card says so and offers "Add photo" and "Add link" right there.
 */
import { QueryClient } from "@tanstack/react-query";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import {
	afterAll,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from "vitest";
import type { MediaDto } from "@/features/media/media.functions";
import { indexGraph } from "@/lib/engine/graph-index";
import type { GraphNode, TripGraph } from "@/lib/engine/types";
import { demoGraph, N } from "@/lib/fixtures/demo";
import { tripKeys } from "@/lib/query/keys";
import { renderWithWorkspace } from "@/test/render-workspace";
import { INSIDE_MAX, mediaInside, PlaceMedia } from "../rate/PlaceMedia";
import { PLACES_TESTID } from "../testids";

const calls = vi.hoisted(() => ({ addLink: [] as unknown[] }));
vi.mock("@/features/media/media.functions", async (orig) => ({
	...(await orig<typeof import("@/features/media/media.functions")>()),
	addLink: async (opts: { data: Record<string, unknown> }) => {
		calls.addLink.push(opts.data);
		return {
			id: "00000000-0000-7000-8000-00000000ab01",
			target: opts.data.target,
			kind: "link",
			status: "ready",
			url: opts.data.url,
			position: "z",
		};
	},
}));
vi.mock("../ui/mini-map", () => ({
	MiniMap: ({ label }: { label: string }) => (
		<div role="img" aria-label={label} />
	),
}));

beforeEach(() => {
	calls.addLink.length = 0;
});

// The YouTube slide is a real iframe: happy-dom would load it from the
// network, so every request from this file gets an empty page instead.
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

// Shibuya (an area) holds Hands, Loft and Shibuya Sky; Harajuku's Meiji
// Jingu is outside it. Loft is dropped in one test.
const graph: TripGraph = {
	...demoGraph,
	nodes: demoGraph.nodes.map((n) =>
		n.id === N.shibuya
			? { ...n, description: "Scramble crossing, shops and the Sky deck." }
			: n,
	),
};
const node = (id: string | undefined) =>
	graph.nodes.find((n) => n.id === id) as GraphNode;

let seq = 0;
function media(nodeId: string, p: Partial<MediaDto> = {}): MediaDto {
	seq += 1;
	return {
		id: `00000000-0000-7000-8000-${String(seq).padStart(12, "0")}`,
		target: { kind: "node", nodeId },
		kind: "photo",
		status: "ready",
		visibility: "everyone",
		mime: "image/jpeg",
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
		position: `a${String(seq).padStart(4, "0")}`,
		createdAt: "2026-09-01T00:00:00.000Z",
		updatedAt: "2026-09-01T00:00:00.000Z",
		description: null,
		author: null,
		sizeBytes: null,
		hasThumb: true,
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
	} as MediaDto;
}

const hands1 = media(N.hands as string);
const loft1 = media(N.loft as string);
const loft2 = media(N.loft as string);
const skyVideo = media(N.shibuyaSky as string, {
	kind: "link",
	url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
	title: "Shibuya Sky at dusk",
});
const list: MediaDto[] = [
	hands1,
	loft1,
	loft2,
	skyVideo,
	// Not visual, failed, or outside Shibuya: never borrowed.
	media(N.hands as string, { kind: "pdf", title: "Floor map" }),
	media(N.hands as string, {
		kind: "link",
		url: "https://www.japan-guide.com/e/e3007.html",
	}),
	media(N.shibuyaSky as string, { status: "failed" }),
	media(N.meijiJingu as string),
];

function renderFor(n: GraphNode, items: MediaDto[], g: TripGraph = graph) {
	const queryClient = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	queryClient.setQueryData(tripKeys.media(g.trip.id), items);
	return renderWithWorkspace(<PlaceMedia node={n} />, {
		graph: g,
		queryClient,
	});
}

describe("mediaInside", () => {
	it("one per place in outline order, then the next round; visual only", () => {
		const ix = indexGraph(graph);
		const got = mediaInside(list, ix, N.shibuya as string);
		expect(got.map(({ m, from }) => [m.id, from.name])).toEqual([
			[hands1.id, "Hands Shibuya"],
			[loft1.id, "Shibuya Loft"],
			[skyVideo.id, "Shibuya Sky"],
			[loft2.id, "Shibuya Loft"],
		]);
		// The node's own media isn't "inside" it.
		expect(mediaInside(list, ix, N.hands as string)).toEqual([]);
	});

	it("skips places dropped below the node, and stops at INSIDE_MAX", () => {
		const dropped: TripGraph = {
			...graph,
			nodes: graph.nodes.map((n) =>
				n.id === N.loft ? { ...n, status: "dropped" } : n,
			),
		};
		const ix = indexGraph(dropped);
		expect(
			mediaInside(list, ix, N.shibuya as string).map(({ from }) => from.name),
		).toEqual(["Hands Shibuya", "Shibuya Sky"]);
		const many = Array.from({ length: INSIDE_MAX + 5 }, () =>
			media(N.hands as string),
		);
		expect(
			mediaInside(many, indexGraph(graph), N.tokyo as string),
		).toHaveLength(INSIDE_MAX);
	});
});

describe("PlaceMedia for an area", () => {
	it("with none of its own, shows its places' photos, each labelled", () => {
		renderFor(node(N.shibuya), list);
		const box = screen.getByTestId(PLACES_TESTID.rateMedia);
		// The first slide is Hands' photo, labelled with its place.
		expect(
			within(box).getByTestId(PLACES_TESTID.rateMediaFrom),
		).toHaveTextContent("Hands Shibuya");
		const thumbs = within(box).getAllByRole("button", { name: /^Show / });
		expect(thumbs.map((t) => t.getAttribute("aria-label"))).toEqual([
			"Show photo of Hands Shibuya",
			"Show photo of Shibuya Loft",
			"Show youtube video of Shibuya Sky",
			"Show photo of Shibuya Loft",
		]);
		fireEvent.click(thumbs[2] as HTMLElement);
		expect(
			within(box).getByTestId(PLACES_TESTID.rateMediaFrom),
		).toHaveTextContent("Shibuya Sky");
		expect(box).toHaveTextContent("Photos from places in Shibuya.");
		// Its own guide links stay its own (Hands' link isn't borrowed).
		expect(within(box).queryByTestId(PLACES_TESTID.rateLinks)).toBeNull();
		// A way to add its own.
		expect(within(box).getByTestId(PLACES_TESTID.rateAddPhoto)).toBeEnabled();
	});

	it("its own photo wins over its places'", () => {
		const own = media(N.shibuya as string);
		renderFor(node(N.shibuya), [...list, own]);
		const box = screen.getByTestId(PLACES_TESTID.rateMedia);
		expect(within(box).queryByTestId(PLACES_TESTID.rateMediaFrom)).toBeNull();
		expect(within(box).queryAllByRole("button", { name: /^Show / })).toEqual(
			[],
		);
		expect(box).not.toHaveTextContent("Photos from places in");
	});
});

describe("nothing to show", () => {
	it("a located place with no media: the map, a clear line, Add photo / Add link", async () => {
		renderFor(node(N.sensoji), []);
		const box = screen.getByTestId(PLACES_TESTID.rateMedia);
		expect(
			within(box).getByRole("img", { name: "Map of Senso-ji" }),
		).toBeTruthy();
		expect(
			within(box).getByTestId(PLACES_TESTID.rateMediaEmpty),
		).toHaveTextContent("No photos or videos of Senso-ji yet.");
		// Add link: a small form, sent to WP-Media for this place.
		fireEvent.click(within(box).getByTestId(PLACES_TESTID.rateAddLink));
		const input = await screen.findByTestId(PLACES_TESTID.rateAddLinkInput);
		fireEvent.change(input, { target: { value: "not a link" } });
		fireEvent.click(screen.getByRole("button", { name: "Add" }));
		expect(await screen.findByRole("alert")).toHaveTextContent(
			"That isn't a web link",
		);
		fireEvent.change(input, {
			target: { value: "https://www.japan-guide.com/e/e3001.html" },
		});
		fireEvent.click(screen.getByRole("button", { name: "Add" }));
		await waitFor(() =>
			expect(calls.addLink).toEqual([
				expect.objectContaining({
					target: { kind: "node", nodeId: N.sensoji },
					url: "https://www.japan-guide.com/e/e3001.html",
				}),
			]),
		);
		// Add photo opens the file picker (images and videos).
		const file = screen.getByTestId(PLACES_TESTID.rateAddPhotoInput);
		expect(file.getAttribute("accept")).toMatch(/image\/jpeg/);
		expect(file.getAttribute("accept")).toMatch(/video\/mp4/);
	});

	it("no media and no location: the hero itself is the empty state", () => {
		const nowhere: TripGraph = {
			...graph,
			nodes: graph.nodes.map((n) =>
				n.id === N.itoya ? { ...n, lat: null, lng: null } : n,
			),
		};
		renderFor(
			nowhere.nodes.find((n) => n.id === N.itoya) as GraphNode,
			[],
			nowhere,
		);
		const empty = screen.getByTestId(PLACES_TESTID.rateMediaEmpty);
		expect(empty).toHaveTextContent(
			"No photos, videos or location for Itoya Ginza yet.",
		);
		expect(within(empty).getByTestId(PLACES_TESTID.rateAddPhoto)).toBeTruthy();
		expect(within(empty).getByTestId(PLACES_TESTID.rateAddLink)).toBeTruthy();
	});
});
