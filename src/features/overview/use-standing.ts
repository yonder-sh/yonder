/** "Where things stand" from the workspace (`lib/standing.ts`). */
import { useMemo } from "react";
import { useShortlistBar } from "@/features/places/tab/use-bar";
import { useWorkspace } from "@/lib/workspace/use-workspace";
import { type Standing, whereThingsStand } from "./lib/standing";

export function useStanding(): Standing {
	const { ix, graph, schedule, access } = useWorkspace();
	const bar = useShortlistBar().bar;
	return useMemo(
		() =>
			whereThingsStand({
				ix,
				schedule,
				members: graph.members,
				me: access.memberId,
				bar,
				liveIds: new Set(graph.nodes.map((n) => n.id)),
			}),
		[ix, schedule, graph.members, graph.nodes, access.memberId, bar],
	);
}
