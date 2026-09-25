/**
 * The trip's dated to-dos for the root overview (SPEC §18.3 "upcoming
 * deadlines") and "Still to plan" (windows opening in the next 14 days).
 *
 * The due instant comes from WP-Lists' `effectiveDue` (relative booking
 * windows resolved, ADDENDUM §10). Until that engine lands, absolute dates
 * fall back to the documented rule (EXTENSIONS §7: a date alone is 23:59 for
 * `due`/`on`, 00:00 for `opens`, in the to-do's zone or the trip's; a
 * `dueDayId` is that day's start), so the overview is useful on its own.
 */
import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import type { ListItemDto } from "@/features/lists/lists.functions";
import { tripListsQuery } from "@/features/lists/queries";
import { type DueCtx, effectiveDue } from "@/lib/engine/due";
import type { GraphIndex } from "@/lib/engine/graph-index";
import { localDateOf, tzLabel, zonedEpoch } from "@/lib/engine/time";
import type { ScheduleResult } from "@/lib/engine/types";
import { formatDayDate, formatTime } from "@/lib/format";
import { useWorkspace } from "@/lib/workspace/use-workspace";

export function dueCtxOf(ix: GraphIndex, schedule: ScheduleResult): DueCtx {
	return {
		daysById: new Map(ix.days.map((d) => [d.id, d])),
		dayTz: (dayId) => schedule.days[dayId]?.tz ?? ix.defaultTz,
		tripTz: ix.defaultTz,
		itemDayId: (itemId) => ix.item(itemId)?.dayId ?? null,
	};
}

/**
 * A to-do's due instant and the zone it was set in (a relative ANA rule in
 * JST, a hotel's window in ET): `date` is the local date there, `timed` says
 * whether the wall time means anything (a time was set, a relative rule, or a
 * booking window's opening).
 */
export type TripDue = { at: number; tz: string; date: string; timed: boolean };

/** The effective due of a to-do, or null (no date / "Date TBD"). */
export function dueOf(
	li: ListItemDto,
	ix: GraphIndex,
	ctx: DueCtx,
): TripDue | null {
	const opens = li.dueKind === "opens";
	const eff = effectiveDue(li, ctx);
	if (eff)
		return {
			at: eff.at,
			tz: eff.tz,
			date: eff.date,
			timed: !eff.allDay || opens,
		};
	if (li.dueRule) return null; // relative rules are WP-Lists' to resolve
	const fromDay = li.dueDayId ? ctx.daysById.get(li.dueDayId) : undefined;
	const dayTz = fromDay ? ctx.dayTz(fromDay.id) : ix.defaultTz;
	const byDay = fromDay
		? zonedEpoch(fromDay.date, fromDay.startTime, dayTz)
		: null;
	const dateTz = li.dueTz ?? ix.defaultTz;
	const byDate = li.dueDate
		? zonedEpoch(li.dueDate, li.dueTime ?? (opens ? "00:00" : "23:59"), dateTz)
		: null;
	const pick =
		byDay !== null && (byDate === null || byDay <= byDate)
			? { at: byDay, tz: dayTz }
			: byDate !== null
				? { at: byDate, tz: dateTz }
				: null;
	if (!pick) return null;
	return {
		...pick,
		date: localDateOf(pick.at, pick.tz),
		timed: !!li.dueTime || opens,
	};
}

/** The effective due instant of a to-do (epoch ms), or null (no date / "Date TBD"). */
export function dueAtOf(
	li: ListItemDto,
	ix: GraphIndex,
	ctx: DueCtx,
): number | null {
	return dueOf(li, ix, ctx)?.at ?? null;
}

/**
 * "Mon 12 Oct · 09:00 JST": the date and time in the to-do's own zone, always
 * with the zone's label, so a JST window and an ET one side by side read in
 * the right order (WP-Lists' `formatDue`, the dashboard). Untimed → the date.
 */
export function formatDueWhen(due: TripDue): string {
	const date = formatDayDate(due.date);
	if (!due.timed) return date;
	return `${date} · ${formatTime(due.at, due.tz)} ${tzLabel(due.tz, due.at)}`;
}

/** The overview chip: "Opens Mon 12 Oct · 09:00 JST", "Due Fri 2 Oct", "Was due …". */
export function deadlineChip(d: TripDeadline, now: number): string {
	const opens = d.li.dueKind === "opens";
	const word = opens ? "Opens" : d.at < now ? "Was due" : "Due";
	return `${word} ${formatDueWhen(d)}`;
}

export type TripDeadline = TripDue & { li: ListItemDto };

/** The trip's open to-dos with a due instant, soonest first. */
export function deadlinesOf(
	items: readonly ListItemDto[],
	ix: GraphIndex,
	ctx: DueCtx,
): TripDeadline[] {
	return items
		.filter((li) => li.list === "todo" && li.status === "open")
		.map((li) => {
			const due = dueOf(li, ix, ctx);
			return due ? { ...due, li } : null;
		})
		.filter((x): x is TripDeadline => x !== null)
		.sort((a, b) => a.at - b.at);
}

/** List items + a `dueAt` function for the current trip (live mode only). */
export function useTripListItems(): {
	items: ListItemDto[] | undefined;
	dueAt: (li: ListItemDto) => number | null;
	due: (li: ListItemDto) => TripDue | null;
} {
	const { graph, ix, schedule, mode } = useWorkspace();
	const q = useQuery({
		...tripListsQuery(graph.trip.id),
		enabled: mode === "live",
	});
	const ctx = useMemo(() => dueCtxOf(ix, schedule), [ix, schedule]);
	const dueAt = useMemo(
		() => (li: ListItemDto) => dueAtOf(li, ix, ctx),
		[ix, ctx],
	);
	const due = useMemo(() => (li: ListItemDto) => dueOf(li, ix, ctx), [ix, ctx]);
	return { items: q.data, dueAt, due };
}
