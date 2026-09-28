/**
 * The Lists page (One Yonder D12): the four tabs and their counts (a phone's
 * in the titles), Bookings (its groups, a booked stop, a to-do whose stop is
 * booked shown once, a booking's details beside the list, For, Mark booked
 * and Not booked yet with Undo, the booking reference, Add a booking),
 * Packing's two groups and Shopping's Near pill.
 */
import { QueryClient } from "@tanstack/react-query";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MediaDto } from "@/features/media/media.functions";
import type { MoneyDto } from "@/features/money/money.functions";
import type { TripGraph } from "@/lib/engine/types";
import { DEMO_MEMBERS, demo, scenario } from "@/lib/fixtures/demo";
import { tripKeys } from "@/lib/query/keys";
import type { WorkspaceSearch } from "@/lib/workspace/search";
import { renderWithWorkspace } from "@/test/render-workspace";
import type { ListItemDto } from "../lists.functions";

const server = vi.hoisted(() => ({
	calls: [] as [string, unknown][],
	/** What a refetch reads (a create adds to it). */
	items: [] as unknown[],
}));

vi.mock("@/features/lists/lists.functions", () => {
	const fn =
		(name: string, out: unknown = { ok: true }) =>
		async ({ data }: { data: unknown }) => {
			server.calls.push([name, data]);
			return out;
		};
	return {
		listTripListItems: async () => server.items,
		createListItem: async ({ data }: { data: Record<string, unknown> }) => {
			server.calls.push(["create", data]);
			const [first] = server.items as Record<string, unknown>[];
			server.items.push({ ...first, ...data, status: "open" });
			return {};
		},
		updateListItem: fn("update", { updatedAt: new Date().toISOString() }),
		setListItemStatus: fn("status"),
		moveListItem: fn("move"),
		setListItemTargets: fn("targets"),
		setListItemAssignees: fn("assignees"),
		deleteListItem: fn("delete", { deletedAt: new Date().toISOString() }),
		restoreListItem: fn("restore"),
	};
});

vi.mock("@/functions/items.functions", async (importOriginal) => ({
	...(await importOriginal<object>()),
	updateItem: async ({ data }: { data: unknown }) => {
		server.calls.push(["item", data]);
		return { ok: true };
	},
}));

const undo = vi.hoisted(() => ({
	toasts: [] as [string, () => void | Promise<void>][],
}));
vi.mock("@/components/common/undo-toast", () => ({
	undoToast: (label: string, fn: () => void | Promise<void>) => {
		undo.toasts.push([label, fn]);
		return 1;
	},
}));

// A plain field for the TipTap one (Enter submits).
vi.mock("@/features/notes/MentionInput", () => ({
	MentionInput: (p: {
		value: string;
		onChange: (v: string) => void;
		onSubmit?: (v: string) => void;
		ariaLabel?: string;
		placeholder?: string;
		disabled?: boolean;
	}) => (
		<input
			aria-label={p.ariaLabel}
			placeholder={p.placeholder}
			disabled={p.disabled}
			value={p.value}
			onChange={(e) => p.onChange(e.target.value)}
			onKeyDown={(e) => {
				if (e.key === "Enter") p.onSubmit?.(p.value);
			}}
		/>
	),
}));

import { ListsTab } from "../ListsTab";
import { LISTS_TESTID as L } from "../testids";

const I = demo.I as Record<string, string>;
const LEG = demo.L as Record<string, string>;
const TRIP = demo.graph.trip.id;
const NOW = Date.parse("2027-09-01T00:00:00Z");

function row(p: Partial<ListItemDto> & { id: string }): ListItemDto {
	return {
		target: { kind: "trip" },
		list: "todo",
		text: p.id,
		note: null,
		url: null,
		status: "open",
		dueDayId: null,
		dueDate: null,
		dueTime: null,
		dueTz: null,
		dueKind: "due",
		dueRule: null,
		quantity: null,
		priceAmount: null,
		priceCurrency: null,
		position: "a0",
		isPrivate: false,
		assigneeIds: [],
		extraTargetNodeIds: [],
		createdAt: "2027-01-01T00:00:00.000Z",
		updatedAt: "2027-01-01T00:00:00.000Z",
		doneAt: null,
		mine: true,
		bookingRef: null,
		...p,
	};
}

const ID = (n: number) =>
	`00000000-0000-7000-8000-00000000a${String(n).padStart(3, "0")}`;
const TRAIN = ID(1);
const SKY = ID(2);

const items: ListItemDto[] = [
	row({ id: ID(10), text: "Get a Suica card" }),
	// The ryokan: a month before its day, at 10:00 JST; a to-do on the visit.
	row({
		id: TRAIN,
		text: "Fuji Excursion train seats",
		dueKind: "opens",
		target: { kind: "item", itemId: I.dropBags as string },
		dueRule: {
			kind: "months",
			months: 1,
			itemId: I.dropBags as string,
			time: "10:00",
			tz: "Asia/Tokyo",
		},
		url: "https://www.eki-net.com/",
		bookingRef: "E7K2Q9",
		assigneeIds: [DEMO_MEMBERS.dennis],
	}),
	row({
		id: SKY,
		text: "Shibuya Sky sunset slot",
		dueKind: "opens",
		target: { kind: "item", itemId: I.sky as string },
	}),
	row({ id: ID(11), list: "shopping", text: "Petty knife" }),
	row({ id: ID(12), list: "packing", text: "Adapter" }),
	row({
		id: ID(13),
		list: "packing",
		text: "Gift for Audrey",
		isPrivate: true,
	}),
];

// Kiyomizu-dera is booked for its date, with a PDF attached.
const graph: TripGraph = {
	...demo.graph,
	items: demo.graph.items.map((it) =>
		it.id === I.kiyomizu ? { ...it, fixedDate: true } : it,
	),
};

function pdf(itemId: string): MediaDto {
	return {
		id: ID(50),
		target: { kind: "item", itemId },
		kind: "pdf",
		status: "ready",
		visibility: "members",
		mime: "application/pdf",
		width: null,
		height: null,
		durationSec: null,
		thumbhash: null,
		takenAt: null,
		url: null,
		provider: null,
		embedId: null,
		title: "Tickets.pdf",
		siteName: null,
		caption: null,
		position: "a0",
		createdAt: "2027-01-01T00:00:00.000Z",
		updatedAt: "2027-01-01T00:00:00.000Z",
		description: null,
		author: null,
		sizeBytes: 1000,
		hasThumb: false,
		hasImage: false,
		hasFavicon: false,
		aspect: null,
		pages: 0,
		pageCount: 1,
		igType: null,
		license: null,
		licenseUrl: null,
		sourceUrl: null,
		fetch: null,
		mine: true,
	};
}

const money: MoneyDto = {
	...scenario.money,
	expenses: [
		...scenario.money.expenses,
		{
			...(scenario.money.expenses[0] as MoneyDto["expenses"][number]),
			id: ID(60),
			title: "Fuji Excursion seats",
			amountMinor: 8_260,
			currency: "JPY",
			listItemId: TRAIN,
		},
	],
};

function mount(
	search: WorkspaceSearch = {},
	extra: ListItemDto[] = [],
	phone = false,
) {
	const queryClient = new QueryClient({
		defaultOptions: { queries: { retry: false, staleTime: Infinity } },
	});
	server.items = [...items, ...extra];
	queryClient.setQueryData(tripKeys.lists(TRIP), [...items, ...extra]);
	queryClient.setQueryData(tripKeys.media(TRIP), [pdf(I.kiyomizu as string)]);
	queryClient.setQueryData(tripKeys.money(TRIP), money);
	return renderWithWorkspace(<ListsTab phone={phone} />, {
		graph,
		mode: "live",
		queryClient,
		search: { tab: "lists", ...search },
	});
}

beforeEach(() => {
	vi.useFakeTimers({ toFake: ["Date"], now: NOW });
});

afterEach(() => {
	vi.useRealTimers();
	vi.unstubAllGlobals();
	localStorage.clear();
	server.calls = [];
	undo.toasts = [];
});

describe("the Lists page", () => {
	it("four tabs, each with its count; picking one puts it in the URL", async () => {
		const user = userEvent.setup();
		const r = mount();
		const counts = [
			L.kindTodo,
			L.kindBookings,
			L.kindShopping,
			L.kindPacking,
		].map((t) => screen.getByTestId(t).textContent);
		expect(counts).toEqual(["To-dos3", "Bookings2", "Shopping1", "Packing2"]);
		expect(screen.getByTestId("rollup-todo")).toBeInTheDocument();
		await user.click(screen.getByTestId(L.kindPacking));
		expect(r.ws().search.list).toBe("packing");
		expect(screen.getByTestId(L.packing)).toBeInTheDocument();
	});

	it("a phone keeps the four words whole: the counts move to each tab's title", () => {
		mount({}, [], true);
		const tabs = [
			L.kindTodo,
			L.kindBookings,
			L.kindShopping,
			L.kindPacking,
		].map((t) => screen.getByTestId(t));
		expect(tabs.map((t) => t.textContent)).toEqual([
			"To-dos",
			"Bookings",
			"Shopping",
			"Packing",
		]);
		expect(tabs.map((t) => t.getAttribute("title"))).toEqual([
			"To-dos · 3",
			"Bookings · 2",
			"Shopping · 1",
			"Packing · 2",
		]);
	});

	it("wide: Lists heads the page and Add a booking opens Bookings on its add row", async () => {
		vi.stubGlobal(
			"ResizeObserver",
			class {
				constructor(private cb: ResizeObserverCallback) {}
				observe() {
					this.cb(
						[{ contentRect: { width: 1200 } } as ResizeObserverEntry],
						this as unknown as ResizeObserver,
					);
				}
				disconnect() {}
			},
		);
		const user = userEvent.setup();
		const r = mount();
		expect(screen.getByRole("heading", { name: /^Lists/ })).toHaveTextContent(
			"Whole trip · shared with everyone",
		);
		await user.click(screen.getByTestId(L.addBooking));
		expect(r.ws().search.list).toBe("bookings");
		const add = screen.getByRole("textbox", { name: "Add a booking" });
		await user.type(add, "Ghibli Museum tickets{Enter}");
		await waitFor(() =>
			expect(server.calls).toContainEqual([
				"create",
				expect.objectContaining({
					list: "todo",
					dueKind: "opens",
					text: "Ghibli Museum tickets",
					target: { kind: "trip" },
				}),
			]),
		);
		// Its details open beside the list, to say when it opens.
		expect(await screen.findByTestId(L.bookingDetails)).toHaveTextContent(
			"Ghibli Museum tickets",
		);
	});
});

describe("Bookings", () => {
	it("Opening soon, Booked and No date yet; a booked stop says its confirmation and day", () => {
		mount({ list: "bookings" });
		const groups = screen
			.getAllByTestId(L.group)
			.map((g) => g.getAttribute("data-group"));
		expect(groups).toEqual(["book:soon", "book:booked", "book:none"]);
		const rows = screen.getAllByTestId(L.bookingRow);
		const train = rows.find((x) => x.dataset.id === TRAIN) as HTMLElement;
		expect(train).toHaveTextContent(
			"Opens Sun 5 Sep 2027 · 10:00 JST · 1 month before · Day 3",
		);
		expect(within(train).getByTestId(L.bookingChip)).toHaveTextContent(
			"Opens in 4 days",
		);
		const kiyomizu = rows.find((x) => x.dataset.kind === "stop") as HTMLElement;
		expect(kiyomizu).toHaveTextContent("Kiyomizu-dera");
		expect(kiyomizu).toHaveTextContent(
			"Confirmation attached · Wed 6 Oct · Day 4",
		);
		expect(within(kiyomizu).getByTestId(L.bookingChip)).toHaveTextContent(
			"Booked",
		);
	});

	it("a booking's details: what it's for, when it opens, reminders, reference, expense and actions", async () => {
		const user = userEvent.setup();
		mount({ list: "bookings" });
		const train = screen
			.getAllByTestId(L.bookingRow)
			.find((x) => x.dataset.id === TRAIN) as HTMLElement;
		await user.click(within(train).getByTestId(L.bookingOpen));
		const d = await screen.findByTestId(L.bookingDetails);
		expect(d).toHaveTextContent("Booking · assigned to Dennis");
		expect(within(d).getByTestId(L.bookingFor)).toHaveTextContent(
			/Drop bags.*Tue 5 Oct · Day 3/,
		);
		const opens = within(d).getByTestId(L.bookingOpens);
		expect(opens).toHaveTextContent("Opens Sun 5 Sep 2027 · 10:00 JST");
		expect(opens).toHaveTextContent(
			"1 month before · moves with Drop bags if the day changes",
		);
		expect(within(d).getByTestId(L.bookingReminders)).toHaveTextContent(
			"Reminders 1 day before · 15 min before",
		);
		expect(within(d).getByTestId(L.bookingRef)).toHaveValue("E7K2Q9");
		expect(within(d).getByTestId(L.bookingExpense)).toHaveTextContent(
			"¥8,260 · split with Audrey",
		);
		expect(within(d).getByTestId(L.bookingSite)).toHaveAttribute(
			"href",
			"https://www.eki-net.com/",
		);
		expect(within(d).getByTestId(L.bookingEdit)).toBeInTheDocument();
	});

	it("Mark booked ticks the to-do and books its stop for the date", async () => {
		const user = userEvent.setup();
		mount({ list: "bookings" });
		const sky = screen
			.getAllByTestId(L.bookingRow)
			.find((x) => x.dataset.id === SKY) as HTMLElement;
		await user.click(within(sky).getByTestId(L.bookingOpen));
		const d = await screen.findByTestId(L.bookingDetails);
		expect(within(d).getByTestId(L.bookingExpense)).toHaveTextContent(
			"Add expense",
		);
		await user.click(within(d).getByTestId(L.bookingMarkBooked));
		await waitFor(() =>
			expect(server.calls).toContainEqual([
				"status",
				{ id: SKY, status: "done" },
			]),
		);
		await waitFor(() =>
			expect(server.calls).toContainEqual([
				"item",
				{ itemId: I.sky, patch: { fixedDate: true } },
			]),
		);
	});

	it("a suggested booking reads only until it's accepted", async () => {
		const user = userEvent.setup();
		const ghost = {
			...row({ id: ID(20), text: "teamLab tickets", dueKind: "opens" }),
			ghostOf: ID(21),
		};
		mount({ list: "bookings" }, [ghost]);
		const r = screen
			.getAllByTestId(L.bookingRow)
			.find((x) => x.dataset.id === ID(20)) as HTMLElement;
		expect(r).toHaveAttribute("data-ghost");
		expect(within(r).getByTestId(L.bookingCheck)).toBeDisabled();
		await user.click(within(r).getByTestId(L.bookingOpen));
		const d = await screen.findByTestId(L.bookingDetails);
		expect(within(d).getByTestId(L.bookingRef)).toBeDisabled();
		expect(within(d).queryByTestId(L.bookingMarkBooked)).toBeNull();
		expect(within(d).queryByTestId(L.bookingEdit)).toBeNull();
	});

	it("the booking reference saves on Enter", async () => {
		const user = userEvent.setup();
		mount({ list: "bookings" });
		const sky = screen
			.getAllByTestId(L.bookingRow)
			.find((x) => x.dataset.id === SKY) as HTMLElement;
		await user.click(within(sky).getByTestId(L.bookingOpen));
		const ref = within(await screen.findByTestId(L.bookingDetails)).getByTestId(
			L.bookingRef,
		);
		await user.type(ref, "SKY-42{Enter}");
		await waitFor(() =>
			expect(server.calls).toContainEqual([
				"update",
				expect.objectContaining({ id: SKY, patch: { bookingRef: "SKY-42" } }),
			]),
		);
	});

	it("a to-do whose stop is booked shows once, under Booked; unticking clears the stop, with Undo", async () => {
		const tickets = row({
			id: ID(30),
			text: "Kiyomizu night tickets",
			dueKind: "opens",
			dueDate: "2027-09-20",
			target: { kind: "item", itemId: I.kiyomizu as string },
		});
		mount({ list: "bookings" }, [tickets]);
		const booked = screen
			.getAllByTestId(L.bookingRow)
			.filter((x) => x.dataset.group === "booked");
		expect(booked.map((x) => x.dataset.id)).toEqual([ID(30)]);
		const one = booked[0] as HTMLElement;
		expect(one).toHaveTextContent("Confirmation attached · Wed 6 Oct · Day 4");
		expect(within(one).getByTestId(L.bookingChip)).toHaveTextContent("Booked");
		const check = within(one).getByTestId(L.bookingCheck);
		expect(check).toBeChecked();
		// Bookings counts only the windows still to book.
		expect(screen.getByTestId(L.kindBookings).textContent).toBe("Bookings2");
		fireEvent.click(check);
		await waitFor(() =>
			expect(server.calls).toContainEqual([
				"item",
				{ itemId: I.kiyomizu, patch: { fixedDate: false } },
			]),
		);
		// The to-do was open: only its stop changes.
		expect(server.calls.some(([name]) => name === "status")).toBe(false);
		await waitFor(() =>
			expect(undo.toasts.map(([label]) => label)).toEqual([
				"Kiyomizu night tickets · not booked yet",
			]),
		);
		await undo.toasts[0]?.[1]();
		await waitFor(() =>
			expect(server.calls).toContainEqual([
				"item",
				{ itemId: I.kiyomizu, patch: { fixedDate: true } },
			]),
		);
	});

	it("Not booked yet reopens the to-do and clears its stop; Undo restores both", async () => {
		const user = userEvent.setup();
		const ticked = row({
			id: ID(31),
			text: "Kiyomizu night tickets",
			dueKind: "opens",
			status: "done",
			target: { kind: "item", itemId: I.kiyomizu as string },
		});
		mount({ list: "bookings" }, [ticked]);
		const r = screen
			.getAllByTestId(L.bookingRow)
			.find((x) => x.dataset.id === ID(31)) as HTMLElement;
		await user.click(within(r).getByTestId(L.bookingOpen));
		const d = await screen.findByTestId(L.bookingDetails);
		const button = within(d).getByTestId(L.bookingMarkBooked);
		expect(button).toHaveTextContent("Not booked yet");
		await user.click(button);
		await waitFor(() =>
			expect(server.calls).toEqual(
				expect.arrayContaining([
					["status", { id: ID(31), status: "open" }],
					["item", { itemId: I.kiyomizu, patch: { fixedDate: false } }],
				]),
			),
		);
		await waitFor(() => expect(undo.toasts).toHaveLength(1));
		server.calls = [];
		await undo.toasts[0]?.[1]();
		await waitFor(() =>
			expect(server.calls).toEqual(
				expect.arrayContaining([
					["status", { id: ID(31), status: "done" }],
					["item", { itemId: I.kiyomizu, patch: { fixedDate: true } }],
				]),
			),
		);
	});

	it("unticking a booked booking in To-dos clears its stop too; a plain to-do reopens silently", async () => {
		const user = userEvent.setup();
		const ticked = row({
			id: ID(33),
			text: "Kiyomizu night tickets",
			dueKind: "opens",
			status: "done",
			target: { kind: "item", itemId: I.kiyomizu as string },
		});
		const plain = row({ id: ID(34), text: "Buy a SIM", status: "done" });
		mount({ list: "todo" }, [ticked, plain]);
		const untick = async (name: string) => {
			for (const f of screen.queryAllByTestId(L.doneFold))
				if (f.getAttribute("aria-expanded") !== "true") await user.click(f);
			fireEvent.click(await screen.findByRole("checkbox", { name }));
		};
		await untick("Done: Buy a SIM");
		await waitFor(() =>
			expect(server.calls).toContainEqual([
				"status",
				{ id: ID(34), status: "open" },
			]),
		);
		expect(undo.toasts).toEqual([]);
		await untick("Done: Kiyomizu night tickets");
		await waitFor(() =>
			expect(server.calls).toEqual(
				expect.arrayContaining([
					["status", { id: ID(33), status: "open" }],
					["item", { itemId: I.kiyomizu, patch: { fixedDate: false } }],
				]),
			),
		);
		await waitFor(() =>
			expect(undo.toasts.map(([label]) => label)).toEqual([
				"Kiyomizu night tickets · not booked yet",
			]),
		);
	});

	it("a booked stop on its own offers Not booked yet", async () => {
		const user = userEvent.setup();
		mount({ list: "bookings" });
		const stop = screen
			.getAllByTestId(L.bookingRow)
			.find((x) => x.dataset.kind === "stop") as HTMLElement;
		await user.click(within(stop).getByTestId(L.bookingOpen));
		const d = await screen.findByTestId(L.bookingDetails);
		expect(within(d).queryByTestId(L.bookingEdit)).toBeNull();
		await user.click(within(d).getByTestId(L.bookingMarkBooked));
		await waitFor(() =>
			expect(server.calls).toContainEqual([
				"item",
				{ itemId: I.kiyomizu, patch: { fixedDate: false } },
			]),
		);
		await waitFor(() =>
			expect(undo.toasts.map(([label]) => label)).toEqual([
				"Kiyomizu-dera · not booked yet",
			]),
		);
	});

	it("For links an unlinked booking to a stop or a travel leg", async () => {
		const user = userEvent.setup();
		const ghibli = row({
			id: ID(32),
			text: "Ghibli Museum tickets",
			dueKind: "opens",
		});
		mount({ list: "bookings" }, [ghibli]);
		const r = screen
			.getAllByTestId(L.bookingRow)
			.find((x) => x.dataset.id === ID(32)) as HTMLElement;
		await user.click(within(r).getByTestId(L.bookingOpen));
		const d = await screen.findByTestId(L.bookingDetails);
		const forSection = within(d).getByTestId(L.bookingFor);
		expect(forSection).toHaveTextContent("Not linked to a stop yet.");
		const pick = within(forSection).getByTestId(L.bookingForPick);
		expect(pick).toHaveTextContent("Choose");
		await user.click(pick);
		const picker = await screen.findByTestId(L.bookingForPicker);
		// Day by day: the stops, the train from Itoya and the flight (never a walk).
		const legs = within(picker)
			.getAllByRole("option")
			.map((o) => o.textContent ?? "")
			.filter((t) => t.includes("→"));
		expect(legs).toEqual([
			"Transit · Itoya Ginza → Drop bags",
			"Flight · KE 724 KIX → ICN",
		]);
		await user.click(
			within(picker).getByRole("option", { name: /Itoya Ginza → Drop bags/ }),
		);
		await waitFor(() =>
			expect(server.calls).toContainEqual([
				"move",
				{ id: ID(32), target: { kind: "leg", legId: LEG.fuji } },
			]),
		);
	});

	it("wide: the details sit beside the list in their own scroll", async () => {
		vi.stubGlobal(
			"ResizeObserver",
			class {
				constructor(private cb: ResizeObserverCallback) {}
				observe() {
					this.cb(
						[{ contentRect: { width: 1200 } } as ResizeObserverEntry],
						this as unknown as ResizeObserver,
					);
				}
				disconnect() {}
			},
		);
		const user = userEvent.setup();
		mount({ list: "bookings" });
		const sky = screen
			.getAllByTestId(L.bookingRow)
			.find((x) => x.dataset.id === SKY) as HTMLElement;
		await user.click(within(sky).getByTestId(L.bookingOpen));
		const aside = await screen.findByTestId(L.bookingAside);
		expect(aside).toHaveClass("sticky", "overflow-y-auto");
		expect(within(aside).getByTestId(L.bookingMarkBooked)).toBeInTheDocument();
	});

	it("a to-do whose stop is booked carries the stop's expense", async () => {
		const user = userEvent.setup();
		const tickets = row({
			id: ID(35),
			text: "Kiyomizu night tickets",
			dueKind: "opens",
			target: { kind: "item", itemId: I.kiyomizu as string },
		});
		mount({ list: "bookings" }, [tickets]);
		const r = screen
			.getAllByTestId(L.bookingRow)
			.find((x) => x.dataset.id === ID(35)) as HTMLElement;
		await user.click(within(r).getByTestId(L.bookingOpen));
		const d = await screen.findByTestId(L.bookingDetails);
		expect(within(d).getByTestId(L.bookingExpense)).toHaveTextContent("¥1,000");
		expect(within(d).getByTestId(L.bookingMarkBooked)).toHaveTextContent(
			"Not booked yet",
		);
	});
});

describe("Packing", () => {
	it("For everyone and Just mine, each with its own add row", async () => {
		const user = userEvent.setup();
		mount({ list: "packing" });
		const groups = screen.getAllByTestId(L.packingGroup);
		expect(groups.map((g) => g.dataset.group)).toEqual(["everyone", "mine"]);
		expect(groups[0]).toHaveTextContent("Adapter");
		expect(groups[0]).not.toHaveTextContent("Gift for Audrey");
		expect(groups[1]).toHaveTextContent("Gift for Audrey");
		// Simple rows: no date chip.
		expect(
			within(groups[0] as HTMLElement).queryByTestId(L.dueChip),
		).toBeNull();
		const mine = within(groups[1] as HTMLElement).getByRole("textbox", {
			name: "Add to Just mine",
		});
		await user.type(mine, "Earplugs{Enter}");
		await waitFor(() =>
			expect(server.calls).toContainEqual([
				"create",
				expect.objectContaining({
					list: "packing",
					text: "Earplugs",
					isPrivate: true,
				}),
			]),
		);
		fireEvent.click(
			within(groups[0] as HTMLElement).getByRole("checkbox", {
				name: "Packed: Adapter",
			}),
		);
		await waitFor(() =>
			expect(server.calls).toContainEqual([
				"status",
				{ id: ID(12), status: "done" },
			]),
		);
	});
});

describe("Shopping", () => {
	it("Near Shibuya is the kit's filter pill and narrows to shops in the area", async () => {
		const user = userEvent.setup();
		const hands = demo.N.hands as string;
		mount({ list: "shopping", sel: `n.${hands}` }, [
			row({
				id: ID(14),
				list: "shopping",
				text: "Travel scissors",
				target: { kind: "node", nodeId: hands },
			}),
		]);
		const near = screen.getByTestId(L.near);
		expect(near).toHaveTextContent("Near Shibuya");
		expect(near).toHaveAttribute("data-slot", "filter-pill");
		expect(near).toHaveAttribute("aria-pressed", "false");
		const board = screen.getByTestId("rollup-shopping");
		expect(board).toHaveTextContent("Petty knife");
		await user.click(near);
		expect(near).toHaveAttribute("aria-pressed", "true");
		expect(board).toHaveTextContent("Travel scissors");
		expect(board).not.toHaveTextContent("Petty knife");
		await user.click(near);
		expect(near).toHaveAttribute("aria-pressed", "false");
		expect(board).toHaveTextContent("Petty knife");
	});
});
