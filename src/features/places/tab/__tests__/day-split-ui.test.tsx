/**
 * The day split on the Schedule step: before any day has a city, the trip's
 * days shared between the cities (− / +, who still rates, Use these days);
 * with no dates, a way to set them; afterwards "Days: …" with Change, which
 * confirms in the panel before places go back to the list.
 */
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { DaySpec } from "@/lib/engine/__fixtures__/demo";
import type { GraphNode, Priority, TripGraph } from "@/lib/engine/types";
import { DEMO_MEMBERS, scenario } from "@/lib/fixtures/demo";
import { useUi } from "@/lib/workspace/ui-store";
import { renderWithWorkspace } from "@/test/render-workspace";
import { splitOverrides } from "../DaySplit";
import { PlacesTab } from "../PlacesTab";
import { PLACES_TAB_TESTID as T } from "../testids";

const fns = vi.hoisted(() => ({
	setDayStay: vi.fn(async (_: { data: unknown }) => ({ dayIds: [] })),
	moveItem: vi.fn(async (_: { data: unknown }) => ({ detachedLegIds: [] })),
}));
vi.mock("@/functions/days.functions", async (orig) => ({
	...(await orig<typeof import("@/functions/days.functions")>()),
	setDayStay: fns.setDayStay,
}));
vi.mock("@/functions/items.functions", async (orig) => ({
	...(await orig<typeof import("@/functions/items.functions")>()),
	moveItem: fns.moveItem,
}));

beforeAll(() => {
	const g = globalThis as unknown as Record<string, unknown>;
	class Noop {
		observe() {}
		unobserve() {}
		disconnect() {}
		takeRecords() {
			return [];
		}
	}
	g.ResizeObserver ??= Noop;
	g.IntersectionObserver ??= Noop;
});

afterEach(() => {
	fns.setDayStay.mockClear();
	fns.moveItem.mockClear();
	splitOverrides.clear();
	useUi.getState().resetUi();
});

const D = DEMO_MEMBERS.dennis;

/**
 * Sat 2 – Mon 11 Oct (10 days). Tokyo: four 12-hour places Dennis rated
 * Must (4 days); Kyoto: one (1 day); Osaka: one nobody rated.
 */
function trip(days: DaySpec[]) {
	const place = (key: string, parent: string, at: [number, number]) => ({
		key,
		parent,
		type: "place" as const,
		category: "sight" as const,
		name: key.toUpperCase(),
		at,
		timeNeededMin: 720,
	});
	const s = scenario({
		firstDate: "2027-10-02",
		days,
		nodes: [
			place("t1", "tokyo", [35.66, 139.7]),
			place("t2", "tokyo", [35.67, 139.71]),
			place("t3", "tokyo", [35.68, 139.72]),
			place("t4", "tokyo", [35.69, 139.73]),
			place("k1", "kyoto", [35.0, 135.77]),
			place("o1", "osaka", [34.69, 135.5]),
		],
	});
	const must = new Set(["t1", "t2", "t3", "t4", "k1"]);
	const nodes: GraphNode[] = s.graph.nodes.map((n) => {
		const key = Object.keys(s.N).find((k) => s.N[k] === n.id) ?? "";
		return must.has(key)
			? { ...n, priorities: { [D]: "must" as Priority } }
			: n;
	});
	return { s, graph: { ...s.graph, nodes } as TripGraph };
}

const empty = (n: number): DaySpec[] =>
	Array.from({ length: n }, () => ({ items: [] }));

const rowOf = (name: string) =>
	screen
		.getAllByTestId(T.splitRow)
		.find((r) => r.textContent?.startsWith(name)) as HTMLElement;

const schedule = (graph: TripGraph) =>
	renderWithWorkspace(<PlacesTab />, {
		graph,
		search: { tab: "places", pv: "schedule" },
	});

describe("the day split (no day has a city yet)", () => {
	it("the trip's days per city, who still rates, the rest unused", () => {
		const { graph } = trip(empty(10));
		schedule(graph);
		expect(screen.getByTestId(T.schedule)).toHaveAttribute(
			"data-mode",
			"split",
		);
		const split = screen.getByTestId(T.split);
		expect(within(split).getByRole("heading")).toHaveTextContent(
			"10 days, Sat 2 – Mon 11 Oct",
		);
		expect(
			screen
				.getAllByTestId(T.splitRow)
				.map((r) => [r.textContent?.match(/^[A-Za-z]+/)?.[0], r.dataset.days]),
		).toEqual([
			["Tokyo", "4"],
			["Kyoto", "1"],
			["Osaka", "0"],
		]);
		// The demo's seven Tokyo places are unrated; Audrey rated nothing.
		expect(rowOf("Tokyo")).toHaveTextContent(
			"4 shortlisted · 11 not rated yet",
		);
		expect(rowOf("Osaka")).toHaveTextContent("0 shortlisted · 1 not rated yet");
		expect(screen.getByTestId(T.splitRate)).toHaveTextContent(
			"You have 9 places to rate and Audrey 14. These days will change as you rate.",
		);
		expect(screen.getByTestId(T.splitUnused)).toHaveTextContent(
			"5 days not used",
		);
		expect(screen.queryByTestId(T.splitOver)).toBeNull();
	});

	it("a city opens to its places: the shortlist with time and score, then what's left to rate", () => {
		const { graph } = trip(empty(10));
		const { ws } = schedule(graph);
		const tokyo = rowOf("Tokyo");
		expect(within(tokyo).queryByTestId(T.splitPlaces)).toBeNull();
		fireEvent.click(within(tokyo).getByTestId(T.splitExpand));
		const places = within(tokyo).getByTestId(T.splitPlaces);
		expect(places).toHaveTextContent("About 48h of sights on the shortlist");
		const listed = within(places).getAllByTestId(T.splitPlace);
		expect(listed.map((b) => b.textContent?.slice(0, 2)).sort()).toEqual([
			"T1",
			"T2",
			"T3",
			"T4",
		]);
		expect(places).toHaveTextContent(/Not rated yet:/);
		// A place opens its details.
		fireEvent.click(listed[0] as HTMLElement);
		expect(ws().sel?.kind).toBe("node");
		// Osaka: nothing shortlisted, all to rate.
		fireEvent.click(within(rowOf("Osaka")).getByTestId(T.splitExpand));
		expect(within(rowOf("Osaka")).getByTestId(T.splitPlaces)).toHaveTextContent(
			/Nothing shortlisted here yet\..*Not rated yet: O1/,
		);
	});

	it("Rate opens the Rate step", () => {
		const { graph } = trip(empty(10));
		const { navigations } = schedule(graph);
		fireEvent.click(
			within(screen.getByTestId(T.splitRate)).getByRole("button", {
				name: "Rate",
			}),
		);
		expect(navigations.at(-1)?.search.pv).toBe("rate");
	});

	it("+ takes an unused day, − gives it back; + stops when none are left", () => {
		const { graph } = trip(empty(6));
		schedule(graph);
		expect(screen.getByTestId(T.splitUnused)).toHaveTextContent(
			"1 day not used",
		);
		fireEvent.click(within(rowOf("Osaka")).getByTestId(T.splitPlus));
		expect(rowOf("Osaka")).toHaveAttribute("data-days", "1");
		expect(screen.getByTestId(T.splitUnused)).toHaveTextContent(
			"No free days left. Take one from another city first.",
		);
		for (const b of screen.getAllByTestId(T.splitPlus))
			expect(b).toBeDisabled();
		fireEvent.click(within(rowOf("Tokyo")).getByTestId(T.splitMinus));
		expect(rowOf("Tokyo")).toHaveAttribute("data-days", "3");
		expect(screen.getByTestId(T.splitUnused)).toHaveTextContent(
			"1 day not used",
		);
	});

	it("too long: scaled down, and says so", () => {
		const { graph } = trip(empty(4));
		schedule(graph);
		expect(screen.getByTestId(T.splitOver)).toHaveTextContent(
			"Your shortlist needs about 5 days, and you have 4. Remove a city or some places.",
		);
		expect(rowOf("Tokyo")).toHaveAttribute("data-days", "3");
		expect(rowOf("Kyoto")).toHaveAttribute("data-days", "1");
	});

	it("Use these days: each city's nights in turn from the first day", async () => {
		const { s, graph } = trip(empty(10));
		schedule(graph);
		fireEvent.click(within(rowOf("Osaka")).getByTestId(T.splitPlus));
		fireEvent.click(screen.getByTestId(T.splitUse));
		await waitFor(() => expect(fns.setDayStay).toHaveBeenCalledTimes(3));
		expect(fns.setDayStay.mock.calls.map((c) => c[0].data)).toEqual([
			{ fromDayId: s.D.d1, toDayId: s.D.d4, nodeId: s.N.tokyo },
			{ fromDayId: s.D.d5, toDayId: s.D.d5, nodeId: s.N.kyoto },
			{ fromDayId: s.D.d6, toDayId: s.D.d6, nodeId: s.N.osaka },
		]);
		expect(fns.moveItem).not.toHaveBeenCalled();
	});

	it("people who can't edit see it read-only", () => {
		const { graph } = trip(empty(10));
		schedule({
			...graph,
			me: { ...graph.me, role: "viewer" },
			members: graph.members.map((m) =>
				m.id === D ? { ...m, role: "viewer" as const } : m,
			),
		});
		expect(screen.getAllByTestId(T.splitRow)).toHaveLength(3);
		expect(screen.queryByTestId(T.splitPlus)).toBeNull();
		expect(screen.queryByTestId(T.splitMinus)).toBeNull();
		expect(screen.queryByTestId(T.splitUse)).toBeNull();
	});

	it("no dates: pick them first", () => {
		const { graph } = trip([]);
		schedule(graph);
		const box = screen.getByTestId(T.scheduleNoDates);
		expect(box).toHaveTextContent("Pick your trip dates first");
		fireEvent.click(within(box).getByRole("button", { name: "Set dates" }));
		expect(useUi.getState().settingsOpen).toBe(true);
		expect(screen.queryByTestId(T.split)).toBeNull();
	});
});

describe("once days have cities", () => {
	/** Tokyo Sat 2 – Sun 3 (T1 on the 3rd), Kyoto Mon 4 – Tue 5 (the day you leave). */
	const planned = () =>
		trip([
			{ night: "tokyo", items: [] },
			{ night: "tokyo", items: [{ k: "t1", node: "t1" }] },
			{ night: "kyoto", items: [] },
			{ items: [] },
		]);

	it("the list, under the days line and a plain intro", () => {
		const { graph } = planned();
		schedule(graph);
		expect(screen.getByTestId(T.schedule)).toHaveAttribute(
			"data-mode",
			"schedule",
		);
		expect(screen.getByTestId(T.splitDays)).toHaveTextContent(
			"Days: Tokyo 2 · Kyoto 2",
		);
		const intro = screen.getByTestId(T.scheduleIntro);
		expect(intro).toHaveTextContent("Put your shortlist on days");
		expect(intro).toHaveTextContent(
			"Each place lists the days you're in its city. The button adds it to the best one.",
		);
		expect(screen.getAllByTestId(T.scheduleWindow).length).toBeGreaterThan(0);
	});

	it("Change → − on Tokyo: confirm in the panel, then T1 goes back and Kyoto moves up", async () => {
		const { s, graph } = planned();
		schedule(graph);
		fireEvent.click(screen.getByTestId(T.splitChange));
		// Prefilled from the days, then the cities with no days.
		expect(
			screen.getAllByTestId(T.splitRow).map((r) => r.dataset.days),
		).toEqual(["2", "2", "0"]);
		expect(screen.getByTestId(T.splitUnused)).toHaveTextContent(
			"No free days left. Take one from another city first.",
		);
		fireEvent.click(within(rowOf("Tokyo")).getByTestId(T.splitMinus));
		fireEvent.click(screen.getByTestId(T.splitApply));
		expect(screen.getByTestId(T.splitConfirm)).toHaveTextContent(
			"1 place is on a day that moves to another city. It'll go back to your list to schedule again.",
		);
		expect(fns.moveItem).not.toHaveBeenCalled();
		fireEvent.click(
			within(screen.getByTestId(T.splitConfirm)).getByTestId(T.splitApply),
		);
		await waitFor(() => expect(fns.setDayStay).toHaveBeenCalledTimes(1));
		expect(fns.moveItem.mock.calls.map((c) => c[0].data)).toEqual([
			{ itemId: s.I.t1, dayId: null },
		]);
		expect(fns.setDayStay.mock.calls[0]?.[0].data).toEqual({
			fromDayId: s.D.d2,
			toDayId: s.D.d2,
			nodeId: s.N.kyoto,
		});
		await waitFor(() =>
			expect(screen.queryByTestId(T.splitConfirm)).toBeNull(),
		);
	});

	it("Cancel in the confirm keeps the panel; nothing is written", () => {
		const { graph } = planned();
		schedule(graph);
		fireEvent.click(screen.getByTestId(T.splitChange));
		fireEvent.click(within(rowOf("Tokyo")).getByTestId(T.splitMinus));
		fireEvent.click(screen.getByTestId(T.splitApply));
		fireEvent.click(
			within(screen.getByTestId(T.splitConfirm)).getByTestId(T.splitCancel),
		);
		expect(screen.queryByTestId(T.splitConfirm)).toBeNull();
		expect(rowOf("Tokyo")).toHaveAttribute("data-days", "1");
		expect(fns.setDayStay).not.toHaveBeenCalled();
		expect(fns.moveItem).not.toHaveBeenCalled();
	});
});
