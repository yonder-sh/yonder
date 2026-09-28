/**
 * ⌘K's New place… for a pasted link (D10): the palette's own search, its box
 * empty, the link waiting ("Adding the link: …", Don't add, Esc back to the
 * link's choices). The place picked or made there takes the link; opened
 * from a day, it goes on that day too. In suggest mode every create path
 * says "Suggested — …" and offers no Show.
 */
import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { demo, demoGraph, N } from "@/lib/fixtures/demo";
import { type AddPlaceRequest, useUi } from "@/lib/workspace/ui-store";
import { renderWithWorkspace } from "@/test/render-workspace";
import { AddPlaceDialog } from "../AddPlaceDialog";
import type { PlacePreview } from "../lib/providers";
import { PLACES_TESTID } from "../testids";

const calls = vi.hoisted(() => ({
	links: [] as { target: { nodeId: string }; url: string }[],
	paths: [] as { chain: unknown[]; ids: string[] }[],
	items: [] as { dayId: string | null; nodeId: string }[],
	path: (async () => ({ ok: true })) as () => Promise<unknown>,
	toasts: [] as string[],
}));

vi.mock("../places.functions", () => ({
	searchPlaces: async () => ({
		provider: "photon",
		results: [
			{ ref: "N9", title: "Moffu", subtitle: "Harajuku, Tokyo", types: [] },
		],
	}),
	getPlacePreview: async (): Promise<PlacePreview> => ({
		provider: "photon",
		ref: "N9",
		osmRef: "N9",
		name: "Moffu",
		category: "cafe",
		address: "Harajuku, Tokyo, Japan",
		lat: 35.671,
		lng: 139.705,
		countryCode: "JP",
		photos: [],
		level: "place",
		filing: {
			existing: [N.japan, N.tokyo, N.harajuku] as string[],
			create: [],
		},
	}),
	reverseGeocode: async () => {
		throw new Error("no geocoding here");
	},
	resolveSharedLink: async () => ({ preview: null }),
}));
vi.mock("@/features/media/media.functions", async (orig) => ({
	...(await orig<typeof import("@/features/media/media.functions")>()),
	addLink: async (opts: { data: (typeof calls.links)[number] }) => {
		calls.links.push(opts.data);
		return { ok: true, value: null };
	},
	peekLink: async () => ({
		title: "The fluffiest café in Harajuku 🐶 #moffu",
		description: null,
		siteName: "TikTok",
	}),
}));
vi.mock("@/functions/nodes.functions", () => ({
	createNodePath: async (opts: { data: (typeof calls.paths)[number] }) => {
		calls.paths.push({ chain: opts.data.chain, ids: opts.data.ids });
		return calls.path();
	},
	updateNode: async () => ({ ok: true }),
	setNodePriority: async () => ({ ok: true }),
	moveNode: async () => ({ ok: true }),
}));
vi.mock("@/functions/items.functions", async (orig) => ({
	...(await orig<typeof import("@/functions/items.functions")>()),
	createItem: async (opts: { data: (typeof calls.items)[number] }) => {
		calls.items.push({ dayId: opts.data.dayId, nodeId: opts.data.nodeId });
		return { ok: true };
	},
}));
vi.mock("@tanstack/react-router", async (orig) => ({
	...(await orig<typeof import("@tanstack/react-router")>()),
	useNavigate: () => () => undefined,
}));
vi.mock("../ui/mini-map", () => ({ MiniMap: () => null }));
vi.mock("../ui/results-map", () => ({ ResultsMap: () => null }));
vi.mock("sonner", async (orig) => {
	const say = (m: string) => {
		calls.toasts.push(m);
	};
	return {
		...(await orig<typeof import("sonner")>()),
		toast: Object.assign(say, { error: say, success: say }),
	};
});

const REEL = "https://www.tiktok.com/@cafes/video/7430912345678901234";
const SUGGESTED = async () => ({
	proposed: { id: "p1", summary: "Add Moffu" },
});

beforeEach(() => {
	calls.links.length = 0;
	calls.paths.length = 0;
	calls.items.length = 0;
	calls.path = async () => ({ ok: true });
	calls.toasts.length = 0;
});
afterEach(() => {
	act(() => useUi.getState().openAddPlace(null));
});

const input = () => screen.getByTestId(PLACES_TESTID.paletteInput);
const type = (value: string) =>
	fireEvent.change(input(), { target: { value } });
const newPlace = () =>
	fireEvent.keyDown(input(), { key: "Enter", metaKey: true });
const addOption = (name: RegExp) => screen.findByRole("option", { name });
const isOpen = () => useUi.getState().addPlace !== null;

function open(
	opts: Parameters<typeof renderWithWorkspace>[1] = {},
	request: AddPlaceRequest = { mode: "search" },
) {
	useUi.getState().openAddPlace(request);
	return renderWithWorkspace(<AddPlaceDialog />, opts);
}

/** Paste the reel, then New place… (⌘Enter). */
async function toSearch() {
	type(REEL);
	await screen.findByTestId(PLACES_TESTID.linkNewPlace);
	newPlace();
	await screen.findByTestId(PLACES_TESTID.linkPending);
}

describe("New place… from a pasted link (D10)", () => {
	it("opens the search with an empty box, the link waiting", async () => {
		open({ mode: "live", splat: "japan/tokyo/shibuya" });
		await toSearch();
		expect(input()).toHaveValue("");
		await waitFor(() =>
			expect(screen.getByTestId(PLACES_TESTID.linkPending)).toHaveTextContent(
				"Adding the link: The fluffiest café in Harajuku",
			),
		);
		expect(
			screen.getByText(
				"Search for the place in the link, or type its name to add it.",
			),
		).toBeInTheDocument();
		expect(
			screen.queryByText("Add it to a place, or save a new one?"),
		).toBeNull();
		expect(calls.paths).toEqual([]);
		expect(calls.links).toEqual([]);
	});

	it("Esc goes back to the link's choices; Don't add drops the link", async () => {
		open({ splat: "japan/tokyo/shibuya" });
		await toSearch();
		// Without a preview: the kind of link.
		expect(screen.getByTestId(PLACES_TESTID.linkPending)).toHaveTextContent(
			"Adding the link: TikTok video",
		);
		type("Mof");
		fireEvent.keyDown(input(), { key: "Escape" });
		await waitFor(() => expect(input()).toHaveValue(REEL));
		expect(isOpen()).toBe(true);
		expect(
			screen.getByText("Add it to a place, or save a new one?"),
		).toBeInTheDocument();
		expect(screen.queryByTestId(PLACES_TESTID.linkPending)).toBeNull();

		newPlace();
		fireEvent.click(await screen.findByTestId(PLACES_TESTID.linkPendingDrop));
		expect(screen.queryByTestId(PLACES_TESTID.linkPending)).toBeNull();
		type("Moffu");
		fireEvent.click(await addOption(/Add “Moffu” as a new place in Shibuya/));
		await waitFor(() => expect(calls.toasts).toEqual(["Added Moffu"]));
		expect(calls.links).toEqual([]);
	});

	it("a search result saved to Ideas takes the link", async () => {
		open({ mode: "live", splat: "japan/tokyo/shibuya" });
		await toSearch();
		type("Moffu");
		fireEvent.click(await screen.findByTestId(PLACES_TESTID.paletteResult));
		fireEvent.click(await screen.findByTestId(PLACES_TESTID.saveToIdeas));
		await waitFor(() => expect(calls.links).toHaveLength(1));
		const id = calls.paths[0]?.ids.at(-1);
		expect(calls.paths[0]?.chain).toEqual([
			{ id: N.japan },
			{ id: N.tokyo },
			{ id: N.harajuku },
			expect.objectContaining({ type: "place", name: "Moffu" }),
		]);
		expect(calls.links).toEqual([
			{
				tripId: demoGraph.trip.id,
				target: { kind: "node", nodeId: id },
				url: REEL,
			},
		]);
		expect(calls.toasts).toEqual(["Saved to Harajuku ideas"]);
		expect(isOpen()).toBe(false);
	});

	it("a new place typed there files beside the open place, with the link", async () => {
		// Itoya Ginza is open: filed under Tokyo, its city, not the Shibuya scope.
		open({
			splat: "japan/tokyo/shibuya",
			search: { sel: `n.${N.itoya}` } as never,
		});
		type(REEL);
		expect(
			await screen.findByTestId(PLACES_TESTID.linkNewPlace),
		).toHaveTextContent("Filed under Japan › Tokyo");
		newPlace();
		type("Moffu");
		fireEvent.click(await addOption(/Add “Moffu” as a new place in Tokyo/));
		await waitFor(() => expect(calls.links).toHaveLength(1));
		expect(calls.paths).toEqual([
			{
				chain: [
					{ id: N.japan },
					{ id: N.tokyo },
					{ type: "place", name: "Moffu", category: "other" },
				],
				ids: [expect.any(String)],
			},
		]);
		expect(calls.links[0]).toMatchObject({
			target: { kind: "node", nodeId: calls.paths[0]?.ids[0] },
			url: REEL,
		});
		expect(calls.toasts).toEqual(["Added Moffu"]);
	});

	it("a place already in the trip takes it", async () => {
		open({ splat: "japan/tokyo/shibuya" });
		await toSearch();
		type("senso");
		fireEvent.click(await screen.findByRole("option", { name: /Senso-ji/ }));
		await waitFor(() =>
			expect(calls.links).toMatchObject([
				{ target: { nodeId: N.sensoji }, url: REEL },
			]),
		);
		expect(calls.paths).toEqual([]);
		await waitFor(() =>
			expect(calls.toasts).toEqual(["Link added to Senso-ji"]),
		);
	});
});

describe("opened from a day", () => {
	const day = { mode: "schedule", dayId: demo.D.d2 } as const;

	it("the chosen place goes on that day too, with the link", async () => {
		open({ search: { sel: `n.${N.loft}` } as never }, day);
		type(REEL);
		fireEvent.click(await screen.findByTestId(PLACES_TESTID.addLinkTo));
		await waitFor(() =>
			expect(calls.items).toEqual([{ dayId: demo.D.d2, nodeId: N.loft }]),
		);
		expect(calls.links).toMatchObject([
			{ target: { nodeId: N.loft }, url: REEL },
		]);
		await waitFor(() =>
			expect(calls.toasts).toEqual([
				"Link added to Shibuya Loft · End of Day 2",
			]),
		);
	});

	it("a new place goes on that day too, with the link", async () => {
		open({ splat: "japan/tokyo/shibuya" }, day);
		await toSearch();
		type("Moffu");
		fireEvent.click(await addOption(/Add “Moffu” as a new place in Shibuya/));
		await waitFor(() => expect(calls.items).toHaveLength(1));
		const id = calls.paths[0]?.ids[0];
		expect(calls.items).toEqual([{ dayId: demo.D.d2, nodeId: id }]);
		expect(calls.links).toMatchObject([{ target: { nodeId: id }, url: REEL }]);
		expect(calls.toasts).toEqual(["Moffu · End of Day 2"]);
	});
});

describe("in suggest mode", () => {
	it("the link's new place is a suggestion that still takes the link", async () => {
		calls.path = SUGGESTED;
		open({ splat: "japan/tokyo/shibuya" });
		await toSearch();
		type("Moffu");
		fireEvent.click(await addOption(/Add “Moffu” as a new place/));
		await waitFor(() => expect(calls.links).toHaveLength(1));
		expect(calls.links[0]).toMatchObject({
			target: { nodeId: calls.paths[0]?.ids[0] },
		});
		expect(calls.toasts).toEqual(["Suggested — Add Moffu"]);
		expect(isOpen()).toBe(false);
	});

	it("“Add … as a new …” says Suggested and offers no Show", async () => {
		calls.path = SUGGESTED;
		open({ splat: "japan/tokyo/shibuya" });
		type("Moffu");
		fireEvent.click(await addOption(/Add “Moffu” as a new place/));
		await waitFor(() => expect(isOpen()).toBe(false));
		expect(calls.toasts).toEqual(["Suggested — Add Moffu"]);
	});

	it("the preview's Save to Ideas says Suggested and offers no Show", async () => {
		calls.path = SUGGESTED;
		open({ mode: "live", splat: "japan/tokyo/shibuya" });
		type("Moffu");
		fireEvent.click(await screen.findByTestId(PLACES_TESTID.paletteResult));
		fireEvent.click(await screen.findByTestId(PLACES_TESTID.saveToIdeas));
		await waitFor(() => expect(isOpen()).toBe(false));
		expect(calls.toasts).toEqual(["Suggested — Add Moffu"]);
	});
});
