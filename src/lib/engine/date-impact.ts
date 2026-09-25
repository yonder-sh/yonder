/**
 * E2 date-shift what-if (EXTENSIONS §5), WP-Insights. Pure and client-side:
 * clone the graph, apply the change as SPEC §7.7 does (a shift re-dates every
 * day and its timed legs; a range change adds days at the ends and sends the
 * items of removed days to Unscheduled), recompute the schedule and diff the
 * hours issues by (item, kind).
 *
 * - Booked = items with `fixedDate`, flights with a booking ref, and reserved
 *   transit (fixed times + a booking). Timed — check = pinned items that
 *   aren't booked, and flights without a ref.
 * - Deadlines: `after_target` when an absolute due date is on or after its
 *   target's new date; `now_past` when a due day now falls before today.
 */
import type { ListItemDto } from "@/features/lists/lists.functions";
import { type FlightDetails, isRedactedRef } from "@/lib/schemas/legs";
import type { Holiday } from "@/lib/schemas/trips";
import { flightDepDate, flightTimes, shiftFlight } from "./flights";
import { type GraphIndex, indexGraph } from "./graph-index";
import {
	type EffectiveHours,
	type HoursIssue,
	type HoursIssues,
	hoursIssues,
	WEEKDAY_SHORT,
	weekdayOf,
} from "./hours";
import { computeSchedule, formatFlightNumber } from "./schedule";
import { addDays, localDateOf, localDateTimeToEpoch } from "./time";
import type { GraphDay, GraphItem, GraphLeg, TripGraph } from "./types";

export type DateChange =
	| { deltaDays: number }
	| { startDate: string; endDate: string };

export type DateImpact = {
	range: { from: string; to: string };
	weekdays: string;
	startsInPast: boolean;
	bookings: {
		kind: "flight" | "transit" | "item";
		id: string;
		label: string;
		from: string;
		to: string;
		ref?: string;
	}[];
	timed: {
		kind: "item" | "flight";
		id: string;
		label: string;
		from: string;
		to: string;
		reason: "pinned" | "flight_no_ref";
	}[];
	closures: {
		added: { itemId: string; date: string; issue: HoursIssue }[];
		resolved: { itemId: string; issue: HoursIssue }[];
	};
	stays: {
		nodeId: string;
		name: string;
		from: [string, string];
		to: [string, string];
	}[];
	deadlines: {
		listItemId: string;
		text: string;
		due: string;
		reason: "after_target" | "now_past";
	}[];
	holidays: { date: string; name: string }[];
};

/** `items.fixed_date` ("Booked for this date"; absent in fixtures = false). */
export const isFixedDate = (item: GraphItem): boolean =>
	item.fixedDate === true;

const shiftLocal = (local: string, days: number) =>
	`${addDays(local.slice(0, 10), days)}${local.slice(10)}`;

/** A timed leg moved by `days` (flights and fixed transit keep their local times). */
function shiftLeg(leg: GraphLeg, days: number): GraphLeg {
	const d = leg.details as { kind?: string } & Record<string, unknown>;
	const byMs = (iso: string) =>
		new Date(Date.parse(iso) + days * 86_400_000).toISOString();
	if (d.kind === "flight") {
		// FB-18: a flight without times still carries its dates.
		const f = shiftFlight((d as { flight: FlightDetails }).flight, days);
		const t = flightTimes(f);
		return {
			...leg,
			depAt: leg.depAt
				? t.depMs === null
					? byMs(leg.depAt)
					: new Date(t.depMs).toISOString()
				: null,
			arrAt: leg.arrAt
				? t.arrMs === null
					? byMs(leg.arrAt)
					: new Date(t.arrMs).toISOString()
				: null,
			details: { ...d, flight: f } as GraphLeg["details"],
		};
	}
	if (!leg.depAt || !leg.arrAt) return leg;
	if (d.kind === "transit" && d.fixed) {
		const fx = d.fixed as {
			departLocal: string;
			arriveLocal: string;
			fromTz: string;
			toTz: string;
		};
		const departLocal = shiftLocal(fx.departLocal, days);
		const arriveLocal = shiftLocal(fx.arriveLocal, days);
		const dep = localDateTimeToEpoch(departLocal, fx.fromTz);
		const arr = localDateTimeToEpoch(arriveLocal, fx.toTz);
		return {
			...leg,
			depAt: dep === null ? byMs(leg.depAt) : new Date(dep).toISOString(),
			arrAt: arr === null ? byMs(leg.arrAt) : new Date(arr).toISOString(),
			details: {
				...d,
				fixed: { ...fx, departLocal, arriveLocal },
			} as GraphLeg["details"],
		};
	}
	return { ...leg, depAt: byMs(leg.depAt), arrAt: byMs(leg.arrAt) };
}

/** SPEC §7.7 `shiftTripDates`, on a copy. */
export function shiftedGraph(graph: TripGraph, deltaDays: number): TripGraph {
	if (!deltaDays) return graph;
	const dayIds = new Set(graph.days.map((d) => d.id));
	const itemDay = new Map(graph.items.map((i) => [i.id, i.dayId]));
	return {
		...graph,
		trip: {
			...graph.trip,
			startDate: graph.trip.startDate
				? addDays(graph.trip.startDate, deltaDays)
				: null,
			endDate: graph.trip.endDate
				? addDays(graph.trip.endDate, deltaDays)
				: null,
		},
		days: graph.days.map((d) => ({ ...d, date: addDays(d.date, deltaDays) })),
		legs: graph.legs.map((l) => {
			const from = l.fromItemId ? itemDay.get(l.fromItemId) : null;
			return from && dayIds.has(from) ? shiftLeg(l, deltaDays) : l;
		}),
	};
}

/** SPEC §7.7 `setTripDates`, on a copy: days outside the range go (their items to Unscheduled), new days are added at the ends. */
export function rangedGraph(
	graph: TripGraph,
	startDate: string,
	endDate: string,
): TripGraph {
	const kept = graph.days.filter(
		(d) => d.date >= startDate && d.date <= endDate,
	);
	const keptIds = new Set(kept.map((d) => d.id));
	const have = new Set(kept.map((d) => d.date));
	const startTime = graph.trip.settings.defaultDayStart ?? "09:00";
	const added: GraphDay[] = [];
	for (
		let d = startDate, guard = 0;
		d <= endDate && guard < 400;
		d = addDays(d, 1), guard++
	)
		if (!have.has(d))
			added.push({
				id: `new-day:${d}`,
				date: d,
				startTime,
				title: null,
				nightNodeId: null,
				updatedAt: graph.trip.updatedAt,
			});
	return {
		...graph,
		trip: { ...graph.trip, startDate, endDate },
		days: [...kept, ...added].sort((a, b) => a.date.localeCompare(b.date)),
		items: graph.items.map((i) =>
			i.dayId && !keptIds.has(i.dayId) ? { ...i, dayId: null } : i,
		),
	};
}

type Ctx = {
	hoursOf: (nodeId: string) => EffectiveHours | null;
	holidays: readonly Holiday[];
	today: string;
	listItems?: readonly ListItemDto[];
};

const labelOfItem = (ix: GraphIndex, item: GraphItem) =>
	item.title ?? ix.node(item.nodeId)?.name ?? "Untitled";

/** Runs of consecutive nights at one stay: [check-in, check-out]. */
function stayRuns(
	graph: TripGraph,
): { nodeId: string; dayIds: string[]; from: [string, string] }[] {
	const days = [...graph.days].sort((a, b) => a.date.localeCompare(b.date));
	const runs: { nodeId: string; dayIds: string[]; from: [string, string] }[] =
		[];
	for (const d of days) {
		const last = runs.at(-1);
		if (
			d.nightNodeId &&
			last &&
			last.nodeId === d.nightNodeId &&
			addDays(last.from[1], 0) === d.date
		) {
			last.dayIds.push(d.id);
			last.from[1] = addDays(d.date, 1);
		} else if (d.nightNodeId)
			runs.push({
				nodeId: d.nightNodeId,
				dayIds: [d.id],
				from: [d.date, addDays(d.date, 1)],
			});
	}
	return runs;
}

const ixMemo = new WeakMap<TripGraph, GraphIndex>();
/** The current graph's index, built once for every delta the stepper tries. */
function indexOf(graph: TripGraph): GraphIndex {
	let ix = ixMemo.get(graph);
	if (!ix) {
		ix = indexGraph(graph);
		ixMemo.set(graph, ix);
	}
	return ix;
}

const beforeMemo = new WeakMap<
	TripGraph,
	{ hoursOf: Ctx["hoursOf"]; holidays: Ctx["holidays"]; issues: HoursIssues }
>();

/** The current plan's hours issues, reused while hoursOf and holidays are the same. */
function issuesBefore(graph: TripGraph, ix: GraphIndex, ctx: Ctx): HoursIssues {
	const hit = beforeMemo.get(graph);
	if (hit && hit.hoursOf === ctx.hoursOf && hit.holidays === ctx.holidays)
		return hit.issues;
	const issues = hoursIssues(ix, computeSchedule(ix), {
		hoursOf: ctx.hoursOf,
		holidays: ctx.holidays,
	});
	beforeMemo.set(graph, {
		hoursOf: ctx.hoursOf,
		holidays: ctx.holidays,
		issues,
	});
	return issues;
}

export function dateChangeImpact(
	graph: TripGraph,
	change: DateChange,
	ctx: Ctx,
): DateImpact {
	const before = indexOf(graph);
	const next =
		"deltaDays" in change
			? shiftedGraph(graph, change.deltaDays)
			: rangedGraph(graph, change.startDate, change.endDate);
	const from = next.trip.startDate ?? next.days[0]?.date ?? "";
	const to = next.trip.endDate ?? next.days.at(-1)?.date ?? "";
	const out: DateImpact = {
		range: { from, to },
		weekdays:
			from && to
				? `${WEEKDAY_SHORT[weekdayOf(from)]}–${WEEKDAY_SHORT[weekdayOf(to)]}`
				: "",
		startsInPast: !!from && from < ctx.today,
		bookings: [],
		timed: [],
		closures: { added: [], resolved: [] },
		stays: [],
		deadlines: [],
		holidays: [],
	};
	if (next === graph) return out;
	const after = indexGraph(next);
	const oldDate = (dayId: string | null) =>
		dayId ? (before.day(dayId)?.date ?? "") : "";
	const newDate = (dayId: string | null) =>
		dayId ? (after.day(dayId)?.date ?? "") : "";

	// Items: booked for their date, or pinned to a time.
	for (const item of graph.items) {
		if (!item.dayId) continue;
		const a = oldDate(item.dayId);
		const b = newDate(after.item(item.id)?.dayId ?? null);
		if (a === b) continue;
		if (isFixedDate(item))
			out.bookings.push({
				kind: "item",
				id: item.id,
				label: labelOfItem(before, item),
				from: a,
				to: b,
			});
		else if (item.pinnedStart)
			out.timed.push({
				kind: "item",
				id: item.id,
				label: labelOfItem(before, item),
				from: a,
				to: b,
				reason: "pinned",
			});
	}
	// Legs: flights and reserved transit.
	const legAfter = new Map(next.legs.map((l) => [l.id, l]));
	for (const leg of graph.legs) {
		const d = before.legDetails(leg);
		const nl = legAfter.get(leg.id);
		if (d.kind === "flight") {
			const a = flightDepDate(d.flight);
			const nd = nl ? after.legDetails(nl) : d;
			const b = nd.kind === "flight" ? flightDepDate(nd.flight) : a;
			if (!a || !b || a === b) continue;
			const number = formatFlightNumber(d.flight.flightNumber);
			const label = `Flight ${number ?? `${d.flight.from.iata} → ${d.flight.to.iata}`}`;
			if (d.flight.bookingRef)
				out.bookings.push({
					kind: "flight",
					id: leg.id,
					label,
					from: a,
					to: b,
					// A link guest's graph has only the mask: booked, ref hidden.
					...(isRedactedRef(d.flight.bookingRef)
						? {}
						: { ref: d.flight.bookingRef }),
				});
			else
				out.timed.push({
					kind: "flight",
					id: leg.id,
					label,
					from: a,
					to: b,
					reason: "flight_no_ref",
				});
		} else if (d.kind === "transit" && d.fixed && d.booking) {
			const a = d.fixed.departLocal.slice(0, 10);
			const nd = nl ? after.legDetails(nl) : d;
			const b =
				nd.kind === "transit" && nd.fixed
					? nd.fixed.departLocal.slice(0, 10)
					: a;
			if (a === b) continue;
			const label = d.route?.label ?? d.booking.trainNumber ?? "Reserved train";
			out.bookings.push({
				kind: "transit",
				id: leg.id,
				label,
				from: a,
				to: b,
				...(d.booking.ref ? { ref: d.booking.ref } : {}),
			});
		}
	}

	const byDate = (a: { from: string }, b: { from: string }) =>
		a.from.localeCompare(b.from);
	out.bookings.sort(byDate);
	out.timed.sort(byDate);

	// Hours: what the new dates open or close. The "before" side is the same
	// for every delta, so it's computed once per (graph, hoursOf, holidays).
	const scheduleAfter = computeSchedule(after);
	const was = issuesBefore(graph, before, ctx);
	const now = hoursIssues(after, scheduleAfter, {
		hoursOf: ctx.hoursOf,
		holidays: ctx.holidays,
	});
	const warnKeys = (list: readonly HoursIssue[] | undefined) =>
		new Map(
			(list ?? []).filter((i) => i.severity === "warn").map((i) => [i.kind, i]),
		);
	const itemIds = new Set([
		...Object.keys(was.byItem),
		...Object.keys(now.byItem),
	]);
	for (const itemId of itemIds) {
		const w = warnKeys(was.byItem[itemId]);
		const n = warnKeys(now.byItem[itemId]);
		for (const [kind, issue] of n)
			if (!w.has(kind)) {
				const s = scheduleAfter.items[itemId];
				const item = after.item(itemId);
				const date =
					s && item?.nodeId
						? localDateOf(s.start, after.tzOf(item.nodeId))
						: newDate(item?.dayId ?? null);
				out.closures.added.push({ itemId, date, issue });
			}
		for (const [kind, issue] of w)
			if (!n.has(kind)) out.closures.resolved.push({ itemId, issue });
	}
	const order = (id: string) => after.orderOf(id);
	out.closures.added.sort((a, b) => order(a.itemId) - order(b.itemId));

	// Stays: every run of nights that moves.
	const runsAfter = new Map(stayRuns(next).map((r) => [r.dayIds[0], r]));
	for (const r of stayRuns(graph)) {
		const moved = runsAfter.get(r.dayIds[0]);
		const toRange: [string, string] = moved ? moved.from : ["", ""];
		if (toRange[0] === r.from[0] && toRange[1] === r.from[1]) continue;
		out.stays.push({
			nodeId: r.nodeId,
			name: before.node(r.nodeId)?.name ?? "Stay",
			from: r.from,
			to: toRange,
		});
	}

	// Deadlines: absolute due dates that now land on or after their target.
	for (const li of ctx.listItems ?? []) {
		if (li.status !== "open" || li.dueRule) continue;
		let targetDate = "";
		const t = li.target;
		if (t.kind === "item")
			targetDate = newDate(after.item(t.itemId)?.dayId ?? null);
		else if (t.kind === "day") targetDate = newDate(t.dayId);
		else if (t.kind === "leg") {
			const leg = after.leg(t.legId);
			targetDate = newDate(
				after.item(leg?.fromItemId)?.dayId ??
					after.day(leg?.stayDayId)?.id ??
					null,
			);
		}
		const text = li.text.replace(/\s+/g, " ").slice(0, 120);
		if (li.dueDate && targetDate && li.dueDate >= targetDate) {
			const wasDate = (() => {
				if (t.kind === "item")
					return oldDate(before.item(t.itemId)?.dayId ?? null);
				if (t.kind === "day") return oldDate(t.dayId);
				return "";
			})();
			if (!(wasDate && li.dueDate >= wasDate))
				out.deadlines.push({
					listItemId: li.id,
					text,
					due: li.dueDate,
					reason: "after_target",
				});
			continue;
		}
		if (li.dueDayId) {
			const due = newDate(li.dueDayId);
			if (due && due < ctx.today && !(oldDate(li.dueDayId) < ctx.today))
				out.deadlines.push({
					listItemId: li.id,
					text,
					due,
					reason: "now_past",
				});
		}
	}

	// Holidays that now fall inside the trip (each one lands on another day).
	for (const h of ctx.holidays)
		if (h.date >= from && h.date <= to)
			out.holidays.push({ date: h.date, name: h.name });
	out.holidays.sort((a, b) => a.date.localeCompare(b.date));
	return out;
}

/** The items and legs a what-if touches (the primary ring on cards and legs). */
export function impactedIds(impact: DateImpact): {
	items: Set<string>;
	legs: Set<string>;
} {
	const items = new Set<string>();
	const legs = new Set<string>();
	for (const b of impact.bookings) (b.kind === "item" ? items : legs).add(b.id);
	for (const t of impact.timed) (t.kind === "item" ? items : legs).add(t.id);
	for (const c of impact.closures.added) items.add(c.itemId);
	return { items, legs };
}
