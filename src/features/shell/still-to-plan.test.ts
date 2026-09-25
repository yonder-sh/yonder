import { describe, expect, it } from "vitest";
import type { ListItemDto } from "@/features/lists/lists.functions";
import { cityDayTable } from "@/features/places/lib/days";
import {
	isRateable as isRateableNode,
	rateableNodes,
} from "@/features/places/lib/rate";
import { indexGraph } from "@/lib/engine/graph-index";
import { computeSchedule } from "@/lib/engine/schedule";
import type { TripGraph } from "@/lib/engine/types";
import { DEMO_MEMBERS, demo, N, scenario } from "@/lib/fixtures/demo";
import { selForRefs } from "./activity-sel";
import {
	cityOf,
	daysHint,
	isRateable,
	stillToPlan,
	todoContext,
	todoSearch,
	todoTitle,
	todoView,
} from "./still-to-plan";

const NOW = Date.parse("2027-09-01T00:00:00Z");

function run(
	graph: TripGraph,
	listItems?: ListItemDto[],
	dueAt?: (li: ListItemDto) => number | null,
) {
	const ix = indexGraph(graph);
	return stillToPlan({
		ix,
		schedule: computeSchedule(ix),
		members: graph.members,
		listItems,
		dueAt,
		now: NOW,
	});
}

let n = 0;
function todo(p: Partial<ListItemDto>): ListItemDto {
	n += 1;
	// `doneAt`/`mine` are WP-Lists' newer DTO fields: set, whichever version is merged.
	return {
		doneAt: null,
		mine: true,
		id: `00000000-0000-7000-8000-0000000f${String(n).padStart(4, "0")}`,
		target: { kind: "trip" },
		list: "todo",
		text: "Something",
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
		createdAt: "2027-01-01T00:00:00Z",
		updatedAt: "2027-01-01T00:00:00Z",
		...p,
	} as ListItemDto;
}

describe("stillToPlan on the demo trip", () => {
	it("finds the nights without a stay (not the last day)", () => {
		const r = run(demo.graph);
		expect(r.nights.map((x) => x.dayId)).toEqual([
			demo.D.d1,
			demo.D.d2,
			demo.D.d4,
		]);
	});

	it("a night in a town (no hotel yet) still needs a stay", () => {
		const s = scenario({
			days: [
				{ night: "tokyo", items: [] },
				{ night: "ryokan", items: [] },
				{ items: [] },
			],
		});
		expect(run(s.graph).nights.map((x) => x.dayId)).toEqual([s.D.d1]);
	});

	it("an overnight flight covers its night", () => {
		const s = scenario({
			days: [
				{ items: [{ k: "a", node: "kix" }] },
				{ items: [{ k: "b", node: "icn" }] },
				{ items: [{ k: "c", node: "icn" }] },
			],
			legs: [
				{
					from: "a",
					to: "b",
					mode: "flight",
					dep: ["2027-10-03T23:00", "Asia/Tokyo"],
					arr: ["2027-10-04T01:00", "Asia/Seoul"],
				},
			],
		});
		expect(run(s.graph).nights.map((x) => x.dayId)).toEqual([s.D.d2]);
	});

	it("finds the city moves with no mode, in trip order", () => {
		const r = run(demo.graph);
		expect(r.moves.map((m) => `${m.from} → ${m.to}`)).toEqual([
			"Mt. Fuji → Kyoto",
			"Kyoto → Osaka",
		]);
		expect(r.moves[0]?.sel).toBe(
			`l.${demo.I.ryokanBreakfast}.${demo.I.kiyomizu}`,
		);
	});

	it("a mode on the leg clears the move", () => {
		const g: TripGraph = {
			...demo.graph,
			legs: [
				...demo.graph.legs,
				{
					...(demo.graph.legs[0] as TripGraph["legs"][number]),
					id: "00000000-0000-7000-8000-00000000fff1",
					fromItemId: demo.I.ryokanBreakfast ?? "",
					toItemId: demo.I.kiyomizu ?? "",
					mode: "transit",
				},
			],
		};
		expect(run(g).moves.map((m) => m.to)).toEqual(["Osaka"]);
	});

	it("counts unrated rateable places per member", () => {
		const nodes = demo.graph.nodes.map((x) =>
			x.id === N.sensoji
				? { ...x, priorities: { [DEMO_MEMBERS.audrey]: "must" as const } }
				: x,
		);
		const r = run({ ...demo.graph, nodes });
		const rateable = demo.graph.nodes.filter((x) =>
			isRateable(x, false),
		).length;
		// The Rate screen's own rule (WP-Places' `isRateable`: no airports or
		// lodging; areas only when they are destinations in themselves).
		expect(rateable).toBe(
			demo.graph.nodes.filter((x) => isRateableNode(x)).length,
		);
		expect(rateable).toBeGreaterThan(0);
		const kix = demo.graph.nodes.find((x) => x.id === N.kix);
		expect(kix && isRateable(kix, false)).toBe(false);
		const byName = Object.fromEntries(r.unrated.map((u) => [u.name, u.count]));
		expect(byName).toEqual({ Dennis: rateable, Audrey: rateable - 1 });
	});

	it("PLAN-R3-02: an unaccepted suggestion is not a place to rate (the Rate screen's count)", () => {
		// `ix` is built from the proposal overlay while suggestions are shown: Maya's
		// suggested Tōfuku-ji is a ghost node next to the live ones.
		const kiyomizu = demo.graph.nodes.find((x) => x.id === N.kiyomizu);
		if (!kiyomizu) throw new Error("no Kiyomizu-dera");
		const ghost = {
			...kiyomizu,
			id: "00000000-0000-7000-8000-00000000abcd",
			name: "Tōfuku-ji",
			slug: "tofuku-ji",
			priorities: {},
		};
		const g: TripGraph = { ...demo.graph, nodes: [...demo.graph.nodes, ghost] };
		const ix = indexGraph(g);
		const liveIds = new Set(demo.graph.nodes.map((x) => x.id));
		const r = stillToPlan({
			ix,
			schedule: computeSchedule(ix),
			members: g.members,
			liveIds,
			now: NOW,
		});
		const live = rateableNodes(ix, null, { liveIds });
		expect(live.map((x) => x.name)).not.toContain("Tōfuku-ji");
		for (const u of r.unrated) expect(u.total).toBe(live.length);
		const dennis = r.unrated.find((u) => u.memberId === DEMO_MEMBERS.dennis);
		expect(dennis?.count).toBe(
			live.filter((x) => !x.priorities[DEMO_MEMBERS.dennis ?? ""]).length,
		);
		// Without the live ids (fixture mode: no overlay) every node counts.
		const all = stillToPlan({
			ix,
			schedule: computeSchedule(ix),
			members: g.members,
			now: NOW,
		});
		expect(all.unrated[0]?.total).toBe(live.length + 1);
	});

	it("booking to-dos and windows opening within 14 days", () => {
		const soon = todo({ text: "ANA award seats open", dueKind: "opens" });
		const later = todo({ text: "JR seats open", dueKind: "opens" });
		const book = todo({ text: "Book Shibuya Sky sunset slot" });
		const done = todo({ text: "Book teamLab", status: "done" });
		const shopping = todo({ text: "Book stand", list: "shopping" });
		const plain = todo({ text: "Get a Suica card" });
		const at = new Map([
			[soon.id, NOW + 3 * 86_400_000],
			[later.id, NOW + 30 * 86_400_000],
		]);
		const r = run(
			demo.graph,
			[soon, later, book, done, shopping, plain],
			(li) => at.get(li.id) ?? null,
		);
		expect(r.toBook.map((x) => x.text)).toEqual([
			soon.text,
			later.text,
			book.text,
		]);
		expect(r.opening.map((x) => x.text)).toEqual([soon.text]);
	});

	it("days per city: planned against the trip length", () => {
		const nodes = demo.graph.nodes.map((x) =>
			x.id === N.tokyo
				? { ...x, details: { plannedDays: 2 } }
				: x.id === N.kyoto
					? { ...x, details: { plannedDays: 1 } }
					: x,
		);
		const r = run({ ...demo.graph, nodes });
		expect(r.days.tripDays).toBe(5);
		expect(r.days.planned).toBe(3);
		expect(r.days.unallocated).toBe(2);
		const tokyo = r.days.cities.find((c) => c.name === "Tokyo");
		expect(tokyo).toMatchObject({ planned: 2, scheduled: 2 });
	});

	it("days per city: one number with the table (region stand-ins count; PLAN-I2-13)", () => {
		// Mt. Fuji is a region with no city inside: WP-Places' table counts it.
		const nodes = demo.graph.nodes.map((x) =>
			x.id === N.tokyo
				? { ...x, details: { plannedDays: 2 } }
				: x.id === N.mtFuji
					? { ...x, details: { plannedDays: 1 } }
					: x,
		);
		const graph = { ...demo.graph, nodes };
		const r = run(graph);
		const ix = indexGraph(graph);
		const table = cityDayTable(ix, computeSchedule(ix), null);
		expect(r.days.planned).toBe(3);
		expect(r.days.planned).toBe(table.plannedTotal);
		expect(r.days.unallocated).toBe(table.unallocated);
		expect(r.days.tripDays).toBe(table.tripDays);
		expect(r.days.cities.map((c) => c.name)).toContain("Mt. Fuji");
		expect(daysHint(r.days)).toBe(`${table.unallocated} of 5 unallocated`);
	});

	it("days hint: over-allocated, all planned, not planned", () => {
		const d = { tripDays: 5, planned: 7, unallocated: -2, cities: [] };
		expect(daysHint(d)).toBe("2 over-allocated");
		expect(daysHint({ ...d, planned: 5, unallocated: 0 })).toBe(
			"all 5 planned",
		);
		expect(daysHint({ ...d, planned: 0, unallocated: 5 })).toBe(
			"not planned yet",
		);
		expect(daysHint({ ...d, planned: 4.5, unallocated: 0.5 })).toBe(
			"0.5 of 5 unallocated",
		);
		const over = run({
			...demo.graph,
			nodes: demo.graph.nodes.map((x) =>
				x.id === N.tokyo ? { ...x, details: { plannedDays: 9 } } : x,
			),
		});
		expect(over.days.unallocated).toBe(-4);
		expect(over.open).toBeGreaterThan(0);
	});

	it("each booking to-do opens its own context, not the whole list (PLAN-I2-14)", () => {
		const ix = indexGraph(demo.graph);
		const sky = todo({
			text: "Book Shibuya Sky sunset slot",
			target: { kind: "node", nodeId: N.shibuyaSky ?? "" },
		});
		const ana = todo({
			text: "ANA award seats open",
			dueKind: "opens",
			target: { kind: "item", itemId: demo.I.sky ?? "" },
		});
		const jr = todo({ text: "Book the JR pass" });
		const r = run(demo.graph, [sky, ana, jr], (li) =>
			li.id === ana.id ? NOW + 86_400_000 : null,
		);
		expect(r.toBook.map((b) => b.target)).toEqual([
			sky.target,
			ana.target,
			jr.target,
		]);
		expect(r.opening[0]?.target).toEqual(ana.target);
		expect(todoSearch(ix, sky.target)).toEqual({
			tab: "lists",
			list: "todo",
			sel: `n.${N.shibuyaSky}`,
		});
		expect(todoSearch(ix, ana.target).sel).toBe(`i.${demo.I.sky}`);
		expect(selForRefs(ix, { itemId: demo.I.sky })).toEqual({
			kind: "item",
			id: demo.I.sky,
		});
		// Trip-wide: nothing to select, the list itself.
		expect(todoSearch(ix, jr.target)).toEqual({
			tab: "lists",
			list: "todo",
			sel: undefined,
		});
	});

	it("a to-do opens a view filtered to its place or day, inspector on Lists (PLAN-R2-05)", () => {
		const ix = indexGraph(demo.graph);
		// A visit: the Lists tab scoped to its place, the visit selected.
		expect(todoView(ix, { kind: "item", itemId: demo.I.sky ?? "" })).toEqual({
			scopeId: N.shibuyaSky,
			search: { tab: "lists", list: "todo", sel: `i.${demo.I.sky}` },
			inspectorTab: "lists",
		});
		// A place: scoped to it.
		expect(todoView(ix, { kind: "node", nodeId: N.tokyo ?? "" })).toEqual({
			scopeId: N.tokyo,
			search: { tab: "lists", list: "todo", sel: `n.${N.tokyo}` },
			inspectorTab: "lists",
		});
		// An unlocated block ("Lunch") and a day: narrowed to that day.
		const lunch = todoView(ix, { kind: "item", itemId: demo.I.lunch1 ?? "" });
		expect(lunch.scopeId).toBeNull();
		expect(lunch.search.days).toBe(
			ix.day(ix.item(demo.I.lunch1 ?? "")?.dayId ?? "")?.date,
		);
		const day = demo.graph.days[2];
		expect(todoView(ix, { kind: "day", dayId: day?.id ?? "" }).search).toEqual({
			tab: "lists",
			list: "todo",
			sel: `d.${day?.id}`,
			days: day?.date,
		});
		// A leg: its day, or both days of one that crosses midnight.
		const flight = todoView(ix, { kind: "leg", legId: demo.L.flight ?? "" });
		expect(flight.scopeId).toBeNull();
		expect(flight.search.sel).toBe(`l.${demo.I.kix}.${demo.I.icn}`);
		expect(flight.search.days).toMatch(/^\d{4}-\d{2}-\d{2}$/);
		const fuji = todoView(ix, { kind: "leg", legId: demo.L.fuji ?? "" });
		expect(fuji.search.days).toMatch(
			/^(\d{4}-\d{2}-\d{2})\.\.(\d{4}-\d{2}-\d{2})$/,
		);
		expect(fuji.inspectorTab).toBe("lists");
		// Trip-wide, or a target that's gone: the list itself, Overview stays.
		expect(todoView(ix, { kind: "trip" })).toEqual({
			scopeId: null,
			search: { tab: "lists", list: "todo" },
			inspectorTab: null,
		});
		expect(
			todoView(ix, {
				kind: "item",
				itemId: "00000000-0000-7000-8000-00000000dead",
			}).inspectorTab,
		).toBeNull();
	});

	it("each to-do names what it's for, so 'Book ahead' rows differ (PLAN-R2-05, COLLAB-R2-13)", () => {
		const ix = indexGraph(demo.graph);
		const dayOf = (itemId: string | undefined) =>
			ix.dayNumber(ix.item(itemId ?? "")?.dayId ?? "");
		const aheads = [
			todo({
				text: "Book ahead",
				target: { kind: "item", itemId: demo.I.sky ?? "" },
			}),
			todo({
				text: "Book ahead",
				target: { kind: "item", itemId: demo.I.meiji ?? "" },
			}),
			todo({
				text: "Book ahead",
				target: { kind: "leg", legId: demo.L.flight ?? "" },
			}),
			todo({
				text: "Book ahead",
				target: { kind: "leg", legId: demo.L.fuji ?? "" },
			}),
			todo({
				text: "Book ahead",
				target: { kind: "day", dayId: demo.graph.days[2]?.id ?? "" },
			}),
		];
		const r = run(demo.graph, aheads);
		const titles = r.toBook.map((b) => todoTitle(b.text, b.context));
		expect(titles[0]).toBe(
			`Book ahead · Shibuya Sky · Day ${dayOf(demo.I.sky)}`,
		);
		expect(titles[1]).toBe(
			`Book ahead · Meiji Jingu · Day ${dayOf(demo.I.meiji)}`,
		);
		expect(titles[2]).toMatch(
			/^Book ahead · Flight · KE 724 KIX → ICN · Day \d+$/,
		);
		expect(titles[3]).toMatch(/^Book ahead · Transit · .+ · Day \d+$/);
		expect(titles[4]).toBe("Book ahead · Day 3 · Tue 5 Oct");
		expect(new Set(titles).size).toBe(titles.length);
		// A name the text already says isn't repeated; a trip-wide to-do has none.
		expect(
			todoContext(
				ix,
				{ kind: "node", nodeId: N.shibuyaSky ?? "" },
				"Book Shibuya Sky sunset slot",
			),
		).toBeNull();
		expect(
			todoContext(
				ix,
				{ kind: "item", itemId: demo.I.sky ?? "" },
				"Book Shibuya Sky sunset slot",
			),
		).toBe(`Day ${dayOf(demo.I.sky)}`);
		expect(
			todoContext(
				ix,
				{ kind: "node", nodeId: N.tokyo ?? "" },
				"Book the Park Hyatt",
			),
		).toBe("Tokyo");
		expect(todoContext(ix, { kind: "trip" }, "Book the JR pass")).toBeNull();
	});

	it("an opening window keeps its own zone (PLAN-I2-15)", () => {
		const ana = todo({ text: "ANA award seats open", dueKind: "opens" });
		const at = NOW + 2 * 86_400_000;
		const r = stillToPlan({
			ix: indexGraph(demo.graph),
			schedule: computeSchedule(indexGraph(demo.graph)),
			members: demo.graph.members,
			listItems: [ana],
			due: () => ({
				at,
				tz: "America/New_York",
				date: "2027-09-02",
				timed: true,
			}),
			now: NOW,
		});
		expect(r.opening[0]?.due).toMatchObject({ at, tz: "America/New_York" });
	});

	it("cityOf falls back to the region and the country", () => {
		const ix = indexGraph(demo.graph);
		expect(ix.node(cityOf(ix, N.ryokan ?? null))?.name).toBe("Mt. Fuji");
		expect(ix.node(cityOf(ix, N.kix ?? null))?.name).toBe("Osaka");
		expect(ix.node(cityOf(ix, N.japan ?? null))?.name).toBe("Japan");
		expect(cityOf(ix, null)).toBeNull();
	});
});
