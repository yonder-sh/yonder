/**
 * The dashboard's deadline chip reads like the trip's Lists (QA DUE-05): a
 * to-do one hour overdue is "Overdue 1h" in both places, not "Overdue 1d".
 */
import { describe, expect, it } from "vitest";
import {
	type DueCtx,
	dueChipLabel,
	dueState,
	effectiveDue,
} from "@/lib/engine/due";
import { zonedEpoch } from "@/lib/engine/time";
import { deadlineLabel } from "../deadline-label";
import type { MyDeadline } from "../types";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

function row(over: Partial<MyDeadline>): MyDeadline {
	return {
		listItemId: "li",
		tripId: "t",
		tripSlug: "asia-2027",
		tripName: "Asia 2027",
		text: "Book",
		dueDate: "2026-09-30",
		dueTime: null,
		dueTz: null,
		sel: null,
		...over,
	};
}

const ctx: DueCtx = {
	daysById: new Map(),
	dayTz: () => "Asia/Tokyo",
	tripTz: "Asia/Tokyo",
	itemDayId: () => null,
};

describe("deadlineLabel", () => {
	it("QA DUE-05: an 'on' to-do due today in Tokyo, seen from a New York afternoon, matches Lists", () => {
		const at = zonedEpoch("2026-09-23", "23:59", "Asia/Tokyo");
		const now = zonedEpoch("2026-09-23", "11:30", "America/New_York");
		expect(now - at).toBeGreaterThan(0);
		expect(now - at).toBeLessThan(2 * HOUR);
		const dash = deadlineLabel(
			row({
				dueKind: "on",
				dueDate: "2026-09-23",
				dueTz: "Asia/Tokyo",
				at,
				state: "overdue",
			}),
			now,
		);
		const due = effectiveDue(
			{
				dueKind: "on",
				dueRule: null,
				dueDate: "2026-09-23",
				dueTime: null,
				dueTz: null,
				dueDayId: null,
			},
			ctx,
		);
		if (!due) throw new Error("no due");
		expect(dash).toBe("Overdue 1h");
		expect(dash).toBe(dueChipLabel(due, dueState(due, now), now));
	});

	it("counts days past a day, and says Opened … ago for booking windows", () => {
		const now = Date.parse("2026-09-23T18:00:00Z");
		expect(
			deadlineLabel(row({ at: now - 3 * DAY - HOUR, state: "overdue" }), now),
		).toBe("Overdue 3d");
		expect(
			deadlineLabel(
				row({ dueKind: "opens", at: now - 5 * DAY, state: "overdue" }),
				now,
			),
		).toBe("Opened 5d ago");
		expect(
			deadlineLabel(
				row({ dueKind: "opens", at: now - HOUR, state: "open_now" }),
				now,
			),
		).toBe("Open now");
	});

	it("names the date (and time with its zone) before it's due", () => {
		const at = zonedEpoch("2026-09-30", "23:59", "America/New_York");
		const now = Date.parse("2026-09-23T18:00:00Z");
		const label = deadlineLabel(
			row({
				dueTime: "23:59",
				dueTz: "America/New_York",
				at,
				state: "later",
			}),
			now,
		);
		expect(label).toMatch(/^Due Wed 30 Sep · 23:59 \S+$/);
		expect(deadlineLabel(row({ dueKind: "on", at, state: "soon" }), now)).toBe(
			"On Wed 30 Sep",
		);
		expect(
			deadlineLabel(
				row({ dueKind: "opens", dueTime: "09:00", at, state: "later" }),
				now,
			),
		).toBe("Opens Wed 30 Sep · 09:00");
	});
});
