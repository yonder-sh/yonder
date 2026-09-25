/**
 * `useHoursIssues()` (EXTENSIONS §1.3): the trip's hours issues for the
 * current schedule, memoised per `schedule` (a WeakMap), so every card and
 * day header reads one computation. `daySun` is the sunrise/sunset of the
 * place a day happens in (E3), shared by `DaySun` and the `after_dark` check.
 */
import { dayPlace } from "@/lib/engine/day-place";
import type { GraphIndex } from "@/lib/engine/graph-index";
import {
	effectiveHours,
	type HoursIssues,
	hoursIssues,
} from "@/lib/engine/hours";
import { type SunTimes, sunTimes } from "@/lib/engine/sun";
import type { GraphNode, ScheduleResult } from "@/lib/engine/types";
import { useWorkspace } from "@/lib/workspace/use-workspace";

export type DaySun = {
	sun: SunTimes;
	place: GraphNode;
	tz: string;
	date: string;
};

const sunMemo = new WeakMap<ScheduleResult, Map<string, DaySun | null>>();

/** The sun on a day at the place the day happens in (`dayPlace`). */
export function daySunOf(
	ix: GraphIndex,
	schedule: ScheduleResult,
	dayId: string,
): DaySun | null {
	let byDay = sunMemo.get(schedule);
	if (!byDay) {
		byDay = new Map();
		sunMemo.set(schedule, byDay);
	}
	if (byDay.has(dayId)) return byDay.get(dayId) ?? null;
	let out: DaySun | null = null;
	const day = ix.day(dayId);
	const placeId = day ? dayPlace(ix, schedule, dayId) : null;
	const place = placeId ? ix.node(placeId) : undefined;
	const at = placeId ? ix.coordOf(placeId) : null;
	if (day && place && at) {
		const tz = ix.tzOf(place.id);
		const sun = sunTimes(day.date, at[1], at[0], tz);
		if (sun) out = { sun, place, tz, date: day.date };
	}
	byDay.set(dayId, out);
	return out;
}

const memo = new WeakMap<ScheduleResult, HoursIssues>();

export function useHoursIssues(): HoursIssues {
	const { ix, schedule, graph } = useWorkspace();
	let issues = memo.get(schedule);
	if (!issues) {
		issues = hoursIssues(ix, schedule, {
			hoursOf: (nodeId) => {
				const n = ix.node(nodeId);
				return n ? effectiveHours(n, graph.trip.settings) : null;
			},
			holidays: graph.trip.settings.holidays ?? [],
			sunOf: (dayId) => daySunOf(ix, schedule, dayId)?.sun ?? null,
		});
		memo.set(schedule, issues);
	}
	return issues;
}
