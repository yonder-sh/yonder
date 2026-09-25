/**
 * The Lists view model: rollup scoping (SPEC §8.4), views and groups
 * (EXTENSIONS §7), shopping ↔ plan and closed days (ADDENDUM §10), and the
 * E7 ghost overlay for proposed creates.
 */
import { describe, expect, it } from "vitest";
import { dueCtxOf } from "@/lib/engine/due";
import { indexGraph } from "@/lib/engine/graph-index";
import { computeSchedule } from "@/lib/engine/schedule";
import type { TripGraph } from "@/lib/engine/types";
import { demo } from "@/lib/fixtures/demo";
import type { ProposalDto } from "@/lib/schemas/proposals";
import { plainOf } from "../format";
import {
	closedOn,
	dayRunsLabel,
	defaultView,
	droppedRowIds,
	filterRows,
	groupRows,
	groupTarget,
	legLabel,
	legSelTarget,
	nearAnchor,
	placeViewSource,
	rollupRows,
	rowsInView,
	shopPlan,
	targetLabel,
	viewsFor,
} from "../list-model";
import type { ListItemDto } from "../lists.functions";
import { applyListProposals } from "../queries";

const N = demo.N as Record<string, string>;
const D = demo.D as Record<string, string>;

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
		createdAt: "2026-09-01T00:00:00.000Z",
		updatedAt: "2026-09-01T00:00:00.000Z",
		doneAt: null,
		mine: true,
		...p,
	};
}

const ix = indexGraph(demo.graph);
const schedule = computeSchedule(ix);
const ctx = {
	ix,
	schedule,
	dueCtx: dueCtxOf(ix, schedule),
	now: Date.parse("2026-09-23T12:00:00Z"),
	scopeId: null,
	memberName: (id: string) => (id === "m1" ? "Audrey" : "Dennis"),
	meMemberId: "m2",
};

const rows = [
	row({ id: "trip-todo" }),
	row({ id: "sky", target: { kind: "node", nodeId: N.shibuyaSky as string } }),
	row({
		id: "knife",
		list: "shopping",
		target: { kind: "node", nodeId: N.knifeShop as string },
	}),
	row({
		id: "washi",
		list: "shopping",
		target: { kind: "node", nodeId: N.hands as string },
		extraTargetNodeIds: [N.hands as string, N.loft as string],
	}),
	row({ id: "leg", target: { kind: "leg", legId: demo.L.fuji as string } }),
	row({ id: "day", target: { kind: "day", dayId: D.d3 as string } }),
];

describe("scoping", () => {
	it("the root shows everything once; Tokyo drops the trip row; Only Tokyo keeps its own", () => {
		const root = rowsInView(ix, rows, { scopeId: null, lens: "country" });
		expect(root.map((r) => r.row.id).sort()).toEqual(
			["day", "knife", "leg", "sky", "trip-todo", "washi"].sort(),
		);
		const tokyo = rowsInView(ix, rows, {
			scopeId: N.tokyo as string,
			lens: "area",
		});
		const ids = tokyo.map((r) => r.row.id);
		expect(ids).toContain("sky");
		expect(ids).toContain("knife");
		expect(ids).toContain("leg"); // the Fuji leg starts in Tokyo (Itoya)
		expect(ids).not.toContain("trip-todo");
		const only = rowsInView(ix, rows, {
			scopeId: N.tokyo as string,
			lens: "area",
			includeDescendants: false,
		});
		expect(only).toEqual([]);
	});

	it("rows on dropped places are left out unless Show dropped (QA ROLL-12)", () => {
		const dropped: TripGraph = {
			...demo.graph,
			nodes: demo.graph.nodes.map((n) =>
				n.id === N.kiyomizu ? { ...n, status: "dropped" as const } : n,
			),
		};
		const dix = indexGraph(dropped);
		const temple = row({
			id: "temple",
			target: { kind: "node", nodeId: N.kiyomizu as string },
		});
		const opts = { scopeId: N.japan as string, lens: "city" as const };
		const ids = (show: boolean) =>
			rowsInView(dix, [...rows, temple], { ...opts, showDropped: show }).map(
				(r) => r.row.id,
			);
		expect(ids(false)).not.toContain("temple");
		expect(ids(true)).toContain("temple");
		expect([...droppedRowIds(dix, [...rows, temple], opts)]).toEqual([
			"temple",
		]);
		expect(droppedRowIds(ix, [...rows, temple], opts).size).toBe(0);
	});

	it("a Place group's add row attaches to its place, its day or the scope", () => {
		expect(
			groupTarget({ groupKind: "rep", repId: "n1", dayId: null }, null),
		).toEqual({ kind: "node", nodeId: "n1" });
		expect(
			groupTarget({ groupKind: "day", repId: null, dayId: "d1" }, "n9"),
		).toEqual({ kind: "day", dayId: "d1" });
		expect(
			groupTarget({ groupKind: "scope", repId: null, dayId: null }, null),
		).toEqual({ kind: "trip" });
		expect(
			groupTarget({ groupKind: "scope", repId: "n9", dayId: null }, "n9"),
		).toEqual({ kind: "node", nodeId: "n9" });
		expect(
			groupTarget({ groupKind: "unlinked", repId: null, dayId: "d1" }, null),
		).toBeNull();
	});

	it("a candidate shop matches the scope even when the primary doesn't (Near selection too)", () => {
		const r = row({
			id: "pens",
			list: "shopping",
			target: { kind: "node", nodeId: N.itoya as string },
			extraTargetNodeIds: [N.loft as string],
		});
		const shibuya = rowsInView(ix, [r], {
			scopeId: N.shibuya as string,
			lens: "place",
		});
		expect(shibuya.map((x) => x.row.id)).toEqual(["pens"]);
		const near = nearAnchor(ix, N.hands as string);
		expect(near).toBe(N.shibuya);
		const all = rowsInView(ix, rows, { scopeId: null, lens: "country" });
		expect(
			filterRows(
				ix,
				all.filter((x) => x.row.list === "shopping"),
				{ who: null, nearNodeId: near },
			).map((x) => x.row.id),
		).toEqual(["washi"]);
	});

	it("labels say where a row hangs", () => {
		expect(targetLabel(ix, { kind: "trip" })).toBe("Trip");
		expect(
			targetLabel(
				ix,
				{ kind: "node", nodeId: N.shibuyaSky as string },
				N.tokyo,
			),
		).toBe("Shibuya › Shibuya Sky");
		expect(targetLabel(ix, { kind: "day", dayId: D.d3 as string })).toBe(
			"Day 3 · Tue 5 Oct",
		);
		expect(targetLabel(ix, { kind: "leg", legId: demo.L.fuji as string })).toBe(
			"Transit · Itoya Ginza → Drop bags",
		);
	});

	it("a leg names its flight or service, else its mode (QA ROLL-05)", () => {
		expect(legLabel(ix, demo.L.flight as string)).toBe(
			"Flight · KE 724 KIX → ICN",
		);
		expect(legLabel(ix, demo.L.handsLoft as string)).toMatch(
			/^Walk · .+ → .+$/,
		);
		const g: TripGraph = structuredClone(demo.graph);
		for (const l of g.legs) {
			if (l.id === demo.L.fuji)
				l.details = {
					kind: "transit",
					route: {
						id: "r1",
						source: "manual",
						durationMin: 116,
						walkMin: 0,
						transfers: 0,
						segments: [],
						label: "Fuji Excursion 7",
					},
				};
			if (l.id === demo.L.handsLoft) l.mode = null;
		}
		const ix2 = indexGraph(g);
		expect(legLabel(ix2, demo.L.fuji as string)).toBe("Leg · Fuji Excursion 7");
		expect(legLabel(ix2, demo.L.handsLoft as string)).toMatch(
			/^Leg · .+ → .+$/,
		);
		expect(legSelTarget(ix, demo.L.fuji as string)).toEqual({
			kind: "pair",
			fromItemId: demo.I.itoya,
			toItemId: demo.I.dropBags,
		});
	});

	it("Place view labels rows that don't hang on their group's own place (QA ROLL-05)", () => {
		const legRow = row({
			id: "leg-todo",
			target: { kind: "leg", legId: demo.L.fuji as string },
		});
		const visitRow = row({
			id: "visit-todo",
			target: { kind: "item", itemId: demo.I.dropBags as string },
		});
		const ownRow = row({
			id: "own",
			target: { kind: "node", nodeId: N.ryokan as string },
		});
		const scope = N.mtFuji as string;
		const pg = rollupRows(ix, [legRow, visitRow, ownRow], {
			scopeId: scope,
			lens: "area",
		});
		const labels = new Map<string, string | null>();
		for (const g of pg)
			for (const sub of g.subs)
				for (const r of sub.rows)
					labels.set(
						r.id,
						placeViewSource(
							ix,
							r.target,
							{ repId: g.repId, dayId: g.dayId, groupKind: g.kind },
							scope,
						),
					);
		expect(labels.get("leg-todo")).toBe("Transit · Itoya Ginza → Drop bags");
		expect(labels.get("visit-todo")).toMatch(/^Day \d+ · Drop bags$/);
		// Two identical "Book ahead" rows are now told apart.
		expect(labels.get("leg-todo")).not.toBe(labels.get("visit-todo"));
		const own = placeViewSource(
			ix,
			ownRow.target,
			{ repId: N.ryokan as string, dayId: null, groupKind: "rep" },
			scope,
		);
		expect(own).toBeNull();
		expect(
			placeViewSource(
				ix,
				{ kind: "trip" },
				{ repId: null, dayId: null, groupKind: "scope" },
				null,
			),
		).toBeNull();
		expect(
			placeViewSource(
				ix,
				{ kind: "day", dayId: D.d3 as string },
				{ repId: null, dayId: D.d3 as string, groupKind: "day" },
				null,
			),
		).toBeNull();
	});
});

describe("views", () => {
	it("defaults: Due at the root for to-dos, Place elsewhere and for shopping", () => {
		expect(defaultView("todo", true)).toBe("due");
		expect(defaultView("todo", false)).toBe("place");
		expect(defaultView("shopping", true)).toBe("place");
		expect(viewsFor("shopping")).toContain("day");
		expect(viewsFor("todo")).not.toContain("day");
	});

	it("Person puts a shared row under each assignee, me first, Unassigned last", () => {
		const r = [
			row({ id: "both", assigneeIds: ["m1", "m2"] }),
			row({ id: "none" }),
			row({ id: "audrey", assigneeIds: ["m1"] }),
		];
		const inView = rowsInView(ix, r, { scopeId: null, lens: "country" });
		const g = groupRows("person", inView, ctx);
		expect(g.map((x) => [x.title, x.rows.map((y) => y.row.id)])).toEqual([
			["Dennis (you)", ["both"]],
			["Audrey", ["audrey", "both"]],
			["Unassigned", ["none"]],
		]);
	});

	it("By day groups shopping by the day its shop is visited, then Not on the plan", () => {
		const inView = rowsInView(
			ix,
			[
				...rows,
				row({
					id: "off",
					list: "shopping",
					target: { kind: "node", nodeId: N.kiyomizu as string },
				}),
				row({ id: "nowhere", list: "shopping" }),
			].filter((r) => r.list === "shopping"),
			{ scopeId: null, lens: "country" },
		);
		const g = groupRows("day", inView, ctx);
		expect(g.map((x) => [x.title, x.rows.map((y) => y.row.id)])).toEqual([
			["Day 1 · Sun 3 Oct", ["washi"]],
			["Day 2 · Mon 4 Oct", ["knife"]],
			["Day 4 · Wed 6 Oct", ["off"]],
			["Not on the plan", ["nowhere"]],
		]);
	});

	it("Place follows the rollup groups", () => {
		const pg = rollupRows(ix, rows, { scopeId: null, lens: "country" });
		const inView = rowsInView(ix, rows, { scopeId: null, lens: "country" });
		const g = groupRows("place", inView, ctx, pg);
		expect(g[0]?.title).toBe("Trip");
		expect(g.map((x) => x.title)).toContain("Japan");
	});
});

describe("shopping ↔ plan", () => {
	it("says where the shop is scheduled, with the visit's local time", () => {
		const plan = shopPlan(ix, schedule, rows[2] as ListItemDto);
		expect(plan.kind).toBe("scheduled");
		if (plan.kind === "scheduled") {
			expect(plan.dayNumber).toBe(2);
			expect(plan.place).toBe("Kama-asa (knives)");
			expect(plan.time).toMatch(/^\d\d:\d\d$/);
			expect(plan.label).toBe(`Day 2 · Kama-asa (knives) ${plan.time}`);
			expect(plan.closed).toBe(false);
		}
		expect(
			shopPlan(ix, schedule, row({ id: "x", list: "shopping" })).kind,
		).toBe("none");
	});

	it("a city/country-level item says the days spent there, not the first visit inside (ADDENDUM §10)", () => {
		const onTokyo = row({
			id: "sake",
			list: "shopping",
			target: { kind: "node", nodeId: N.tokyo as string },
		});
		const plan = shopPlan(ix, schedule, onTokyo);
		expect(plan.kind).toBe("area");
		if (plan.kind === "area") {
			const tokyoDays = new Set<number>();
			for (const it of ix.ordered)
				if (it.dayId && it.nodeId && ix.isWithin(it.nodeId, N.tokyo as string))
					tokyoDays.add(ix.dayNumber(it.dayId));
			expect(plan.label).toBe(`In Tokyo · ${dayRunsLabel([...tokyoDays])}`);
			expect(plan.label).not.toMatch(/\d\d:\d\d/);
		}
		// A city with nothing planned in it: "Not on the plan".
		const nowhere = row({
			id: "istanbul",
			list: "shopping",
			target: { kind: "node", nodeId: N.istanbul as string },
		});
		expect(shopPlan(ix, schedule, nowhere)).toEqual({
			kind: "unscheduled",
			label: "Not on the plan",
		});
		// A shop on the plan still wins over an area candidate.
		const knifeOrTokyo = row({
			id: "k",
			list: "shopping",
			target: { kind: "node", nodeId: N.tokyo as string },
			extraTargetNodeIds: [N.knifeShop as string],
		});
		expect(shopPlan(ix, schedule, knifeOrTokyo).kind).toBe("scheduled");
		// By day: the area row gets its own group after its first day.
		const inView = rowsInView(ix, [onTokyo, rows[2] as ListItemDto], {
			scopeId: null,
			lens: "country",
		});
		const titles = groupRows("day", inView, ctx).map((x) => x.title);
		expect(titles.some((t) => t.startsWith("In Tokyo · "))).toBe(true);
		expect(titles).not.toContain("Not on the plan");
	});

	it("day runs read compactly", () => {
		expect(dayRunsLabel([3])).toBe("Day 3");
		expect(dayRunsLabel([2, 3, 4, 5, 6])).toBe("Days 2–6");
		expect(dayRunsLabel([6, 2, 3, 30, 31])).toBe("Days 2–3, 6, 30–31");
		expect(dayRunsLabel([1, 3, 5, 7])).toBe("Days 1, 3, 5, …");
	});

	it("flags a shop that's closed that day (manual hours)", () => {
		const g: TripGraph = structuredClone(demo.graph);
		const knife = g.nodes.find((n) => n.id === N.knifeShop);
		if (!knife) throw new Error("fixture");
		// Day 2 is Mon 4 Oct 2027: closed on Mondays.
		knife.details = {
			...knife.details,
			openingHours: {
				source: "manual",
				periods: [2, 3, 4, 5, 6, 0].map((day) => ({
					day,
					open: "10:00",
					close: "17:00",
				})),
				closedDays: [1],
				updatedAt: "2026-09-01T00:00:00.000Z",
			},
		};
		const ix2 = indexGraph(g);
		const plan = shopPlan(ix2, computeSchedule(ix2), rows[2] as ListItemDto);
		expect(plan.kind === "scheduled" && plan.closed).toBe(true);
		expect(closedOn(knife, "2027-10-05", g.trip.settings)).toBe(false);
		expect(closedOn(knife, "2027-10-04", g.trip.settings)).toBe(true);
	});

	it("the n-th weekday rule and exceptions", () => {
		const node = structuredClone(ix.node(N.itoya));
		if (!node) throw new Error("fixture");
		node.details = {
			...node.details,
			openingHours: {
				source: "manual",
				periods: [0, 1, 2, 3, 4, 5, 6].map((day) => ({
					day,
					open: "10:00",
					close: "20:00",
				})),
				closedNth: [{ day: 3, nth: -1 }],
				exceptions: [{ date: "2027-10-10", closed: true }],
				updatedAt: "2026-09-01T00:00:00.000Z",
			},
		};
		expect(closedOn(node, "2027-10-27", {})).toBe(true); // last Wednesday
		expect(closedOn(node, "2027-10-20", {})).toBe(false);
		expect(closedOn(node, "2027-10-10", {})).toBe(true);
		expect(closedOn(ix.node(N.loft) as never, "2027-10-10", {})).toBeNull();
	});
});

describe("E7 ghosts", () => {
	it("an open list.create proposal becomes a ghost row; closed ones don't", () => {
		const p = (status: ProposalDto["status"]): ProposalDto =>
			({
				id: `p-${status}`,
				tripId: "t",
				op: "list.create",
				payload: {
					tripId: "t",
					id: `li-${status}`,
					target: { kind: "trip" },
					list: "shopping",
					text: "Maya's idea",
				},
				entityKind: "list",
				entityId: `li-${status}`,
				createdIds: [],
				requires: [],
				summary: "",
				message: null,
				status,
				author: {
					userId: null,
					memberId: null,
					name: "Maya",
					color: 2,
					isGuest: false,
				},
				fields: [],
				before: {},
				reviewedBy: null,
				reviewedAt: null,
				reviewNote: null,
				lastError: null,
				dependants: [],
				createdAt: "2026-09-01T00:00:00.000Z",
				updatedAt: "2026-09-01T00:00:00.000Z",
			}) as ProposalDto;
		const out = applyListProposals([], [p("open"), p("rejected")]);
		expect(out.map((r) => [r.id, r.list, r.text])).toEqual([
			["li-open", "shopping", "Maya's idea"],
		]);
		expect("ghostOf" in (out[0] as object)).toBe(true);
	});
});

describe("plainOf", () => {
	it("drops Markdown markup, keeps real characters", () => {
		expect(plainOf("Whetstone #1000")).toBe("Whetstone #1000");
		expect(plainOf("**Cash only** at _most_ bars")).toBe(
			"Cash only at most bars",
		);
		expect(plainOf("## Heading")).toBe("Heading");
		expect(plainOf("snake_case_name stays")).toBe("snake_case_name stays");
		expect(
			plainOf(
				"[guide](https://x.test) for [@Maya Chen](mention:01a0cd9b-31b0-71a1-b351-bbe524456fb0)",
			),
		).toBe("guide for @Maya Chen");
	});
});
