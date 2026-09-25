/**
 * How long in each city, at the top of the Plan: before any day has a city,
 * the trip's days shared between the cities (numbered stops under their
 * country, − / +, reordering, who still rates, Use these days); with no
 * dates, about how many days and the first one; afterwards "Tokyo 2 days ·
 * Kyoto 2" with Change, which confirms in the panel before places go back
 * to the list. The map gets the stops in order while it's open. And the
 * Places tab's Schedule step: what the shortlist needs until then.
 */
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { PlacesTab } from "@/features/places/tab/PlacesTab";
import { PLACES_TAB_TESTID as P } from "@/features/places/tab/testids";
import { PlanTab } from "@/features/plan/PlanTab";
import type { DaySpec } from "@/lib/engine/__fixtures__/demo";
import type { GraphNode, Priority, TripGraph } from "@/lib/engine/types";
import { DEMO_MEMBERS, scenario } from "@/lib/fixtures/demo";
import { useUi } from "@/lib/workspace/ui-store";
import { renderWithWorkspace } from "@/test/render-workspace";
import { splitDrafts } from "../DaySplit";
import { SPLIT_TESTID as T } from "../testids";

const fns = vi.hoisted(() => ({
	setDayStay: vi.fn(async (_: { data: unknown }) => ({ dayIds: [] })),
	moveItem: vi.fn(async (_: { data: unknown }) => ({ detachedLegIds: [] })),
	setTripDates: vi.fn(
		async (_: { data: unknown }): Promise<unknown> => ({
			ok: true,
			version: 2,
		}),
	),
	getTripGraph: vi.fn(async (_: { data: unknown }): Promise<unknown> => null),
}));
vi.mock("@/functions/days.functions", async (orig) => ({
	...(await orig<typeof import("@/functions/days.functions")>()),
	setDayStay: fns.setDayStay,
}));
vi.mock("@/functions/items.functions", async (orig) => ({
	...(await orig<typeof import("@/functions/items.functions")>()),
	moveItem: fns.moveItem,
}));
vi.mock("@/functions/trips.functions", async (orig) => ({
	...(await orig<typeof import("@/functions/trips.functions")>()),
	setTripDates: fns.setTripDates,
}));
vi.mock("@/functions/graph.functions", async (orig) => ({
	...(await orig<typeof import("@/functions/graph.functions")>()),
	getTripGraph: fns.getTripGraph,
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
	for (const f of Object.values(fns)) f.mockClear();
	splitDrafts.clear();
	useUi.getState().resetUi();
});

const D = DEMO_MEMBERS.dennis;

/**
 * From Sat 2 Oct 2027. Tokyo: four 12-hour places Dennis rated Must (4
 * days), two in Shibuya; Kyoto: one (1 day); Osaka: one nobody rated.
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
			place("t1", "shibuya", [35.66, 139.7]),
			place("t2", "shibuya", [35.67, 139.71]),
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

const rows = () => screen.getAllByTestId(T.splitRow);
const rowOf = (cityId: string | undefined) =>
	rows().find((r) => r.dataset.city === cityId) as HTMLElement;
const shape = () =>
	rows().map((r) => [
		r.dataset.city,
		r.dataset.days,
		within(r).getByTestId(T.stop).textContent,
	]);

const plan = (graph: TripGraph) =>
	renderWithWorkspace(<PlanTab />, { graph, search: { tab: "plan" } });

const asRole = (graph: TripGraph, role: "viewer" | "suggester"): TripGraph => ({
	...graph,
	me: { ...graph.me, role },
	members: graph.members.map((m) => (m.id === D ? { ...m, role } : m)),
});

describe("how long in each city (no day has a city yet)", () => {
	it("the days per city, the spare ones shared out, numbered under their country; who still rates", () => {
		const { s, graph } = trip(empty(10));
		plan(graph);
		const split = screen.getByTestId(T.split);
		expect(within(split).getByRole("heading")).toHaveTextContent(
			"How long in each city?",
		);
		expect(split).toHaveTextContent(
			"Based on your shortlist. Change the days, reorder the stops, then use them.",
		);
		expect(split).toHaveTextContent("10 days, Sat 2 – Mon 11 Oct");
		// Tokyo needs 4, Kyoto 1; the 5 spare days go in turn, Tokyo first.
		expect(shape()).toEqual([
			[s.N.tokyo, "7", "1"],
			[s.N.kyoto, "3", "2"],
			[s.N.osaka, "0", ""],
		]);
		expect(screen.getAllByTestId(T.heading).map((h) => h.textContent)).toEqual([
			"Japan · 10 days",
		]);
		// The demo's seven Tokyo places are unrated; Audrey rated nothing.
		expect(rowOf(s.N.tokyo)).toHaveTextContent(
			"4 shortlisted · 11 not rated yet",
		);
		expect(rowOf(s.N.osaka)).toHaveTextContent(
			"0 shortlisted · 1 not rated yet",
		);
		expect(screen.getByTestId(T.splitRate)).toHaveTextContent(
			"You have 9 places to rate and Audrey 14. These days will change as you rate.",
		);
		expect(screen.getByTestId(T.splitUnused)).toHaveTextContent(
			"No free days left. Take one from another city first.",
		);
		expect(screen.queryByTestId(T.splitOver)).toBeNull();
	});

	it("a city opens to its places by area, with their time; one area gets no heading", () => {
		const { s, graph } = trip(empty(10));
		const { ws } = plan(graph);
		const tokyo = rowOf(s.N.tokyo);
		expect(within(tokyo).queryByTestId(T.splitPlaces)).toBeNull();
		fireEvent.click(within(tokyo).getByTestId(T.splitExpand));
		const places = within(tokyo).getByTestId(T.splitPlaces);
		expect(places).toHaveTextContent("About 48h of sights on the shortlist");
		const areas = within(places).getAllByTestId(T.area);
		expect(areas.map((a) => a.firstChild?.textContent)).toEqual([
			"Shibuya · 24h",
			"Elsewhere in Tokyo · 24h",
		]);
		expect(
			within(areas[0] as HTMLElement)
				.getAllByTestId(T.splitPlace)
				.map((b) => b.textContent?.slice(0, 2)),
		).toEqual(["T1", "T2"]);
		expect(places).toHaveTextContent(/Not rated yet:/);
		fireEvent.click(within(places).getAllByTestId(T.splitPlace)[0] as Element);
		expect(ws().sel?.kind).toBe("node");
		// Kyoto: one place right under the city, no area heading.
		fireEvent.click(within(rowOf(s.N.kyoto)).getByTestId(T.splitExpand));
		const kyoto = within(rowOf(s.N.kyoto)).getByTestId(T.splitPlaces);
		expect(within(kyoto).queryByTestId(T.area)).toBeNull();
		expect(within(kyoto).getAllByTestId(T.splitPlace)).toHaveLength(1);
		// Osaka: nothing shortlisted, all to rate.
		fireEvent.click(within(rowOf(s.N.osaka)).getByTestId(T.splitExpand));
		expect(
			within(rowOf(s.N.osaka)).getByTestId(T.splitPlaces),
		).toHaveTextContent(/Nothing shortlisted here yet\..*Not rated yet: O1/);
	});

	it("Rate opens the Places tab's Rate step, for the whole trip", () => {
		const { graph } = trip(empty(10));
		const { navigations } = plan(graph);
		fireEvent.click(
			within(screen.getByTestId(T.splitRate)).getByRole("button", {
				name: "Rate",
			}),
		);
		expect(navigations.at(-1)?.search).toMatchObject({
			tab: "places",
			pv: "rate",
		});
		expect(navigations.at(-1)?.splat).toBe("");
	});

	it("− leaves a day not planned yet, + takes it; + waits for a free day", () => {
		const { s, graph } = trip(empty(6));
		plan(graph);
		// Tokyo 5 (4 + the spare day), Kyoto 1.
		expect(rowOf(s.N.tokyo)).toHaveAttribute("data-days", "5");
		for (const b of screen.getAllByTestId(T.splitPlus))
			expect(b).toBeDisabled();
		fireEvent.click(within(rowOf(s.N.tokyo)).getByTestId(T.splitMinus));
		expect(rowOf(s.N.tokyo)).toHaveAttribute("data-days", "4");
		expect(screen.getByTestId(T.splitUnused)).toHaveTextContent(
			"1 day not planned yet",
		);
		fireEvent.click(within(rowOf(s.N.osaka)).getByTestId(T.splitPlus));
		expect(rowOf(s.N.osaka)).toHaveAttribute("data-days", "1");
		expect(rowOf(s.N.osaka)).toHaveAttribute("data-stop", "3");
		expect(screen.getByTestId(T.splitUnused)).toHaveTextContent(
			"No free days left. Take one from another city first.",
		);
	});

	it("too long: scaled down, and says so", () => {
		const { s, graph } = trip(empty(4));
		plan(graph);
		expect(screen.getByTestId(T.splitOver)).toHaveTextContent(
			"Your shortlist needs about 5 days, and you have 4. Remove a city or some places.",
		);
		expect(rowOf(s.N.tokyo)).toHaveAttribute("data-days", "3");
		expect(rowOf(s.N.kyoto)).toHaveAttribute("data-days", "1");
	});

	it("Move up / Move down reorder the stops; the numbers, the map and Use these days follow", async () => {
		const { s, graph } = trip(empty(10));
		plan(graph);
		expect(
			useUi.getState().splitRoute?.map((x) => [x.name, x.stop, x.days]),
		).toEqual([
			["Tokyo", 1, 7],
			["Kyoto", 2, 3],
		]);
		const kyoto = rowOf(s.N.kyoto);
		fireEvent.pointerDown(within(kyoto).getByTestId(T.menu), {
			button: 0,
			pointerType: "mouse",
		});
		fireEvent.click(await screen.findByTestId(T.moveUp));
		expect(shape()).toEqual([
			[s.N.kyoto, "3", "1"],
			[s.N.tokyo, "7", "2"],
			[s.N.osaka, "0", ""],
		]);
		expect(useUi.getState().splitRoute?.map((x) => x.name)).toEqual([
			"Kyoto",
			"Tokyo",
		]);
		// Down past Osaka: Kyoto has days, so it's still a stop (the last).
		fireEvent.pointerDown(within(rowOf(s.N.kyoto)).getByTestId(T.menu), {
			button: 0,
			pointerType: "mouse",
		});
		expect(await screen.findByTestId(T.moveUp)).toHaveAttribute(
			"data-disabled",
		);
		fireEvent.click(screen.getByTestId(T.moveDown));
		expect(shape().map((r) => r[0])).toEqual([s.N.tokyo, s.N.kyoto, s.N.osaka]);
		fireEvent.pointerDown(within(rowOf(s.N.tokyo)).getByTestId(T.menu), {
			button: 0,
			pointerType: "mouse",
		});
		fireEvent.click(await screen.findByTestId(T.moveDown));
		// Kept while the page is open, like − / +.
		expect(splitDrafts.get(graph.trip.id)?.order).toEqual([
			s.N.kyoto,
			s.N.tokyo,
			s.N.osaka,
		]);
		fireEvent.click(screen.getByTestId(T.splitUse));
		await waitFor(() => expect(fns.setDayStay).toHaveBeenCalledTimes(2));
		expect(fns.setDayStay.mock.calls.map((c) => c[0].data)).toEqual([
			{ fromDayId: s.D.d1, toDayId: s.D.d3, nodeId: s.N.kyoto },
			{ fromDayId: s.D.d4, toDayId: s.D.d9, nodeId: s.N.tokyo },
		]);
	});

	it("Use these days: each city's nights in turn from the first day", async () => {
		const { s, graph } = trip(empty(10));
		plan(graph);
		fireEvent.click(within(rowOf(s.N.tokyo)).getByTestId(T.splitMinus));
		fireEvent.click(within(rowOf(s.N.osaka)).getByTestId(T.splitPlus));
		fireEvent.click(screen.getByTestId(T.splitUse));
		await waitFor(() => expect(fns.setDayStay).toHaveBeenCalledTimes(3));
		// Every day used: the last one is the day you leave Osaka.
		expect(fns.setDayStay.mock.calls.map((c) => c[0].data)).toEqual([
			{ fromDayId: s.D.d1, toDayId: s.D.d6, nodeId: s.N.tokyo },
			{ fromDayId: s.D.d7, toDayId: s.D.d9, nodeId: s.N.kyoto },
			{ fromDayId: s.D.d10, toDayId: s.D.d10, nodeId: s.N.osaka },
		]);
		expect(fns.moveItem).not.toHaveBeenCalled();
	});

	it("people who can't edit see it read-only", () => {
		const { graph } = trip(empty(10));
		plan(asRole(graph, "viewer"));
		expect(rows()).toHaveLength(3);
		expect(
			within(screen.getByTestId(T.split)).getByText("Based on your shortlist."),
		).toBeInTheDocument();
		for (const id of [T.splitPlus, T.splitMinus, T.splitUse, T.handle, T.menu])
			expect(screen.queryByTestId(id)).toBeNull();
	});

	it("the map goes back to normal when the Plan closes", () => {
		const { graph } = trip(empty(10));
		const { unmount } = plan(graph);
		expect(useUi.getState().splitRoute).toHaveLength(2);
		unmount();
		expect(useUi.getState().splitRoute).toBeNull();
	});
});

describe("no dates yet", () => {
	/** The trip once its dates are set: six new days. */
	const dated = (graph: TripGraph) => {
		const d = trip(empty(6)).graph;
		return { ...graph, days: d.days };
	};

	it("about how many days, then the split; the first day sets the dates and the nights in one go", async () => {
		const { s, graph } = trip([]);
		const after = dated(graph);
		fns.getTripGraph.mockResolvedValueOnce(after);
		splitDrafts.set(graph.trip.id, { start: "2027-10-02" });
		plan(graph);
		const split = screen.getByTestId(T.split);
		expect(within(split).getByRole("heading")).toHaveTextContent(
			"How long in each city?",
		);
		expect(split).toHaveTextContent("About how many days?");
		expect(split).toHaveTextContent("Your shortlist needs about 5 days.");
		expect(screen.queryByTestId(T.splitRow)).toBeNull();
		fireEvent.change(screen.getByTestId(T.tripDays), {
			target: { value: "6" },
		});
		expect(shape()).toEqual([
			[s.N.tokyo, "5", "1"],
			[s.N.kyoto, "1", "2"],
			[s.N.osaka, "0", ""],
		]);
		expect(split).toHaveTextContent("Starting on");
		fireEvent.click(screen.getByTestId(T.splitUse));
		await waitFor(() => expect(fns.setDayStay).toHaveBeenCalledTimes(2));
		expect(fns.setTripDates.mock.calls[0]?.[0].data).toMatchObject({
			tripId: graph.trip.id,
			startDate: "2027-10-02",
			endDate: "2027-10-07",
		});
		const [d1, , , , d5, d6] = after.days.map((d) => d.id);
		expect(fns.setDayStay.mock.calls.map((c) => c[0].data)).toEqual([
			{ fromDayId: d1, toDayId: d5, nodeId: s.N.tokyo },
			{ fromDayId: d6, toDayId: d6, nodeId: s.N.kyoto },
		]);
		expect(splitDrafts.has(graph.trip.id)).toBe(false);
	});

	it("out of range, or no first day yet: nothing to use", () => {
		const { graph } = trip([]);
		plan(graph);
		fireEvent.change(screen.getByTestId(T.tripDays), {
			target: { value: "61" },
		});
		expect(screen.queryByTestId(T.splitRow)).toBeNull();
		fireEvent.change(screen.getByTestId(T.tripDays), {
			target: { value: "9" },
		});
		expect(rows()).toHaveLength(3);
		expect(screen.getByTestId(T.splitUse)).toBeDisabled();
	});

	it("suggesting: says the dates are only suggested, and sets no nights", async () => {
		const { graph } = trip([]);
		fns.setTripDates.mockResolvedValueOnce({
			proposed: { id: "p1", summary: "Change the trip dates" },
		});
		splitDrafts.set(graph.trip.id, { start: "2027-10-02", tripDays: 6 });
		plan(asRole(graph, "suggester"));
		expect(screen.getByTestId(T.suggestNote)).toHaveTextContent(
			"You're suggesting, so this suggests the dates only. Once they're accepted, come back here to use these days.",
		);
		const use = screen.getByTestId(T.splitUse);
		expect(use).toHaveTextContent("Suggest these dates");
		fireEvent.click(use);
		await waitFor(() => expect(fns.setTripDates).toHaveBeenCalledTimes(1));
		await waitFor(() => expect(use).toBeEnabled());
		expect(fns.getTripGraph).not.toHaveBeenCalled();
		expect(fns.setDayStay).not.toHaveBeenCalled();
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

	it("one line at the top with Change; the map stays normal", () => {
		const { graph } = planned();
		plan(graph);
		expect(screen.getByTestId(T.splitDays)).toHaveTextContent(
			"Tokyo 2 days · Kyoto 2",
		);
		expect(screen.queryByTestId(T.split)).toBeNull();
		expect(screen.queryByTestId(T.splitRow)).toBeNull();
		expect(useUi.getState().splitRoute).toBeNull();
	});

	it("Change → − on Tokyo: confirm in the panel, then T1 goes back and Kyoto moves up", async () => {
		const { s, graph } = planned();
		plan(graph);
		fireEvent.click(screen.getByTestId(T.splitChange));
		// Prefilled from the days, then the cities with no days.
		expect(shape()).toEqual([
			[s.N.tokyo, "2", "1"],
			[s.N.kyoto, "2", "2"],
			[s.N.osaka, "0", ""],
		]);
		expect(useUi.getState().splitRoute?.map((x) => x.name)).toEqual([
			"Tokyo",
			"Kyoto",
		]);
		expect(screen.getByTestId(T.splitUnused)).toHaveTextContent(
			"No free days left. Take one from another city first.",
		);
		fireEvent.click(within(rowOf(s.N.tokyo)).getByTestId(T.splitMinus));
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
		expect(useUi.getState().splitRoute).toBeNull();
	});

	it("Change → Kyoto first: the days swap, T1's day becomes Kyoto's", async () => {
		const { s, graph } = planned();
		plan(graph);
		fireEvent.click(screen.getByTestId(T.splitChange));
		fireEvent.pointerDown(within(rowOf(s.N.kyoto)).getByTestId(T.menu), {
			button: 0,
			pointerType: "mouse",
		});
		fireEvent.click(await screen.findByTestId(T.moveUp));
		expect(shape().map((r) => r[0])).toEqual([s.N.kyoto, s.N.tokyo, s.N.osaka]);
		fireEvent.click(screen.getByTestId(T.splitApply));
		fireEvent.click(
			within(screen.getByTestId(T.splitConfirm)).getByTestId(T.splitApply),
		);
		await waitFor(() => expect(fns.setDayStay).toHaveBeenCalledTimes(2));
		expect(fns.moveItem.mock.calls.map((c) => c[0].data)).toEqual([
			{ itemId: s.I.t1, dayId: null },
		]);
		expect(fns.setDayStay.mock.calls.map((c) => c[0].data)).toEqual([
			{ fromDayId: s.D.d1, toDayId: s.D.d2, nodeId: s.N.kyoto },
			{ fromDayId: s.D.d3, toDayId: s.D.d3, nodeId: s.N.tokyo },
		]);
	});

	it("Cancel in the confirm keeps the panel; nothing is written", () => {
		const { s, graph } = planned();
		plan(graph);
		fireEvent.click(screen.getByTestId(T.splitChange));
		fireEvent.click(within(rowOf(s.N.tokyo)).getByTestId(T.splitMinus));
		fireEvent.click(screen.getByTestId(T.splitApply));
		fireEvent.click(
			within(screen.getByTestId(T.splitConfirm)).getByTestId(T.splitCancel),
		);
		expect(screen.queryByTestId(T.splitConfirm)).toBeNull();
		expect(rowOf(s.N.tokyo)).toHaveAttribute("data-days", "1");
		expect(fns.setDayStay).not.toHaveBeenCalled();
		expect(fns.moveItem).not.toHaveBeenCalled();
	});
});

describe("the Places tab's Schedule", () => {
	const places = (graph: TripGraph) =>
		renderWithWorkspace(<PlacesTab />, {
			graph,
			search: { tab: "places", pv: "schedule" },
		});

	it("no day in a city yet: what the shortlist needs, and the way to decide it in the Plan", () => {
		for (const days of [empty(10), []]) {
			const { graph } = trip(days);
			const { navigations, unmount } = places(graph);
			expect(screen.getByTestId(P.schedule)).toHaveAttribute(
				"data-mode",
				"needs",
			);
			const box = screen.getByTestId(P.scheduleNeeds);
			expect(box).toHaveTextContent(
				"Your shortlist needs about: Tokyo 4 days · Kyoto 1",
			);
			expect(screen.queryByTestId(T.split)).toBeNull();
			fireEvent.click(
				within(box).getByRole("button", {
					name: "Decide how long in each city",
				}),
			);
			expect(navigations.at(-1)?.search.tab).toBe("plan");
			expect(fns.setDayStay).not.toHaveBeenCalled();
			unmount();
		}
	});

	it("people who can't edit get the line only", () => {
		const { graph } = trip(empty(10));
		places(asRole(graph, "viewer"));
		expect(screen.getByTestId(P.scheduleNeeds)).toBeInTheDocument();
		expect(
			screen.queryByRole("button", { name: /Decide how long/ }),
		).toBeNull();
	});

	it("the list under its intro; a country heading where the country changes", () => {
		const { s, graph } = trip([
			{ night: "tokyo", items: [] },
			{ night: "tokyo", items: [] },
			{ night: "seoul", items: [] },
			{ items: [] },
		]);
		const k: GraphNode = {
			...(graph.nodes.find((n) => n.id === s.N.k1) as GraphNode),
			id: "seoul-place",
			parentId: s.N.seoul as string,
			name: "Gyeongbokgung",
			lat: 37.58,
			lng: 126.98,
		};
		places({ ...graph, nodes: [...graph.nodes, k] });
		expect(screen.getByTestId(P.schedule)).toHaveAttribute(
			"data-mode",
			"schedule",
		);
		const intro = screen.getByTestId(P.scheduleIntro);
		expect(intro).toHaveTextContent("Put your shortlist on days");
		expect(intro).toHaveTextContent(
			"Each place lists the days you're in its city. The button adds it to the best one.",
		);
		expect(
			screen.getAllByTestId(P.scheduleCountry).map((h) => h.textContent),
		).toEqual(["Japan · 2 days", "South Korea · 2 days"]);
		// Tokyo's places by area: Shibuya, then the city's own.
		const tokyo = screen
			.getAllByTestId(P.scheduleWindow)
			.find((w) => w.dataset.city === s.N.tokyo) as HTMLElement;
		expect(
			within(tokyo)
				.getAllByRole("heading", { level: 4 })
				.map((h) => h.textContent?.replace(/ · \d+$/, "")),
		).toEqual(["Shibuya", "Elsewhere in Tokyo"]);
	});

	it("one country: no heading", () => {
		const { graph } = trip([
			{ night: "tokyo", items: [] },
			{ night: "kyoto", items: [] },
			{ items: [] },
		]);
		places(graph);
		expect(screen.getAllByTestId(P.scheduleWindow).length).toBeGreaterThan(0);
		expect(screen.queryByTestId(P.scheduleCountry)).toBeNull();
	});
});
