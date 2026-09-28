/**
 * Today on the road (One Yonder phase 5, boards P15–P18), on Tue 5 Oct in
 * Shinjuku at an `?asOf` local time: running late (a risk and its fixes),
 * running early (Dinner, with no place, Next whenever you like; free time
 * and ideas), the first stop, the end of the day, a day without stops, the
 * driver's address, and read-only for viewers.
 */
import { fireEvent, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const calls = vi.hoisted(() => ({
	done: [] as Record<string, unknown>[],
	move: [] as Record<string, unknown>[],
	update: [] as Record<string, unknown>[],
	create: [] as Record<string, unknown>[],
	toasts: [] as { label: string; undo: () => unknown }[],
}));

vi.mock("@/components/common/undo-toast", () => ({
	undoToast: (label: string, undo: () => unknown) => {
		calls.toasts.push({ label, undo });
		return 1;
	},
}));

vi.mock("@/functions/items.functions", async (orig) => ({
	...(await orig<typeof import("@/functions/items.functions")>()),
	setItemDone: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
		calls.done.push(data);
		return { doneAt: null };
	}),
	moveItem: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
		calls.move.push(data);
		return { detachedLegIds: [] };
	}),
	updateItem: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
		calls.update.push(data);
		return {};
	}),
	createItem: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
		calls.create.push(data);
		return {};
	}),
}));

import type { LocalAt } from "@/lib/engine/__fixtures__/demo";
import type { TripGraph } from "@/lib/engine/types";
import { importedDay, tokyoDay } from "@/lib/fixtures/demo";
import { renderWithWorkspace } from "@/test/render-workspace";
import { TodayTab } from "../TodayTab";
import { TODAY_TESTID as T } from "../testids";

const done = (time: string): LocalAt => [`2027-10-05T${time}`, "Asia/Tokyo"];
const LATE = { cha: done("09:50"), broadway: done("14:30") };
const EARLY = {
	cha: done("09:50"),
	broadway: done("13:30"),
	yodobashi: done("15:20"),
	bic: done("17:10"),
};

afterEach(() => {
	calls.done = [];
	calls.move = [];
	calls.update = [];
	calls.create = [];
	calls.toasts = [];
});

function render(
	s: ReturnType<typeof tokyoDay>,
	asOf: string,
	graph: TripGraph = s.graph,
) {
	return renderWithWorkspace(<TodayTab phone />, {
		graph,
		search: { asOf },
	});
}

const rows = () =>
	screen
		.getAllByTestId(T.restRow)
		.map((r) => r.textContent?.replace(/\s+/g, " ").trim());

describe("Today, running late (P15)", () => {
	const s = tokyoDay(LATE);

	it("says where you are, what's next and how late you run", () => {
		render(s, "2027-10-05T16:40");
		expect(screen.getByTestId(T.page)).toHaveAttribute(
			"data-state",
			"underway",
		);
		expect(screen.getByTestId(T.header)).toHaveTextContent(
			"Day 2 of 3 · Tue 5 Oct · Tokyo",
		);
		const pace = screen.getByTestId(T.pace);
		expect(pace).toHaveAttribute("data-pace", "behind");
		expect(pace).toHaveTextContent("35 min behind");

		const now = screen.getByTestId(T.now);
		expect(now).toHaveTextContent("Now · since 14:40");
		expect(now).toHaveTextContent("Yodobashi Camera");
		expect(within(now).getByTestId(T.done)).toBeEnabled();

		const next = screen.getByTestId(T.next);
		expect(next).toHaveTextContent("Next · about 16:45");
		expect(next).toHaveTextContent("planned 16:10");
		expect(next).toHaveTextContent("Bic Camera");
		expect(next).toHaveTextContent("5 min walk");
		expect(within(next).getByTestId(T.directions)).toHaveAttribute(
			"href",
			expect.stringMatching(
				/^https:\/\/www\.google\.com\/maps\/dir\/\?api=1&destination=35\.6918,139\.7006&travelmode=walking$/,
			),
		);
		// A Done a while ago stays out of the way.
		expect(screen.queryByTestId(T.doneRow)).toBeNull();
	});

	it("shows what's at risk, with a fix", () => {
		render(s, "2027-10-05T16:40");
		const risk = screen.getByTestId(T.risk);
		expect(risk).toHaveAttribute("data-item", s.I.bar);
		expect(risk).toHaveTextContent(
			"Tight before Bar Benfiddich · 20:00, booked",
		);
		expect(risk).toHaveTextContent(
			"You'd arrive 19:55: 5 min spare instead of 40.",
		);
		const fixes = within(risk).getAllByTestId(T.fix);
		expect(fixes.map((f) => f.textContent)).toEqual([
			"Shorten dinner to 1 h",
			"Skip Bic Camera",
		]);
		expect(screen.queryByTestId(T.free)).toBeNull();
	});

	it("re-times the rest of the day from now; the booking holds", () => {
		render(s, "2027-10-05T16:40");
		expect(screen.getByTestId(T.rest)).toHaveTextContent("re-timed from now");
		expect(rows()).toEqual([
			"16:4516:10Bic Camera",
			"18:1517:40Dinner",
			"20:00Bar Benfiddichbooked",
			"21:05Golden Gai",
		]);
		expect(screen.getByTestId(T.tonight)).toHaveTextContent("Hotel Gracery");
	});

	it("Done, Skip and Shorten write at once, with Undo for the fixes", async () => {
		render(s, "2027-10-05T16:40");
		fireEvent.click(screen.getByTestId(T.done));
		fireEvent.click(screen.getByText("Skip Bic Camera"));
		fireEvent.click(screen.getByText("Shorten dinner to 1 h"));
		await vi.waitFor(() => expect(calls.toasts).toHaveLength(2));
		expect(calls.done).toEqual([
			expect.objectContaining({ itemId: s.I.yodobashi, done: true }),
		]);
		expect(calls.move).toEqual([{ itemId: s.I.bic, dayId: null }]);
		expect(calls.update).toEqual([
			expect.objectContaining({
				itemId: s.I.dinner,
				patch: { durationMin: 60 },
			}),
		]);
		const toast = (label: string) =>
			calls.toasts.find((t) => t.label === label);
		// Undo puts Bic Camera back after Yodobashi, and dinner back to 1 h 30.
		toast("Bic Camera moved to Ideas")?.undo();
		toast("Dinner shortened to 1 h")?.undo();
		await vi.waitFor(() => expect(calls.update).toHaveLength(2));
		expect(calls.move[1]).toEqual({
			itemId: s.I.bic,
			dayId: s.D.d1,
			afterItemId: s.I.yodobashi,
		});
		expect(calls.update[1]).toMatchObject({
			itemId: s.I.dinner,
			patch: { durationMin: 90 },
		});
	});

	it("a stop opens its details over Today", () => {
		const { ws } = render(s, "2027-10-05T16:40");
		fireEvent.click(screen.getAllByTestId(T.restRow)[1] as HTMLElement);
		expect(ws().sel).toEqual({ kind: "item", id: s.I.dinner });
		expect(ws().tab).toBe("today");
	});
});

describe("Today, running early (P18)", () => {
	const s = tokyoDay(EARLY);

	it("the Done stays with its Undo; the pace is ahead", async () => {
		render(s, "2027-10-05T17:10");
		const pace = screen.getByTestId(T.pace);
		expect(pace).toHaveAttribute("data-pace", "ahead");
		expect(pace).toHaveTextContent("30 min ahead");
		const row = screen.getByTestId(T.doneRow);
		expect(row).toHaveTextContent("Bic Camera · done 17:10");
		fireEvent.click(within(row).getByTestId(T.undo));
		await vi.waitFor(() =>
			expect(calls.done).toEqual([
				expect.objectContaining({ itemId: s.I.bic, done: false }),
			]),
		);
		expect(screen.queryByTestId(T.risk)).toBeNull();
	});

	it("Dinner has no place: Next whenever you like, with when to leave for the bar and its own Done", async () => {
		render(s, "2027-10-05T17:10");
		expect(screen.queryByTestId(T.now)).toBeNull();
		const next = screen.getByTestId(T.next);
		expect(next).toHaveAttribute("data-item", s.I.dinner);
		expect(next).toHaveTextContent("Next · Dinner, whenever you like");
		expect(next).toHaveTextContent(
			"No place yet · your note: near Shinjuku, or Omoide Yokocho",
		);
		expect(next).not.toHaveTextContent("planned");
		expect(within(next).getByTestId(T.leave)).toHaveTextContent(
			"Leave for Bar Benfiddich by 19:50 (booked for 20:00, 10 min walk)",
		);
		expect(within(next).queryByTestId(T.directions)).toBeNull();
		expect(rows()).toEqual(["20:00Bar Benfiddichbooked", "21:05Golden Gai"]);
		fireEvent.click(within(next).getByTestId(T.done));
		await vi.waitFor(() =>
			expect(calls.done).toEqual([
				expect.objectContaining({ itemId: s.I.dinner, done: true }),
			]),
		);
	});

	it("shows the free time, Dinner's in it, and ideas nearby; Add puts one on today after Dinner", async () => {
		render(s, "2027-10-05T17:10");
		const free = screen.getByTestId(T.free);
		expect(free).toHaveTextContent("2 h 40 free before 19:50");
		expect(free).toHaveTextContent("from your ideas nearby");
		// The Next card says when to leave.
		expect(within(free).queryByTestId(T.leave)).toBeNull();
		const ideas = within(free).getAllByTestId(T.idea);
		expect(ideas.map((i) => i.textContent)).toEqual([
			expect.stringContaining("Fuunji"),
			expect.stringContaining("Omoide Yokocho"),
			expect.stringContaining("Don Quijote"),
		]);
		expect(ideas[1]).toHaveTextContent("walk · open till late");
		// Fuunji's stop waits in Ideas: it moves back; Omoide Yokocho gets a new one.
		fireEvent.click(within(ideas[0] as HTMLElement).getByTestId(T.ideaAdd));
		await vi.waitFor(() => expect(calls.move).toHaveLength(1));
		expect(calls.move[0]).toEqual({
			itemId: s.I.ramenStop,
			dayId: s.D.d1,
			afterItemId: s.I.dinner,
		});
		fireEvent.click(within(ideas[1] as HTMLElement).getByTestId(T.ideaAdd));
		await vi.waitFor(() => expect(calls.create).toHaveLength(1));
		expect(calls.create[0]).toMatchObject({
			dayId: s.D.d1,
			nodeId: s.N.omoide,
			afterItemId: s.I.dinner,
		});
	});

	it("with a stop Now, Dinner Next has no Done of its own: that stop's comes first", () => {
		render(tokyoDay({ ...LATE, yodobashi: done("16:40") }), "2027-10-05T17:00");
		expect(screen.getByTestId(T.now)).toHaveTextContent("Bic Camera");
		const next = screen.getByTestId(T.next);
		expect(next).toHaveTextContent("Next · Dinner, whenever you like");
		expect(within(next).getByTestId(T.leave)).toHaveTextContent(
			"Leave for Bar Benfiddich by 19:50",
		);
		expect(within(next).queryByTestId(T.done)).toBeNull();
		expect(screen.getAllByTestId(T.done)).toHaveLength(1);
		expect(
			within(screen.getByTestId(T.risk)).getAllByTestId(T.fix)[0],
		).toHaveTextContent("Shorten dinner to 1 h");
	});

	it("Dinner before a place: nothing to leave for on its card, and no free time while Bic Camera is to do", () => {
		const { bic: _, ...marks } = EARLY;
		const s = tokyoDay(marks);
		const position = s.graph.items.find((i) => i.id === s.I.yodobashi)
			?.position as string;
		const graph: TripGraph = {
			...s.graph,
			items: s.graph.items.map((i) =>
				i.id === s.I.dinner ? { ...i, position: `${position}m` } : i,
			),
		};
		render(s, "2027-10-05T15:20", graph);
		const next = screen.getByTestId(T.next);
		expect(next).toHaveTextContent("Next · Dinner, whenever you like");
		expect(within(next).queryByTestId(T.leave)).toBeNull();
		expect(rows()[0]).toContain("Bic Camera");
		expect(screen.queryByTestId(T.free)).toBeNull();
		expect(screen.queryByTestId(T.leave)).toBeNull();
	});

	it("once Dinner is Done, the bar is Next and the free time says when to leave", () => {
		render(tokyoDay({ ...EARLY, dinner: done("18:30") }), "2027-10-05T18:30");
		expect(screen.getByTestId(T.next)).toHaveTextContent(
			"Next · 20:00, booked",
		);
		const free = screen.getByTestId(T.free);
		expect(free).toHaveTextContent("1 h 20 free before 19:50");
		expect(within(free).getByTestId(T.leave)).toHaveTextContent(
			"Leave for Bar Benfiddich by 19:50 (booked for 20:00, 10 min walk)",
		);
	});
});

describe("Today before anyone taps Done: the plan by the clock (the imported day)", () => {
	const s = importedDay();

	it("09:05: Breakfast first, whenever you like, with its own Done and the hint under it; no pace, no free time", () => {
		render(s, "2027-10-05T09:05");
		expect(screen.getByTestId(T.page)).toHaveAttribute(
			"data-state",
			"starting",
		);
		expect(screen.queryByTestId(T.pace)).toBeNull();
		const next = screen.getByTestId(T.next);
		expect(next).toHaveTextContent("First stop · Breakfast, whenever you like");
		expect(within(next).getByTestId(T.done)).toBeEnabled();
		expect(screen.getByTestId(T.hint)).toBeInTheDocument();
		expect(screen.queryByTestId(T.free)).toBeNull();
		expect(screen.queryByTestId(T.risk)).toBeNull();
		expect(rows()[0]).toBe("09:30Cha no Ikedaya");
	});

	it("14:40: Now at Yodobashi Camera since 14:05, with a quiet line on what Done does; Bic Camera next at 16:10; nothing late", () => {
		render(s, "2027-10-05T14:40");
		expect(screen.queryByTestId(T.pace)).toBeNull();
		const now = screen.getByTestId(T.now);
		expect(now).toHaveTextContent("Now · since 14:05");
		expect(now).toHaveTextContent("Yodobashi Camera");
		expect(screen.getByTestId(T.hint)).toHaveTextContent(
			"Tap Done when you leave: the rest of today follows your pace.",
		);
		const next = screen.getByTestId(T.next);
		expect(next).toHaveTextContent("Next · about 16:10");
		expect(next).not.toHaveTextContent("planned");
		expect(rows()).toEqual([
			"16:10Bic Camera",
			"17:40Dinner",
			"20:00Bar Benfiddich",
			"21:05Golden Gai",
		]);
		expect(screen.getByTestId(T.rest)).not.toHaveTextContent(
			"re-timed from now",
		);
		expect(screen.queryByTestId(T.risk)).toBeNull();
		expect(screen.queryByTestId(T.free)).toBeNull();
		expect(screen.queryByTestId(T.checkIn)).toBeNull();
	});

	it("18:30: Dinner next whenever you like, when to leave for the bar, 1 h 20 free before 19:50; the hint under Dinner's own Done", () => {
		render(s, "2027-10-05T18:30");
		const next = screen.getByTestId(T.next);
		expect(next).toHaveTextContent("Next · Dinner, whenever you like");
		expect(within(next).getByTestId(T.leave)).toHaveTextContent(
			"Leave for Bar Benfiddich by 19:50 (at 20:00, 10 min walk)",
		);
		expect(within(next).getByTestId(T.done)).toBeEnabled();
		expect(screen.getByTestId(T.hint)).toBeInTheDocument();
		expect(screen.getByTestId(T.free)).toHaveTextContent(
			"1 h 20 free before 19:50",
		);
		expect(screen.queryByTestId(T.pace)).toBeNull();
		expect(rows()).toEqual(["20:00Bar Benfiddich", "21:05Golden Gai"]);
	});

	it("the hint goes with the first Done, and viewers never see it", () => {
		const { unmount } = render(
			importedDay({ cha: done("09:58") }),
			"2027-10-05T10:30",
		);
		expect(screen.getByTestId(T.now)).toHaveTextContent("Nakano Broadway");
		expect(screen.queryByTestId(T.hint)).toBeNull();
		unmount();
		render(s, "2027-10-05T14:40", {
			...s.graph,
			me: { ...s.graph.me, role: "viewer" },
		});
		expect(screen.getByTestId(T.now)).toBeInTheDocument();
		expect(screen.queryByTestId(T.hint)).toBeNull();
	});
});

describe("Today after a forgotten Done (the imported day, Cha no Ikedaya Done at 10:40)", () => {
	const s = importedDay({ cha: done("10:40") });

	it("12:00: at Nakano Broadway since 10:55, 40 min behind", () => {
		render(s, "2027-10-05T12:00");
		expect(screen.getByTestId(T.pace)).toHaveTextContent("40 min behind");
		expect(screen.getByTestId(T.now)).toHaveTextContent("Now · since 10:55");
		expect(screen.queryByTestId(T.checkIn)).toBeNull();
	});

	it("15:00: “Still at Nakano Broadway?” with Done; the day is back on the plan, no pace", async () => {
		render(s, "2027-10-05T15:00");
		expect(screen.queryByTestId(T.pace)).toBeNull();
		const ask = screen.getByTestId(T.checkIn);
		expect(ask).toHaveAttribute("data-item", s.I.broadway);
		expect(ask).toHaveTextContent("Still at Nakano Broadway?");
		expect(screen.getByTestId(T.now)).toHaveTextContent("Now · since 14:05");
		expect(screen.getByTestId(T.now)).toHaveTextContent("Yodobashi Camera");
		expect(screen.queryByTestId(T.hint)).toBeNull();
		expect(screen.queryByTestId(T.risk)).toBeNull();
		fireEvent.click(within(ask).getByTestId(T.done));
		await vi.waitFor(() =>
			expect(calls.done).toEqual([
				expect.objectContaining({ itemId: s.I.broadway, done: true }),
			]),
		);
		expect(calls.done[0]).not.toHaveProperty("at");
	});

	it("No puts the question away; viewers aren't asked", () => {
		const { unmount } = render(s, "2027-10-05T15:00");
		fireEvent.click(
			within(screen.getByTestId(T.checkIn)).getByRole("button", {
				name: "No",
			}),
		);
		expect(screen.queryByTestId(T.checkIn)).toBeNull();
		unmount();
		render(s, "2027-10-05T15:00", {
			...s.graph,
			me: { ...s.graph.me, role: "viewer" },
		});
		expect(screen.queryByTestId(T.checkIn)).toBeNull();
	});

	it("Done on it at 15:00: the rest re-times from then, the bar keeps 20:00 and says when you'd arrive", () => {
		render(
			importedDay({ cha: done("10:40"), broadway: done("15:00") }),
			"2027-10-05T15:00",
		);
		expect(rows()).toEqual([
			"16:2014:05Yodobashi Camera",
			"18:2516:10Bic Camera",
			"19:5517:40Dinner",
			"20:00Bar BenfiddichYou'd arrive 21:35",
			"21:4021:05Golden Gai",
		]);
	});
});

describe("Today's own states", () => {
	it("the first stop of the day: when to leave, no Now yet", () => {
		render(tokyoDay(), "2027-10-05T08:00");
		expect(screen.getByTestId(T.page)).toHaveAttribute(
			"data-state",
			"starting",
		);
		expect(screen.queryByTestId(T.now)).toBeNull();
		expect(screen.queryByTestId(T.pace)).toBeNull();
		const next = screen.getByTestId(T.next);
		expect(next).toHaveTextContent("First stop · 09:10");
		expect(next).toHaveTextContent("Leave by 09:00 · 10 min walk");
		expect(next).toHaveTextContent("Cha no Ikedaya");
	});

	it("the end of the day: nothing left, tomorrow's first stop and where you sleep", () => {
		const all = Object.fromEntries(
			["cha", "broadway", "yodobashi", "bic", "dinner", "bar", "gai"].map(
				(k, i) => [k, done(`1${i}:00`)],
			),
		);
		render(tokyoDay({ ...all, gai: done("22:40") }), "2027-10-05T22:45");
		expect(screen.getByTestId(T.page)).toHaveAttribute("data-state", "ended");
		expect(screen.getByTestId(T.ended)).toHaveTextContent("7 of 7 stops done");
		expect(screen.getByTestId(T.tomorrow)).toHaveTextContent(
			"Wed 6 Oct: Meiji Jingu at 09:25 · leave by 09:00",
		);
		expect(screen.getByTestId(T.tonight)).toHaveTextContent("Hotel Gracery");
		expect(screen.getByTestId(T.tonightDirections)).toHaveAttribute(
			"href",
			expect.stringContaining("travelmode=walking"),
		);
		expect(screen.queryByTestId(T.next)).toBeNull();
	});

	it("a day without stops says so and opens the Plan", () => {
		const { ws } = render(tokyoDay(), "2027-10-04T12:00");
		expect(screen.getByTestId(T.page)).toHaveAttribute("data-state", "empty");
		expect(screen.getByTestId(T.empty)).toHaveTextContent(
			"Nothing planned for today.",
		);
		fireEvent.click(screen.getByTestId(T.openPlan));
		expect(ws().tab).toBe("plan");
		expect(ws().days).toEqual({ from: "2027-10-04", to: "2027-10-04" });
	});

	it("Trip overview opens the Overview", () => {
		const { ws } = render(tokyoDay(LATE), "2027-10-05T16:40");
		fireEvent.click(screen.getByTestId(T.overviewLink));
		expect(ws().tab).toBe("overview");
		expect(ws().search.tab).toBe("overview");
	});
});

describe("Today read-only", () => {
	it("viewers see the day, without Done, fixes or Add", () => {
		const s = tokyoDay(LATE);
		const graph: TripGraph = {
			...s.graph,
			me: { ...s.graph.me, role: "viewer" },
		};
		render(s, "2027-10-05T16:40", graph);
		expect(screen.getByTestId(T.now)).toHaveTextContent("Yodobashi Camera");
		expect(screen.queryByTestId(T.done)).toBeNull();
		expect(screen.getByTestId(T.risk)).toBeInTheDocument();
		expect(screen.queryByTestId(T.fix)).toBeNull();
		// Directions and the driver's address are for everyone.
		expect(screen.getByTestId(T.directions)).toBeInTheDocument();
		expect(screen.getByTestId(T.address)).toBeInTheDocument();
	});

	it("raters too; the early day shows no Undo or Add", () => {
		const s = tokyoDay(EARLY);
		render(s, "2027-10-05T17:10", {
			...s.graph,
			me: { ...s.graph.me, role: "rater" },
		});
		expect(screen.getByTestId(T.doneRow)).toBeInTheDocument();
		expect(screen.queryByTestId(T.undo)).toBeNull();
		expect(screen.queryByTestId(T.done)).toBeNull();
		expect(screen.getAllByTestId(T.idea)).toHaveLength(3);
		expect(screen.queryByTestId(T.ideaAdd)).toBeNull();
	});

	it("link guests too, even on a Can edit link", () => {
		const s = tokyoDay(LATE);
		render(s, "2027-10-05T16:40", {
			...s.graph,
			me: { ...s.graph.me, role: "editor", isGuest: true },
		});
		expect(screen.getByTestId(T.risk)).toBeInTheDocument();
		expect(screen.queryByTestId(T.done)).toBeNull();
		expect(screen.queryByTestId(T.fix)).toBeNull();
	});
});

describe("Today for screen readers", () => {
	it("a live region says Now, Next and whether you run late or early", () => {
		const live = (marks: Record<string, LocalAt>, asOf: string) => {
			const { container, unmount } = render(tokyoDay(marks), asOf);
			const text = container.querySelector("[aria-live=polite]")?.textContent;
			unmount();
			return text;
		};
		expect(live(LATE, "2027-10-05T16:40")).toBe(
			"Now: Yodobashi Camera. Next: Bic Camera. Running late.",
		);
		expect(live(EARLY, "2027-10-05T17:10")).toBe(
			"Next: Dinner. Running early.",
		);
		expect(live({}, "2027-10-05T08:00")).toBe("Next: Cha no Ikedaya.");
	});
});

describe("Use my location (opt-in, on the device)", () => {
	afterEach(() => {
		Reflect.deleteProperty(navigator, "geolocation");
	});

	it("near the next stop: “Looks like you're at Bic Camera?”; Yes marks the Now stop Done as you left it, and you're at Bic Camera", async () => {
		const clearWatch = vi.fn();
		const watchPosition = vi.fn((ok: PositionCallback) => {
			ok({
				coords: { latitude: 35.6919, longitude: 139.7007 },
			} as GeolocationPosition);
			return 7;
		});
		Object.defineProperty(navigator, "geolocation", {
			value: { watchPosition, clearWatch },
			configurable: true,
		});
		const s = tokyoDay(LATE);
		const { unmount } = render(s, "2027-10-05T16:40");
		// Nothing is asked before you opt in.
		expect(watchPosition).not.toHaveBeenCalled();
		expect(screen.queryByTestId(T.here)).toBeNull();
		fireEvent.click(screen.getByTestId(T.locate));
		const here = await screen.findByTestId(T.here);
		expect(here).toHaveAttribute("data-item", s.I.bic);
		expect(here).toHaveTextContent("Looks like you're at Bic Camera?");
		fireEvent.click(within(here).getByTestId(T.hereYes));
		// Left Yodobashi the 5 min walk ago (16:35 in Tokyo), so Bic Camera is Now at once.
		await vi.waitFor(() =>
			expect(calls.done).toEqual([
				expect.objectContaining({
					itemId: s.I.yodobashi,
					done: true,
					at: "2027-10-05T07:35:00.000Z",
				}),
			]),
		);
		// Stop: the watch ends.
		fireEvent.click(screen.getByTestId(T.locate));
		expect(clearWatch).toHaveBeenCalledWith(7);
		unmount();
	});
});

describe("Show this to the driver (P16)", () => {
	it("the local name and address, very large; then the English, Copy and Directions", async () => {
		const s = tokyoDay(LATE);
		const graph: TripGraph = {
			...s.graph,
			nodes: s.graph.nodes.map((n) =>
				n.id === s.N.bic
					? {
							...n,
							localName: "ビックカメラ 新宿西口店",
							localAddress: "東京都新宿区西新宿1丁目5-1",
							address: "1-5-1 Nishishinjuku, Shinjuku City, Tokyo",
						}
					: n,
			),
		};
		const writeText = vi.fn(async () => {});
		Object.defineProperty(navigator, "clipboard", {
			value: { writeText },
			configurable: true,
		});
		render(s, "2027-10-05T16:40", graph);
		fireEvent.click(screen.getByTestId(T.address));
		const sheet = await screen.findByTestId(T.driver);
		expect(sheet).toHaveTextContent("Show this to the driver");
		const local = within(sheet).getByTestId(T.driverLocal);
		expect(local).toHaveAttribute("lang", "ja");
		expect(local).toHaveTextContent("ビックカメラ 新宿西口店");
		expect(local).toHaveTextContent("東京都新宿区西新宿1丁目5-1");
		expect(sheet).toHaveTextContent("Bic Camera");
		expect(sheet).toHaveTextContent(
			"1-5-1 Nishishinjuku, Shinjuku City, Tokyo",
		);
		expect(within(sheet).getByTestId(T.driverDirections)).toHaveAttribute(
			"href",
			expect.stringContaining("destination=35.6918,139.7006"),
		);
		fireEvent.click(within(sheet).getByTestId(T.driverCopy));
		await vi.waitFor(() =>
			expect(writeText).toHaveBeenCalledWith(
				"ビックカメラ 新宿西口店\n東京都新宿区西新宿1丁目5-1",
			),
		);
	});
});
