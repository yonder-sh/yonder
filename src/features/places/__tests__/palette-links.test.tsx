/**
 * ⌘K with a pasted link (D10 "Add · paste a link: new place, or add to
 * one"): a reel or a guide is never a place name ("Add 'https://…' as a new
 * country"). The palette previews it and asks "Add it to a place, or save a
 * new one?": the places its caption names, the open place, a few nearby, a
 * search over every place, and New place. Enter adds it to the highlighted
 * place, ⌘Enter makes a new place. The preview can arrive late or fail
 * quietly. Without edit access it still goes to the share page.
 */
import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LinkPeek } from "@/features/media/media.functions";
import { demoGraph, N } from "@/lib/fixtures/demo";
import { useUi } from "@/lib/workspace/ui-store";
import { renderWithWorkspace } from "@/test/render-workspace";
import { AddPlaceDialog } from "../AddPlaceDialog";
import { PLACES_TESTID } from "../testids";

const calls = vi.hoisted(() => ({
	links: [] as { target: { nodeId: string }; url: string }[],
	paths: [] as { chain: unknown[]; ids: string[] }[],
	navigate: [] as unknown[],
	peeks: [] as string[],
	peek: (() => new Promise(() => {})) as () => Promise<unknown>,
	path: (async () => ({ ok: true })) as () => Promise<unknown>,
	toasts: [] as string[],
}));

vi.mock("../places.functions", () => ({
	searchPlaces: async () => ({ provider: "photon", results: [] }),
	reverseGeocode: async () => {
		throw new Error("no geocoding here");
	},
	getPlacePreview: async () => {
		throw new Error("no preview here");
	},
	resolveSharedLink: async () => ({ preview: null }),
}));
vi.mock("@/features/media/media.functions", async (orig) => ({
	...(await orig<typeof import("@/features/media/media.functions")>()),
	addLink: async (opts: { data: (typeof calls.links)[number] }) => {
		calls.links.push(opts.data);
		return { ok: true, value: null };
	},
	peekLink: async (opts: { data: { url: string } }) => {
		calls.peeks.push(opts.data.url);
		return calls.peek();
	},
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
vi.mock("@tanstack/react-router", async (orig) => ({
	...(await orig<typeof import("@tanstack/react-router")>()),
	useNavigate: () => (to: unknown) => {
		calls.navigate.push(to);
	},
}));
vi.mock("../ui/mini-map", () => ({ MiniMap: () => null }));
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
const CAPTION: LinkPeek = {
	title: "Sunset at Shibuya Sky, then Meiji Jingu 🌇 #tokyo",
	description: null,
	siteName: "TikTok",
};

beforeEach(() => {
	calls.links.length = 0;
	calls.paths.length = 0;
	calls.navigate.length = 0;
	calls.peeks.length = 0;
	calls.peek = () => new Promise(() => {});
	calls.path = async () => ({ ok: true });
	calls.toasts.length = 0;
});
afterEach(() => {
	act(() => useUi.getState().openAddPlace(null));
});

const input = () => screen.getByTestId(PLACES_TESTID.paletteInput);
const paste = (value: string) =>
	fireEvent.change(input(), { target: { value } });
/** The link's places, top to bottom. */
const rows = () =>
	[...document.querySelectorAll("[data-node]")].map((el) =>
		el.getAttribute("data-node"),
	);
const highlighted = () =>
	screen
		.getAllByRole("option")
		.find((o) => o.getAttribute("aria-selected") === "true");

function open(opts: Parameters<typeof renderWithWorkspace>[1] = {}) {
	useUi.getState().openAddPlace({ mode: "search" });
	return renderWithWorkspace(<AddPlaceDialog />, opts);
}

describe("a pasted link in ⌘K (D10)", () => {
	it("asks where it goes, and never offers it as a new country", async () => {
		open();
		paste(REEL);
		await screen.findByText("Add it to a place, or save a new one?");
		expect(screen.queryByText(/as a new/)).toBeNull();
		expect(screen.queryByTestId(PLACES_TESTID.saveLink)).toBeNull();
		expect(screen.queryByTestId(PLACES_TESTID.dropPin)).toBeNull();
		const preview = screen.getByTestId(PLACES_TESTID.linkPreview);
		expect(preview).toHaveTextContent("TikTok video");
		expect(preview).toHaveTextContent("tiktok.com");
		expect(screen.getByTestId(PLACES_TESTID.linkNewPlace)).toHaveTextContent(
			`Filed under ${demoGraph.trip.name}`,
		);
		expect(screen.getByTestId(PLACES_TESTID.providerFooter)).toHaveTextContent(
			"Works with Instagram, TikTok, YouTube, Maps and any web page",
		);
		// Nothing open or in view: New place is the first choice.
		await waitFor(() => expect(highlighted()).toHaveTextContent("New place"));
		expect(rows()).toEqual([]);
	});

	it("adds it to the open place in one step", async () => {
		open({ search: { sel: `n.${N.shibuya}` } as never });
		paste(REEL);
		const add = await screen.findByTestId(PLACES_TESTID.addLinkTo);
		expect(add).toHaveTextContent("Shibuya");
		expect(add).toHaveTextContent("Selected");
		fireEvent.click(add);
		await waitFor(() =>
			expect(calls.links).toEqual([
				{
					tripId: demoGraph.trip.id,
					target: { kind: "node", nodeId: N.shibuya },
					url: REEL,
				},
			]),
		);
	});

	it("puts the caption's places first, then the open place, then nearby; Enter adds it to the first", async () => {
		calls.peek = async () => CAPTION;
		open({ mode: "live", search: { sel: `n.${N.loft}` } as never });
		paste(REEL);
		// Before the preview: the open place and what's near it.
		await waitFor(() =>
			expect(rows()).toEqual([N.loft, N.hands, N.shibuyaSky, N.meijiJingu]),
		);
		const preview = screen.getByTestId(PLACES_TESTID.linkPreview);
		await waitFor(() =>
			expect(preview).toHaveTextContent("Sunset at Shibuya Sky"),
		);
		expect(preview).toHaveTextContent("Mentions Shibuya Sky, Meiji Jingu");
		expect(rows()).toEqual([N.shibuyaSky, N.meijiJingu, N.loft, N.hands]);
		expect(calls.peeks).toEqual([REEL]);
		await waitFor(() => expect(highlighted()).toHaveTextContent("Shibuya Sky"));
		expect(highlighted()).toHaveTextContent("Named in the caption");
		expect(screen.getByTestId(PLACES_TESTID.providerFooter)).toHaveTextContent(
			"Add to Shibuya Sky",
		);
		fireEvent.keyDown(input(), { key: "Enter" });
		await waitFor(() =>
			expect(calls.links).toMatchObject([
				{ target: { nodeId: N.shibuyaSky }, url: REEL },
			]),
		);
	});

	it("works before the preview arrives", async () => {
		open({ mode: "live", search: { sel: `n.${N.loft}` } as never });
		paste(REEL);
		await waitFor(() =>
			expect(highlighted()).toHaveTextContent("Shibuya Loft"),
		);
		const preview = screen.getByTestId(PLACES_TESTID.linkPreview);
		expect(preview).not.toHaveTextContent("tiktok.com");
		expect(preview).not.toHaveTextContent("Mentions");
		fireEvent.keyDown(input(), { key: "Enter" });
		await waitFor(() =>
			expect(calls.links).toMatchObject([{ target: { nodeId: N.loft } }]),
		);
	});

	it("stays quiet when the preview fails", async () => {
		calls.peek = async () => {
			throw new Error("upstream 403");
		};
		open({ mode: "live", search: { sel: `n.${N.loft}` } as never });
		paste(REEL);
		const preview = screen.getByTestId(PLACES_TESTID.linkPreview);
		await waitFor(() => expect(preview).toHaveTextContent("tiktok.com"));
		expect(screen.queryByText(/403/)).toBeNull();
		expect(screen.queryByRole("alert")).toBeNull();
		expect(rows()[0]).toBe(N.loft);
	});

	it("⌘Enter saves it as a new place, named from its title and filed under the scope", async () => {
		calls.peek = async () => ({
			title: "The fluffiest café in Harajuku 🐶 #moffu",
			description: null,
			siteName: "TikTok",
		});
		open({ mode: "live", splat: "japan/tokyo/shibuya" });
		paste(REEL);
		const row = screen.getByTestId(PLACES_TESTID.linkNewPlace);
		await waitFor(() =>
			expect(row).toHaveTextContent("The fluffiest café in Harajuku"),
		);
		expect(row).toHaveTextContent("Filed under Tokyo › Shibuya");
		fireEvent.keyDown(input(), { key: "Enter", metaKey: true });
		await waitFor(() => expect(calls.links).toHaveLength(1));
		expect(calls.paths).toEqual([
			{
				chain: [
					{ id: N.japan },
					{ id: N.tokyo },
					{ id: N.shibuya },
					{
						type: "place",
						name: "The fluffiest café in Harajuku",
						category: "other",
					},
				],
				ids: [expect.any(String)],
			},
		]);
		expect(calls.links[0]).toMatchObject({
			target: { kind: "node", nodeId: calls.paths[0]?.ids[0] },
			url: REEL,
		});
		expect(calls.toasts).toEqual(["Saved to Shibuya ideas"]);
	});

	it("a suggested new place still takes the link, and isn't called saved", async () => {
		calls.path = async () => ({
			proposed: { id: "p1", summary: "Add TikTok video" },
		});
		open({ splat: "japan/tokyo/shibuya" });
		paste(REEL);
		fireEvent.keyDown(input(), { key: "Enter", ctrlKey: true });
		await waitFor(() => expect(calls.links).toHaveLength(1));
		expect(calls.links[0]).toMatchObject({
			target: { nodeId: calls.paths[0]?.ids[0] },
		});
		expect(calls.toasts).toEqual(["Suggested — Add TikTok video"]);
	});

	it("files New place somewhere else when asked", async () => {
		open({ splat: "japan/tokyo/shibuya" });
		paste(REEL);
		fireEvent.click(await screen.findByTestId(PLACES_TESTID.linkFiling));
		fireEvent.click(await screen.findByRole("option", { name: "Harajuku" }));
		await waitFor(() =>
			expect(screen.getByTestId(PLACES_TESTID.linkNewPlace)).toHaveTextContent(
				"Filed under Tokyo › Harajuku",
			),
		);
		expect(calls.links).toEqual([]);
	});

	it("searches every place in the trip, and Enter adds it to the first match", async () => {
		open({ search: { sel: `n.${N.loft}` } as never });
		paste(REEL);
		const find = await screen.findByTestId(PLACES_TESTID.linkSearch);
		fireEvent.change(find, { target: { value: "zzz" } });
		await screen.findByText("No places in this trip match.");
		expect(rows()).toEqual([]);
		fireEvent.change(find, { target: { value: "senso" } });
		await waitFor(() => expect(rows()).toEqual([N.sensoji]));
		await waitFor(() => expect(highlighted()).toHaveTextContent("Senso-ji"));
		fireEvent.keyDown(find, { key: "Enter" });
		await waitFor(() =>
			expect(calls.links).toMatchObject([{ target: { nodeId: N.sensoji } }]),
		);
	});

	it("starts a new link without the last search", async () => {
		open({ search: { sel: `n.${N.loft}` } as never });
		paste(REEL);
		const find = await screen.findByTestId(PLACES_TESTID.linkSearch);
		fireEvent.change(find, { target: { value: "senso" } });
		await waitFor(() => expect(rows()).toEqual([N.sensoji]));
		paste("https://www.japan-guide.com/e/e3007.html");
		await waitFor(() =>
			expect(screen.getByTestId(PLACES_TESTID.linkSearch)).toHaveValue(""),
		);
		expect(rows()[0]).toBe(N.loft);
	});

	it("goes to the share page when it can't be added here", async () => {
		open({ connection: "offline" });
		paste(REEL);
		const save = await screen.findByTestId(PLACES_TESTID.saveLink);
		expect(screen.queryByTestId(PLACES_TESTID.linkPreview)).toBeNull();
		fireEvent.click(save);
		expect(calls.navigate).toEqual([{ to: "/share", search: { url: REEL } }]);
	});
});
