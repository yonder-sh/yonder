/**
 * The Lists view model (DESIGN §7.3, EXTENSIONS §7, ADDENDUM §10). Pure:
 * the rows in view for a scope (SPEC §8.4 `rollup`), their grouping per View
 * (Due buckets, Place, Person, Recent, By day), where a row comes from (the
 * source crumb), and where a shopping item's shop is on the plan
 * ("Day 3 · Kappabashi 14:10", "Not on the plan", "Closed Day 3").
 */
import { Temporal } from "temporal-polyfill";
import {
	DUE_BUCKET_LABEL,
	type DueCtx,
	dueBuckets,
	effectiveDue,
	shortDate,
	sortListItems,
} from "@/lib/engine/due";
import type { GraphIndex } from "@/lib/engine/graph-index";
import { effectiveHours } from "@/lib/engine/hours";
import { type RollupSubgroup, rollup } from "@/lib/engine/rollup";
import { formatFlightNumber } from "@/lib/engine/schedule";
import { hhmm } from "@/lib/engine/time";
import type {
	DayRange,
	GraphNode,
	Lens,
	ScheduleResult,
	WorkspaceModel,
} from "@/lib/engine/types";
import type { ListKind } from "@/lib/schemas/enums";
import type { OtherKind } from "@/lib/schemas/legs";
import {
	type BundleTarget,
	bundleTargetColumns,
	type LegTarget,
} from "@/lib/schemas/targets";
import type { ListItemDto } from "./lists.functions";

/** Views per list (EXTENSIONS §7 "View"; ADDENDUM §10 "By day" for shopping). */
export type ListsView = "due" | "place" | "person" | "recent" | "day";

export const VIEW_LABEL: Record<ListsView, string> = {
	due: "Due",
	place: "Place",
	person: "Person",
	recent: "Recent",
	day: "By day",
};

export function viewsFor(kind: ListKind): ListsView[] {
	return kind === "shopping"
		? ["place", "day", "due", "person", "recent"]
		: ["due", "place", "person", "recent"];
}

/** At the trip root Todo defaults to Due (the MAIN list); elsewhere Place. */
export function defaultView(kind: ListKind, atRoot: boolean): ListsView {
	return kind === "todo" && atRoot ? "due" : "place";
}

/** A row in view, with the rollup subgroup it came through (its source). */
export type RowInView = {
	row: ListItemDto;
	sub: RollupSubgroup<unknown> | null;
	/** The rollup group's rep (Place view header). */
	repId: string | null;
};

/** Anything that hangs on a bundle target (list items, note rows). */
export type Targeted = {
	id: string;
	target: BundleTarget;
	extraTargetNodeIds?: readonly string[];
};

export type ScopeOptions = {
	scopeId: string | null;
	lens: Lens;
	/** Default true ("Everything inside"). */
	includeDescendants?: boolean;
	dayRange?: DayRange | null;
	model?: WorkspaceModel;
	showDropped?: boolean;
};

export type RolledGroup<R> = {
	repId: string | null;
	key: string;
	kind: "scope" | "rep" | "day" | "unlinked";
	dayId: string | null;
	subs: { sub: RollupSubgroup<unknown>; rows: R[] }[];
	count: number;
};

/**
 * The rows in view for a scope, grouped the rollup way (Place view), in
 * rollup group order. Ghost rows (proposed creates) roll up like real ones.
 */
export function rollupRows<R extends Targeted>(
	ix: GraphIndex,
	rows: readonly R[],
	opts: ScopeOptions,
): RolledGroup<R>[] {
	const entries = rows.map((row) => ({
		...bundleTargetColumns(row.target),
		extraNodeIds: row.extraTargetNodeIds ?? [],
		row,
	}));
	const groups = rollup(
		ix,
		{
			scopeId: opts.scopeId,
			lens: opts.lens,
			includeDescendants: opts.includeDescendants ?? true,
			dayRange: opts.dayRange ?? null,
			showDropped: opts.showDropped,
			model: opts.model,
		},
		entries,
	);
	return groups.map((g) => ({
		repId: g.repId,
		key: g.key,
		kind: g.kind,
		dayId: g.dayId,
		count: g.count,
		subs: g.subgroups.map((s) => ({
			sub: s as RollupSubgroup<unknown>,
			rows: s.entries.map((e) => e.row),
		})),
	}));
}

/**
 * Rows that are in view only while "Show dropped" is on: every one of their
 * places is dropped (SPEC A-11, QA ROLL-12). The board leaves them out and
 * says so ("2 on dropped places · Show"), never hiding them silently.
 */
export function droppedRowIds<R extends Targeted>(
	ix: GraphIndex,
	rows: readonly R[],
	opts: ScopeOptions,
): Set<string> {
	const ids = (showDropped: boolean) => {
		const out = new Set<string>();
		for (const g of rollupRows(ix, rows, { ...opts, showDropped }))
			for (const s of g.subs) for (const r of s.rows) out.add(r.id);
		return out;
	};
	const shown = ids(false);
	return new Set([...ids(true)].filter((id) => !shown.has(id)));
}

/**
 * Where a Place group's own add row attaches (DESIGN §7.3 "at the bottom of
 * a group"): its place, its day, or the trip for the scope's own group.
 * Unlinked transit has no single target.
 */
export function groupTarget(
	g: Pick<ListGroup, "repId" | "dayId" | "groupKind">,
	scopeId: string | null,
): BundleTarget | null {
	switch (g.groupKind) {
		case "rep":
			return g.repId ? { kind: "node", nodeId: g.repId } : null;
		case "day":
			return g.dayId ? { kind: "day", dayId: g.dayId } : null;
		case "scope":
			return scopeId ? { kind: "node", nodeId: scopeId } : { kind: "trip" };
		default:
			return null;
	}
}

/** Flat rows in view (each once), with their source subgroup. */
export function rowsInView(
	ix: GraphIndex,
	rows: readonly ListItemDto[],
	opts: ScopeOptions,
): RowInView[] {
	const out: RowInView[] = [];
	const seen = new Set<string>();
	for (const g of rollupRows(ix, rows, opts))
		for (const s of g.subs)
			for (const row of s.rows) {
				if (seen.has(row.id)) continue;
				seen.add(row.id);
				out.push({ row, sub: s.sub, repId: g.repId });
			}
	return out;
}

/** "Day 5 · Thu 7 Oct". */
export function dayLabel(ix: GraphIndex, dayId: string): string {
	const d = ix.day(dayId);
	return d ? `Day ${ix.dayNumber(dayId)} · ${shortDate(d.date)}` : "A day";
}

/** The item's display name ("Lunch", "Shibuya Sky"). */
export function itemName(ix: GraphIndex, itemId: string): string {
	const it = ix.item(itemId);
	return it?.title ?? ix.node(it?.nodeId)?.name ?? "An item";
}

const OTHER_KIND_LABEL: Record<OtherKind, string> = {
	taxi: "Taxi",
	car: "Car",
	ferry: "Ferry",
	bike: "Bike",
	bus: "Bus",
	other: "Leg",
};

/**
 * A leg as a source crumb (QA ROLL-05): the flight or the named service when
 * there is one ("Flight · NH 9 JFK → HND", "Leg · Fuji Excursion 7"), else the
 * mode and its ends ("Walk · Ryokan → Chureito Pagoda", "Leg · Osaka → Seoul"
 * while no mode is chosen); stay legs read "Morning · Day 5 · Thu 7 Oct".
 */
export function legLabel(ix: GraphIndex, legId: string): string {
	const leg = ix.leg(legId);
	if (!leg) return "Leg";
	if (leg.kind === "pair") {
		const d = ix.legDetails(leg);
		if (d.kind === "flight") {
			const f = d.flight;
			const name =
				formatFlightNumber(f.flightNumber) ?? f.airline?.name ?? null;
			const route = `${f.from.iata} → ${f.to.iata}`;
			return `Flight · ${name ? `${name} ${route}` : route}`;
		}
		const named =
			d.kind === "transit"
				? (d.route?.label ?? d.booking?.trainNumber)
				: d.kind === "other"
					? d.label
					: undefined;
		if (named?.trim()) return `Leg · ${named.trim()}`;
		const a = leg.fromItemId ? itemName(ix, leg.fromItemId) : "?";
		const b = leg.toItemId ? itemName(ix, leg.toItemId) : "?";
		const mode =
			d.kind === "other"
				? OTHER_KIND_LABEL[d.otherKind]
				: leg.mode === "walk"
					? "Walk"
					: leg.mode === "transit"
						? "Transit"
						: leg.mode === "flight"
							? "Flight"
							: "Leg";
		return `${mode} · ${a} → ${b}`;
	}
	const day = leg.stayDayId ? dayLabel(ix, leg.stayDayId) : "";
	return `${leg.kind === "stay_start" ? "Morning" : "Evening"} · ${day}`;
}

/** What selecting a leg crumb opens (the leg's inspector). */
export function legSelTarget(ix: GraphIndex, legId: string): LegTarget | null {
	const leg = ix.leg(legId);
	if (!leg) return null;
	if (leg.kind === "pair")
		return leg.fromItemId && leg.toItemId
			? { kind: "pair", fromItemId: leg.fromItemId, toItemId: leg.toItemId }
			: null;
	return leg.stayDayId
		? {
				kind: "stay",
				dayId: leg.stayDayId,
				end: leg.kind === "stay_start" ? "start" : "end",
			}
		: null;
}

/**
 * Place view (QA ROLL-05): the crumb a row needs inside its group, or null
 * when it hangs on the group's own place, day or scope (the header already
 * says where). Legs, visits and places further down are labelled: "Leg ·
 * Fuji Excursion 7", "Day 4 · Drop bags at ryokan", "Asakusa › Kappabashi".
 */
export function placeViewSource(
	ix: GraphIndex,
	target: BundleTarget,
	group: Pick<ListGroup, "repId" | "dayId" | "groupKind">,
	scopeId: string | null,
): string | null {
	const scopeGroup = group.groupKind === "scope";
	switch (target.kind) {
		case "trip":
			return scopeGroup && scopeId === null ? null : "Trip";
		case "node":
			if (target.nodeId === group.repId) return null;
			if (scopeGroup && target.nodeId === scopeId) return null;
			return targetLabel(ix, target, group.repId ?? scopeId);
		case "day":
			return group.groupKind === "day" && group.dayId === target.dayId
				? null
				: dayLabel(ix, target.dayId);
		case "item":
		case "leg":
			return targetLabel(ix, target, scopeId);
	}
}

/** Where a row hangs, as a short crumb ("Tokyo › Shibuya Sky", "Day 4 · Lunch", "Trip"). */
export function targetLabel(
	ix: GraphIndex,
	target: BundleTarget,
	relativeTo: string | null = null,
): string {
	switch (target.kind) {
		case "trip":
			return "Trip";
		case "node": {
			const path = ix.path(target.nodeId);
			const cut = relativeTo ? path.findIndex((n) => n.id === relativeTo) : -1;
			const shown = path.slice(cut + 1);
			const names = (shown.length ? shown : path.slice(-1)).map((n) => n.name);
			return names.slice(-3).join(" › ") || "A place";
		}
		case "item": {
			const it = ix.item(target.itemId);
			const day = it?.dayId ? `Day ${ix.dayNumber(it.dayId)} · ` : "";
			return `${day}${itemName(ix, target.itemId)}`;
		}
		case "day":
			return dayLabel(ix, target.dayId);
		case "leg":
			return legLabel(ix, target.legId);
	}
}

// ---------------------------------------------------------------------------
// Shopping ↔ plan (ADDENDUM §10)
// ---------------------------------------------------------------------------

export type ShopPlan =
	| {
			kind: "scheduled";
			itemId: string;
			dayId: string;
			nodeId: string;
			/** "Day 3 · Kappabashi 14:10". */
			label: string;
			dayNumber: number;
			/** The scheduled place ("Kappabashi"). */
			place: string;
			/** Local "HH:mm" of the visit, when scheduled. */
			time: string | null;
			/** The shop is closed that day (E1 hours): "Closed Day 3". */
			closed: boolean;
	  }
	| {
			/**
			 * The row hangs on a city, area, region or country (no single shop):
			 * the days the plan spends there, "In Tokyo · Days 2–6".
			 */
			kind: "area";
			nodeId: string;
			/** "In Tokyo · Days 2–6". */
			label: string;
			place: string;
			/** The days with a visit inside the area, in trip order. */
			dayIds: string[];
			/** "Day 3", "Days 2–6", "Days 2–6, 30–33". */
			days: string;
	  }
	| { kind: "unscheduled"; label: "Not on the plan" }
	| { kind: "none" };

/** The shop nodes a row can be bought at: its node (or its item's) + candidate shops. */
export function shopNodes(ix: GraphIndex, row: ListItemDto): string[] {
	const out: string[] = [];
	if (row.target.kind === "node") out.push(row.target.nodeId);
	if (row.target.kind === "item") {
		const n = ix.item(row.target.itemId)?.nodeId;
		if (n) out.push(n);
	}
	for (const n of row.extraTargetNodeIds) if (!out.includes(n)) out.push(n);
	return out.filter((n) => ix.node(n));
}

/**
 * Whether a place is closed on a local date, from its effective hours (E1;
 * manual > google > parsed sheet text). null = unknown. Low-confidence hours
 * never claim a closure (EXTENSIONS §4.3).
 */
export function closedOn(
	node: GraphNode,
	date: string,
	settings: Parameters<typeof effectiveHours>[1],
): boolean | null {
	const eff = effectiveHours(node, settings);
	if (!eff || eff.confidence === "low") return null;
	const h = eff.hours;
	if (h.alwaysOpen) return false;
	const ex = h.exceptions?.find((e) => e.date === date);
	if (ex) return ex.closed;
	const d = Temporal.PlainDate.from(date);
	const weekday = d.dayOfWeek % 7;
	if (h.closedDays?.includes(weekday)) return true;
	for (const rule of h.closedNth ?? []) {
		if (rule.day !== weekday) continue;
		const nth = Math.ceil(d.day / 7);
		const last = d.day + 7 > d.daysInMonth;
		if (rule.nth === nth || (rule.nth === -1 && last)) return true;
	}
	if (h.periods.length === 0) return null;
	// A period that started the day before and runs past midnight doesn't open it.
	return !h.periods.some((p) => p.day === weekday);
}

/** "Day 3", "Days 2–6", "Days 2–6, 30–33" (runs of consecutive day numbers; at most three). */
export function dayRunsLabel(numbers: readonly number[]): string {
	const ns = [...new Set(numbers)].sort((a, b) => a - b);
	if (ns.length === 0) return "";
	if (ns.length === 1) return `Day ${ns[0]}`;
	const runs: [number, number][] = [];
	for (const n of ns) {
		const last = runs[runs.length - 1];
		if (last && n === last[1] + 1) last[1] = n;
		else runs.push([n, n]);
	}
	const shown = runs
		.slice(0, 3)
		.map(([a, b]) => (a === b ? `${a}` : `${a}–${b}`))
		.join(", ");
	return `Days ${shown}${runs.length > 3 ? ", …" : ""}`;
}

/**
 * A city/area-level shop (no single place): the days with a visit inside it,
 * "In Tokyo · Days 2–6" (ADDENDUM §10) — never the first item that happens
 * to sit inside the area (an airport arrival). null when nothing is planned
 * there.
 */
function areaPlan(ix: GraphIndex, areaId: string): ShopPlan | null {
	const dayIds: string[] = [];
	for (const it of ix.ordered) {
		if (!it.dayId || !it.nodeId) continue;
		if (!ix.isWithin(it.nodeId, areaId)) continue;
		if (!dayIds.includes(it.dayId)) dayIds.push(it.dayId);
	}
	if (!dayIds.length) return null;
	const place = ix.node(areaId)?.name ?? "the area";
	const days = dayRunsLabel(dayIds.map((d) => ix.dayNumber(d)));
	return {
		kind: "area",
		nodeId: areaId,
		label: `In ${place} · ${days}`,
		place,
		dayIds,
		days,
	};
}

/**
 * Where a shopping row's shop sits on the plan: the first scheduled visit to
 * one of its place-level shops (a shop, or a place inside it), else — for a
 * row on a city/area/country — the days the plan spends there ("In Tokyo ·
 * Days 2–6"), else "Not on the plan". Rows without any located shop → `none`.
 */
export function shopPlan(
	ix: GraphIndex,
	schedule: ScheduleResult,
	row: ListItemDto,
	closedIssue?: (itemId: string) => boolean,
): ShopPlan {
	const nodes = shopNodes(ix, row);
	if (!nodes.length) return { kind: "none" };
	const shops = nodes.filter((n) => ix.node(n)?.type === "place");
	const areas = nodes.filter((n) => ix.node(n)?.type !== "place");
	for (const it of ix.ordered) {
		if (!it.dayId || !it.nodeId) continue;
		const shop = shops.find((s) => ix.isWithin(it.nodeId, s));
		if (!shop) continue;
		const node = ix.node(it.nodeId);
		const s = schedule.items[it.id];
		const time = s ? hhmm(s.start, s.tz) : null;
		const day = ix.day(it.dayId);
		const n = ix.dayNumber(it.dayId);
		const place = node?.name ?? ix.node(shop)?.name ?? "Shop";
		const closed =
			(closedIssue?.(it.id) ?? false) ||
			(node && day
				? closedOn(node, day.date, ix.trip.settings) === true
				: false);
		return {
			kind: "scheduled",
			itemId: it.id,
			dayId: it.dayId,
			nodeId: it.nodeId,
			label: `Day ${n} · ${place}${time ? ` ${time}` : ""}`,
			dayNumber: n,
			place,
			time,
			closed,
		};
	}
	// The area planned earliest (the row's own target first on a tie).
	let best: Extract<ShopPlan, { kind: "area" }> | null = null;
	for (const a of areas) {
		const plan = areaPlan(ix, a);
		if (plan?.kind !== "area") continue;
		const first = ix.dayNumber(plan.dayIds[0] as string);
		if (!best || first < ix.dayNumber(best.dayIds[0] as string)) best = plan;
	}
	return best ?? { kind: "unscheduled", label: "Not on the plan" };
}

// ---------------------------------------------------------------------------
// Groups per view
// ---------------------------------------------------------------------------

export type ListGroup = {
	key: string;
	title: string;
	/** Place view: the rep node (header crumbs + zoom). */
	repId?: string | null;
	/** Place view: the rollup group's kind (its add row's target). */
	groupKind?: RolledGroup<unknown>["kind"];
	/** By day: the day. */
	dayId?: string | null;
	/** Person view: the member (null = unassigned). */
	memberId?: string | null;
	/** A group of only done rows (they sit at the end). */
	tone?: "overdue" | "normal";
	rows: RowInView[];
};

export type GroupCtx = {
	ix: GraphIndex;
	schedule: ScheduleResult;
	dueCtx: DueCtx;
	now: number;
	/** Scope (for relative crumbs). */
	scopeId: string | null;
	/** Member names for Person view (current names, merges followed). */
	memberName: (memberId: string) => string;
	/** "Me" first in Person view. */
	meMemberId: string | null;
	closedIssue?: (itemId: string) => boolean;
};

function sortInView(rows: RowInView[], view: ListsView, ctx: GroupCtx) {
	const order = sortListItems(
		rows.map((r) => r.row),
		view === "day"
			? "place"
			: view === "due"
				? "due"
				: view === "recent"
					? "recent"
					: "place",
		ctx.dueCtx,
	);
	const pos = new Map(order.map((r, i) => [r.id, i]));
	return [...rows].sort(
		(a, b) => (pos.get(a.row.id) ?? 0) - (pos.get(b.row.id) ?? 0),
	);
}

/**
 * Groups for a view over the rows in view. Place follows the rollup groups
 * (one group per rep, subgroups flattened in order); Due uses the buckets;
 * Person groups by assignee (a row with two assignees shows under both;
 * "Unassigned" last); Recent is one flat group; By day groups shopping rows by
 * the day their shop is scheduled (a city/area-level row by its area, "In
 * Tokyo · Days 2–6", after its first day), then "Not on the plan".
 */
export function groupRows(
	view: ListsView,
	inView: RowInView[],
	ctx: GroupCtx,
	placeGroups?: RolledGroup<ListItemDto>[],
): ListGroup[] {
	const byId = new Map(inView.map((r) => [r.row.id, r]));
	switch (view) {
		case "place": {
			if (!placeGroups) return [];
			return placeGroups.map((g) => {
				const rows: RowInView[] = [];
				for (const s of g.subs)
					for (const row of sortListItems(s.rows, "place", ctx.dueCtx)) {
						const r = byId.get(row.id);
						if (r && !rows.includes(r)) rows.push(r);
					}
				return {
					key: g.key,
					title:
						g.kind === "day" && g.dayId
							? dayLabel(ctx.ix, g.dayId)
							: g.kind === "unlinked"
								? "Unlinked transit"
								: g.repId
									? (ctx.ix.node(g.repId)?.name ?? "A place")
									: ctx.scopeId
										? (ctx.ix.node(ctx.scopeId)?.name ?? "Here")
										: "Trip",
					repId: g.repId,
					groupKind: g.kind,
					dayId: g.dayId,
					rows,
				};
			});
		}
		case "due":
			return dueBuckets(
				inView.map((r) => r.row),
				ctx.now,
				ctx.dueCtx,
			).map((b) => ({
				key: `due:${b.key}`,
				title: DUE_BUCKET_LABEL[b.key],
				tone: b.key === "overdue" ? "overdue" : "normal",
				rows: b.rows.flatMap((row) => byId.get(row.id) ?? []),
			}));
		case "person": {
			const groups = new Map<string, RowInView[]>();
			for (const r of sortInView(inView, "person", ctx)) {
				const ids = r.row.assigneeIds.length ? r.row.assigneeIds : [""];
				for (const id of ids) {
					const g = groups.get(id);
					if (g) g.push(r);
					else groups.set(id, [r]);
				}
			}
			const keys = [...groups.keys()].sort((a, b) => {
				if (a === "") return 1;
				if (b === "") return -1;
				if (a === ctx.meMemberId) return -1;
				if (b === ctx.meMemberId) return 1;
				return ctx.memberName(a).localeCompare(ctx.memberName(b));
			});
			return keys.map((k) => ({
				key: `person:${k || "none"}`,
				title: k
					? k === ctx.meMemberId
						? `${ctx.memberName(k)} (you)`
						: ctx.memberName(k)
					: "Unassigned",
				memberId: k || null,
				rows: groups.get(k) ?? [],
			}));
		}
		case "recent":
			return [
				{
					key: "recent",
					title: "Newest first",
					rows: sortInView(inView, "recent", ctx),
				},
			];
		case "day": {
			// Day groups, then one group per city/area ("In Tokyo · Days 2–6")
			// right after its first day, then "Not on the plan".
			const byDay = new Map<string, RowInView[]>();
			const byArea = new Map<
				string,
				{ plan: Extract<ShopPlan, { kind: "area" }>; rows: RowInView[] }
			>();
			const off: RowInView[] = [];
			for (const r of sortInView(inView, "day", ctx)) {
				const plan = shopPlan(ctx.ix, ctx.schedule, r.row, ctx.closedIssue);
				if (plan.kind === "scheduled") {
					const g = byDay.get(plan.dayId);
					if (g) g.push(r);
					else byDay.set(plan.dayId, [r]);
				} else if (plan.kind === "area") {
					const g = byArea.get(plan.nodeId);
					if (g) g.rows.push(r);
					else byArea.set(plan.nodeId, { plan, rows: [r] });
				} else off.push(r);
			}
			const sorted: { at: number; area: boolean; group: ListGroup }[] = [
				...[...byDay.entries()].map(([d, rows]) => ({
					at: ctx.ix.dayNumber(d),
					area: false,
					group: {
						key: `day:${d}`,
						title: dayLabel(ctx.ix, d),
						dayId: d,
						rows,
					},
				})),
				...[...byArea.values()].map(({ plan, rows }) => ({
					at: ctx.ix.dayNumber(plan.dayIds[0] as string),
					area: true,
					group: { key: `area:${plan.nodeId}`, title: plan.label, rows },
				})),
			].sort((a, b) => a.at - b.at || Number(a.area) - Number(b.area));
			const out = sorted.map((s) => s.group);
			if (off.length)
				out.push({ key: "day:none", title: "Not on the plan", rows: off });
			return out;
		}
	}
}

/** The due of a row (null = none or "Date TBD"). */
export function dueOf(row: ListItemDto, ctx: DueCtx) {
	return effectiveDue(row, ctx);
}

/**
 * Rows narrowed by the person filter (`who`, members only) and, for
 * shopping, "Near selection" (any of the row's shops inside `nearNodeId`).
 */
export function filterRows(
	ix: GraphIndex,
	rows: RowInView[],
	opts: { who: string | null; nearNodeId: string | null },
): RowInView[] {
	return rows.filter((r) => {
		if (opts.who && !r.row.assigneeIds.includes(opts.who)) return false;
		if (opts.nearNodeId) {
			const near = opts.nearNodeId;
			const nodes = shopNodes(ix, r.row);
			if (!nodes.some((n) => ix.isWithin(n, near))) return false;
		}
		return true;
	});
}

/** The area around a selected place ("Near Shibuya"): its parent unless it's already an area or bigger. */
export function nearAnchor(
	ix: GraphIndex,
	nodeId: string | null,
): string | null {
	const n = ix.node(nodeId);
	if (!n) return null;
	return n.type === "place" ? (n.parentId ?? n.id) : n.id;
}
