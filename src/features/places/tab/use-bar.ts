/** The trip's shortlist bar (`bar.ts`), trip-wide whatever the scope. */
import { useMemo } from "react";
import { useWorkspace } from "@/lib/workspace/use-workspace";
import { raters } from "../lib/rate";
import { type ShortlistBar, shortlistBar, shortlistLevel } from "./bar";
import { openPlaces } from "./model";

export function useShortlistBar(): ShortlistBar {
	const { ix, graph } = useWorkspace();
	const level = shortlistLevel(graph.trip.settings);
	return useMemo(() => {
		const liveIds = new Set(graph.nodes.map((n) => n.id));
		const places = openPlaces(ix, liveIds);
		const ids = raters(graph.members, places).map((m) => m.id);
		return shortlistBar(level, places, ids);
	}, [ix, graph.nodes, graph.members, level]);
}
