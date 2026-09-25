/**
 * "Changes that affect you" and "Assigned to you", by snapshot (pure).
 *
 * The worker keeps a small snapshot per trip of what these triggers watch
 * and diffs it after every change to the trip, whatever code path made it
 * (an edit, a day move, a date shift, an accepted suggestion):
 *
 * - a booked (`fixedDate`) or pinned item changing its day or time;
 * - a timed flight changing its departure or arrival;
 * - the trip's start date moving ("the trip's dates shift"); the plans that
 *   simply moved with it are not reported one by one;
 * - new assignees on an item or a to-do (private to-dos never notify anyone
 *   but their author, so they are not watched).
 *
 * Not every edit: renames, notes, reorders within a day and unpinned plans
 * say nothing. The first snapshot of a trip is a baseline (no events).
 */
import { shortDate } from "@/lib/engine/due";
import { type GraphIndex, indexGraph } from "@/lib/engine/graph-index";
import { formatFlightNumber } from "@/lib/engine/schedule";
import { addDays, daysBetween } from "@/lib/engine/time";
import type { TripGraph } from "@/lib/engine/types";
import { tripUrl } from "./links";
import { memberUserIds, planAudience } from "./recipients";
import { type PushTodo, todoText, todoUrl } from "./reminders";
import type { PushItem } from "./types";

type Slot = { d: string | null; t: string | null };
type FlightSlot = { d: string | null; a: string | null };

export type PushSnapshot = {
	v: 1;
	start: string | null;
	end: string | null;
	/** Booked or pinned items: their day's date and pinned time. */
	plans: Record<string, Slot>;
	/** Timed flights: local departure and arrival ("2027-10-02T10:40"). */
	flights: Record<string, FlightSlot>;
	/** Item → assignee member ids. */
	itemTags: Record<string, string[]>;
	/** Shared (not private) to-do → assignee member ids. */
	todoTags: Record<string, string[]>;
};

export type PushChange =
	| {
			kind: "dates";
			from: { start: string | null; end: string | null };
			to: { start: string | null; end: string | null };
	  }
	| { kind: "plan"; itemId: string; from: Slot; to: Slot }
	| { kind: "flight"; legId: string; from: FlightSlot; to: FlightSlot }
	| {
			kind: "assigned";
			target: "item" | "todo";
			id: string;
			memberIds: string[];
	  };

const sorted = (ids: readonly string[]) => [...new Set(ids)].sort();

export function snapshotOf(
	graph: TripGraph,
	todos: readonly PushTodo[],
	ix: GraphIndex = indexGraph(graph),
): PushSnapshot {
	const plans: PushSnapshot["plans"] = {};
	const itemTags: PushSnapshot["itemTags"] = {};
	for (const item of graph.items) {
		if (item.assigneeIds.length) itemTags[item.id] = sorted(item.assigneeIds);
		if (!item.fixedDate && !item.pinnedStart) continue;
		plans[item.id] = {
			d: item.dayId ? (ix.day(item.dayId)?.date ?? null) : null,
			t: item.pinnedStart,
		};
	}
	const flights: PushSnapshot["flights"] = {};
	for (const leg of graph.legs) {
		const d = ix.legDetails(leg);
		if (d.kind !== "flight" || !d.flight.depLocal) continue;
		flights[leg.id] = {
			d: d.flight.depLocal,
			a: d.flight.arrLocal ?? null,
		};
	}
	const todoTags: PushSnapshot["todoTags"] = {};
	for (const t of todos)
		if (!t.isPrivate && t.assigneeIds.length)
			todoTags[t.id] = sorted(t.assigneeIds);
	return {
		v: 1,
		start: graph.trip.startDate,
		end: graph.trip.endDate,
		plans,
		flights,
		itemTags,
		todoTags,
	};
}

/** `YYYY-MM-DD…` shifted by `days` (null stays null). */
const shiftDate = (d: string | null, days: number) =>
	d ? addDays(d.slice(0, 10), days) + d.slice(10) : null;

export function diffSnapshots(
	prev: PushSnapshot,
	next: PushSnapshot,
): PushChange[] {
	const out: PushChange[] = [];
	let shift = 0;
	if (prev.start !== next.start) {
		out.push({
			kind: "dates",
			from: { start: prev.start, end: prev.end },
			to: { start: next.start, end: next.end },
		});
		if (prev.start && next.start) shift = daysBetween(prev.start, next.start);
	}
	for (const [id, to] of Object.entries(next.plans)) {
		const from = prev.plans[id];
		if (!from || (from.d === to.d && from.t === to.t)) continue;
		// Moved along with the whole trip: the date shift says it.
		if (shift && to.t === from.t && to.d === shiftDate(from.d, shift)) continue;
		out.push({ kind: "plan", itemId: id, from, to });
	}
	for (const [id, to] of Object.entries(next.flights)) {
		const from = prev.flights[id];
		if (!from || (from.d === to.d && from.a === to.a)) continue;
		if (
			shift &&
			to.d === shiftDate(from.d, shift) &&
			to.a === shiftDate(from.a, shift)
		)
			continue;
		out.push({ kind: "flight", legId: id, from, to });
	}
	for (const [kind, map, before] of [
		["item", next.itemTags, prev.itemTags],
		["todo", next.todoTags, prev.todoTags],
	] as const) {
		for (const [id, ids] of Object.entries(map)) {
			const had = new Set(before[id] ?? []);
			const added = ids.filter((m) => !had.has(m));
			if (added.length)
				out.push({ kind: "assigned", target: kind, id, memberIds: added });
		}
	}
	return out;
}

export type RoutedChange = {
	group: "changes" | "assigned";
	userIds: string[];
	item: PushItem;
};

const slotLabel = (s: Slot) =>
	s.d ? `${shortDate(s.d)}${s.t ? ` · ${s.t}` : ""}` : "Unscheduled";
/** "Tue 5 Oct · 10:40" from a local date-time. */
const localLabel = (v: string | null) =>
	v
		? `${shortDate(v.slice(0, 10))}${v.length > 10 ? ` · ${v.slice(11, 16)}` : ""}`
		: "unknown";
const rangeLabel = (r: { start: string | null; end: string | null }) =>
	r.start
		? r.end && r.end !== r.start
			? `${shortDate(r.start)} – ${shortDate(r.end)}`
			: shortDate(r.start)
		: "no dates";

/**
 * Who hears about each change and what it says. `actor` is the first name of
 * whoever made the changes, when it is known and one person.
 */
export function routeChanges(
	changes: readonly PushChange[],
	graph: TripGraph,
	todos: readonly PushTodo[],
	opts: { actor?: string | null; now?: number; ix?: GraphIndex } = {},
): RoutedChange[] {
	const ix = opts.ix ?? indexGraph(graph);
	const now = opts.now ?? Date.now();
	const actor = opts.actor ?? null;
	const slug = graph.trip.slug;
	const todoById = new Map(todos.map((t) => [t.id, t]));
	const planName = (itemId: string) => {
		const item = ix.item(itemId);
		return item?.title ?? ix.node(item?.nodeId)?.name ?? "A plan";
	};
	const out: RoutedChange[] = [];
	for (const c of changes) {
		switch (c.kind) {
			case "dates": {
				out.push({
					group: "changes",
					userIds: memberUserIds(graph.members),
					item: {
						key: `dates.${c.to.start ?? "none"}.${c.to.end ?? "none"}`,
						at: now,
						actor,
						headline: "The trip's dates changed",
						body: `Now ${rangeLabel(c.to)} (was ${rangeLabel(c.from)})`,
						url: tripUrl(slug),
						meta: { label: "Trip dates" },
					},
				});
				break;
			}
			case "plan": {
				const item = ix.item(c.itemId);
				if (!item) break;
				const name = planName(c.itemId);
				const headline = !c.to.d
					? `${name} is no longer scheduled`
					: c.to.d !== c.from.d
						? `${name} moved to ${slotLabel(c.to)}`
						: `${name} now starts at ${c.to.t ?? "no fixed time"}`;
				out.push({
					group: "changes",
					userIds: planAudience(item.assigneeIds, graph.members),
					item: {
						key: `plan.${c.itemId}.${c.to.d ?? "none"}.${c.to.t ?? "none"}`,
						at: now,
						actor,
						headline,
						body: `Was ${slotLabel(c.from)}`,
						url: tripUrl(slug, { sel: `i.${c.itemId}` }),
						meta: { label: name },
					},
				});
				break;
			}
			case "flight": {
				const leg = ix.leg(c.legId);
				if (!leg) break;
				const d = ix.legDetails(leg);
				if (d.kind !== "flight") break;
				const name = `Flight ${formatFlightNumber(d.flight.flightNumber) ?? `${d.flight.from.iata} → ${d.flight.to.iata}`}`;
				const departs = c.to.d !== c.from.d;
				out.push({
					group: "changes",
					userIds: planAudience(leg.assigneeIds, graph.members),
					item: {
						key: `flight.${c.legId}.${c.to.d ?? "none"}.${c.to.a ?? "none"}`,
						at: now,
						actor,
						headline: departs
							? `${name} now departs ${localLabel(c.to.d)}`
							: `${name} now lands ${localLabel(c.to.a)}`,
						body: `Was ${departs ? localLabel(c.from.d) : localLabel(c.from.a)}`,
						url:
							leg.fromItemId && leg.toItemId
								? tripUrl(slug, { sel: `l.${leg.fromItemId}.${leg.toItemId}` })
								: tripUrl(slug),
						meta: { label: name },
					},
				});
				break;
			}
			case "assigned": {
				const userIds = memberUserIds(graph.members, c.memberIds);
				if (!userIds.length) break;
				if (c.target === "item") {
					const item = ix.item(c.id);
					if (!item) break;
					const name = planName(c.id);
					const day = item.dayId ? ix.day(item.dayId) : undefined;
					out.push({
						group: "assigned",
						userIds,
						item: {
							key: `asg.item.${c.id}`,
							at: now,
							actor,
							headline: actor
								? `${actor} assigned you to ${name}`
								: `You were assigned to ${name}`,
							body: day ? shortDate(day.date) : "Not scheduled yet",
							url: tripUrl(slug, { sel: `i.${c.id}` }),
							meta: { label: name, target: "item", id: c.id },
						},
					});
				} else {
					const t = todoById.get(c.id);
					if (!t || t.isPrivate) break;
					const text = todoText(t.text);
					out.push({
						group: "assigned",
						userIds,
						item: {
							key: `asg.todo.${c.id}`,
							at: now,
							actor,
							headline: actor
								? `${actor} assigned you a to-do`
								: "A to-do was assigned to you",
							body: text,
							url: todoUrl(slug, t),
							meta: { label: text, target: "todo", id: c.id },
						},
					});
				}
				break;
			}
		}
	}
	return out;
}
