import { describe, expect, it } from "vitest";
import {
	addDaysIso,
	DEMO_MEMBERS,
	demo,
	scenario,
	uuid,
} from "@/lib/engine/__fixtures__/demo";
import { zonedEpoch } from "@/lib/engine/time";
import type { TripGraph } from "@/lib/engine/types";
import {
	computeReminders,
	dueWithin,
	type PushTodo,
	planReminderJobs,
	type Reminder,
	reminderJobId,
} from "./reminders";

const MAYA = uuid(0x53);
const MIN = 60_000;
const HOUR = 60 * MIN;

/** The demo trip (Day 1 = Sun 3 Oct 2027, Tokyo) with a second account, Maya. */
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

let seq = 0x9000;
const todo = (over: Partial<PushTodo> = {}): PushTodo => ({
	id: uuid(seq++),
	list: "todo",
	text: "Book [Ghibli Museum](https://ghibli.jp) tickets",
	status: "open",
	dueKind: "opens",
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

const of = (rs: Reminder[], group: Reminder["group"]) =>
	rs.filter((r) => r.group === group);
const jobs = (tripId: string, rs: Reminder[]) =>
	rs.map((r) => ({ jobId: reminderJobId(tripId, r.key), fireAt: r.fireAt }));
const asMap = (xs: { jobId: string; fireAt: number }[]) =>
	Object.fromEntries(xs.map((x) => [x.jobId, x.fireAt]));

describe("booking windows", () => {
	it("a day before and 15 minutes before the window opens, in its zone", () => {
		const t = todo({
			dueDate: "2027-09-03",
			dueTime: "10:00",
			dueTz: "Asia/Tokyo",
		});
		const rs = of(computeReminders(trip(), [t]), "booking");
		const at = Date.parse("2027-09-03T01:00:00Z"); // 10:00 JST
		expect(rs.map((r) => [r.key, r.fireAt])).toEqual([
			[`b1d.${t.id}.${at}`, at - 24 * HOUR],
			[`b15.${t.id}.${at}`, at - 15 * MIN],
		]);
		// Nobody assigned: every member with an account.
		expect(rs[0]?.userIds.sort()).toEqual(["user-dennis", "user-maya"]);
		expect(rs[1]?.item).toMatchObject({
			headline: "A booking opens in 15 minutes",
			body: "Book Ghibli Museum tickets · Opens Fri 3 Sep · 10:00 JST",
			url: "/t/asia-2027?tab=lists&list=todo",
		});
		// Past its opening, "opens in 15 minutes" is stale.
		expect(rs[1]?.staleAt).toBe(at);
	});

	it("a date without a time opens at 00:00 in the trip's zone", () => {
		const t = todo({ dueDate: "2027-09-03" });
		const [first] = of(computeReminders(trip(), [t]), "booking");
		expect(first?.fireAt).toBe(
			zonedEpoch("2027-09-03", "00:00", "Asia/Tokyo") - 24 * HOUR,
		);
	});

	it("deep-links to the to-do's place in the Lists tab", () => {
		const t = todo({
			dueDate: "2027-09-03",
			itemId: demo.I.kiyomizu as string,
		});
		const [r] = of(computeReminders(trip(), [t]), "booking");
		expect(r?.item.url).toBe(
			`/t/asia-2027?sel=i.${demo.I.kiyomizu}&tab=lists&list=todo`,
		);
	});

	it("reschedules when a relative rule's item moves (new keys: old jobs go, new ones come)", () => {
		const kiyomizu = demo.I.kiyomizu as string;
		const t = todo({
			dueRule: {
				kind: "days",
				itemId: kiyomizu,
				days: 30,
				time: "10:00",
				tz: "Asia/Tokyo",
			},
		});
		const before = of(computeReminders(trip(), [t]), "booking");
		// Kiyomizu is on Day 4 (Wed 6 Oct): 30 days before, 10:00 JST.
		expect(before[0]?.fireAt).toBe(
			zonedEpoch("2027-09-06", "10:00", "Asia/Tokyo") - 24 * HOUR,
		);

		const moved = trip((g) => {
			const it = g.items.find((i) => i.id === kiyomizu);
			if (it) it.dayId = demo.D.d5 as string;
		});
		const after = of(computeReminders(moved, [t]), "booking");
		expect(after[0]?.fireAt).toBe(
			zonedEpoch("2027-09-07", "10:00", "Asia/Tokyo") - 24 * HOUR,
		);

		const plan = planReminderJobs(
			asMap(jobs("trip", before)),
			jobs("trip", after),
		);
		expect(plan.remove.sort()).toEqual(
			jobs("trip", before)
				.map((j) => j.jobId)
				.sort(),
		);
		expect(plan.add).toEqual(jobs("trip", after));
		// Unchanged plans change nothing.
		expect(
			planReminderJobs(asMap(jobs("trip", after)), jobs("trip", after)),
		).toEqual({
			add: [],
			remove: [],
		});

		// Its item unscheduled: "Date TBD", nothing planned.
		const tbd = trip((g) => {
			const it = g.items.find((i) => i.id === kiyomizu);
			if (it) it.dayId = null;
		});
		expect(of(computeReminders(tbd, [t]), "booking")).toEqual([]);
	});

	it("a trip date shift moves relative windows, the countdown and the mornings", () => {
		const kiyomizu = demo.I.kiyomizu as string;
		const rel = todo({
			dueRule: {
				kind: "days",
				itemId: kiyomizu,
				days: 30,
				time: "10:00",
				tz: "Asia/Tokyo",
			},
		});
		const abs = todo({
			dueDate: "2027-09-01",
			dueTime: "12:00",
			dueTz: "Asia/Tokyo",
		});
		const shifted = trip((g) => {
			for (const d of g.days) d.date = addDaysIso(d.date, 7);
			g.trip.startDate = g.days[0]?.date ?? null;
			g.trip.endDate = g.days.at(-1)?.date ?? null;
		});
		const a = computeReminders(trip(), [rel, abs]);
		const b = computeReminders(shifted, [rel, abs]);
		const fire = (rs: Reminder[], prefix: string) =>
			rs.filter((r) => r.key.startsWith(prefix)).map((r) => r.fireAt);
		const week = 7 * 24 * HOUR;
		expect(fire(b, `b1d.${rel.id}`)).toEqual(
			fire(a, `b1d.${rel.id}`).map((x) => x + week),
		);
		// An absolute date stays where it is.
		expect(fire(b, `b1d.${abs.id}`)).toEqual(fire(a, `b1d.${abs.id}`));
		expect(fire(b, "cd7.")).toEqual(fire(a, "cd7.").map((x) => x + week));
		expect(fire(b, "today.")).toEqual(fire(a, "today.").map((x) => x + week));
	});

	it("done (or skipped, or deleted) cancels: nothing planned, every job removed", () => {
		const t = todo({
			dueDate: "2027-09-03",
			dueTime: "10:00",
			dueTz: "Asia/Tokyo",
		});
		const open = of(computeReminders(trip(), [t]), "booking");
		const done = of(
			computeReminders(trip(), [{ ...t, status: "done" }]),
			"booking",
		);
		expect(done).toEqual([]);
		const plan = planReminderJobs(asMap(jobs("trip", open)), []);
		expect(plan.remove).toHaveLength(2);
		expect(plan.add).toEqual([]);
	});

	it("a private to-do tells only its author; an assigned one only its assignees", () => {
		const priv = todo({
			dueDate: "2027-09-03",
			isPrivate: true,
			createdBy: "user-maya",
		});
		const mine = todo({ dueDate: "2027-09-03", assigneeIds: [MAYA] });
		const rs = computeReminders(trip(), [priv, mine]);
		expect(rs.find((r) => r.key.includes(priv.id))?.userIds).toEqual([
			"user-maya",
		]);
		expect(rs.find((r) => r.key.includes(mine.id))?.userIds).toEqual([
			"user-maya",
		]);
	});
});

describe("due reminders", () => {
	it("only assigned to-dos, at their due time; a bare date at 09:00 local", () => {
		const loose = todo({ dueKind: "due", dueDate: "2027-09-10" });
		const bare = todo({
			dueKind: "due",
			dueDate: "2027-09-10",
			assigneeIds: [MAYA],
		});
		const timed = todo({
			dueKind: "on",
			dueDate: "2027-09-11",
			dueTime: "18:30",
			dueTz: "Asia/Seoul",
			assigneeIds: [DEMO_MEMBERS.dennis],
		});
		const rs = of(computeReminders(trip(), [loose, bare, timed]), "due");
		expect(rs.map((r) => [r.key.split(".")[1], r.fireAt, r.userIds])).toEqual([
			[bare.id, zonedEpoch("2027-09-10", "09:00", "Asia/Tokyo"), ["user-maya"]],
			[
				timed.id,
				zonedEpoch("2027-09-11", "18:30", "Asia/Seoul"),
				["user-dennis"],
			],
		]);
		expect(rs[0]?.item.headline).toBe("A to-do is due today");
		expect(rs[1]?.item.headline).toBe("A to-do for today");
	});
});

describe("countdown and mornings", () => {
	it("09:00 in Day 1's zone, 7 days and 1 day before", () => {
		const rs = of(computeReminders(trip(), []), "countdown");
		expect(rs.map((r) => [r.item.headline, r.fireAt])).toEqual([
			["starts in 7 days", Date.parse("2027-09-26T00:00:00Z")],
			["starts tomorrow", Date.parse("2027-10-02T00:00:00Z")],
		]);
		expect(rs[0]?.item.body).toBe("Day 1 is Sun 3 Oct in Tokyo");
		expect(rs[0]?.userIds.sort()).toEqual(["user-dennis", "user-maya"]);
	});

	it("follows Day 1's own zone (not the server's, not UTC)", () => {
		const s = scenario({
			firstDate: "2027-05-01",
			defaultTz: "UTC",
			days: [{ items: [{ k: "ewr", node: "ewr", min: 60 }] }],
		});
		const rs = of(computeReminders(s.graph, []), "countdown");
		// 09:00 EDT = 13:00 UTC.
		expect(rs[0]?.fireAt).toBe(Date.parse("2027-04-24T13:00:00Z"));
	});

	it("07:30 each trip day, in that day's zone, with the first stop", () => {
		const rs = of(computeReminders(trip(), []), "today");
		expect(rs).toHaveLength(demo.graph.days.length);
		expect(rs[0]).toMatchObject({
			fireAt: zonedEpoch("2027-10-03", "07:30", "Asia/Tokyo"),
			item: {
				headline: "Day 1",
				body: "Today in Tokyo: first stop 9:00 Hands Shibuya",
				url: `/t/asia-2027?sel=d.${demo.D.d1}`,
			},
		});
		expect(rs.every((r) => r.userIds.length === 2)).toBe(true);
	});

	it("no members with an account, no countdown or mornings", () => {
		const g = structuredClone(demo.graph);
		g.members = g.members.filter((m) => m.status !== "active");
		expect(computeReminders(g, [])).toEqual([]);
	});
});

describe("dueWithin", () => {
	it("keeps what fires within the horizon and isn't stale", () => {
		const rs = computeReminders(trip(), []);
		const now = Date.parse("2027-10-02T12:00:00Z");
		const soon = dueWithin(rs, now, 48 * HOUR).map((r) => r.key);
		// The "starts tomorrow" at 00:00Z on the 2nd is 12 h old: stale is 6 h.
		expect(soon).not.toContain(`cd1.2027-10-03`);
		expect(soon).toContain(`today.${demo.D.d1}.2027-10-03`);
		expect(soon).toContain(`today.${demo.D.d2}.2027-10-04`);
		expect(soon).not.toContain(`today.${demo.D.d3}.2027-10-05`);
	});
});
