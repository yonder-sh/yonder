/**
 * Grouping and sorting for the Places tab (docs/PLACES.md §1). Shared by the
 * table, the board and the phone list. Pure.
 *
 * - Grouping by a level uses each place's NEAREST ancestor of that type; a
 *   place with none (Mt. Fuji has no city) falls back to the nearest level
 *   above, so nothing hides.
 * - A city group with `SPLIT_AT` or more places offers "Split by area": it
 *   subdivides just that group by area (remembered per person).
 * - Groups sort by trip order (the first day anything in them is visited),
 *   then outline order.
 */
import { RANK } from "@/lib/engine/lens";
import type { GraphNode, NodeType } from "@/lib/engine/types";
import type { PlaceStatus } from "./lifecycle";
import { compareByScore, type Scored } from "./score";

export const GROUP_BYS = [
	"country",
	"region",
	"city",
	"area",
	"status",
	"none",
] as const;
export type GroupBy = (typeof GROUP_BYS)[number];

export const SORT_BYS = ["priority", "name", "trip"] as const;
export type SortBy = (typeof SORT_BYS)[number];

export const GROUP_LABEL: Record<GroupBy, string> = {
	country: "Country",
	region: "Region",
	city: "City",
	area: "Area",
	status: "Status",
	none: "None",
};

export const SORT_LABEL: Record<SortBy, string> = {
	priority: "Priority",
	name: "Name",
	trip: "Trip order",
};

/** A city group this big offers "Split by area". */
export const SPLIT_AT = 15;

type Tree = {
	path(id: string): GraphNode[];
	outlineIndex(id: string): number;
};

export type LevelGroup = {
	/** The group's node, or null (nothing above the place at all). */
	node: GraphNode | null;
	/** The node is the nearest level ABOVE the one asked for. */
	fallback: boolean;
};

/**
 * The node a place groups under at `level`: its nearest (innermost) ancestor
 * of that type, else the nearest ancestor of a coarser type. The place itself
 * never counts (an area row groups under the area or city around it).
 */
export function levelGroupOf(
	ix: Tree,
	nodeId: string,
	level: NodeType,
): LevelGroup {
	const above = ix.path(nodeId).slice(0, -1);
	for (let i = above.length - 1; i >= 0; i--) {
		const n = above[i] as GraphNode;
		if (n.type === level) return { node: n, fallback: false };
	}
	for (let i = above.length - 1; i >= 0; i--) {
		const n = above[i] as GraphNode;
		if (RANK[n.type] < RANK[level]) return { node: n, fallback: true };
	}
	return { node: null, fallback: true };
}

/** What grouping and sorting read from a row. */
export type Groupable = Scored & {
	id: string;
	status: PlaceStatus;
	/** The top rating is a Must ("3 must" in the group summary). */
	must: boolean;
	/** Trip order: the first scheduled occurrence's position, else null. */
	tripOrder: number | null;
};

export type SubGroup<R> = { key: string; label: string; rows: R[] };

export type PlaceGroup<R> = {
	key: string;
	label: string;
	/** "city-wide", "region-wide": the group is the nearest level above. */
	note: string | null;
	node: GraphNode | null;
	rows: R[];
	/** Split by area (only when split). */
	subgroups: SubGroup<R>[] | null;
	canSplit: boolean;
	split: boolean;
	summary: { count: number; musts: number; scheduled: number };
};

const STATUS_GROUPS: { status: PlaceStatus; label: string }[] = [
	{ status: "shortlist", label: "Shortlist" },
	{ status: "idea", label: "Ideas" },
	{ status: "scheduled", label: "Scheduled" },
	{ status: "dropped", label: "Dropped" },
];

export function comparatorFor<R extends Groupable>(
	sort: SortBy,
	outlineIndex: (id: string) => number,
): (a: R, b: R) => number {
	switch (sort) {
		case "name":
			return (a, b) => a.name.localeCompare(b.name);
		case "trip":
			return (a, b) => {
				if (a.tripOrder !== null && b.tripOrder !== null)
					return a.tripOrder - b.tripOrder;
				if (a.tripOrder !== null) return -1;
				if (b.tripOrder !== null) return 1;
				return outlineIndex(a.id) - outlineIndex(b.id);
			};
		default:
			return compareByScore;
	}
}

export function groupPlaces<R extends Groupable>(
	rows: readonly R[],
	opts: {
		by: GroupBy;
		sort: SortBy;
		ix: Tree;
		/** Group node ids split by area (per person). */
		split?: ReadonlySet<string>;
		/** The first trip day index anything inside a node is visited, or null. */
		groupVisit?: (nodeId: string) => number | null;
		splitAt?: number;
	},
): PlaceGroup<R>[] {
	const cmp = comparatorFor<R>(opts.sort, (id) => opts.ix.outlineIndex(id));
	const splitAt = opts.splitAt ?? SPLIT_AT;
	const summary = (xs: R[]) => ({
		count: xs.length,
		musts: xs.filter((r) => r.must).length,
		scheduled: xs.filter((r) => r.status === "scheduled").length,
	});

	if (opts.by === "none")
		return rows.length
			? [
					{
						key: "all",
						label: "All places",
						note: null,
						node: null,
						rows: [...rows].sort(cmp),
						subgroups: null,
						canSplit: false,
						split: false,
						summary: summary([...rows]),
					},
				]
			: [];

	if (opts.by === "status")
		return STATUS_GROUPS.flatMap(({ status, label }) => {
			const xs = rows.filter((r) => r.status === status).sort(cmp);
			return xs.length
				? [
						{
							key: `status:${status}`,
							label,
							note: null,
							node: null,
							rows: xs,
							subgroups: null,
							canSplit: false,
							split: false,
							summary: summary(xs),
						},
					]
				: [];
		});

	const level = opts.by;
	const buckets = new Map<
		string,
		{ node: GraphNode | null; fallback: boolean; rows: R[] }
	>();
	for (const r of rows) {
		const g = levelGroupOf(opts.ix, r.id, level);
		const key = g.node?.id ?? "root";
		const b = buckets.get(key);
		if (b) b.rows.push(r);
		else buckets.set(key, { ...g, rows: [r] });
	}
	const visit = (id: string | null) =>
		id && opts.groupVisit ? opts.groupVisit(id) : null;
	const ordered = [...buckets.entries()].sort(([ka, a], [kb, b]) => {
		const va = visit(a.node?.id ?? null);
		const vb = visit(b.node?.id ?? null);
		if (va !== null && vb !== null && va !== vb) return va - vb;
		if (va !== null && vb === null) return -1;
		if (vb !== null && va === null) return 1;
		const oa =
			ka === "root" ? Number.MAX_SAFE_INTEGER : opts.ix.outlineIndex(ka);
		const ob =
			kb === "root" ? Number.MAX_SAFE_INTEGER : opts.ix.outlineIndex(kb);
		return oa - ob;
	});
	return ordered.map(([key, b]) => {
		const xs = b.rows.sort(cmp);
		const canSplit =
			level === "city" && b.node?.type === "city" && xs.length >= splitAt;
		const split = canSplit && !!b.node && !!opts.split?.has(b.node.id);
		return {
			key,
			label: b.node?.name ?? "Elsewhere",
			note:
				b.fallback && b.node
					? `${b.node.type === "country" ? "country" : b.node.type}-wide`
					: null,
			node: b.node,
			rows: xs,
			subgroups: split && b.node ? splitByArea(opts.ix, b.node.id, xs) : null,
			canSplit,
			split,
			summary: summary(xs),
		};
	});
}

/**
 * One city's places by area: the nearest area inside the city, else
 * "City-wide". Largest first, then by name (the rows keep their order).
 */
export function splitByArea<R extends { id: string }>(
	ix: Tree,
	cityId: string,
	rows: readonly R[],
): SubGroup<R>[] {
	const by = new Map<string, SubGroup<R>>();
	for (const r of rows) {
		const above = ix.path(r.id).slice(0, -1);
		const at = above.findIndex((n) => n.id === cityId);
		// The outermost area below the city (Gion rolls up into Higashiyama).
		const area =
			at >= 0 ? above.slice(at + 1).find((n) => n.type === "area") : undefined;
		const key = area?.id ?? "city-wide";
		const g = by.get(key);
		if (g) g.rows.push(r);
		else
			by.set(key, {
				key,
				label: area?.name ?? "City-wide",
				rows: [r],
			});
	}
	return [...by.values()].sort(
		(a, b) => b.rows.length - a.rows.length || a.label.localeCompare(b.label),
	);
}
