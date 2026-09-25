/**
 * The Places tab's rows (docs/PLACES.md §1–§3): every rateable place in the
 * scope with its group score, Split, lifecycle status, when it is (or could
 * be) visited, time needed and media count, and the filters shared by every
 * view (status pills, "Talk about it", the shared `f`, text search). Pure:
 * `usePlaces()` feeds it the workspace.
 */
import type { CityDaysTable } from "@/features/places/lib/days";
import { isRateable } from "@/features/places/lib/rate";
import type { GraphIndex } from "@/lib/engine/graph-index";
import type {
	GraphItem,
	GraphNode,
	Priority,
	TripCounts,
} from "@/lib/engine/types";
import { formatDayDate } from "@/lib/format";
import type { WorkspaceFilter } from "@/lib/workspace/filter";
import {
	type FilterContext,
	matchesFilter,
} from "@/lib/workspace/filter-match";
import { type Groupable, levelGroupOf } from "./grouping";
import { type PlaceStatus, placeStatus, type StatusInfo } from "./lifecycle";
import { allNah, groupScore, isSplit, topRating } from "./score";

export type PlaceRow = Groupable & {
	node: GraphNode;
	split: boolean;
	info: StatusInfo;
	/** Dropped by hand (the node, an ancestor, or its lifecycle decision). */
	droppedByHand: boolean;
	/** Scheduled items of this place (or inside it), in trip order. */
	occurrences: GraphItem[];
	/** "Kyoto › Higashiyama". */
	where: string;
	/** The city it runs with in the feed (or the nearest level above). */
	city: { id: string; name: string } | null;
	/** Minutes: the planned stop's duration when scheduled, else its own. */
	timeMin: number | null;
	timeSource: "planned" | "set" | null;
	/** Photos, videos and links. */
	media: number;
	/** "Day 4 · Thu 7 Oct", "In Tokyo · Days 2–5", "No days here yet". */
	when: string;
	/** The days the trip spends in its city (unscheduled places), by id. */
	cityDayIds: string[];
};

export type PlacesCounts = Record<PlaceStatus, number> & {
	all: number;
	talk: number;
	toDecide: number;
};

/** "Day 5", "Days 2–5", "Days 2, 4, 7–8" (1-based day numbers). */
export function formatDayNumbers(nums: readonly number[]): string {
	const xs = [...new Set(nums)].filter((n) => n > 0).sort((a, b) => a - b);
	if (!xs.length) return "";
	const parts: string[] = [];
	let start = xs[0] as number;
	let prev = start;
	for (const n of [...xs.slice(1), Number.NaN]) {
		if (n === prev + 1) {
			prev = n;
			continue;
		}
		parts.push(start === prev ? String(start) : `${start}–${prev}`);
		start = n;
		prev = n;
	}
	return `${xs.length === 1 ? "Day" : "Days"} ${parts.join(", ")}`;
}

/** The places the tab shows: rateable, live (no proposal ghosts), in scope. */
export function placesInScope(
	ix: GraphIndex,
	scopeId: string | null,
	liveIds?: ReadonlySet<string>,
): GraphNode[] {
	return ix.outline.filter(
		(n) =>
			isRateable(n) &&
			(!liveIds || liveIds.has(n.id)) &&
			n.id !== scopeId &&
			ix.isWithin(n.id, scopeId),
	);
}

/** The trip's places to rate: every live one not dropped by hand (the bar, progress, reminders). */
export function openPlaces(
	ix: GraphIndex,
	liveIds?: ReadonlySet<string>,
): GraphNode[] {
	return placesInScope(ix, null, liveIds).filter(
		(n) => n.ideaStatus !== "dropped" && !ix.isDropped(n.id),
	);
}

export function buildRows(
	ix: GraphIndex,
	nodes: readonly GraphNode[],
	opts: {
		memberIds: readonly string[];
		threshold: number;
		counts?: TripCounts;
		cityDays?: CityDaysTable;
	},
): PlaceRow[] {
	// Items per node, in trip order (for "scheduled" and "when").
	const byNode = new Map<string, GraphItem[]>();
	for (const it of ix.ordered) {
		if (!it.nodeId) continue;
		const list = byNode.get(it.nodeId);
		if (list) list.push(it);
		else byNode.set(it.nodeId, [it]);
	}
	const cityRows = opts.cityDays?.rows ?? [];
	const rowOf = (nodeId: string) => {
		let best: (typeof cityRows)[number] | undefined;
		let depth = -1;
		for (const r of cityRows) {
			if (!ix.isWithin(nodeId, r.nodeId)) continue;
			const d = ix.path(r.nodeId).length;
			if (d > depth) {
				best = r;
				depth = d;
			}
		}
		return best;
	};
	return nodes.map((node) => {
		const ratings = node.priorities;
		const score = groupScore(ratings, opts.memberIds);
		const top = topRating(ratings, opts.memberIds);
		const own = byNode.get(node.id) ?? [];
		const inside = own.length
			? own
			: ix.scheduledNodeIds.has(node.id)
				? ix.ordered.filter(
						(it) =>
							it.nodeId !== null &&
							it.nodeId !== node.id &&
							ix.isWithin(it.nodeId, node.id),
					)
				: [];
		const scheduled = inside.some((it) => it.dayId !== null);
		const droppedByHand =
			node.ideaStatus === "dropped" || ix.isDropped(node.id);
		const info = placeStatus({
			dropped: droppedByHand,
			scheduled,
			pin: node.shortlistPin ?? "auto",
			score,
			threshold: opts.threshold,
			allNah: allNah(ratings, opts.memberIds),
		});
		const path = ix.path(node.id).slice(0, -1);
		const city = levelGroupOf(ix, node.id, "city").node;
		const cityAt = city ? path.findIndex((n) => n.id === city.id) : -1;
		const below = path
			.slice(cityAt + 1)
			.filter((n) => n.type === "area")
			.slice(0, 1);
		const where = [...(city ? [city] : []), ...below]
			.map((n) => n.name)
			.join(" › ");
		const first = inside[0];
		const firstDay = first ? ix.day(first.dayId) : undefined;
		const days = [...new Set(inside.map((it) => it.dayId))].filter(
			(d): d is string => !!d,
		);
		const cityRow = rowOf(node.id);
		const cityDayIds = cityRow?.dayIds ?? [];
		let when: string;
		if (firstDay) {
			const n = ix.dayNumber(firstDay.id);
			when = `Day ${n} · ${formatDayDate(firstDay.date)}${days.length > 1 ? ` +${days.length - 1}` : ""}`;
		} else if (cityRow && cityDayIds.length) {
			const at = cityRow.name;
			when = `In ${at} · ${formatDayNumbers(cityDayIds.map((d) => ix.dayNumber(d)))}`;
		} else when = "No days here yet";
		const planned = own[0]?.durationMin ?? null;
		const c = opts.counts?.byNode[node.id];
		return {
			id: node.id,
			name: node.name,
			node,
			score,
			top,
			must: top === 3,
			split: isSplit(ratings, opts.memberIds),
			status: info.status,
			info,
			droppedByHand,
			tripOrder: first ? ix.orderOf(first.id) : null,
			occurrences: inside,
			where,
			city: city ? { id: city.id, name: city.name } : null,
			timeMin: scheduled && planned !== null ? planned : node.timeNeededMin,
			timeSource:
				scheduled && planned !== null
					? "planned"
					: node.timeNeededMin !== null
						? "set"
						: null,
			media: (c?.media ?? 0) + (c?.links ?? 0),
			when,
			cityDayIds,
		};
	});
}

export function countRows(rows: readonly PlaceRow[]): PlacesCounts {
	const out: PlacesCounts = {
		all: 0,
		idea: 0,
		shortlist: 0,
		scheduled: 0,
		dropped: 0,
		talk: 0,
		toDecide: 0,
	};
	for (const r of rows) {
		out[r.status] += 1;
		if (r.status !== "dropped") out.all += 1;
		if (r.split && r.status !== "dropped") out.talk += 1;
		if (r.status === "idea" || r.status === "shortlist") out.toDecide += 1;
	}
	return out;
}

/** Text search: name, local name, description, the shared note, link titles. */
export function matchesText(
	row: PlaceRow,
	q: string,
	extra?: (id: string) => string,
): boolean {
	const needle = q.trim().toLowerCase();
	if (!needle) return true;
	const hay = [
		row.node.name,
		row.node.localName,
		row.node.description,
		row.where,
		extra?.(row.id),
	]
		.filter(Boolean)
		.join("\n")
		.toLowerCase();
	return needle.split(/\s+/).every((w) => hay.includes(w));
}

/** The status pills, "Talk about it", the shared filter and the search. */
export function filterRows(
	rows: readonly PlaceRow[],
	f: {
		status: PlaceStatus | null;
		talk: boolean;
		filter: WorkspaceFilter;
		ctx: FilterContext;
		q?: string;
		extra?: (id: string) => string;
	},
): PlaceRow[] {
	return rows.filter(
		(r) =>
			(f.status ? r.status === f.status : r.status !== "dropped") &&
			(!f.talk || r.split) &&
			matchesFilter(r.node, f.filter, f.ctx) &&
			matchesText(r, f.q ?? "", f.extra),
	);
}

/** Per-member progress over the rows ("Audrey rated 42 of 78"). */
export function ratedCount(
	rows: readonly { node: { priorities: Readonly<Record<string, Priority>> } }[],
	memberId: string,
): number {
	return rows.filter((r) => r.node.priorities[memberId] !== undefined).length;
}
