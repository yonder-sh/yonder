/**
 * The Bookings tab's model (One Yonder D12): the groups, what a booking is
 * for, and the words its rows and details use.
 */
import { describe, expect, it } from "vitest";
import { dueCtxOf, effectiveDue } from "@/lib/engine/due";
import { indexGraph } from "@/lib/engine/graph-index";
import { computeSchedule } from "@/lib/engine/schedule";
import type { TripGraph } from "@/lib/engine/types";
import { demo } from "@/lib/fixtures/demo";
import {
	bookingCategory,
	bookingFor,
	bookingGroups,
	dayBits,
	longDate,
	nightsAt,
	opensIn,
	opensLabel,
	ruleLabel,
} from "../bookings-model";
import type { ListItemDto } from "../lists.functions";

const I = demo.I as Record<string, string>;
const L = demo.L as Record<string, string>;

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
		dueKind: "opens",
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
		...p,
	};
}

// The ryokan stop is booked; the Fuji Excursion has seats.
const graph: TripGraph = {
	...demo.graph,
	items: demo.graph.items.map((it) =>
		it.id === I.dropBags ? { ...it, fixedDate: true } : it,
	),
	legs: demo.graph.legs.map((l) =>
		l.id === L.fuji
			? {
					...l,
					details: {
						kind: "transit",
						booking: {
							trainNumber: "Fuji Excursion 7",
							car: "3",
							seats: [{ seat: "5A" }, { seat: "5B" }],
						},
					},
				}
			: l,
	),
};
const ix = indexGraph(graph);
const schedule = computeSchedule(ix);
const dueCtx = dueCtxOf(ix, schedule);
const now = Date.parse("2026-09-27T12:00:00Z");
const booked = graph.items.filter((i) => i.fixedDate);

describe("bookingGroups", () => {
	it("Opening soon (30 days) · Later · Booked · No date yet; skipped ones stay in To-dos", () => {
		const todos = [
			row({
				id: "later",
				dueDate: "2026-12-03",
				dueTime: "09:00",
				dueTz: "UTC",
			}),
			row({
				id: "soon",
				dueDate: "2026-10-12",
				dueTime: "09:00",
				dueTz: "UTC",
			}),
			row({ id: "opened", dueDate: "2026-09-20" }),
			row({ id: "undated" }),
			row({ id: "done", status: "done" }),
			row({ id: "skipped", status: "skipped", dueDate: "2026-10-01" }),
			row({ id: "plain", dueKind: "due", dueDate: "2026-10-01" }),
		];
		const g = bookingGroups(ix, todos, booked, { dueCtx, now });
		expect(g.map((x) => [x.title, x.entries.map((e) => e.id)])).toEqual([
			["Opening soon", ["opened", "soon"]],
			["Later", ["later"]],
			// Booked by day; one without a day last.
			["Booked", [I.dropBags, "done"]],
			["No date yet", ["undated"]],
		]);
	});

	it("a ticked to-do for a booked stop stands for it; Booked sorts by day", () => {
		const todos = [
			row({
				id: "ryokan",
				status: "done",
				target: { kind: "item", itemId: I.dropBags as string },
			}),
			row({
				id: "sky",
				status: "done",
				target: { kind: "item", itemId: I.sky as string },
			}),
		];
		const g = bookingGroups(ix, todos, booked, { dueCtx, now });
		expect(g.map((x) => x.entries.map((e) => e.id))).toEqual([
			["sky", "ryokan"],
		]);
	});
});

describe("what a booking is for", () => {
	it("a leg: its service, times, day and seats; it moves with the train", () => {
		const f = bookingFor(ix, schedule, {
			kind: "todo",
			id: "t",
			row: row({ id: "t", target: { kind: "leg", legId: L.fuji as string } }),
		});
		expect(f).toMatchObject({
			kind: "leg",
			target: { kind: "leg", legId: L.fuji },
			name: "Fuji Excursion 7",
			extra: "Car 3, seats 5A and 5B",
			anchor: "the train",
		});
		expect(f?.when).toMatch(/^Itoya Ginza \d\d:\d\d → Drop bags \d\d:\d\d$/);
		// It leaves on Day 2 (Itoya is that day's last stop).
		expect(dayBits(ix, f?.dayId ?? null)).toEqual(["Mon 4 Oct", "Day 2"]);
	});

	it("a booked stop is itself; a rule's stop when the to-do hangs on the trip; nothing otherwise", () => {
		const stop = bookingFor(ix, schedule, {
			kind: "stop",
			id: I.dropBags as string,
			item: ix.item(I.dropBags as string) as never,
		});
		expect(stop).toMatchObject({ kind: "item", name: "Drop bags" });
		const rule = row({
			id: "r",
			dueRule: {
				kind: "days",
				itemId: I.kiyomizu as string,
				days: 30,
				time: "10:00",
				tz: "Asia/Tokyo",
			},
		});
		expect(
			bookingFor(ix, schedule, { kind: "todo", id: "r", row: rule })?.target,
		).toEqual({
			kind: "item",
			itemId: I.kiyomizu,
		});
		expect(
			bookingFor(ix, schedule, {
				kind: "todo",
				id: "x",
				row: row({ id: "x" }),
			}),
		).toBeNull();
	});

	it("a stay counts its nights; the expense category follows what it is", () => {
		const ryokan = ix.item(I.dropBags as string);
		expect(ryokan && nightsAt(ix, ryokan)).toBe(1);
		const sky = ix.item(I.sky as string);
		expect(sky && nightsAt(ix, sky)).toBe(0);
		const f = (itemId: string) =>
			bookingFor(ix, schedule, {
				kind: "todo",
				id: "c",
				row: row({ id: "c", target: { kind: "item", itemId } }),
			});
		expect(bookingCategory(ix, f(I.dropBags as string))).toBe("lodging");
		expect(bookingCategory(ix, f(I.sky as string))).toBe("activities");
		expect(
			bookingCategory(
				ix,
				bookingFor(ix, schedule, {
					kind: "todo",
					id: "l",
					row: row({
						id: "l",
						target: { kind: "leg", legId: L.fuji as string },
					}),
				}),
			),
		).toBe("transport");
	});
});

describe("words", () => {
	it("when it opens, with the year and the zone", () => {
		const due = effectiveDue(
			row({
				id: "w",
				dueDate: "2026-10-12",
				dueTime: "09:00",
				dueTz: "Asia/Tokyo",
			}),
			dueCtx,
		);
		expect(due && opensLabel(due)).toBe("Opens Mon 12 Oct 2026 · 09:00 JST");
		expect(due && opensIn(due, now)).toBe("Opens in 15 days");
		expect(longDate("2027-09-07")).toBe("Tue 7 Sep 2027");
		const open = effectiveDue(row({ id: "o", dueDate: "2026-09-27" }), dueCtx);
		expect(open && opensIn(open, now)).toBe("Open now");
	});

	it("the rule it follows", () => {
		const base = { itemId: "x", time: "10:00", tz: "Asia/Tokyo" };
		expect(ruleLabel({ kind: "days", days: 355, ...base })).toBe(
			"355 days before",
		);
		expect(ruleLabel({ kind: "months", months: 1, ...base })).toBe(
			"1 month before",
		);
		expect(
			ruleLabel({ kind: "months", months: 2, dayOfMonth: 10, ...base }),
		).toBe("the 10th, 2 months before");
		expect(ruleLabel({ kind: "days", days: 0, ...base })).toBe("the same day");
	});
});
