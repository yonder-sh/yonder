import { QueryClient } from "@tanstack/react-query";
import { fireEvent, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { flightDetails } from "@/lib/engine/__fixtures__/demo";
import { hhmm } from "@/lib/engine/time";
import { demo, demoGraph, scenario } from "@/lib/fixtures/demo";
import { activityQuery } from "@/lib/query/trip-queries";
import { TESTID } from "@/lib/testids";
import { useUi } from "@/lib/workspace/ui-store";
import { renderWithWorkspace } from "@/test/render-workspace";
import { DayChips } from "../DayChips";
import { DayOverview } from "../DayOverview";
import { ItemOverview } from "../ItemOverview";
import { NowNext } from "../NowNext";
import { PlanTab } from "../PlanTab";
import { PLAN_TESTID } from "../testids";

const I = demo.I;
const D = demo.D;

describe("PlanTab", () => {
	it("card times equal the schedule (place lens, root)", () => {
		const { ws } = renderWithWorkspace(<PlanTab />, {
			search: { lens: "place" },
		});
		const cards = screen.getAllByTestId(TESTID.timelineItem);
		expect(cards.length).toBe(demoGraph.items.length);
		const schedule = ws().schedule;
		for (const card of cards) {
			const id = card.getAttribute("data-item-id") as string;
			const s = schedule.items[id];
			if (!s) continue;
			expect(within(card).getByTestId(TESTID.itemStart).textContent).toBe(
				hhmm(s.start, s.tz),
			);
			expect(within(card).getByTestId(TESTID.itemEnd).textContent).toBe(
				hhmm(s.end, s.tz),
			);
		}
	});

	it("shows a free-time gap and a pinned mark before Shibuya Sky", () => {
		renderWithWorkspace(<PlanTab />, { search: { lens: "place" } });
		expect(screen.getAllByTestId(TESTID.freeTime)[0]?.textContent).toMatch(
			/free$/,
		);
		const sky = screen
			.getAllByTestId(TESTID.timelineItem)
			.find((c) => c.getAttribute("data-item-id") === I.sky);
		expect(sky && within(sky).getByLabelText("pinned")).toBeTruthy();
	});

	it("groups the area lens under block headers and folds them", () => {
		renderWithWorkspace(<PlanTab />, {
			splat: "japan/tokyo",
			search: { lens: "area" },
		});
		const blocks = screen.getAllByTestId(PLAN_TESTID.areaBlock);
		expect(blocks[0]?.textContent).toMatch(/Shibuya\s*· 2 stops · 09:00–11:33/);
		const before = screen.getAllByTestId(TESTID.timelineItem).length;
		fireEvent.click(
			within(blocks[0] as HTMLElement).getByRole("button", {
				name: /Collapse Shibuya/,
			}),
		);
		expect(screen.getAllByTestId(TESTID.timelineItem).length).toBe(before - 3);
	});

	it("shows city bands at the city lens", () => {
		renderWithWorkspace(<PlanTab />, { search: { lens: "city" } });
		const bands = screen.getAllByTestId(PLAN_TESTID.band);
		expect(bands[0]?.textContent).toMatch(/Tokyo/);
		expect(screen.getAllByTestId(PLAN_TESTID.bandLink).length).toBeGreaterThan(
			0,
		);
	});

	it("a ride between two city bands shows its line, as at the country lens", () => {
		const graph = structuredClone(demoGraph);
		const fuji = graph.legs.find(
			(l) => l.mode === "transit" && l.durationMin === 116,
		);
		if (!fuji) throw new Error("the demo's Fuji Excursion leg");
		fuji.details = {
			kind: "transit",
			route: {
				id: "r1",
				source: "manual",
				durationMin: 116,
				walkMin: 0,
				transfers: 0,
				segments: [
					{ mode: "rail", lineName: "Fuji Excursion", durationMin: 116 },
				],
			},
		};
		renderWithWorkspace(<PlanTab />, { graph, search: { lens: "city" } });
		const links = screen.getAllByTestId(PLAN_TESTID.bandLink);
		expect(links.some((l) => l.textContent?.includes("Fuji Excursion"))).toBe(
			true,
		);
	});

	it("FB-08: a click on a day header never filters; the date selects the day, the filter toggle filters", () => {
		const { ws } = renderWithWorkspace(<PlanTab />, {
			search: { lens: "place" },
		});
		const header = screen.getAllByTestId(
			PLAN_TESTID.dayHeader,
		)[1] as HTMLElement;
		const d2 = demoGraph.days[1]?.date as string;
		// The empty header (the owner clicks there to dismiss menus): nothing.
		fireEvent.click(header);
		fireEvent.click(header.firstElementChild as HTMLElement);
		fireEvent.click(header.firstElementChild as HTMLElement, {
			shiftKey: true,
		});
		expect(ws().days).toBeNull();
		expect(ws().sel).toBeNull();
		// The date selects (inspects) the day; still no filter.
		fireEvent.click(within(header).getByRole("button", { name: /, Day 2/ }));
		expect(ws().sel).toEqual({ kind: "day", id: demoGraph.days[1]?.id });
		expect(ws().days).toBeNull();
		expect(screen.getAllByTestId(PLAN_TESTID.daySection).length).toBe(
			demoGraph.days.length,
		);
		// The explicit toggle shows only that day; the others fold.
		const filter = within(header).getByTestId(PLAN_TESTID.dayFilter);
		expect(filter.getAttribute("aria-pressed")).toBe("false");
		fireEvent.click(filter);
		expect(ws().days).toEqual({ from: d2, to: d2 });
		expect(screen.getAllByTestId(PLAN_TESTID.daySection)).toHaveLength(1);
		expect(
			screen
				.getAllByTestId(PLAN_TESTID.fold)
				.map((f) => f.getAttribute("data-reason")),
		).toEqual(["before", "after"]);
		expect(screen.getByTestId(PLAN_TESTID.rangeBar).textContent).toMatch(
			/Show all/,
		);
		const shown = within(screen.getByTestId(PLAN_TESTID.dayHeader)).getByTestId(
			PLAN_TESTID.dayFilter,
		);
		expect(shown.getAttribute("aria-pressed")).toBe("true");
		// Pressed again: every day.
		fireEvent.click(shown);
		expect(ws().days).toBeNull();
	});

	it("the person filter shows only that person's cards and says how many are hidden", () => {
		const g = structuredClone(demoGraph);
		const me = g.me.memberId as string;
		const hands = g.items.find((i) => i.id === I.hands);
		const loft = g.items.find((i) => i.id === I.loft);
		if (hands) hands.assigneeIds = [demo.graph.members[1]?.id as string];
		if (loft) loft.assigneeIds = [me];
		renderWithWorkspace(<PlanTab />, {
			graph: g,
			search: { lens: "place", who: me },
		});
		// QA TAG-01: exactly the tagged card, under its day heading; unassigned ones hide too.
		expect(
			screen
				.queryAllByTestId(TESTID.timelineItem)
				.map((c) => c.getAttribute("data-item-id")),
		).toEqual([I.loft]);
		expect(screen.getAllByTestId(PLAN_TESTID.dayHidden).length).toBeGreaterThan(
			0,
		);
		// The unassigned idea hides from Unscheduled too.
		expect(screen.getByTestId(PLAN_TESTID.unscheduled).textContent).toMatch(
			/Unscheduled ·\s*0/,
		);
	});

	it("when the person filter hides everything: “Nothing assigned to Audrey here.”", () => {
		const audrey = demo.graph.members[1]?.id as string;
		const { ws } = renderWithWorkspace(<PlanTab />, {
			search: { lens: "place", who: audrey },
		});
		expect(screen.getByTestId(TESTID.emptyState).textContent).toMatch(
			/Nothing assigned to Audrey here\./,
		);
		expect(screen.queryAllByTestId(TESTID.timelineItem)).toHaveLength(0);
		fireEvent.click(screen.getByRole("button", { name: "Show everyone" }));
		expect(ws().who).toBeNull();
		expect(screen.getAllByTestId(TESTID.timelineItem).length).toBe(
			demoGraph.items.length,
		);
	});

	it("a late pinned card shows ONE warning chip, and the day ONE issues chip", () => {
		const g = structuredClone(demoGraph);
		const sky = g.items.find((i) => i.id === I.sky);
		if (sky) sky.pinnedStart = "09:30"; // before the plan can get there
		renderWithWorkspace(<PlanTab />, { graph: g, search: { lens: "place" } });
		const card = screen
			.getAllByTestId(TESTID.timelineItem)
			.find((c) => c.getAttribute("data-item-id") === I.sky) as HTMLElement;
		expect(within(card).getAllByTestId(TESTID.conflictBadge)).toHaveLength(1);
		const header = screen.getAllByTestId(
			PLAN_TESTID.dayHeader,
		)[0] as HTMLElement;
		expect(within(header).getAllByTestId(TESTID.conflictBadge)).toHaveLength(1);
	});

	it("viewers see the plan with edit affordances disabled", () => {
		const g = structuredClone(demoGraph);
		g.me = { ...g.me, role: "viewer" };
		renderWithWorkspace(<PlanTab />, { graph: g, search: { lens: "place" } });
		expect(screen.queryAllByTestId(PLAN_TESTID.addBetween)).toHaveLength(0);
		expect(screen.queryAllByTestId(PLAN_TESTID.itemResize)).toHaveLength(0);
		const duration = screen.getAllByTestId(
			PLAN_TESTID.itemDuration,
		)[0] as HTMLElement;
		expect(within(duration).getByRole("button")).toBeDisabled();
	});
});

describe("Overviews and mobile", () => {
	it("ItemOverview shows when, duration and who", () => {
		renderWithWorkspace(<ItemOverview itemId={I.hands as string} />);
		expect(screen.getByTestId(TESTID.itemOverview)).toBeInTheDocument();
		expect(screen.getByText(/09:00–09:45/)).toBeInTheDocument();
		expect(
			screen.getByTestId(PLAN_TESTID.overviewAssignees).textContent,
		).toMatch(/Everyone/);
	});

	it("DayOverview shows the capacity and stops", () => {
		renderWithWorkspace(<DayOverview dayId={D.d1 as string} />);
		expect(
			screen.getByTestId(PLAN_TESTID.dayOverviewCapacity).textContent,
		).toMatch(/Your day/);
		expect(screen.getByText("Hands Shibuya")).toBeInTheDocument();
	});

	it("DayChips select one day, then all again", () => {
		const { ws } = renderWithWorkspace(<DayChips />);
		fireEvent.click(screen.getByRole("button", { name: /^Day 2,/ }));
		const d2 = demoGraph.days[1]?.date;
		expect(ws().days).toEqual({ from: d2, to: d2 });
		fireEvent.click(screen.getByRole("button", { name: /^Day 2,/ }));
		expect(ws().days).toBeNull();
	});

	it("NowNext counts down before the trip and selects the first stop", () => {
		const { ws } = renderWithWorkspace(<NowNext />);
		const el = screen.getByTestId(TESTID.nowNext);
		expect(el.textContent).toMatch(/Starts in \d+ days · Day 1 Hands Shibuya/);
		fireEvent.click(el);
		expect(ws().sel).toEqual({ kind: "item", id: I.hands });
	});

	describe("during the trip", () => {
		afterEach(() => vi.useRealTimers());
		// Sun 3 Oct 2027, 10:00 in Tokyo: Loft (09:48–10:33) is on.
		const DURING = new Date("2027-10-03T01:00:00Z");

		it("NowNext shows the stop that's on now", () => {
			vi.useFakeTimers({ toFake: ["Date"] });
			vi.setSystemTime(DURING);
			const { ws } = renderWithWorkspace(<NowNext />);
			const el = screen.getByTestId(TESTID.nowNext);
			expect(el.textContent).toMatch(/^Now10:00 Shibuya Loft/);
			fireEvent.click(el);
			expect(ws().sel).toEqual({ kind: "item", id: I.loft });
		});

		it("the now line sits before the first stop that hasn't started", () => {
			vi.useFakeTimers({ toFake: ["Date"] });
			vi.setSystemTime(DURING);
			renderWithWorkspace(<PlanTab />, { search: { lens: "place" } });
			const line = screen.getByTestId(PLAN_TESTID.nowLine);
			expect(line.getAttribute("aria-label")).toBe("Now 10:00");
			const row = line.closest("li");
			expect(row?.querySelector(`[data-item-id="${I.lunch1}"]`)).not.toBeNull();
		});
	});
});

describe("I2 fixes", () => {
	const ZERO = {
		media: 0,
		links: 0,
		docs: 0,
		todoOpen: 0,
		todo: 0,
		shopOpen: 0,
		shop: 0,
		hasNote: false,
	};
	const cardOf = (id: string) =>
		screen
			.getAllByTestId(TESTID.timelineItem)
			.find((c) => c.getAttribute("data-item-id") === id) as HTMLElement;

	it("HOME-12: a viewer's ⋯ menu shows 'Move to day' disabled like the rest", () => {
		const g = structuredClone(demoGraph);
		g.me = { ...g.me, role: "viewer" };
		renderWithWorkspace(<PlanTab />, { graph: g, search: { lens: "place" } });
		const menu = within(cardOf(I.hands as string)).getByTestId(
			PLAN_TESTID.itemMenu,
		);
		fireEvent.keyDown(menu, { key: "Enter" });
		const move = screen.getByRole("menuitem", { name: /Move to day/ });
		expect(move).toHaveAttribute("data-disabled");
		expect(move.className).toMatch(/data-\[disabled\]:opacity-50/);
		expect(move.className).toMatch(/data-\[disabled\]:pointer-events-none/);
		expect(screen.getByRole("menuitem", { name: "Delete" })).toHaveAttribute(
			"data-disabled",
		);
	});

	it("VIS-07: no role=button in the Plan wraps focusable controls", () => {
		renderWithWorkspace(<PlanTab />, { search: { lens: "place" } });
		const root = screen.getByTestId(TESTID.planTab);
		const nested = [...root.querySelectorAll('[role="button"]')].filter((el) =>
			el.querySelector(
				'button, a[href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
			),
		);
		expect(nested.map((el) => el.getAttribute("aria-label"))).toEqual([]);
		// The keyboard entries: the day's date, the card's title, the leg's own button.
		expect(
			screen.getAllByRole("button", { name: /^Mon 4 Oct, Day 2/ }),
		).toHaveLength(1);
		expect(screen.getAllByRole("button", { name: "Senso-ji" })).toHaveLength(1);
		expect(
			screen.getAllByRole("button", {
				name: /^Travel Hands Shibuya → Shibuya Loft/,
			}),
		).toHaveLength(1);
	});

	it("VIS-07: the card title, the day date and the leg row select as before", () => {
		const { ws } = renderWithWorkspace(<PlanTab />, {
			search: { lens: "place" },
		});
		fireEvent.click(screen.getByRole("button", { name: "Senso-ji" }));
		expect(ws().sel).toEqual({ kind: "item", id: I.sensoji });
		fireEvent.click(
			screen.getByRole("button", {
				name: /^Travel Hands Shibuya → Shibuya Loft/,
			}),
		);
		expect(ws().sel).toMatchObject({
			kind: "leg",
			target: { kind: "pair", fromItemId: I.hands, toItemId: I.loft },
		});
		// FB-08: the date selects the day (it used to set the day filter).
		fireEvent.click(screen.getByRole("button", { name: /^Mon 4 Oct, Day 2/ }));
		expect(ws().sel).toEqual({ kind: "day", id: demoGraph.days[1]?.id });
		expect(ws().days).toBeNull();
	});

	it("MT-09: hovering a card or a leg row lights it on the map", () => {
		useUi.getState().setHover(null);
		renderWithWorkspace(<PlanTab />, { search: { lens: "place" } });
		const title = screen.getByRole("button", { name: "Hands Shibuya" });
		fireEvent.mouseEnter(title);
		expect(useUi.getState().hover).toEqual({ kind: "item", id: I.hands });
		fireEvent.mouseLeave(title);
		expect(useUi.getState().hover).toBeNull();
		const leg = screen.getByRole("button", {
			name: /^Travel Hands Shibuya → Shibuya Loft/,
		});
		fireEvent.mouseEnter(leg);
		expect(useUi.getState().hover).toEqual({
			kind: "pair",
			id: `${I.hands}>${I.loft}`,
		});
		fireEvent.mouseLeave(leg);
		expect(useUi.getState().hover).toBeNull();
	});

	it("CONTENT-03: leg and flight rows show their own todo/media counts", () => {
		const L = demo.L;
		const counts = {
			root: ZERO,
			byNode: {},
			byItem: {},
			byDay: {},
			byLeg: {
				[L.fuji as string]: { ...ZERO, todoOpen: 3, todo: 3 },
				[L.flight as string]: { ...ZERO, media: 2 },
			},
		};
		renderWithWorkspace(<PlanTab />, { counts, search: { lens: "place" } });
		const bundles = screen.getAllByTestId(PLAN_TESTID.legBundles);
		expect(bundles).toHaveLength(2);
		expect(screen.getByRole("img", { name: "3 open todos" })).toBeTruthy();
		const stub = screen.getByTestId(PLAN_TESTID.flightStub);
		expect(within(stub).getByRole("img", { name: "2 media" })).toBeTruthy();
	});

	it("PLAN-I2-19 / MT-10: an overnight train row shows its time on board, class and berths", () => {
		const g = structuredClone(demoGraph);
		const fuji = g.legs.find((l) => l.id === demo.L.fuji);
		if (!fuji) throw new Error("no leg");
		fuji.mode = "transit";
		fuji.depAt = "2027-10-04T12:35:00.000Z"; // 21:35 JST
		fuji.arrAt = "2027-10-04T20:30:00.000Z"; // 05:30 JST, 5 Oct
		fuji.details = {
			kind: "transit",
			fixed: {
				departLocal: "2027-10-04T21:35",
				arriveLocal: "2027-10-05T05:30",
				fromTz: "Asia/Tokyo",
				toTz: "Asia/Tokyo",
				accessMin: 10,
				egressMin: 0,
			},
			booking: {
				trainNumber: "SP3",
				class: "Soft sleeper 4-berth",
				car: "6",
				seats: [{ seat: "1" }, { seat: "2" }],
				ref: "VNR-26X8",
			},
		};
		renderWithWorkspace(<PlanTab />, { graph: g, search: { lens: "place" } });
		const row = screen
			.getAllByTestId(TESTID.leg)
			.find(
				(r) =>
					/SP3/.test(r.textContent ?? "") &&
					!/continued/.test(r.textContent ?? ""),
			);
		const text = (row?.textContent ?? "").replace(/\s+/g, " ");
		expect(text).toMatch(/SP3\s*dep 21:35 → 05:30\+1\s*· 7h 55m/);
		expect(text).toMatch(/· Soft sleeper 4-berth/);
		expect(text).toMatch(/· Car 6\s*· Berths 1, 2/);
		expect(text).toMatch(/ref VNR-26X8/);
	});

	it("PLAN-I2-02: the day summary ends in the last stop's zone", () => {
		const TPE = {
			iata: "TPE",
			tz: "Asia/Taipei",
			country: "TW",
			at: [25.08, 121.23] as [number, number],
		};
		const KIX = {
			iata: "KIX",
			tz: "Asia/Tokyo",
			country: "JP",
			at: [34.43, 135.23] as [number, number],
		};
		const sc = scenario({
			days: [
				{
					items: [
						{ k: "kix", node: "kix", min: 120 },
						{ k: "tpe", node: "tpe", min: 60 },
					],
				},
			],
			legs: [
				{
					from: "kix",
					to: "tpe",
					mode: "flight",
					dep: ["2027-10-03T14:00", "Asia/Tokyo"],
					arr: ["2027-10-03T16:30", "Asia/Taipei"],
					details: flightDetails({
						number: "CI 157",
						from: KIX,
						to: TPE,
						dep: "2027-10-03T14:00",
						arr: "2027-10-03T16:30",
					}),
				},
			],
		});
		renderWithWorkspace(<PlanTab />, {
			graph: sc.graph,
			search: { lens: "place" },
		});
		// 16:30 CST landing, then the 60 min TPE stop (the arrival time, FB-19a).
		const tpe = cardOf(sc.I.tpe as string);
		expect(within(tpe).getByTestId(TESTID.itemEnd).textContent).toBe("17:30");
		expect(screen.getByTestId(PLAN_TESTID.daySummary).textContent).toMatch(
			/ends 17:30/,
		);
	});

	it("COLLAB-6: a deleted item says who deleted it and offers Close", async () => {
		const queryClient = new QueryClient({
			defaultOptions: { queries: { retry: false, staleTime: Infinity } },
		});
		const gone = "00000000-0000-7000-8000-00000000ffff";
		queryClient.setQueryData(
			activityQuery(demoGraph.trip.id, { itemId: gone }).queryKey,
			[
				{
					id: "1",
					at: "2027-10-01T10:00:00.000Z",
					actorName: "Audrey",
					actorColor: 1,
					actorIsGuest: false,
					summary: "deleted Tue Lunch",
					nodeId: null,
					legId: null,
					itemId: gone,
					dayId: null,
				},
			],
		);
		const { ws } = renderWithWorkspace(<ItemOverview itemId={gone} />, {
			mode: "live",
			queryClient,
			search: { sel: `i.${gone}` },
		});
		const box = await screen.findByTestId(PLAN_TESTID.overviewDeleted);
		expect(box.textContent).toMatch(
			/This item was deleted by Audrey \(Tue Lunch\)\./,
		);
		fireEvent.click(within(box).getByRole("button", { name: "Close" }));
		expect(ws().sel).toBeNull();
	});

	it("VIS-04: phone day chips have a 44px hit area around the 32px pill", () => {
		renderWithWorkspace(<DayChips />);
		const chip = screen.getByRole("button", { name: /^Day 1,/ });
		expect(chip.className).toMatch(/\bh-11\b/);
		expect(chip.className).toMatch(/\bmin-w-11\b/);
		expect(chip.querySelector("span")?.className).toMatch(/\bh-8\b/);
	});
});
