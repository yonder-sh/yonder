/**
 * E4 due dates (EXTENSIONS §7), WP-Lists. Pure.
 *
 * - Due instant: `dueDate` + `dueTime` in `dueTz`; a date alone → 23:59 (`due`,
 *   `on`) or 00:00 (`opens`) in the trip tz; `dueDayId` → the day's start.
 *   The earlier wins.
 * - ADDENDUM §10: a `dueRule` (relative to an item's day) replaces the
 *   absolute fields and recomputes whenever that item or the trip moves:
 *   `days` → that many days before the item's day at `time` in `tz`;
 *   `months` → that many calendar months before (clamped to the month's last
 *   day; `dayOfMonth` picks the day). The anchor item unscheduled or gone →
 *   no due date ("Date TBD").
 * - States: `opens` is `open_now` for 72 h, then `overdue` ("Opened 5d ago").
 *   Done and skipped → `none`.
 *
 * The first argument of `effectiveDue` only needs the due fields, so the
 * inbox feed (F) can pass its own rows.
 */
import { Temporal } from "temporal-polyfill";
import type { ListItemDto } from "@/features/lists/lists.functions";
import type { DueKind } from "@/lib/schemas/enums";
import type { DueRule } from "@/lib/schemas/lists";
import type { GraphIndex } from "./graph-index";
import {
	addDays,
	localDateOf,
	normalizeTimeZone,
	tzLabel,
	zonedEpoch,
} from "./time";
import type { GraphDay, ScheduleResult } from "./types";

export type EffectiveDue = {
	/** Epoch ms. */
	at: number;
	kind: DueKind;
	/** "Due Fri 2 Oct", "Opens Wed 30 Sep · 20:00 ET", "On Tue 6 Oct", "by Day 4". */
	label: string;
	/** No wall time was given (a date alone). */
	allDay: boolean;
	/** Resolved from a `dueRule` (it follows its item). */
	relative?: true;
	/** The zone the instant was expressed in (for "today" and labels). */
	tz: string;
	/** The local date of `at` in `tz`. */
	date: string;
	/** Set when the winning date came from `dueDayId` ("by Day 4"). */
	dayId?: string;
};

export type DueState =
	| "overdue"
	| "open_now"
	| "today"
	| "soon"
	| "later"
	| "none";

export type ListView = "due" | "place" | "person" | "recent";

export type DueCtx = {
	daysById: ReadonlyMap<string, GraphDay>;
	dayTz(dayId: string): string;
	tripTz: string;
	/** The day an item sits on (null = Unscheduled or gone), for `dueRule`. */
	itemDayId(itemId: string): string | null;
	/** 1-based day number for "by Day 4" labels (optional). */
	dayNumber?(dayId: string): number;
};

/** The fields `effectiveDue` reads (a `ListItemDto` has them all). */
export type DueFields = Pick<
	ListItemDto,
	"dueKind" | "dueRule" | "dueDate" | "dueTime" | "dueTz" | "dueDayId"
>;

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
/** An opened booking window counts as "open now" for 72 h, then overdue. */
export const OPEN_NOW_MS = 72 * HOUR;
/** "soon" = within 7 days. */
export const SOON_MS = 7 * DAY;

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;
const MONTHS = [
	"Jan",
	"Feb",
	"Mar",
	"Apr",
	"May",
	"Jun",
	"Jul",
	"Aug",
	"Sep",
	"Oct",
	"Nov",
	"Dec",
] as const;

/** "Fri 2 Oct" (DESIGN §12 voice). */
export function shortDate(date: string): string {
	const d = Temporal.PlainDate.from(date);
	return `${WEEKDAYS[d.dayOfWeek % 7]} ${d.day} ${MONTHS[d.month - 1]}`;
}

const KIND_WORD: Record<DueKind, string> = {
	due: "Due",
	opens: "Opens",
	on: "On",
};

function safeTz(tz: string | null | undefined, fallback: string): string {
	return normalizeTimeZone(tz ?? "") ?? normalizeTimeZone(fallback) ?? "UTC";
}

/** The local date a relative rule lands on, or null when it can't resolve. */
export function ruleDate(rule: DueRule, anchorDate: string): string | null {
	try {
		if (rule.kind === "days") return addDays(anchorDate, -rule.days);
		const anchor = Temporal.PlainDate.from(anchorDate);
		// Calendar months back; Temporal constrains 31 Oct − 1 month to 30 Sep.
		const back = anchor.subtract({ months: rule.months });
		if (rule.dayOfMonth === undefined) return back.toString();
		const day = Math.min(rule.dayOfMonth, back.daysInMonth);
		return back.with({ day }).toString();
	} catch {
		return null;
	}
}

function labelFor(
	kind: DueKind,
	date: string,
	time: string | null,
	tz: string,
	at: number,
): string {
	const when = `${shortDate(date)}${time ? ` · ${time} ${tzLabel(tz, at)}` : ""}`;
	return `${KIND_WORD[kind]} ${when}`;
}

/**
 * The due instant of a list item (EXTENSIONS §7), or null (no date, or a
 * relative rule whose item is unscheduled or gone: "Date TBD").
 */
export function effectiveDue(li: DueFields, ctx: DueCtx): EffectiveDue | null {
	const kind = li.dueKind ?? "due";
	if (li.dueRule) {
		const rule = li.dueRule;
		const dayId = ctx.itemDayId(rule.itemId);
		const day = dayId ? ctx.daysById.get(dayId) : undefined;
		if (!day) return null;
		const date = ruleDate(rule, day.date);
		if (!date) return null;
		const tz = safeTz(rule.tz, ctx.tripTz);
		const at = zonedEpoch(date, rule.time, tz);
		return {
			at,
			kind,
			label: labelFor(kind, date, rule.time, tz, at),
			allDay: false,
			relative: true,
			tz,
			date,
		};
	}
	const candidates: EffectiveDue[] = [];
	if (li.dueDate) {
		if (li.dueTime) {
			const tz = safeTz(li.dueTz, ctx.tripTz);
			const at = zonedEpoch(li.dueDate, li.dueTime, tz);
			candidates.push({
				at,
				kind,
				label: labelFor(kind, li.dueDate, li.dueTime, tz, at),
				allDay: false,
				tz,
				date: li.dueDate,
			});
		} else {
			const tz = safeTz(ctx.tripTz, "UTC");
			const at = zonedEpoch(
				li.dueDate,
				kind === "opens" ? "00:00" : "23:59",
				tz,
			);
			candidates.push({
				at,
				kind,
				label: labelFor(kind, li.dueDate, null, tz, at),
				allDay: true,
				tz,
				date: li.dueDate,
			});
		}
	}
	if (li.dueDayId) {
		const day = ctx.daysById.get(li.dueDayId);
		if (day) {
			const tz = safeTz(ctx.dayTz(day.id), ctx.tripTz);
			const at = zonedEpoch(day.date, day.startTime || "09:00", tz);
			const n = ctx.dayNumber?.(day.id);
			candidates.push({
				at,
				kind,
				label:
					kind === "due"
						? n
							? `by Day ${n}`
							: `by ${shortDate(day.date)}`
						: `${KIND_WORD[kind]} ${n ? `Day ${n} · ` : ""}${shortDate(day.date)}`,
				allDay: true,
				tz,
				date: day.date,
				dayId: day.id,
			});
		}
	}
	if (candidates.length === 0) return null;
	return candidates.reduce((a, b) => (b.at < a.at ? b : a));
}

/**
 * Where a due date stands at `now`. Pass the row's `status`: done and skipped
 * rows are never overdue (`none`).
 */
export function dueState(
	due: EffectiveDue | null,
	now: number,
	status: "open" | "done" | "skipped" = "open",
): DueState {
	if (!due || status !== "open") return "none";
	if (due.kind === "opens") {
		if (now >= due.at + OPEN_NOW_MS) return "overdue";
		if (now >= due.at) return "open_now";
	}
	const today = localDateOf(now, due.tz) === due.date;
	if (due.kind === "on") {
		if (today) return "today";
		if (now > due.at) return "overdue";
	} else {
		if (now > due.at) return "overdue";
		if (today) return "today";
	}
	if (due.at - now <= SOON_MS) return "soon";
	return "later";
}

/** "Overdue 3d", "Opened 5d ago", "Open now", "Today" … for a row's due chip. */
export function dueChipLabel(
	due: EffectiveDue,
	state: DueState,
	now: number,
): string {
	const days = Math.max(1, Math.floor(Math.abs(now - due.at) / DAY));
	const hours = Math.max(1, Math.floor(Math.abs(now - due.at) / HOUR));
	const ago = Math.abs(now - due.at) < DAY ? `${hours}h` : `${days}d`;
	switch (state) {
		case "overdue":
			return due.kind === "opens" ? `Opened ${ago} ago` : `Overdue ${ago}`;
		case "open_now":
			return "Open now";
		default:
			return due.label;
	}
}

/** A DueCtx from the workspace graph (and the schedule's day zones, if given). */
export function dueCtxOf(ix: GraphIndex, schedule?: ScheduleResult): DueCtx {
	const daysById = new Map(ix.days.map((d) => [d.id, d]));
	return {
		daysById,
		tripTz: ix.defaultTz,
		dayTz: (dayId) => {
			const s = schedule?.days[dayId]?.tz;
			if (s) return s;
			const first = ix.firstLocated(dayId);
			return first ? ix.tzOf(first.nodeId) : ix.defaultTz;
		},
		itemDayId: (itemId) => {
			const it = ix.item(itemId);
			return it?.dayId && daysById.has(it.dayId) ? it.dayId : null;
		},
		dayNumber: (dayId) => ix.dayNumber(dayId),
	};
}

type Sortable = Pick<
	ListItemDto,
	"id" | "position" | "createdAt" | "assigneeIds" | "status"
> &
	DueFields;

const byPosition = (a: Sortable, b: Sortable) =>
	a.position < b.position
		? -1
		: a.position > b.position
			? 1
			: a.id < b.id
				? -1
				: a.id > b.id
					? 1
					: 0;

/**
 * A stable order for a view: `due` by instant (undated last), `place` and
 * `person` by manual position, `recent` by creation (newest first). Ties fall
 * back to the manual position, then the id.
 */
export function sortListItems<T extends Sortable>(
	rows: readonly T[],
	view: ListView,
	ctx: DueCtx,
): T[] {
	const out = [...rows];
	if (view === "due") {
		const at = new Map(
			out.map((r) => [
				r.id,
				effectiveDue(r, ctx)?.at ?? Number.POSITIVE_INFINITY,
			]),
		);
		return out.sort(
			(a, b) =>
				(at.get(a.id) as number) - (at.get(b.id) as number) || byPosition(a, b),
		);
	}
	if (view === "recent")
		return out.sort(
			(a, b) =>
				(a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0) ||
				byPosition(a, b),
		);
	return out.sort(byPosition);
}

export type DueBucketKey = "overdue" | "today" | "week" | "later" | "none";

export const DUE_BUCKET_LABEL: Record<DueBucketKey, string> = {
	overdue: "Overdue",
	today: "Today",
	week: "This week",
	later: "Later",
	none: "No date",
};

/**
 * View = Due (EXTENSIONS §7): Overdue / Today / This week / Later / No date,
 * each sorted by due. `open_now` rows sit in Today; an opened window past 72 h
 * in Overdue. Done and skipped rows are bucketed by their date alone (their
 * own `dueState` is `none`, never overdue); the UI folds them at the end of
 * their group ("3 done"). Empty buckets are left out.
 */
export function dueBuckets<T extends Sortable>(
	rows: readonly T[],
	now: number,
	ctx: DueCtx,
): { key: DueBucketKey; rows: T[] }[] {
	const order: DueBucketKey[] = ["overdue", "today", "week", "later", "none"];
	const buckets = new Map<DueBucketKey, T[]>(order.map((k) => [k, []]));
	for (const r of sortListItems(rows, "due", ctx)) {
		const due = effectiveDue(r, ctx);
		let key: DueBucketKey;
		if (!due) key = "none";
		else {
			const state = dueState(due, now, "open");
			key =
				state === "overdue"
					? "overdue"
					: state === "today" || state === "open_now"
						? "today"
						: state === "soon"
							? "week"
							: "later";
		}
		buckets.get(key)?.push(r);
	}
	return order
		.map((key) => ({ key, rows: buckets.get(key) ?? [] }))
		.filter((b) => b.rows.length > 0);
}
