/**
 * Today's data (One Yonder phase 5): "now" (a live clock, or `?asOf`), the
 * trip day being lived and the engine's view of it (`computeToday`), with
 * the day's number, date and city for the header.
 */
import { useMemo } from "react";
import { asOfZone, nowFor } from "@/features/overview/lib/phase";
import { raters } from "@/features/places/lib/rate";
import { useNow } from "@/features/plan/use-media";
import { dayWhere, dayWhereText } from "@/lib/engine/day-place";
import type { LngLat } from "@/lib/engine/geo";
import { computeToday, type TodayView, todayDayId } from "@/lib/engine/today";
import { useWorkspace } from "@/lib/workspace/use-workspace";

export interface TodayData {
	now: number;
	view: TodayView | null;
	/** 1-based, of `days`. */
	dayNumber: number;
	days: number;
	/** Where today is (`dayWhere`): "Tokyo", "Tokyo → Kyoto", "Kyoto · fly home". */
	city: string | null;
}

export function useToday(here: LngLat | null = null): TodayData {
	const { ix, schedule, graph, search } = useWorkspace();
	const asOf = search.asOf ?? null;
	const tick = useNow(30_000);
	const now = asOf ? nowFor(asOf, asOfZone(ix, schedule)) : tick || Date.now();
	const raterIds = useMemo(
		() => raters(graph.members, graph.nodes).map((m) => m.id),
		[graph.members, graph.nodes],
	);
	const dayId = useMemo(
		() => todayDayId(ix, schedule, now),
		[ix, schedule, now],
	);
	const view = useMemo(
		() =>
			dayId
				? computeToday(ix, schedule, dayId, now, {
						raterIds,
						here,
						asOf: !!asOf,
					})
				: null,
		[ix, schedule, dayId, now, raterIds, here, asOf],
	);
	// Where today is, by the one rule: "Tokyo → Kyoto" on a travel day.
	const city = useMemo(
		() => (dayId ? dayWhereText(ix, dayWhere(ix, dayId)) : null),
		[ix, dayId],
	);
	return {
		now,
		view,
		dayNumber: dayId ? ix.dayNumber(dayId) : 0,
		days: ix.days.length,
		city,
	};
}
