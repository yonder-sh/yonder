/**
 * What the Where picker lists (One Yonder, D13): the whole trip, then its
 * countries › regions › cities › areas in outline order, each with the dates
 * the plan spends there ("3–6 Oct"); typing also finds places. Pure.
 */
import { visitsOf } from "@/features/places/lib/node-facts";
import type { GraphIndex } from "@/lib/engine/graph-index";
import type { GraphNode } from "@/lib/engine/types";
import { formatDateRange } from "@/lib/format";

export type WhereRow = {
	/** null = the whole trip. */
	id: string | null;
	name: string;
	/** 0 for the whole trip, 1 for a country… */
	depth: number;
	/** "3–6 Oct", or "" when the plan doesn't go there yet. */
	dates: string;
	/** Names above it, for search ("Tokyo" finds Shinjuku too). */
	path: string;
};

const COARSE = new Set<GraphNode["type"]>([
	"country",
	"region",
	"city",
	"area",
]);

function datesOf(ix: GraphIndex, nodeId: string): string {
	const visits = visitsOf(ix, nodeId);
	const first = visits[0]?.days[0]?.date;
	const last = visits.at(-1)?.days.at(-1)?.date;
	return first ? formatDateRange(first, last) : "";
}

/** The trip and its coarse places, in outline order. */
export function whereRows(ix: GraphIndex): WhereRow[] {
	const { startDate, endDate } = ix.trip;
	const out: WhereRow[] = [
		{
			id: null,
			name: "Whole trip",
			depth: 0,
			dates: startDate ? formatDateRange(startDate, endDate) : "",
			path: "",
		},
	];
	for (const n of ix.outline) {
		if (!COARSE.has(n.type) || n.status === "dropped") continue;
		const above = ix.path(n.id).slice(0, -1);
		out.push({
			id: n.id,
			name: n.name,
			depth: above.length + 1,
			dates: datesOf(ix, n.id),
			path: above.map((a) => a.name).join(" › "),
		});
	}
	return out;
}

/** Places (for typed searches): their names and where they are. */
export function wherePlaces(ix: GraphIndex): WhereRow[] {
	return ix.outline
		.filter((n) => n.type === "place" && n.status !== "dropped")
		.map((n) => {
			const above = ix.path(n.id).slice(0, -1);
			return {
				id: n.id,
				name: n.name,
				depth: above.length + 1,
				dates: "",
				path: above.map((a) => a.name).join(" › "),
			};
		});
}
