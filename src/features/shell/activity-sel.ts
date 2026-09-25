/**
 * Which workspace selection an activity row (or digest line) points at, so a
 * click selects the thing that changed. Gone entities give null (the row
 * stays readable, just not clickable).
 */
import type { GraphIndex } from "@/lib/engine/graph-index";
import type { Sel } from "@/lib/workspace/search";

export type EntityRefs = {
	nodeId?: string | null;
	itemId?: string | null;
	legId?: string | null;
	dayId?: string | null;
};

export function selForRefs(ix: GraphIndex, r: EntityRefs): Sel | null {
	if (r.itemId && ix.item(r.itemId)) return { kind: "item", id: r.itemId };
	if (r.legId) {
		const leg = ix.leg(r.legId);
		if (leg?.kind === "pair" && leg.fromItemId && leg.toItemId)
			return {
				kind: "leg",
				target: {
					kind: "pair",
					fromItemId: leg.fromItemId,
					toItemId: leg.toItemId,
				},
			};
		if (leg?.stayDayId && leg.kind !== "pair")
			return {
				kind: "leg",
				target: {
					kind: "stay",
					dayId: leg.stayDayId,
					end: leg.kind === "stay_start" ? "start" : "end",
				},
			};
	}
	if (r.nodeId && ix.node(r.nodeId)) return { kind: "node", id: r.nodeId };
	if (r.dayId && ix.day(r.dayId)) return { kind: "day", id: r.dayId };
	return null;
}
