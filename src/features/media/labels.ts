/** Human names for attachment targets (drop pills, toasts, captions). */
import type { GraphIndex } from "@/lib/engine/graph-index";
import { formatDayDate } from "@/lib/format";
import type { AttachmentTarget } from "@/lib/schemas/targets";

/** "Shibuya Sky", "Day 5", "Tokyo → Kyoto", "the trip". */
export function targetName(ix: GraphIndex, target: AttachmentTarget): string {
	switch (target.kind) {
		case "trip":
			return ix.trip.name || "the trip";
		case "node":
			return ix.node(target.nodeId)?.name ?? "this place";
		case "item": {
			const it = ix.item(target.itemId);
			return it?.title ?? ix.node(it?.nodeId)?.name ?? "this stop";
		}
		case "day": {
			const n = ix.dayNumber(target.dayId);
			return n ? `Day ${n}` : "this day";
		}
		case "leg": {
			const leg = ix.leg(target.legId);
			if (leg?.kind === "pair") {
				const a = ix.node(ix.effectiveNodeId(leg.fromItemId ?? ""))?.name;
				const b = ix.node(ix.effectiveNodeId(leg.toItemId ?? ""))?.name;
				if (a && b) return `${a} → ${b}`;
			}
			return "this leg";
		}
		case "expense":
			return "this expense";
	}
}

/** The drop pill: "Drop to attach to Shibuya", "…to this visit", "…to Day 5". */
export function dropLabel(
	ix: GraphIndex,
	target: AttachmentTarget,
	visit = false,
): string {
	if (visit) return "Drop to attach to this visit";
	return `Drop to attach to ${targetName(ix, target)}`;
}

/** "Day 4 · Thu 7 Oct" for day group headers. */
export function dayHeading(ix: GraphIndex, dayId: string | null): string {
	const day = ix.day(dayId);
	if (!day) return "A removed day";
	return `Day ${ix.dayNumber(day.id)} · ${formatDayDate(day.date)}`;
}
