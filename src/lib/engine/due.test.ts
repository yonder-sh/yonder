/**
 * E4 + ADDENDUM §10 due dates (EXTENSIONS §7 "Tests"). The unit project runs
 * with TZ=Pacific/Kiritimati, so any host-local conversion fails loudly.
 */
import { describe, expect, it } from "vitest";
import type { ListItemDto } from "@/features/lists/lists.functions";
import { demo } from "@/lib/fixtures/demo";
import {
	dueBuckets,
	dueChipLabel,
	dueCtxOf,
	dueState,
	effectiveDue,
	ruleDate,
	sortListItems,
} from "./due";
import { indexGraph } from "./graph-index";
import type { TripGraph } from "./types";

const HOUR = 3_600_000;

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
		mine: false,
		...p,
	};
}

const ix = indexGraph(demo.graph);
const ctx = dueCtxOf(ix);
const D = demo.D as Record<string, string>;
const I = demo.I as Record<string, string>;

/** A copy of the demo graph with every day moved by `n` days (a trip shift). */
function shifted(n: number): TripGraph {
	const g = structuredClone(demo.graph);
	for (const d of g.days) {
		const dt = new Date(`${d.date}T00:00:00Z`);
		dt.setUTCDate(dt.getUTCDate() + n);
		d.date = dt.toISOString().slice(0, 10);
	}
	return g;
}

describe("effectiveDue", () => {
	it("an ET deadline is the same instant when viewed from JST (and the host zone)", () => {
		const due = effectiveDue(
			row({
				id: "et",
				dueDate: "2026-09-30",
				dueTime: "20:00",
				dueTz: "America/New_York",
			}),
			ctx,
		);
		expect(due?.at).toBe(Date.parse("2026-10-01T00:00:00Z"));
		expect(due?.label).toBe("Due Wed 30 Sep · 20:00 EDT");
		// 09:00 on 1 Oct in Tokyo is exactly that instant.
		expect(new Date(due?.at ?? 0).toISOString()).toBe(
			"2026-10-01T00:00:00.000Z",
		);
	});

	it("a date alone ends the day (due) or starts it (opens) in the trip zone", () => {
		const due = effectiveDue(row({ id: "d", dueDate: "2027-10-02" }), ctx);
		expect(due?.at).toBe(Date.parse("2027-10-02T23:59:00+09:00"));
		expect(due?.allDay).toBe(true);
		const opens = effectiveDue(
			row({ id: "o", dueDate: "2027-10-02", dueKind: "opens" }),
			ctx,
		);
		expect(opens?.at).toBe(Date.parse("2027-10-02T00:00:00+09:00"));
		expect(opens?.label).toBe("Opens Sat 2 Oct");
	});

	it("a day-based due date is the day's start, labelled 'by Day N'", () => {
		const d4 = D.d4 as string;
		const due = effectiveDue(row({ id: "day", dueDayId: d4 }), ctx);
		expect(due?.label).toBe("by Day 4");
		expect(due?.at).toBe(Date.parse("2027-10-06T09:00:00+09:00"));
		// The earlier of an absolute date and a day wins.
		const both = effectiveDue(
			row({ id: "both", dueDayId: d4, dueDate: "2027-10-01" }),
			ctx,
		);
		expect(both?.date).toBe("2027-10-01");
	});

	it("a relative rule (355 days @ 09:00 JST) follows its item to another day", () => {
		const r = row({
			id: "ana",
			dueKind: "opens",
			dueRule: {
				kind: "days",
				itemId: I.kix as string,
				days: 355,
				time: "09:00",
				tz: "Asia/Tokyo",
			},
		});
		// KIX is on Day 5 (2027-10-07) → 2026-10-17 09:00 JST.
		const due = effectiveDue(r, ctx);
		expect(due?.relative).toBe(true);
		expect(due?.at).toBe(Date.parse("2026-10-17T09:00:00+09:00"));
		expect(due?.label).toBe("Opens Sat 17 Oct · 09:00 JST");
		// Move the item to Day 4: the window moves one day earlier.
		const g = structuredClone(demo.graph);
		const kix = g.items.find((i) => i.id === I.kix);
		if (kix) kix.dayId = D.d4 as string;
		const moved = effectiveDue(r, dueCtxOf(indexGraph(g)));
		expect(moved?.at).toBe(Date.parse("2026-10-16T09:00:00+09:00"));
		// Shift the whole trip by +1 day: the window follows.
		const later = effectiveDue(r, dueCtxOf(indexGraph(shifted(1))));
		expect(later?.at).toBe(Date.parse("2026-10-18T09:00:00+09:00"));
	});

	it("month rules: 1 month before @ 10:00, and the 10th two months before", () => {
		const itemId = I.dropBags as string; // Day 3, 2027-10-05
		const oneMonth = effectiveDue(
			row({
				id: "jr",
				dueKind: "opens",
				dueRule: {
					kind: "months",
					itemId,
					months: 1,
					time: "10:00",
					tz: "Asia/Tokyo",
				},
			}),
			ctx,
		);
		expect(oneMonth?.at).toBe(Date.parse("2027-09-05T10:00:00+09:00"));
		const tenth = effectiveDue(
			row({
				id: "ghibli",
				dueKind: "opens",
				dueRule: {
					kind: "months",
					itemId,
					months: 2,
					dayOfMonth: 10,
					time: "14:00",
					tz: "Asia/Tokyo",
				},
			}),
			ctx,
		);
		expect(tenth?.at).toBe(Date.parse("2027-08-10T14:00:00+09:00"));
		expect(
			ruleDate(
				{ kind: "months", itemId, months: 1, time: "10:00", tz: "UTC" },
				"2027-10-31",
			),
		).toBe("2027-09-30");
		expect(
			ruleDate(
				{
					kind: "months",
					itemId,
					months: 1,
					dayOfMonth: 31,
					time: "10:00",
					tz: "UTC",
				},
				"2027-03-15",
			),
		).toBe("2027-02-28");
	});

	it("a rule whose item is unscheduled or gone has no date (Date TBD)", () => {
		const unscheduled = row({
			id: "tbd",
			dueRule: {
				kind: "days",
				itemId: I.backup as string,
				days: 3,
				time: "09:00",
				tz: "Asia/Tokyo",
			},
		});
		expect(effectiveDue(unscheduled, ctx)).toBeNull();
		const gone = row({
			id: "gone",
			dueRule: {
				kind: "days",
				itemId: "00000000-0000-4000-8000-000000000000",
				days: 3,
				time: "09:00",
				tz: "Asia/Tokyo",
			},
		});
		expect(effectiveDue(gone, ctx)).toBeNull();
	});
});

describe("dueState", () => {
	const opens = effectiveDue(
		row({
			id: "w",
			dueKind: "opens",
			dueDate: "2027-09-01",
			dueTime: "10:00",
			dueTz: "Asia/Tokyo",
		}),
		ctx,
	);
	const at = opens?.at ?? 0;

	it("an opened window is 'open now' for 72 h, then overdue ('Opened 3d ago')", () => {
		expect(dueState(opens, at - HOUR)).toBe("today");
		expect(dueState(opens, at + HOUR)).toBe("open_now");
		expect(dueState(opens, at + 71 * HOUR)).toBe("open_now");
		expect(dueState(opens, at + 73 * HOUR)).toBe("overdue");
		if (opens)
			expect(dueChipLabel(opens, "overdue", at + 73 * HOUR)).toBe(
				"Opened 3d ago",
			);
		if (opens)
			expect(dueChipLabel(opens, "overdue", at + 5 * 24 * HOUR)).toBe(
				"Opened 5d ago",
			);
	});

	it("a done or skipped row is never overdue", () => {
		expect(dueState(opens, at + 200 * HOUR, "done")).toBe("none");
		expect(dueState(opens, at + 200 * HOUR, "skipped")).toBe("none");
		expect(dueState(null, at)).toBe("none");
	});

	it("deadlines: overdue after the instant, today, soon within 7 days, later", () => {
		const due = effectiveDue(row({ id: "x", dueDate: "2027-10-10" }), ctx);
		const end = due?.at ?? 0;
		expect(dueState(due, end + 60_000)).toBe("overdue");
		expect(dueState(due, end - HOUR)).toBe("today");
		expect(dueState(due, end - 3 * 24 * HOUR)).toBe("soon");
		expect(dueState(due, end - 30 * 24 * HOUR)).toBe("later");
	});

	it("'on' stays today all day and is overdue only after the day", () => {
		const on = effectiveDue(
			row({ id: "on", dueKind: "on", dueDayId: D.d2 as string }),
			ctx,
		);
		const start = on?.at ?? 0;
		expect(dueState(on, start + 3 * HOUR)).toBe("today");
		expect(dueState(on, start + 20 * HOUR)).toBe("overdue");
	});
});

describe("ordering and buckets", () => {
	const rows = [
		row({ id: "c", position: "a2", dueDate: "2027-10-10" }),
		row({ id: "a", position: "a0" }),
		row({ id: "b", position: "a1", dueDate: "2027-10-01" }),
		row({ id: "d", position: "a3", dueDate: "2027-10-01" }),
	];

	it("sorts by due (undated last), ties by position; stable across calls", () => {
		const once = sortListItems(rows, "due", ctx).map((r) => r.id);
		expect(once).toEqual(["b", "d", "c", "a"]);
		expect(
			sortListItems([...rows].reverse(), "due", ctx).map((r) => r.id),
		).toEqual(once);
		expect(sortListItems(rows, "place", ctx).map((r) => r.id)).toEqual([
			"a",
			"b",
			"c",
			"d",
		]);
	});

	it("recent is newest first", () => {
		const r = [
			row({ id: "old", createdAt: "2026-01-01T00:00:00.000Z" }),
			row({ id: "new", createdAt: "2026-09-01T00:00:00.000Z" }),
		];
		expect(sortListItems(r, "recent", ctx).map((x) => x.id)).toEqual([
			"new",
			"old",
		]);
	});

	it("'by Day 4' rolls into This week on time", () => {
		const r = row({ id: "d4", dueDayId: D.d4 as string });
		const at = effectiveDue(r, ctx)?.at ?? 0;
		expect(dueBuckets([r], at - 30 * 24 * HOUR, ctx)[0]?.key).toBe("later");
		expect(dueBuckets([r], at - 3 * 24 * HOUR, ctx)[0]?.key).toBe("week");
		expect(dueBuckets([r], at + HOUR, ctx)[0]?.key).toBe("overdue");
	});

	it("buckets: overdue, today (incl. open now), week, later, no date", () => {
		const now = Date.parse("2027-10-01T12:00:00+09:00");
		const b = dueBuckets(
			[
				row({ id: "late", dueDate: "2027-09-20" }),
				row({ id: "today", dueDate: "2027-10-01" }),
				row({
					id: "open",
					dueKind: "opens",
					dueDate: "2027-10-01",
					dueTime: "10:00",
					dueTz: "Asia/Tokyo",
				}),
				row({ id: "week", dueDate: "2027-10-05" }),
				row({ id: "later", dueDate: "2027-11-20" }),
				row({ id: "none" }),
			],
			now,
			ctx,
		);
		expect(b.map((x) => [x.key, x.rows.map((r) => r.id)])).toEqual([
			["overdue", ["late"]],
			["today", ["open", "today"]],
			["week", ["week"]],
			["later", ["later"]],
			["none", ["none"]],
		]);
	});
});
