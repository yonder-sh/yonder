/**
 * The Places tab's state (docs/PLACES.md §1): the rows in scope, the
 * filtered set every view shows, the groups, counts and per-member progress.
 * The view, grouping, sort, status pill, "Talk about it" and the shared `f`
 * live in the URL (so they deep-link and follow, FB-21); "Split by area" is
 * remembered per person (view prefs).
 */
import { useQuery } from "@tanstack/react-query";
import { useCallback, useMemo } from "react";
import { noteFor, tripNotesQuery } from "@/features/notes/queries";
import { cityDayTable } from "@/features/places/lib/days";
import { raters } from "@/features/places/lib/rate";
import { useViewPrefs } from "@/features/shell/view-prefs";
import type { GraphMember } from "@/lib/engine/types";
import { filterContextOf } from "@/lib/workspace/filter-match";
import type { PlacesView } from "@/lib/workspace/search";
import { useWorkspace } from "@/lib/workspace/use-workspace";
import type { FeedOrder } from "./feed";
import { type GroupBy, groupPlaces, type SortBy } from "./grouping";
import { type PlaceStatus, shortlistThreshold } from "./lifecycle";
import {
	buildRows,
	countRows,
	filterRows,
	type PlaceRow,
	placesInScope,
	ratedCount,
} from "./model";

export type PlacesState = {
	view: PlacesView;
	group: GroupBy;
	sort: SortBy;
	status: PlaceStatus | null;
	talk: boolean;
	order: FeedOrder;
};

export function usePlacesState(): PlacesState {
	const { search } = useWorkspace();
	return {
		view: search.pv ?? "table",
		group: search.pg ?? "city",
		sort: search.ps ?? "priority",
		status: search.pst ?? null,
		talk: search.talk === 1,
		order: search.po ?? "mixed",
	};
}

/** "Split by area" per person: the city ids split (view prefs, synced). */
export function useSplitAreas(): [ReadonlySet<string>, (id: string) => void] {
	const { mode } = useWorkspace();
	const { prefs, setPrefs } = useViewPrefs({ enabled: mode === "live" });
	const list = prefs.placesSplit;
	const set = useMemo(() => new Set(list ?? []), [list]);
	const toggle = useCallback(
		(id: string) => {
			const next = new Set(list ?? []);
			if (next.has(id)) next.delete(id);
			else next.add(id);
			setPrefs({ placesSplit: [...next].slice(-200) });
		},
		[list, setPrefs],
	);
	return [set, toggle];
}

export type MemberProgress = {
	member: GraphMember;
	rated: number;
	total: number;
};

export function usePlaces(q = "") {
	const ws = useWorkspace();
	const { ix, graph, scope, counts, schedule, filter, access, mode } = ws;
	const state = usePlacesState();
	const [split] = useSplitAreas();
	const notes = useQuery({
		...tripNotesQuery(graph.trip.id),
		enabled: mode === "live" && q.trim().length > 0,
	}).data;
	const scopeId = scope?.id ?? null;
	const threshold = shortlistThreshold(graph.trip.settings);
	// Proposal ghosts are reviewed in the workspace, never rated or pinned here.
	const liveIds = useMemo(
		() => new Set(graph.nodes.map((n) => n.id)),
		[graph.nodes],
	);
	const nodes = useMemo(
		() => placesInScope(ix, scopeId, liveIds),
		[ix, scopeId, liveIds],
	);
	const members = useMemo(
		() => raters(graph.members, nodes),
		[graph.members, nodes],
	);
	const memberIds = useMemo(() => members.map((m) => m.id), [members]);
	const cityDays = useMemo(
		() => cityDayTable(ix, schedule, null),
		[ix, schedule],
	);
	const rows = useMemo(
		() => buildRows(ix, nodes, { memberIds, threshold, counts, cityDays }),
		[ix, nodes, memberIds, threshold, counts, cityDays],
	);
	const byId = useMemo(() => new Map(rows.map((r) => [r.id, r])), [rows]);
	const tally = useMemo(() => countRows(rows), [rows]);
	const ctx = useMemo(
		() => filterContextOf(ix, access.memberId),
		[ix, access.memberId],
	);
	const extra = useCallback(
		(id: string) =>
			noteFor(notes, { kind: "node", nodeId: id })?.plainText ?? "",
		[notes],
	);
	const visible = useMemo(
		() =>
			filterRows(rows, {
				status: state.status,
				talk: state.talk,
				filter,
				ctx,
				q,
				extra,
			}),
		[rows, state.status, state.talk, filter, ctx, q, extra],
	);
	// Groups visit in trip order: the first day anything inside is on.
	const groupVisit = useCallback(
		(nodeId: string) => {
			for (const it of ix.ordered)
				if (it.nodeId && ix.isWithin(it.nodeId, nodeId))
					return ix.orderOf(it.id);
			return null;
		},
		[ix],
	);
	const groups = useMemo(
		() =>
			groupPlaces<PlaceRow>(visible, {
				by: state.group,
				sort: state.sort,
				ix,
				split,
				groupVisit,
			}),
		[visible, state.group, state.sort, ix, split, groupVisit],
	);
	const progress = useMemo<MemberProgress[]>(
		() =>
			members.map((m) => ({
				member: m,
				rated: ratedCount(
					rows.filter((r) => r.status !== "dropped"),
					m.id,
				),
				total: tally.all,
			})),
		[members, rows, tally.all],
	);
	return {
		state,
		rows,
		byId,
		visible,
		groups,
		counts: tally,
		members,
		memberIds,
		threshold,
		progress,
		cityDays,
	};
}

export type PlacesData = ReturnType<typeof usePlaces>;

/**
 * The tab's count badge: places in the scope still to decide (not on a day,
 * not dropped by hand, not everyone-said-Nah). Cheaper than `usePlaces`.
 */
export function usePlacesToDecide(): number {
	const { ix, graph, scope } = useWorkspace();
	return useMemo(() => {
		const liveIds = new Set(graph.nodes.map((n) => n.id));
		const nodes = placesInScope(ix, scope?.id ?? null, liveIds);
		const memberIds = raters(graph.members, nodes).map((m) => m.id);
		let n = 0;
		for (const node of nodes) {
			if (node.ideaStatus === "dropped" || ix.isDropped(node.id)) continue;
			if (ix.scheduledNodeIds.has(node.id)) continue;
			if (
				node.shortlistPin !== "pinned" &&
				memberIds.length > 0 &&
				memberIds.every((m) => node.priorities[m] === "nah")
			)
				continue;
			n += 1;
		}
		return n;
	}, [ix, graph.nodes, graph.members, scope?.id]);
}
