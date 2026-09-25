/**
 * What a ghost or a chip calls the thing behind an anchor id ("Shibuya Sky",
 * "KE 724", "Book the ryokan"), from MY data (the graph, my lists and money
 * caches), never from the wire: something I can't see has no name here.
 */
import { useQueryClient } from "@tanstack/react-query";
import { useCallback } from "react";
import { plainOf } from "@/features/lists/format";
import type { ListItemDto } from "@/features/lists/lists.functions";
import { itemName } from "@/features/plan/use-plan-actions";
import { pairKey } from "@/lib/engine/graph-index";
import { formatFlightNumber } from "@/lib/engine/schedule";
import { tripKeys } from "@/lib/query/keys";
import { plainAnchorId } from "@/lib/realtime/cursor-protocol";
import { cleanLabel } from "@/lib/realtime/view-protocol";
import { useWorkspace } from "@/lib/workspace/use-workspace";

export function useAnchorLabel(): (anchorId: string) => string | null {
	const { ix, graph } = useWorkspace();
	const qc = useQueryClient();
	return useCallback(
		(anchorId: string): string | null => {
			const plain = plainAnchorId(anchorId);
			const i = plain.indexOf(":");
			const kind = plain.slice(0, i);
			const id = plain.slice(i + 1);
			if (kind === "item") {
				const it = ix.item(id);
				return it ? cleanLabel(itemName(ix, it), 60) : null;
			}
			if (kind === "tree" || kind === "idea") return ix.node(id)?.name ?? null;
			if (kind === "leg" && id.startsWith("l.")) {
				// A flight's number ("NH 744"), else "Tokyo → Kyoto".
				const [, a = "", b = ""] = id.split(".");
				const leg = ix.legByPair.get(pairKey(a, b));
				const d = leg ? ix.legDetails(leg) : null;
				const num =
					d?.kind === "flight"
						? formatFlightNumber(d.flight.flightNumber)
						: null;
				if (num) return num;
				const from = ix.item(a);
				const to = ix.item(b);
				return from && to
					? cleanLabel(`${itemName(ix, from)} → ${itemName(ix, to)}`, 60)
					: null;
			}
			if (kind === "day" || kind === "dayh") {
				const day = ix.day(id);
				return day ? (day.title ?? day.date) : null;
			}
			if (kind === "exp") {
				const money = qc.getQueryData<{
					expenses?: {
						id: string;
						title?: string | null;
						isPrivate?: boolean;
					}[];
				}>(tripKeys.money(graph.trip.id));
				const e = money?.expenses?.find((x) => x.id === id);
				return e && !e.isPrivate && e.title ? cleanLabel(e.title, 60) : null;
			}
			if (kind === "list") {
				const rows = qc.getQueryData<ListItemDto[]>(
					tripKeys.lists(graph.trip.id),
				);
				const row = rows?.find((r) => r.id === id);
				return row && !row.isPrivate ? cleanLabel(plainOf(row.text), 60) : null;
			}
			return null;
		},
		[ix, qc, graph.trip.id],
	);
}
