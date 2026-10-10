/**
 * Saved's grid tiles (badge, line, placeholder) and its feed: Save moves on
 * to the next link after a beat and says where it went, Delete moves on too,
 * Later leaves, the end card goes back to the grid.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
	fireEvent,
	render,
	screen,
	waitFor,
	within,
} from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SavedFeed } from "../SavedFeed";
import { SavedTile } from "../SavedTile";
import { SAVED_TESTID as T } from "../testids";
import type { SavedLink } from "../types";

const calls = vi.hoisted(() => ({
	added: [] as unknown[],
	deleted: [] as unknown[],
	toasts: [] as string[],
}));

vi.mock("../saved.functions", () => ({
	markSavedAdded: async (o: { data: unknown }) => {
		calls.added.push(o.data);
		return { ok: true };
	},
	deleteSavedLink: async (o: { data: unknown }) => {
		calls.deleted.push(o.data);
		return { ok: true };
	},
}));
vi.mock("sonner", () => ({
	toast: Object.assign((t: string) => calls.toasts.push(t), {
		success: (t: string) => calls.toasts.push(t),
		error: (t: string) => calls.toasts.push(t),
	}),
}));
// The save controls have their own tests (the share page): here, one button.
vi.mock("@/features/home/Saver", () => ({
	Saver: (p: {
		entry: { id: string };
		actions?: ReactNode;
		onSaved?: (r: unknown) => void;
	}) => (
		<div>
			{p.actions}
			<button
				type="button"
				onClick={() =>
					p.onSaved?.({
						tripId: "11111111-1111-4111-8111-111111111111",
						tripName: "Japan 2027",
						slug: "japan",
						nodeId: "22222222-2222-4222-8222-222222222222",
						text: "Saved to Kyoto ideas",
					})
				}
			>
				Save {p.entry.id}
			</button>
		</div>
	),
}));

afterEach(() => {
	vi.restoreAllMocks();
	calls.added.length = 0;
	calls.deleted.length = 0;
	calls.toasts.length = 0;
});

const link = (id: string, over: Partial<SavedLink> = {}): SavedLink => ({
	id,
	url: `https://www.timeout.com/tokyo/${id}`,
	text: null,
	title: null,
	provider: null,
	embedId: null,
	igType: null,
	status: "ready",
	previewTitle: `Page ${id}`,
	description: null,
	author: null,
	siteName: "Time Out",
	image: null,
	imageW: null,
	imageH: null,
	thumbhash: null,
	favicon: null,
	place: null,
	nearTrips: [],
	createdAt: Date.now(),
	...over,
});

describe("a Saved tile", () => {
	it("shows the picture, the source badge and one line", () => {
		render(
			<SavedTile
				link={link("a", {
					url: "https://www.tiktok.com/@a/video/7300000000000000001",
					provider: "tiktok",
					previewTitle: "Golden Gai at night",
					image: "/api/saved/a/image?v=1",
				})}
				onOpen={() => {}}
			/>,
		);
		expect(screen.getByTestId(T.tileBadge)).toHaveTextContent("TikTok");
		expect(screen.getByTestId(T.tileLine)).toHaveTextContent(
			"Golden Gai at night",
		);
		expect(document.querySelector("img")?.getAttribute("src")).toBe(
			"/api/saved/a/image?v=1",
		);
		expect(document.querySelector("[data-placeholder]")).toBeNull();
	});

	it("without a picture: a placeholder by kind (a Maps place)", () => {
		const open = vi.fn();
		render(
			<SavedTile
				link={link("m", {
					url: "https://maps.app.goo.gl/abc",
					siteName: "Google Maps",
					previewTitle: null,
					place: { name: "Itoya Ginza", lat: 35.67, lng: 139.77 },
				})}
				onOpen={open}
			/>,
		);
		expect(screen.getByTestId(T.tileBadge)).toHaveTextContent("Maps");
		expect(screen.getByTestId(T.tileLine)).toHaveTextContent("Itoya Ginza");
		expect(
			document
				.querySelector("[data-placeholder]")
				?.getAttribute("data-placeholder"),
		).toBe("maps");
		fireEvent.click(screen.getByTestId(T.tile));
		expect(open).toHaveBeenCalled();
	});
});

function feed(
	links: SavedLink[],
	opts: { open?: string; fromShare?: boolean } = {},
) {
	const scrolled: string[] = [];
	vi.spyOn(Element.prototype, "scrollIntoView").mockImplementation(function (
		this: Element,
	) {
		scrolled.push(this.getAttribute("data-key") ?? "");
	});
	const onClose = vi.fn();
	render(
		<QueryClientProvider client={new QueryClient()}>
			<SavedFeed
				links={links}
				open={opts.open ?? null}
				fromShare={opts.fromShare}
				onClose={onClose}
			/>
		</QueryClientProvider>,
	);
	return { scrolled, onClose };
}

describe("the Saved feed", () => {
	it("starts at the tile you opened", () => {
		feed([link("a"), link("b"), link("c")], { open: "b" });
		const cards = screen.getAllByTestId(T.card);
		expect(cards.map((c) => c.getAttribute("data-saved"))).toEqual([
			"b",
			"a",
			"c",
		]);
	});

	it("Save marks it added, says where, and moves on to the next", async () => {
		const { scrolled } = feed([link("a"), link("b")]);
		const [first] = screen.getAllByTestId(T.card) as [HTMLElement];
		fireEvent.click(within(first).getByRole("button", { name: "Save a" }));
		await waitFor(() => expect(first).toHaveAttribute("data-done", "saved"));
		expect(calls.toasts).toContain("Saved to Kyoto ideas · Japan 2027");
		await waitFor(() =>
			expect(calls.added).toEqual([
				{
					id: "a",
					tripId: "11111111-1111-4111-8111-111111111111",
					nodeId: "22222222-2222-4222-8222-222222222222",
				},
			]),
		);
		await waitFor(() => expect(scrolled).toContain("b"), { timeout: 3000 });
	});

	it("Delete removes it from Saved and moves on", async () => {
		const { scrolled } = feed([link("a"), link("b")]);
		const [first] = screen.getAllByTestId(T.card) as [HTMLElement];
		fireEvent.click(within(first).getByTestId(T.delete));
		await waitFor(() => expect(first).toHaveAttribute("data-done", "deleted"));
		expect(calls.deleted).toEqual([{ id: "a" }]);
		await waitFor(() => expect(scrolled).toContain("b"), { timeout: 3000 });
	});

	it("Later (from a share) leaves it in Saved and goes back", () => {
		const { onClose } = feed([link("a")], { fromShare: true });
		fireEvent.click(screen.getByTestId(T.later));
		expect(onClose).toHaveBeenCalled();
		expect(calls.added).toEqual([]);
		expect(calls.deleted).toEqual([]);
	});

	it("no Later when you opened it from the grid; the end card goes back", () => {
		const { onClose } = feed([link("a")]);
		expect(screen.queryByTestId(T.later)).toBeNull();
		expect(screen.getByTestId(T.end)).toHaveTextContent(
			"That's everything you saved",
		);
		fireEvent.click(screen.getByTestId(T.endBack));
		expect(onClose).toHaveBeenCalled();
	});
});
