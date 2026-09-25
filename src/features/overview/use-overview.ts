/**
 * Everything the Overview page draws, from the workspace (docs/OVERVIEW.md):
 * the route model, the phase, the day lines, media counts, highlight
 * candidates and the planning numbers. One hook so the page's pieces agree.
 */
import { useMemo, useSyncExternalStore } from "react";
import { useTripMedia } from "@/features/media/queries";
import { rateableNodes, raters } from "@/features/places/lib/rate";
import { useCovers } from "@/features/places/tab/PlacesBoard";
import { groupScore, scoreTier, topRating } from "@/features/places/tab/score";
import { stillToPlan } from "@/features/shell/still-to-plan";
import {
	deadlinesOf,
	dueCtxOf,
	type TripDeadline,
	useTripListItems,
} from "@/features/shell/trip-deadlines";
import { useWorkspace } from "@/lib/workspace/use-workspace";
import { type DayLine, dayLines } from "./lib/day-lines";
import type { HighlightCandidate } from "./lib/highlights";
import { nowFor, type TripPhase, tripPhase } from "./lib/phase";
import { type TripRoute, tripRoute } from "./lib/trip-route";

/** A minute clock (0 on the server). */
function useMinute(): number {
	return useSyncExternalStore(
		(cb) => {
			const t = setInterval(cb, 60_000);
			return () => clearInterval(t);
		},
		() => Math.floor(Date.now() / 60_000) * 60_000,
		() => 0,
	);
}

export interface OverviewData {
	route: TripRoute;
	phase: TripPhase;
	/** "Now" as an instant (noon on `?asOf`). */
	now: number;
	asOf: string | null;
	lines: DayLine[];
	/** Photos and videos saved on the trip. */
	media: number;
	highlights: HighlightCandidate[];
	planning: {
		must: number;
		mustScheduled: number;
		toBook: number;
		nightsWithoutStay: number;
		next: TripDeadline | null;
	};
	/** The stay tonight (during), or null. */
	hereStay: number | null;
}

export function useOverview(): OverviewData {
	const { ix, graph, schedule, search } = useWorkspace();
	const asOf = search.asOf ?? null;
	const minute = useMinute();
	const now = asOf ? nowFor(asOf, ix.defaultTz) : minute || Date.now();
	const route = useMemo(() => tripRoute(ix), [ix]);
	const lines = useMemo(() => dayLines(ix, route), [ix, route]);
	const phase = useMemo(
		() =>
			tripPhase(
				ix.days.map((d) => ({
					id: d.id,
					date: d.date,
					tz: schedule.days[d.id]?.tz ?? ix.defaultTz,
				})),
				now,
				asOf,
			),
		[ix, schedule, now, asOf],
	);

	// ---- media and highlights ---------------------------------------------
	const { data: mediaRows } = useTripMedia();
	const covers = useCovers();
	const { media, photosByNode } = useMemo(() => {
		const byNode = new Map<string, number>();
		let n = 0;
		for (const m of mediaRows) {
			if (m.proposed || m.status !== "ready") continue;
			if (m.kind !== "photo" && m.kind !== "video") continue;
			n++;
			const t = m.target;
			const node =
				t.kind === "node"
					? t.nodeId
					: t.kind === "item"
						? ix.item(t.itemId)?.nodeId
						: undefined;
			if (node) byNode.set(node, (byNode.get(node) ?? 0) + 1);
		}
		return { media: n, photosByNode: byNode };
	}, [mediaRows, ix]);
	const liveIds = useMemo(
		() => new Set(graph.nodes.map((n) => n.id)),
		[graph.nodes],
	);
	const places = useMemo(
		() => rateableNodes(ix, null, { liveIds }),
		[ix, liveIds],
	);
	const memberIds = useMemo(
		() => raters(graph.members, places).map((m) => m.id),
		[graph.members, places],
	);
	const highlights = useMemo<HighlightCandidate[]>(
		() =>
			places
				.filter((n) => n.type === "place")
				.map((n) => ({
					id: n.id,
					name: n.name,
					score: groupScore(n.priorities, memberIds),
					top: topRating(n.priorities, memberIds),
					coverId: covers.get(n.id)?.id ?? null,
					photos: photosByNode.get(n.id) ?? 0,
				})),
		[places, memberIds, covers, photosByNode],
	);

	// ---- planning (before the trip) ----------------------------------------
	const { items, due } = useTripListItems();
	const planning = useMemo(() => {
		const musts = places.filter(
			(n) => scoreTier(groupScore(n.priorities, memberIds)) === "must",
		);
		const s = stillToPlan({
			ix,
			schedule,
			members: graph.members,
			listItems: items,
			due,
			liveIds,
			now,
		});
		const next = items
			? (deadlinesOf(items, ix, dueCtxOf(ix, schedule)).find(
					(d) => d.at >= now,
				) ?? null)
			: null;
		return {
			must: musts.length,
			mustScheduled: musts.filter((n) => ix.scheduledNodeIds.has(n.id)).length,
			toBook: s.toBook.length,
			nightsWithoutStay: s.nights.length,
			next,
		};
	}, [
		places,
		memberIds,
		ix,
		schedule,
		graph.members,
		items,
		due,
		liveIds,
		now,
	]);

	const hereStay = useMemo(() => {
		if (phase.kind !== "during") return null;
		const i = route.stays.findIndex(
			(s) => s.firstDate <= phase.today && phase.today <= s.lastDate,
		);
		if (i >= 0) return i;
		// A travel day: the stay it leads to.
		const next = route.stays.findIndex((s) => s.firstDate > phase.today);
		return next >= 0 ? next : null;
	}, [phase, route]);

	return {
		route,
		phase,
		now,
		asOf,
		lines,
		media,
		highlights,
		planning,
		hereStay,
	};
}
