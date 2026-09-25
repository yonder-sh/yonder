/**
 * Planned notifications of a trip (pure): what fires when, and for whom.
 *
 * - Booking windows: to-dos with `dueKind = 'opens'`, at `at − 1 day` and
 *   `at − 15 min`, where `at` is the to-do's effective instant
 *   (`effectiveDue`: relative rules follow their item and the trip's dates).
 * - Due reminders: an assigned to-do's due instant for the other kinds (a
 *   date without a time fires at 09:00 that day in its zone, not at 23:59).
 * - Countdown: "starts in 7 days" and "starts tomorrow", at 09:00 in Day 1's
 *   zone.
 * - Today: each trip day at 07:30 in that day's zone ("Today in Kyoto: first
 *   stop 9:00 Fushimi Inari"). The app keeps no per-member travel days, so
 *   every member gets it.
 *
 * Done, skipped and deleted to-dos plan nothing, so recomputing after any
 * change reschedules moved instants and cancels the rest; the worker diffs
 * the result against what it scheduled (`planReminderJobs`) and checks each
 * job again when it fires.
 */
import { dayPlace } from "@/lib/engine/day-place";
import {
	dueCtxOf,
	type EffectiveDue,
	effectiveDue,
	shortDate,
} from "@/lib/engine/due";
import { type GraphIndex, indexGraph } from "@/lib/engine/graph-index";
import { computeSchedule } from "@/lib/engine/schedule";
import { addDays, hhmm, zonedEpoch } from "@/lib/engine/time";
import type { ScheduleResult, TripGraph } from "@/lib/engine/types";
import type { DueKind, ListKind } from "@/lib/schemas/enums";
import type { DueRule } from "@/lib/schemas/lists";
import { tripUrl } from "./links";
import { dueAudience, memberUserIds, todoAudience } from "./recipients";
import type { PushItem } from "./types";

/** A list row as the reminder planner reads it (`loadPushTodos`). */
export type PushTodo = {
	id: string;
	list: ListKind;
	text: string;
	status: "open" | "done" | "skipped";
	dueKind: DueKind;
	dueRule: DueRule | null;
	dueDate: string | null;
	dueTime: string | null;
	dueTz: string | null;
	dueDayId: string | null;
	isPrivate: boolean;
	/** The author's user id. */
	createdBy: string | null;
	/** Member ids. */
	assigneeIds: string[];
	nodeId: string | null;
	itemId: string | null;
	legId: string | null;
	dayId: string | null;
};

export type ReminderGroup = "booking" | "due" | "countdown" | "today";

export type Reminder = {
	/** Stable while the instant stays; safe in a BullMQ job id (no ':'). */
	key: string;
	group: ReminderGroup;
	/** When to send (epoch ms). */
	fireAt: number;
	/** Too late to be useful after this. */
	staleAt: number;
	/** Who it is for, before prefs and devices (user ids). */
	userIds: string[];
	item: PushItem;
};

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
export const BOOKING_LEADS = [
	{ id: "b1d", ms: DAY },
	{ id: "b15", ms: 15 * MIN },
] as const;
export const COUNTDOWN_DAYS = [7, 1] as const;
export const COUNTDOWN_TIME = "09:00";
export const TODAY_TIME = "07:30";
/** A date-only due reminder fires at this local time on its date. */
export const ALL_DAY_DUE_TIME = "09:00";

/** A to-do's inbox-style link: the Lists tab, on its target. */
export function todoUrl(slug: string, t: PushTodo): string {
	const sel = t.itemId
		? `i.${t.itemId}`
		: t.nodeId
			? `n.${t.nodeId}`
			: t.dayId
				? `d.${t.dayId}`
				: undefined;
	return tripUrl(slug, {
		tab: "lists",
		list: t.list === "shopping" ? "shopping" : "todo",
		...(sel ? { sel } : {}),
	});
}

/** One line of a to-do's text (Markdown tokens and links flattened). */
export function todoText(text: string): string {
	return (
		text
			.replace(/\[@([^\]]*)\]\(mention:[^)]*\)/g, "@$1")
			.replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
			.replace(/[*_`~>#]+/g, "")
			.replace(/\s+/g, " ")
			.trim()
			.slice(0, 160) || "A to-do"
	);
}

/** When a due reminder fires: its instant, or 09:00 local for a bare date. */
export function dueFireAt(due: EffectiveDue): number {
	return due.allDay && !due.dayId
		? zonedEpoch(due.date, ALL_DAY_DUE_TIME, due.tz)
		: due.at;
}

function bookingReminders(
	t: PushTodo,
	due: EffectiveDue,
	userIds: string[],
	slug: string,
): Reminder[] {
	const text = todoText(t.text);
	const url = todoUrl(slug, t);
	return BOOKING_LEADS.map((lead) => {
		const fireAt = due.at - lead.ms;
		return {
			key: `${lead.id}.${t.id}.${due.at}`,
			group: "booking" as const,
			fireAt,
			// "Opens in 15 min" is wrong once it has opened.
			staleAt: Math.min(fireAt + 30 * MIN, due.at),
			userIds,
			item: {
				key: `${lead.id}.${t.id}.${due.at}`,
				at: fireAt,
				actor: null,
				headline:
					lead.id === "b1d"
						? "A booking opens tomorrow"
						: "A booking opens in 15 minutes",
				body: `${text} · ${due.label}`,
				url,
				meta: { label: text },
			},
		};
	});
}

function dueReminder(
	t: PushTodo,
	due: EffectiveDue,
	userIds: string[],
	slug: string,
): Reminder {
	const text = todoText(t.text);
	const fireAt = dueFireAt(due);
	const headline =
		due.kind === "on"
			? "A to-do for today"
			: due.allDay
				? "A to-do is due today"
				: "A to-do is due now";
	return {
		key: `due.${t.id}.${due.at}`,
		group: "due",
		fireAt,
		staleAt: fireAt + 2 * HOUR,
		userIds,
		item: {
			key: `due.${t.id}.${due.at}`,
			at: fireAt,
			actor: null,
			headline,
			body: `${text} · ${due.label}`,
			url: todoUrl(slug, t),
			meta: { label: text },
		},
	};
}

/** "Today in Kyoto: first stop 9:00 Fushimi Inari" for one trip day. */
export function todayLine(
	ix: GraphIndex,
	schedule: ScheduleResult,
	dayId: string,
): string {
	const placeId = dayPlace(ix, schedule, dayId);
	const place = placeId ? ix.node(placeId)?.name : undefined;
	let first: { at: number; tz: string; name: string } | null = null;
	for (const item of ix.itemsByDay.get(dayId) ?? []) {
		const s = schedule.items[item.id];
		if (!s) continue;
		const at = s.start.getTime();
		if (first && first.at <= at) continue;
		const name = item.title ?? ix.node(item.nodeId)?.name;
		if (!name) continue;
		first = { at, tz: s.tz, name };
	}
	const stop = first
		? `first stop ${hhmm(first.at, first.tz).replace(/^0(\d)/, "$1")} ${first.name}`
		: null;
	if (place && stop) return `Today in ${place}: ${stop}`;
	if (place) return `Today in ${place}`;
	if (stop) return `Today: ${stop.charAt(0).toUpperCase()}${stop.slice(1)}`;
	return `Day ${ix.dayNumber(dayId)} of ${ix.days.length}`;
}

export type ComputeOptions = {
	ix?: GraphIndex;
	schedule?: ScheduleResult;
};

/** Everything a trip plans, whatever the instant (the caller filters by time). */
export function computeReminders(
	graph: TripGraph,
	todos: readonly PushTodo[],
	opts: ComputeOptions = {},
): Reminder[] {
	const ix = opts.ix ?? indexGraph(graph);
	const schedule = opts.schedule ?? computeSchedule(ix);
	const ctx = dueCtxOf(ix, schedule);
	const slug = graph.trip.slug;
	const everyone = memberUserIds(graph.members);
	const out: Reminder[] = [];

	for (const t of todos) {
		if (t.status !== "open") continue;
		const due = effectiveDue(t, ctx);
		if (!due) continue;
		if (due.kind === "opens") {
			const userIds = todoAudience(t, graph.members);
			if (userIds.length) out.push(...bookingReminders(t, due, userIds, slug));
		} else {
			const userIds = dueAudience(t, graph.members);
			if (userIds.length) out.push(dueReminder(t, due, userIds, slug));
		}
	}

	const day1 = ix.days[0];
	if (day1 && everyone.length) {
		const tz = ctx.dayTz(day1.id);
		const placeId = dayPlace(ix, schedule, day1.id);
		const place = placeId ? ix.node(placeId)?.name : undefined;
		for (const n of COUNTDOWN_DAYS) {
			const fireAt = zonedEpoch(addDays(day1.date, -n), COUNTDOWN_TIME, tz);
			out.push({
				key: `cd${n}.${day1.date}`,
				group: "countdown",
				fireAt,
				staleAt: fireAt + 6 * HOUR,
				userIds: everyone,
				item: {
					key: `cd${n}.${day1.date}`,
					at: fireAt,
					actor: null,
					headline: n === 1 ? "starts tomorrow" : `starts in ${n} days`,
					body: `Day 1 is ${shortDate(day1.date)}${place ? ` in ${place}` : ""}`,
					url: tripUrl(slug),
				},
			});
		}
	}

	if (everyone.length) {
		for (const day of ix.days) {
			const tz = ctx.dayTz(day.id);
			const fireAt = zonedEpoch(day.date, TODAY_TIME, tz);
			const n = ix.dayNumber(day.id);
			out.push({
				key: `today.${day.id}.${day.date}`,
				group: "today",
				fireAt,
				staleAt: fireAt + 4 * HOUR,
				userIds: everyone,
				item: {
					key: `today.${day.id}.${day.date}`,
					at: fireAt,
					actor: null,
					headline: `Day ${n}`,
					body: todayLine(ix, schedule, day.id),
					url: tripUrl(slug, { sel: `d.${day.id}` }),
				},
			});
		}
	}
	return out;
}

/** The BullMQ job id of a trip's reminder (no ':' allowed there). */
export function reminderJobId(tripId: string, key: string): string {
	return `push-rem-${tripId}-${key}`;
}

/**
 * What to change in the scheduled jobs: `current` = job id → fireAt as
 * scheduled, `desired` = the reminders due within the horizon now.
 * Moved instants get a new key, so they show up as one removal + one add.
 */
export function planReminderJobs(
	current: Readonly<Record<string, number>>,
	desired: readonly { jobId: string; fireAt: number }[],
): { add: { jobId: string; fireAt: number }[]; remove: string[] } {
	const want = new Map(desired.map((d) => [d.jobId, d.fireAt]));
	const remove = Object.keys(current).filter(
		(id) => want.get(id) !== current[id],
	);
	const add = desired.filter((d) => current[d.jobId] !== d.fireAt);
	return { add, remove };
}

/** The reminders to schedule now: firing within `horizonMs`, not already stale. */
export function dueWithin(
	reminders: readonly Reminder[],
	now: number,
	horizonMs: number,
): Reminder[] {
	return reminders.filter(
		(r) =>
			r.fireAt <= now + horizonMs &&
			r.staleAt > now &&
			r.fireAt > now - 5 * MIN,
	);
}
