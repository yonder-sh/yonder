/**
 * `useDateDraftImpact()` (EXTENSIONS §5): while a what-if draft is set
 * (`useUi().dateDraft`), the items and legs it affects (the PRIMARY ring on
 * cards and legs, WP-Plan; ADDENDUM §10: amber only for real conflicts). Null
 * without a draft. `useDraftImpact(delta)` is the full `DateImpact` the
 * dialog and the chip read; both share one computation per (graph, delta).
 */
import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import type { ListItemDto } from "@/features/lists/lists.functions";
import { tripListsQuery } from "@/features/lists/queries";
import {
	type DateImpact,
	dateChangeImpact,
	impactedIds,
} from "@/lib/engine/date-impact";
import { type EffectiveHours, effectiveHours } from "@/lib/engine/hours";
import type { TripGraph } from "@/lib/engine/types";
import { todayIn } from "@/lib/format";
import type { Holiday } from "@/lib/schemas/trips";
import { useWorkspaceOptional } from "@/lib/workspace/model-context";
import { useUi } from "@/lib/workspace/ui-store";

const NO_LIST: ListItemDto[] = [];
const NO_HOLIDAYS: Holiday[] = [];

/** One `hoursOf` per graph, so the engine reuses the current plan's issues across deltas. */
const hoursOfMemo = new WeakMap<
	TripGraph,
	(nodeId: string) => EffectiveHours | null
>();
function hoursOfGraph(graph: TripGraph) {
	let fn = hoursOfMemo.get(graph);
	if (!fn) {
		const nodes = new Map(graph.nodes.map((n) => [n.id, n]));
		fn = (id) => {
			const n = nodes.get(id);
			return n ? effectiveHours(n, graph.trip.settings) : null;
		};
		hoursOfMemo.set(graph, fn);
	}
	return fn;
}
/** One computation per (graph, list items, delta). */
const cache = new WeakMap<
	TripGraph,
	WeakMap<readonly ListItemDto[], Map<string, DateImpact>>
>();

function impactOf(
	graph: TripGraph,
	deltaDays: number,
	listItems: readonly ListItemDto[],
): DateImpact {
	let byLists = cache.get(graph);
	if (!byLists) {
		byLists = new WeakMap();
		cache.set(graph, byLists);
	}
	let byKey = byLists.get(listItems);
	if (!byKey) {
		byKey = new Map();
		byLists.set(listItems, byKey);
	}
	const k = String(deltaDays);
	const hit = byKey.get(k);
	if (hit) return hit;
	const impact = dateChangeImpact(
		graph,
		{ deltaDays },
		{
			hoursOf: hoursOfGraph(graph),
			holidays: graph.trip.settings.holidays ?? NO_HOLIDAYS,
			today: todayIn(graph.trip.defaultTz || undefined),
			listItems,
		},
	);
	if (byKey.size > 40) byKey.clear();
	byKey.set(k, impact);
	return impact;
}

/** The full impact of shifting the trip by `deltaDays` (null outside a workspace). */
export function useDraftImpact(deltaDays: number): DateImpact | null {
	const ws = useWorkspaceOptional();
	const tripId = ws?.graph.trip.id ?? "";
	const lists = useQuery({
		...tripListsQuery(tripId),
		enabled: !!ws && ws.mode === "live" && deltaDays !== 0,
	}).data;
	const graph = ws?.graph;
	return useMemo(
		() => (graph ? impactOf(graph, deltaDays, lists ?? NO_LIST) : null),
		[graph, deltaDays, lists],
	);
}

export function useDateDraftImpact(): {
	items: Set<string>;
	legs: Set<string>;
} | null {
	const draft = useUi((s) => s.dateDraft);
	const impact = useDraftImpact(draft?.deltaDays ?? 0);
	return useMemo(
		() => (draft && impact ? impactedIds(impact) : null),
		[draft, impact],
	);
}
