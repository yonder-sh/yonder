/**
 * WP-Plan fixes from QA round 2 (qa-plan-r2, qa-collab-r2, qa-visual-r2):
 * the Travel row and Day select of the item Overview, the carry row of a
 * night train, the day's end on a travel day, the full sun line, suggested
 * moves that never draw a real leg as "Unlinked transit", the countdown,
 * focus after Delete, and Move up / Move down.
 */
import {
	act,
	fireEvent,
	screen,
	waitFor,
	within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { demoProposals } from "@/lib/engine/__fixtures__/demo";
import type { TripGraph } from "@/lib/engine/types";
import { demo, demoGraph } from "@/lib/fixtures/demo";
import { daysUntil } from "@/lib/format";
import { TESTID } from "@/lib/testids";
import { renderWithWorkspace } from "@/test/render-workspace";
import { DayOverview } from "../DayOverview";
import { ItemOverview } from "../ItemOverview";
import { NowNext } from "../NowNext";
import { PlanTab } from "../PlanTab";
import { PLAN_TESTID } from "../testids";

const fns = vi.hoisted(() => ({
	deleteItem: vi.fn(async () => ({ deletedAt: "2026-09-23T12:00:00.000Z" })),
	moveItem: vi.fn(async () => ({ detachedLegIds: [] as string[] })),
}));
vi.mock("@/functions/items.functions", async (orig) => ({
	...(await orig<typeof import("@/functions/items.functions")>()),
	deleteItem: fns.deleteItem,
	moveItem: fns.moveItem,
}));

const I = demo.I;
const D = demo.D;

const cardOf = (id: string) =>
	screen
		.getAllByTestId(TESTID.timelineItem)
		.find((c) => c.getAttribute("data-item-id") === id) as HTMLElement;

const openMenu = (id: string) => {
	const menu = within(cardOf(id)).getByTestId(PLAN_TESTID.itemMenu);
	menu.focus();
	fireEvent.keyDown(menu, { key: "Enter" });
	return menu;
};

/** The demo's Fuji Excursion as the SP3 night train: 21:35 Mon 4 Oct → 05:30 Tue 5 Oct. */
function nightTrain(): TripGraph {
	const g = structuredClone(demoGraph);
	const leg = g.legs.find((l) => l.id === demo.L.fuji);
	if (!leg) throw new Error("no leg");
	leg.depAt = "2027-10-04T12:35:00.000Z";
	leg.arrAt = "2027-10-04T20:30:00.000Z";
	leg.details = {
		kind: "transit",
		fixed: {
			departLocal: "2027-10-04T21:35",
			arriveLocal: "2027-10-05T05:30",
			fromTz: "Asia/Tokyo",
			toTz: "Asia/Tokyo",
			accessMin: 10,
			egressMin: 0,
		},
		booking: { trainNumber: "SP3", seats: [] },
	};
	return g;
}

beforeEach(() => {
	fns.deleteItem.mockClear();
	fns.moveItem.mockClear();
});

describe("item Overview layout", () => {
	it("PLAN-R2-09: the Travel line wraps: chips and minutes stay whole, the destination gets its own truncating box", () => {
		renderWithWorkspace(<ItemOverview itemId={I.loft as string} />);
		const to = screen.getByText(/^to Meiji Jingu$/);
		expect(to.className).toMatch(/\btruncate\b/);
		expect(to.className).toMatch(/\bmax-w-full\b/);
		const line = to.parentElement as HTMLElement;
		expect(line.className).toMatch(/\bflex-wrap\b/);
		// The arrow keeps its own column; the line wraps beside it.
		expect(line.parentElement?.className).toMatch(
			/grid-cols-\[auto_minmax\(0,1fr\)\]/,
		);
		// The leg summary's parts join that wrapping row, and none breaks inside.
		const summary = line.firstElementChild as HTMLElement;
		expect(summary.className).toMatch(/\bcontents\b/);
		expect(summary.className).not.toMatch(/\binline-flex\b/);
		expect(summary.className).toContain("[&>*]:whitespace-nowrap");
	});

	it("COLLAB-R2-11: the Day select fits the panel and cuts its label with an ellipsis", () => {
		const g = structuredClone(demoGraph);
		const d2 = g.days.find((d) => d.id === D.d2);
		if (d2)
			d2.title = "Mt. Fuji · Shinjuku → Kawaguchiko by the Fuji Excursion";
		renderWithWorkspace(<ItemOverview itemId={I.itoya as string} />, {
			graph: g,
		});
		const trigger = screen.getByTestId(PLAN_TESTID.overviewDay);
		expect(trigger.className).toMatch(/\bmin-w-0\b/);
		expect(trigger.className).toMatch(/\bw-full\b/);
		// One shrinkable column (an auto column grows to the longest label).
		expect(trigger.parentElement?.className).toContain(
			"grid-cols-[minmax(0,1fr)]",
		);
		const value = within(trigger).getByText(/Mt\. Fuji · Shinjuku/);
		expect(value.className).toMatch(/\btruncate\b/);
		expect(value.textContent).toMatch(/^D2 Mon 4 Oct · Mt\. Fuji/);
	});
});

describe("area blocks on a phone", () => {
	it("VIS2-09: the dots, then the stops-and-times line give way before the place name", () => {
		renderWithWorkspace(<PlanTab />, {
			splat: "japan/tokyo",
			search: { lens: "area" },
		});
		const block = screen.getAllByTestId(
			PLAN_TESTID.areaBlock,
		)[0] as HTMLElement;
		const name = block.querySelector("[data-block-name]") as HTMLElement;
		expect(name.textContent).toBe("Shibuya");
		expect(name.className).toMatch(/\bmin-w-0\b/);
		expect(name.className).not.toMatch(/\bshrink-\[/);
		const meta = name.nextElementSibling as HTMLElement;
		expect(meta.textContent).toMatch(/· 2 stops · 09:00–11:33/);
		expect(meta.className).toMatch(/\bshrink-\[100\]/);
		expect(meta.className).toMatch(/\btruncate\b/);
		// The button is sized by its content, so the dots beside it can shrink.
		expect(name.parentElement?.className).toMatch(/\bflex-auto\b/);
		const dots = block.querySelector("[data-block-dots]") as HTMLElement;
		expect(dots.className).toMatch(/\bshrink-\[1000\]/);
		// Dots that don't fit drop out whole (onto a hidden second line).
		expect(dots.className).toMatch(/\bflex-wrap\b/);
		expect(dots.className).toMatch(/\boverflow-hidden\b/);
	});
});

describe("day summaries", () => {
	it("COLLAB-R2-10: the day Overview repeats the full sun line", () => {
		renderWithWorkspace(<DayOverview dayId={D.d1 as string} />);
		const sun = screen.getByTestId(TESTID.daySun);
		expect(sun).toHaveAttribute("data-full");
		expect(sun.textContent).toMatch(
			/^Sunrise \d\d:\d\d · Golden hour \d\d:\d\d · Sunset \d\d:\d\d · /,
		);
	});

	it("VIS2-06: a day that leaves on a night train doesn't end at its last stop", () => {
		const g = nightTrain();
		renderWithWorkspace(<PlanTab />, {
			graph: g,
			search: { lens: "place", days: "2027-10-04" },
		});
		const summary = screen.getByTestId(PLAN_TESTID.daySummary);
		// Itoya ends at 13:00; SP3 leaves at 21:35.
		expect(summary.textContent).toMatch(/ends 21:35/);
		expect(summary.textContent).not.toMatch(/ends 13:00/);
	});

	it("VIS2-06: the day Overview says the same", () => {
		renderWithWorkspace(<DayOverview dayId={D.d2 as string} />, {
			graph: nightTrain(),
		});
		expect(screen.getByText(/· ends 21:35/)).toBeInTheDocument();
	});
});

describe("carry row of a reserved ride", () => {
	it("PLAN-R2-13: repeats the ride time from the ticket, not the leg's total with access and buffers", () => {
		renderWithWorkspace(<PlanTab />, {
			graph: nightTrain(),
			search: { lens: "place", days: "2027-10-04" },
		});
		const ticket = screen
			.getAllByTestId(TESTID.leg)
			.find((r) => /SP3/.test(r.textContent ?? "")) as HTMLElement;
		expect(
			within(ticket).getByTestId(PLAN_TESTID.timedDuration).textContent,
		).toMatch(/7h 55m/);
		const ghost = screen
			.getAllByTestId(PLAN_TESTID.ghost)
			.find((r) => r.getAttribute("data-dir") === "out") as HTMLElement;
		const text = (ghost.textContent ?? "").replace(/\s+/g, " ");
		expect(text).toMatch(/SP3 7h55/);
		// Not the schedule's 8h05 (10 minutes at the platform included).
		expect(text).not.toMatch(/8h05/);
	});
});

describe("suggestions", () => {
	it("COLLAB-R2-01: a pending move shows its ghost, never an amber 'Unlinked transit' row for the real leg", () => {
		const move = demoProposals.find(
			(p) => p.op === "item.move" && p.entityId === I.itoya,
		);
		if (!move) throw new Error("fixture: no move of Itoya");
		const { ws } = renderWithWorkspace(<PlanTab />, {
			proposals: [move],
			search: { lens: "place" },
		});
		expect(ws().proposals.show).toBe(true);
		// The simulation did move Itoya (the Fuji Excursion lost its pair there)…
		expect(ws().ix.item(I.itoya as string)?.dayId).toBe(D.d1);
		expect(ws().model.detachedLegs.map((d) => d.legId)).toEqual([demo.L.fuji]);
		// …but on the server nothing broke: no Relink, no Discard.
		expect(screen.queryAllByTestId(PLAN_TESTID.unlinked)).toEqual([]);
	});
});

describe("NowNext", () => {
	const tz = process.env.TZ;
	afterEach(() => {
		vi.useRealTimers();
		process.env.TZ = tz;
	});

	it("VIS2-12: counts the days from the viewer's own date, like the dashboard", () => {
		// 16:00 EDT on Wed 23 Sep 2026: already Thu 24 Sep in Tokyo, the trip's zone.
		process.env.TZ = "America/New_York";
		vi.useFakeTimers({ toFake: ["Date"] });
		vi.setSystemTime(new Date("2026-09-23T20:00:00.000Z"));
		renderWithWorkspace(<NowNext />);
		const start = demoGraph.trip.startDate as string;
		const n = daysUntil(start, "2026-09-23");
		expect(n).toBe(375);
		expect(screen.getByTestId(TESTID.nowNext).textContent).toMatch(
			new RegExp(`Starts in ${n} days`),
		);
	});
});

describe("⋯ menu", () => {
	it("VIS2-07 / A11Y-02: Delete from the keyboard moves the focus to the next card, not <body>", async () => {
		renderWithWorkspace(<PlanTab />, { search: { lens: "place" } });
		openMenu(I.loft as string);
		const del = screen.getByRole("menuitem", { name: "Delete" });
		act(() => {
			del.focus();
		});
		fireEvent.keyDown(del, { key: "Enter" });
		await waitFor(() => expect(fns.deleteItem).toHaveBeenCalled());
		await waitFor(() =>
			expect(document.activeElement).toBe(
				cardOf(I.lunch1 as string).querySelector("[data-card-main]"),
			),
		);
		expect(document.activeElement).not.toBe(document.body);
	});

	it("VIS2-14 / MOB-04: Move up / Move down reorder without a drag", async () => {
		renderWithWorkspace(<PlanTab />, { search: { lens: "place" } });
		// The day's first card can't move up.
		openMenu(I.hands as string);
		expect(screen.getByRole("menuitem", { name: /Move up/ })).toHaveAttribute(
			"data-disabled",
		);
		fireEvent.keyDown(document.activeElement ?? document.body, {
			key: "Escape",
		});
		await waitFor(() =>
			expect(screen.queryByRole("menuitem", { name: /Move up/ })).toBeNull(),
		);
		openMenu(I.loft as string);
		const down = screen.getByRole("menuitem", { name: /Move down/ });
		expect(down).not.toHaveAttribute("data-disabled");
		fireEvent.click(down);
		await waitFor(() => expect(fns.moveItem).toHaveBeenCalledTimes(1));
		expect(fns.moveItem).toHaveBeenCalledWith({
			data: { itemId: I.loft, dayId: D.d1, afterItemId: I.lunch1 },
		});
	});

	it("VIS2-14: a viewer sees Move up / Move down disabled", () => {
		const g = structuredClone(demoGraph);
		g.me = { ...g.me, role: "viewer" };
		renderWithWorkspace(<PlanTab />, { graph: g, search: { lens: "place" } });
		openMenu(I.loft as string);
		expect(screen.getByRole("menuitem", { name: /Move up/ })).toHaveAttribute(
			"data-disabled",
		);
		expect(screen.getByRole("menuitem", { name: /Move down/ })).toHaveAttribute(
			"data-disabled",
		);
	});
});
