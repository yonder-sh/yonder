/**
 * The flow's numbers outside the Places tab (the Overview's next-step card,
 * the phone's Rate pill, the top bar's Rate count): the same rows the tab
 * builds, without its filters, grouping or city days.
 */
import { useMemo } from "react";
import { canRateOwn } from "@/lib/auth/roles";
import { useWorkspace } from "@/lib/workspace/use-workspace";
import { raters } from "../lib/rate";
import { type FlowContext, type FlowTally, flowTally } from "./flow";
import { buildRows, placesInScope } from "./model";
import { useShortlistBar } from "./use-bar";

export function useFlowTally(scopeId: string | null): FlowTally & FlowContext {
	const { ix, graph, access } = useWorkspace();
	// What your role allows (edit or suggest), not whether you're online now.
	const canEdit = access.mode !== "read";
	const canRate = canRateOwn(access);
	const me = access.memberId;
	const threshold = useShortlistBar().bar;
	return useMemo(() => {
		// Proposal ghosts are reviewed in the workspace, never rated here.
		const liveIds = new Set(graph.nodes.map((n) => n.id));
		const nodes = placesInScope(ix, scopeId, liveIds);
		const memberIds = raters(graph.members, nodes).map((m) => m.id);
		const rows = buildRows(ix, nodes, { memberIds, threshold });
		return {
			...flowTally(rows, { me, canRate }),
			canEdit,
			hasDays: ix.days.length > 0,
		};
	}, [
		ix,
		graph.nodes,
		graph.members,
		scopeId,
		threshold,
		me,
		canRate,
		canEdit,
	]);
}
