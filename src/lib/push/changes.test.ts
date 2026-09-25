import { describe, expect, it } from "vitest";
import { addDaysIso, demo, uuid } from "@/lib/engine/__fixtures__/demo";
import type { TripGraph } from "@/lib/engine/types";
import {
	diffSnapshots,
	type PushChange,
	routeChanges,
	snapshotOf,
} from "./changes";
import type { PushTodo } from "./reminders";

const MAYA = uuid(0x53);
const I = demo.I as Record<string, string>;
const D = demo.D as Record<string, string>;
const L = demo.L as Record<string, string>;

function trip(mutate?: (g: TripGraph) => void): TripGraph {
	const g = structuredClone(demo.graph);
	g.trip.slug = "asia-2027";
	g.members.push({
		id: MAYA,
		userId: "user-maya",
		status: "active",
		role: "editor",
		name: "Maya",
		color: 2,
	});
	mutate?.(g);
	return g;
}
const item = (g: TripGraph, k: string) => {
	const it = g.items.find((i) => i.id === I[k]);
	if (!it) throw new Error(k);
	return it;
};
const flight = (g: TripGraph) => {
	const leg = g.legs.find((l) => l.id === L.flight);
	const d = leg?.details as {
		kind: string;
		flight: { depLocal?: string; arrLocal?: string };
	};
	return d.flight;
};

const todo = (over: Partial<PushTodo> = {}): PushTodo => ({
	id: uuid(0x9100),
	list: "todo",
	text: "Buy JR passes",
	status: "open",
	dueKind: "due",
	dueRule: null,
	dueDate: null,
	dueTime: null,
	dueTz: null,
	dueDayId: null,
	isPrivate: false,
	createdBy: "user-dennis",
	assigneeIds: [],
	nodeId: null,
	itemId: null,
	legId: null,
	dayId: null,
	...over,
});

const diff = (a: TripGraph, b: TripGraph, ta: PushTodo[] = [], tb = ta) =>
	diffSnapshots(snapshotOf(a, ta), snapshotOf(b, tb));
const route = (
	changes: PushChange[],
	g: TripGraph,
	todos: PushTodo[] = [],
	actor: string | null = null,
) => routeChanges(changes, g, todos, { actor, now: 5 });

describe("snapshot", () => {
	it("watches booked or pinned items and timed flights only; no change, no events", () => {
		const g = trip();
		const s = snapshotOf(g, []);
		expect(Object.keys(s.plans)).toEqual([I.sky]);
		expect(s.plans[I.sky as string]).toEqual({ d: "2027-10-03", t: "17:30" });
		expect(s.flights[L.flight as string]).toEqual({
			d: "2027-10-07T13:05",
			a: "2027-10-07T15:05",
		});
		expect(diffSnapshots(s, snapshotOf(trip(), []))).toEqual([]);
	});
});

describe("changes that affect you", () => {
	it("a pinned plan moving to another day tells everyone when nobody is assigned", () => {
		const after = trip((g) => {
			item(g, "sky").dayId = D.d2 as string;
		});
		const changes = diff(trip(), after);
		expect(changes).toEqual([
			{
				kind: "plan",
				itemId: I.sky,
				from: { d: "2027-10-03", t: "17:30" },
				to: { d: "2027-10-04", t: "17:30" },
			},
		]);
		const [r] = route(changes, after);
		expect(r).toMatchObject({
			group: "changes",
			item: {
				headline: "Shibuya Sky moved to Mon 4 Oct · 17:30",
				body: "Was Sun 3 Oct · 17:30",
				url: `/t/asia-2027?sel=i.${I.sky}`,
			},
		});
		expect(r?.userIds.sort()).toEqual(["user-dennis", "user-maya"]);
	});

	it("a pinned time change; a booked plan tells only its assignees", () => {
		const after = trip((g) => {
			item(g, "sky").pinnedStart = "18:00";
			const kiyomizu = item(g, "kiyomizu");
			kiyomizu.fixedDate = true;
			kiyomizu.assigneeIds = [MAYA];
		});
		const before = trip((g) => {
			const kiyomizu = item(g, "kiyomizu");
			kiyomizu.fixedDate = true;
			kiyomizu.assigneeIds = [MAYA];
		});
		const moved = trip((g) => {
			item(g, "sky").pinnedStart = "18:00";
			const kiyomizu = item(g, "kiyomizu");
			kiyomizu.fixedDate = true;
			kiyomizu.assigneeIds = [MAYA];
			kiyomizu.dayId = D.d5 as string;
		});
		const r1 = route(diff(before, after), after);
		expect(r1.map((r) => r.item.headline)).toEqual([
			"Shibuya Sky now starts at 18:00",
		]);
		const r2 = route(diff(after, moved), moved);
		expect(r2).toHaveLength(1);
		expect(r2[0]?.userIds).toEqual(["user-maya"]);
		expect(r2[0]?.item.headline).toBe("Kiyomizu-dera moved to Thu 7 Oct");
	});

	it("not every edit: an unpinned, unbooked plan moving says nothing", () => {
		const after = trip((g) => {
			item(g, "hands").dayId = D.d2 as string;
			item(g, "hands").title = "Renamed";
		});
		expect(diff(trip(), after)).toEqual([]);
	});

	it("a timed flight's new departure", () => {
		const after = trip((g) => {
			const f = flight(g);
			f.depLocal = "2027-10-07T14:05";
			f.arrLocal = "2027-10-07T16:05";
		});
		const [r] = route(diff(trip(), after), after);
		expect(r?.item).toMatchObject({
			headline: "Flight KE 724 now departs Thu 7 Oct · 14:05",
			body: "Was Thu 7 Oct · 13:05",
			url: `/t/asia-2027?sel=l.${I.kix}.${I.icn}`,
		});
	});

	it("a trip date shift is one notification, not one per plan", () => {
		const after = trip((g) => {
			for (const d of g.days) d.date = addDaysIso(d.date, 2);
			g.trip.startDate = g.days[0]?.date ?? null;
			g.trip.endDate = g.days.at(-1)?.date ?? null;
			const f = flight(g);
			f.depLocal = "2027-10-09T13:05";
			f.arrLocal = "2027-10-09T15:05";
		});
		const changes = diff(trip(), after);
		expect(changes.map((c) => c.kind)).toEqual(["dates"]);
		const [r] = route(changes, after, [], "Maya");
		expect(r?.item).toMatchObject({
			headline: "The trip's dates changed",
			body: "Now Tue 5 Oct – Sat 9 Oct (was Sun 3 Oct – Thu 7 Oct)",
			actor: "Maya",
		});
		expect(r?.userIds.sort()).toEqual(["user-dennis", "user-maya"]);
	});

	it("a plan that moved on top of the shift is still reported", () => {
		const after = trip((g) => {
			for (const d of g.days) d.date = addDaysIso(d.date, 2);
			g.trip.startDate = g.days[0]?.date ?? null;
			g.trip.endDate = g.days.at(-1)?.date ?? null;
			item(g, "sky").pinnedStart = "19:00";
		});
		expect(diff(trip(), after).map((c) => c.kind)).toEqual(["dates", "plan"]);
	});
});

describe("assigned to you", () => {
	it("only the people newly assigned hear about it", () => {
		const before = trip((g) => {
			item(g, "hands").assigneeIds = ["00000000-0000-7000-8000-000000000051"];
		});
		const after = trip((g) => {
			item(g, "hands").assigneeIds = [
				"00000000-0000-7000-8000-000000000051",
				MAYA,
			];
		});
		const changes = diff(before, after);
		expect(changes).toEqual([
			{ kind: "assigned", target: "item", id: I.hands, memberIds: [MAYA] },
		]);
		const [r] = route(changes, after, [], "Dennis");
		expect(r).toMatchObject({
			group: "assigned",
			userIds: ["user-maya"],
			item: {
				headline: "Dennis assigned you to Hands Shibuya",
				body: "Sun 3 Oct",
				meta: { target: "item", id: I.hands },
			},
		});
		// Unassigning says nothing.
		expect(diff(after, before)).toEqual([]);
	});

	it("to-dos too; a private to-do never tells anyone", () => {
		const open = todo();
		const shared = { ...open, assigneeIds: [MAYA] };
		const changes = diff(trip(), trip(), [open], [shared]);
		const [r] = route(changes, trip(), [shared]);
		expect(r?.item).toMatchObject({
			headline: "A to-do was assigned to you",
			body: "Buy JR passes",
			url: "/t/asia-2027?tab=lists&list=todo",
		});
		// Done, then reopened: not a new assignment.
		expect(
			diff(trip(), trip(), [{ ...shared, status: "done" }], [shared]),
		).toEqual([]);
		const priv = { ...shared, isPrivate: true };
		expect(
			diff(trip(), trip(), [{ ...open, isPrivate: true }], [priv]),
		).toEqual([]);
	});

	it("the first snapshot of a trip is a baseline: already assigned people aren't told", () => {
		// No previous snapshot → the worker only stores this one (see handlers).
		const g = trip((x) => {
			item(x, "hands").assigneeIds = [MAYA];
		});
		expect(snapshotOf(g, []).itemTags[I.hands as string]).toEqual([MAYA]);
	});
});
