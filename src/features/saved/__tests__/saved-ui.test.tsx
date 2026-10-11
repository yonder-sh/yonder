/**
 * Saved's grid tiles (badge, line, placeholder, a photo share, "In Japan
 * 2027"), the grid by country and city, "Hide ones in trips", and Select
 * (Delete N, Undo); its feed: a share asks "Where is this?" first (a chip
 * files it and leaves, Skip, Add to a trip now), Save moves on to the next
 * link after a beat and says where it went, Delete moves on too (Undo puts
 * it back), Later leaves, the end card goes back to the grid, a share's
 * photos are slides. Add to trip: Select's and a city's, only trips I can
 * edit, Undo.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
	within,
} from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SavedFeed } from "../SavedFeed";
import { SavedGrid } from "../SavedPage";
import { SavedTile } from "../SavedTile";
import { SAVED_TESTID as T } from "../testids";
import type { SavedFile, SavedLink } from "../types";

const calls = vi.hoisted(() => ({
	added: [] as unknown[],
	deleted: [] as unknown[],
	restored: [] as unknown[],
	placed: [] as unknown[],
	bulk: [] as unknown[],
	undone: [] as unknown[],
	toasts: [] as string[],
	undo: null as null | (() => void),
}));

vi.mock("../saved.functions", () => ({
	markSavedAdded: async (o: { data: unknown }) => {
		calls.added.push(o.data);
		return { ok: true };
	},
	deleteSavedLinks: async (o: { data: { ids: string[] } }) => {
		calls.deleted.push(o.data);
		return o.data;
	},
	restoreSavedLinks: async (o: { data: { ids: string[] } }) => {
		calls.restored.push(o.data);
		return o.data;
	},
	attachSavedFiles: async () => ({ count: 0 }),
	listSavedLinks: async () => [],
	searchSavedPlaces: async () => [],
	addSavedToTrip: async (o: { data: { ids: string[] } }) => {
		calls.bulk.push(o.data);
		return {
			added: o.data.ids.map((id) => ({ savedId: id, nodeId: `n-${id}` })),
			already: 0,
			made: [],
			cities: [],
		};
	},
	undoSavedToTrip: async (o: { data: unknown }) => {
		calls.undone.push(o.data);
		return { ok: true };
	},
	setSavedPlace: async (o: { data: { ids: string[] } }) => {
		calls.placed.push(o.data);
		return o.data;
	},
}));
vi.mock("@/features/home/queries", () => ({
	myTripsQuery: () => ({
		queryKey: ["me", "trips"],
		queryFn: async () => [
			{
				id: "trip-jp",
				name: "Japan 2027",
				role: "owner",
				viaLink: false,
				countryCodes: ["JP"],
				cities: [{ name: "Kyoto", countryCode: "JP", lat: 35, lng: 135.7 }],
			},
			{
				id: "trip-view",
				name: "Maya's trip",
				role: "viewer",
				viaLink: false,
				countryCodes: [],
			},
			{
				id: "trip-suggest",
				name: "Audrey's trip",
				role: "suggester",
				viaLink: false,
				countryCodes: [],
			},
		],
	}),
}));
vi.mock("sonner", () => ({
	toast: Object.assign(
		(t: string, o?: { action?: { onClick: () => void } }) => {
			calls.toasts.push(t);
			calls.undo = o?.action?.onClick ?? null;
		},
		{
			success: (t: string, o?: { action?: { onClick: () => void } }) => {
				calls.toasts.push(t);
				if (o?.action) calls.undo = o.action.onClick;
			},
			error: (t: string) => calls.toasts.push(t),
		},
	),
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
	calls.restored.length = 0;
	calls.placed.length = 0;
	calls.bulk.length = 0;
	calls.undone.length = 0;
	calls.toasts.length = 0;
	calls.undo = null;
});

const photo = (id: string, over: Partial<SavedFile> = {}): SavedFile => ({
	id,
	kind: "photo",
	mime: "image/jpeg",
	status: "ready",
	width: 800,
	height: 1200,
	durationSec: null,
	thumbhash: null,
	hasThumb: true,
	hasPoster: false,
	...over,
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
	files: [],
	photoSpot: null,
	where: null,
	trips: [],
	fromAttachmentId: null,
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

describe("a shared photos tile", () => {
	it("shows the first photo, a Photos badge and how many", () => {
		render(
			<SavedTile
				link={link("s", {
					url: null,
					previewTitle: null,
					siteName: null,
					files: [photo("f1", { thumbhash: null }), photo("f2")],
				})}
				onOpen={() => {}}
			/>,
		);
		expect(screen.getByTestId(T.tileBadge)).toHaveTextContent("Photos");
		expect(screen.getByTestId(T.tileLine)).toHaveTextContent("2 photos");
		expect(document.querySelector("img")?.getAttribute("src")).toBe(
			"/api/saved-file/f1/thumb",
		);
	});

	it("a video: a Video badge and a play mark", () => {
		render(
			<SavedTile
				link={link("v", {
					url: null,
					previewTitle: null,
					siteName: null,
					text: "Sunset at Fushimi",
					files: [photo("f1", { kind: "video", mime: "video/mp4" })],
				})}
				onOpen={() => {}}
			/>,
		);
		expect(screen.getByTestId(T.tileBadge)).toHaveTextContent("Video");
		expect(screen.getByTestId(T.tileLine)).toHaveTextContent(
			"Sunset at Fushimi",
		);
	});
});

describe("Select in the grid", () => {
	it("ticks tiles, deletes them in one call, and Undo brings them all back", async () => {
		const open = vi.fn();
		render(
			<QueryClientProvider client={new QueryClient()}>
				<SavedGrid
					links={[link("a"), link("b"), link("c")]}
					pending={false}
					onOpen={open}
					empty={null}
				/>
			</QueryClientProvider>,
		);
		fireEvent.click(screen.getByTestId(T.select));
		const tiles = screen.getAllByTestId(T.tile);
		fireEvent.click(tiles[0] as HTMLElement);
		fireEvent.click(tiles[2] as HTMLElement);
		fireEvent.click(tiles[2] as HTMLElement);
		fireEvent.click(tiles[2] as HTMLElement);
		expect(open).not.toHaveBeenCalled();
		expect(screen.getByTestId(T.selectCount)).toHaveTextContent("2 selected");
		expect(tiles[0]).toHaveAttribute("aria-pressed", "true");
		expect(tiles[1]).toHaveAttribute("aria-pressed", "false");
		fireEvent.click(screen.getByTestId(T.deleteSelected));
		await waitFor(() => expect(calls.deleted).toEqual([{ ids: ["a", "c"] }]));
		expect(calls.toasts).toContain("Deleted 2 from Saved");
		await waitFor(() => expect(screen.queryByTestId(T.selectCount)).toBeNull());
		calls.undo?.();
		await waitFor(() => expect(calls.restored).toEqual([{ ids: ["a", "c"] }]));
		// Not selecting: a tap opens.
		fireEvent.click(screen.getAllByTestId(T.tile)[1] as HTMLElement);
		expect(open).toHaveBeenCalledWith("b");
	});
});

describe("Add to trip", () => {
	it("Select adds the ticked ones to a trip I can edit, with Undo", async () => {
		render(
			<QueryClientProvider client={new QueryClient()}>
				<SavedGrid
					links={[link("a"), link("b"), link("c")]}
					pending={false}
					onOpen={() => {}}
					empty={null}
				/>
			</QueryClientProvider>,
		);
		fireEvent.click(screen.getByTestId(T.select));
		const tiles = screen.getAllByTestId(T.tile);
		fireEvent.click(tiles[0] as HTMLElement);
		fireEvent.click(tiles[2] as HTMLElement);
		fireEvent.click(screen.getByTestId(T.addSelected));
		const dialog = await screen.findByTestId(T.addDialog);
		expect(dialog).toHaveTextContent("Add 2 items to a trip");
		// Viewers and suggesters can't add many.
		const trips = await within(dialog).findAllByTestId(T.addTrip);
		expect(trips.map((t) => t.textContent)).toEqual(["Japan 2027"]);
		fireEvent.click(trips[0] as HTMLElement);
		await waitFor(() =>
			expect(calls.bulk).toEqual([
				{ tripId: "trip-jp", ids: ["a", "c"], places: false },
			]),
		);
		await waitFor(() =>
			expect(calls.toasts).toContain("Added 2 items to Japan 2027"),
		);
		await waitFor(() => expect(screen.queryByTestId(T.selectCount)).toBeNull());
		calls.undo?.();
		await waitFor(() =>
			expect(calls.undone).toEqual([
				{
					tripId: "trip-jp",
					added: [
						{ savedId: "a", nodeId: "n-a" },
						{ savedId: "c", nodeId: "n-c" },
					],
					made: [],
				},
			]),
		);
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
			"c",
			"a",
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
		expect(calls.deleted).toEqual([{ ids: ["a"] }]);
		expect(calls.toasts).toContain("Deleted from Saved");
		await waitFor(() => expect(scrolled).toContain("b"), { timeout: 3000 });
		// Undo puts it back.
		calls.undo?.();
		await waitFor(() => expect(first).not.toHaveAttribute("data-done"));
		expect(calls.restored).toEqual([{ ids: ["a"] }]);
	});

	it("a share's photos are slides you step through", () => {
		feed([
			link("p", {
				url: null,
				previewTitle: null,
				siteName: null,
				files: [photo("f1"), photo("f2")],
			}),
		]);
		const slides = screen.getByTestId(T.slides);
		expect(within(slides).getAllByTestId(T.slide)).toHaveLength(2);
		expect(
			within(slides).getByRole("img", { name: "Photo 1 of 2" }),
		).toBeTruthy();
		expect(
			slides.querySelector("img[src='/api/saved-file/f1/display']"),
		).not.toBeNull();
		fireEvent.click(within(slides).getByRole("button", { name: "Next photo" }));
		expect(slides).toHaveAttribute("data-slide", "1");
		expect(
			within(slides).getByRole("img", { name: "Photo 2 of 2" }),
		).toBeTruthy();
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

describe("the grid by place", () => {
	const where = (countryCode: string, city: string | null) => ({
		countryCode,
		city,
		cityKey: city?.toLowerCase() ?? null,
		lat: null,
		lng: null,
		at: 1,
	});
	it("groups by country and city; ones in trips say so, and can be hidden", () => {
		const hide = vi.fn();
		const links = [
			link("k", { where: where("JP", "Kyoto") }),
			link("t", {
				where: where("JP", "Kyoto"),
				trips: [{ id: "1", name: "Japan 2027", slug: "j" }],
			}),
			link("u"),
		];
		const { rerender } = render(
			<QueryClientProvider client={new QueryClient()}>
				<SavedGrid
					links={links}
					pending={false}
					onOpen={() => {}}
					empty={null}
					onHideInTrips={hide}
				/>
			</QueryClientProvider>,
		);
		const sections = screen.getAllByTestId(T.section);
		expect(sections.map((x) => x.getAttribute("aria-label"))).toEqual([
			"Japan",
			"Unsorted",
		]);
		expect(
			within(sections[0] as HTMLElement).getByTestId(T.sectionCity),
		).toHaveTextContent("Kyoto · 2");
		expect(screen.getAllByTestId(T.tileTrips)).toHaveLength(1);
		expect(screen.getByTestId(T.tileTrips)).toHaveTextContent("In Japan 2027");
		fireEvent.click(screen.getByTestId(T.hideInTrips));
		expect(hide).toHaveBeenCalledWith(true);
		rerender(
			<QueryClientProvider client={new QueryClient()}>
				<SavedGrid
					links={links}
					pending={false}
					onOpen={() => {}}
					empty={null}
					hideInTrips
					onHideInTrips={hide}
				/>
			</QueryClientProvider>,
		);
		expect(
			screen.getAllByTestId(T.tile).map((x) => x.getAttribute("data-saved")),
		).toEqual(["k", "u"]);
	});
});

describe("a share asks where it is first", () => {
	it("a chip files it there and goes back", async () => {
		const { onClose } = feed([link("a")], { open: "a", fromShare: true });
		const ask = screen.getByTestId(T.whereAsk);
		expect(ask).toHaveTextContent("Where is this?");
		const chip = await within(ask).findByRole("button", {
			name: "Kyoto, Japan",
		});
		fireEvent.click(chip);
		expect(onClose).toHaveBeenCalled();
		expect(calls.toasts).toContain("Saved in Kyoto, Japan");
		await waitFor(() =>
			expect(calls.placed).toEqual([
				{
					ids: ["a"],
					where: {
						countryCode: "JP",
						city: { name: "Kyoto", lat: 35, lng: 135.7 },
					},
				},
			]),
		);
	});

	it("a Maps link's real place is preselected", () => {
		feed(
			[
				link("m", {
					url: "https://maps.app.goo.gl/x",
					place: {
						name: "Kissa Mado",
						lat: 35,
						lng: 135.77,
						countryCode: "JP",
						city: "Kyoto",
						exact: true,
					},
				}),
			],
			{ open: "m", fromShare: true },
		);
		expect(
			within(screen.getByTestId(T.whereAsk)).getByRole("button", {
				name: "Kyoto, Japan",
				pressed: true,
			}),
		).toBeTruthy();
	});

	it("Skip leaves it Unsorted; Add to a trip now shows the save controls", () => {
		const first = feed([link("a")], { open: "a", fromShare: true });
		fireEvent.click(screen.getByTestId(T.whereSkip));
		expect(first.onClose).toHaveBeenCalled();
		expect(calls.placed).toEqual([]);
		cleanup();
		feed([link("b")], { open: "b", fromShare: true });
		fireEvent.click(screen.getByTestId(T.whereAddNow));
		expect(screen.queryByTestId(T.whereAsk)).toBeNull();
		expect(screen.getByRole("button", { name: "Save b" })).toBeTruthy();
	});

	it("opened from the grid: no question; its place shows with Change", () => {
		feed([
			link("a", {
				where: {
					countryCode: "JP",
					city: "Kyoto",
					cityKey: "kyoto",
					lat: null,
					lng: null,
					at: 1,
				},
			}),
		]);
		expect(screen.queryByTestId(T.whereAsk)).toBeNull();
		expect(screen.getAllByTestId(T.whereRow)[0]).toHaveTextContent(
			"Kyoto, Japan",
		);
	});
});
