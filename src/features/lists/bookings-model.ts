/**
 * The Bookings tab's model (One Yonder D12). Pure: booking to-dos (a to-do
 * whose date is when booking opens) and stops booked for their date, grouped
 * Opening soon · Later · Booked · No date yet; what a booking is for (its
 * stop or leg, and what the For picker offers); and the words its row and
 * details use ("Opens Mon 12 Oct 2026 · 09:00 JST", "355 days before",
 * "Opens in 15 days", "1 night").
 */
import { Temporal } from "temporal-polyfill";
import {
	type DueCtx,
	dueChipLabel,
	dueState,
	type EffectiveDue,
	effectiveDue,
	shortDate,
} from "@/lib/engine/due";
import { type GraphIndex, pairKey } from "@/lib/engine/graph-index";
import { hhmm, tzLabel } from "@/lib/engine/time";
import type { GraphItem, GraphLeg, ScheduleResult } from "@/lib/engine/types";
import type { ExpenseCategory, LegMode } from "@/lib/schemas/enums";
import type { DueRule } from "@/lib/schemas/lists";
import type { BundleTarget } from "@/lib/schemas/targets";
import { isBookingTodo, itemName, legLabel } from "./list-model";
import type { ListItemDto } from "./lists.functions";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
/** A booking window opening within this long is "Opening soon". */
export const BOOKING_SOON_MS = 30 * DAY;

/** A stop marked "Booked for this date" (on a day). */
export function isBookedStop(it: GraphItem): boolean {
	return it.fixedDate === true && it.dayId !== null;
}

/**
 * A row of the Bookings tab: a booking to-do (with the stop it is for when
 * that stop is booked for its date), or a booked stop on its own.
 */
export type BookingEntry =
	| { kind: "todo"; id: string; row: ListItemDto; stop?: GraphItem }
	| { kind: "stop"; id: string; item: GraphItem };

/** Booked: a ticked to-do, one whose stop is booked for its date, or a booked stop. */
export function isBooked(e: BookingEntry): boolean {
	return e.kind === "stop" || e.row.status === "done" || !!e.stop;
}

export type BookingGroupKey = "soon" | "later" | "booked" | "none";

export const BOOKING_GROUP_LABEL: Record<BookingGroupKey, string> = {
	soon: "Opening soon",
	later: "Later",
	booked: "Booked",
	none: "No date yet",
};

export type BookingGroup = {
	key: BookingGroupKey;
	title: string;
	entries: BookingEntry[];
};

/**
 * The stop a booking to-do is for: the visit it hangs on, its leg's
 * departure, the stop its window counts back from, or the first visit to
 * the place it hangs on.
 */
export function bookingItemId(
	ix: GraphIndex,
	row: Pick<ListItemDto, "target" | "dueRule">,
): string | null {
	const t = row.target;
	if (t.kind === "item") return t.itemId;
	if (t.kind === "leg") {
		const leg = ix.leg(t.legId);
		if (leg?.kind === "pair" && leg.fromItemId) return leg.fromItemId;
	}
	return row.dueRule?.itemId ?? firstVisit(ix, row.target);
}

/**
 * The stop a booking to-do books (what Mark booked marks "Booked for this
 * date"): the visit it hangs on, else the stop its window counts back from,
 * else the first visit to its place. A leg books no stop.
 */
export function bookingStopId(
	ix: GraphIndex,
	row: Pick<ListItemDto, "target" | "dueRule">,
): string | null {
	const t = row.target;
	if (t.kind === "item") return t.itemId;
	if (t.kind === "leg") return null;
	return row.dueRule?.itemId ?? firstVisit(ix, t);
}

/** The stop a booking to-do books, when it is already booked for its date. */
export function bookedStopOf(
	ix: GraphIndex,
	row: Pick<ListItemDto, "target" | "dueRule">,
): GraphItem | null {
	const it = ix.item(bookingStopId(ix, row));
	return it && isBookedStop(it) ? it : null;
}

/** The first visit on a day to a place (not a city or area) a row hangs on. */
function firstVisit(ix: GraphIndex, t: BundleTarget): string | null {
	if (t.kind !== "node" || ix.node(t.nodeId)?.type !== "place") return null;
	return (
		ix.ordered.find((it) => it.dayId && it.nodeId === t.nodeId)?.id ?? null
	);
}

/** The day a booking is on (its stop's day), for sorting and "Day 6". */
export function bookingDayId(ix: GraphIndex, e: BookingEntry): string | null {
	const itemId = e.kind === "stop" ? e.item.id : bookingItemId(ix, e.row);
	return (itemId ? ix.item(itemId)?.dayId : null) ?? null;
}

/**
 * Opening soon (within 30 days, or already open) · Later · Booked · No date
 * yet. Windows sort by when they open; Booked by day. A to-do whose stop is
 * booked for its date counts as booked: one row under Booked, carrying the
 * to-do and the stop (never the stop again on its own). Skipped to-dos stay
 * in To-dos. Empty groups are left out.
 */
export function bookingGroups(
	ix: GraphIndex,
	todos: readonly ListItemDto[],
	stops: readonly GraphItem[],
	ctx: { dueCtx: DueCtx; now: number },
): BookingGroup[] {
	const at = new Map<string, number | null>();
	const soon: BookingEntry[] = [];
	const later: BookingEntry[] = [];
	const booked: BookingEntry[] = [];
	const none: BookingEntry[] = [];
	const covered = new Set<string>();
	for (const row of todos) {
		if (!isBookingTodo(row) || row.status === "skipped") continue;
		const stop = bookedStopOf(ix, row);
		const e: BookingEntry = {
			kind: "todo",
			id: row.id,
			row,
			...(stop ? { stop } : {}),
		};
		if (row.status === "done" || stop) {
			booked.push(e);
			const it = bookingStopId(ix, row);
			if (it) covered.add(it);
			continue;
		}
		const due = effectiveDue(row, ctx.dueCtx);
		at.set(row.id, due?.at ?? null);
		if (!due) none.push(e);
		else if (due.at - ctx.now <= BOOKING_SOON_MS) soon.push(e);
		else later.push(e);
	}
	for (const item of stops)
		if (isBookedStop(item) && !covered.has(item.id))
			booked.push({ kind: "stop", id: item.id, item });
	const byAt = (a: BookingEntry, b: BookingEntry) =>
		(at.get(a.id) ?? 0) - (at.get(b.id) ?? 0);
	const dayOrder = (e: BookingEntry) => {
		const d = bookingDayId(ix, e);
		return d ? ix.dayNumber(d) : Number.POSITIVE_INFINITY;
	};
	booked.sort((a, b) => dayOrder(a) - dayOrder(b));
	const groups: [BookingGroupKey, BookingEntry[]][] = [
		["soon", soon.sort(byAt)],
		["later", later.sort(byAt)],
		["booked", booked],
		["none", none],
	];
	return groups
		.filter(([, entries]) => entries.length)
		.map(([key, entries]) => ({
			key,
			title: BOOKING_GROUP_LABEL[key],
			entries,
		}));
}

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;
const MONTHS = [
	"Jan",
	"Feb",
	"Mar",
	"Apr",
	"May",
	"Jun",
	"Jul",
	"Aug",
	"Sep",
	"Oct",
	"Nov",
	"Dec",
] as const;

/** "Mon 12 Oct 2026". */
export function longDate(date: string): string {
	const d = Temporal.PlainDate.from(date);
	return `${WEEKDAYS[d.dayOfWeek % 7]} ${d.day} ${MONTHS[d.month - 1]} ${d.year}`;
}

/** "Opens Mon 12 Oct 2026 · 09:00 JST" (a date alone: no time). */
export function opensLabel(due: EffectiveDue): string {
	const time = due.allDay
		? ""
		: ` · ${hhmm(due.at, due.tz)} ${tzLabel(due.tz, due.at)}`;
	return `Opens ${longDate(due.date)}${time}`;
}

function ordinal(n: number): string {
	if (n % 100 >= 11 && n % 100 <= 13) return "th";
	return ["th", "st", "nd", "rd"][n % 10] ?? "th";
}

/** "355 days before", "1 month before", "the 10th, 2 months before", "the same day". */
export function ruleLabel(rule: DueRule): string {
	const n = rule.kind === "days" ? rule.days : rule.months;
	const unit = rule.kind === "days" ? "day" : "month";
	const on =
		rule.kind === "months" && rule.dayOfMonth
			? `the ${rule.dayOfMonth}${ordinal(rule.dayOfMonth)}, `
			: "";
	if (n === 0) return on ? `${on}the same month` : "the same day";
	return `${on}${n} ${unit}${n === 1 ? "" : "s"} before`;
}

/** "Opens in 15 days", "Opens in 5h", "Open now", "Opened 3d ago". */
export function opensIn(due: EffectiveDue, now: number): string {
	const state = dueState(due, now, "open");
	if (state === "open_now" || state === "overdue")
		return dueChipLabel(due, state, now);
	const ms = due.at - now;
	if (ms < DAY) return `Opens in ${Math.max(1, Math.round(ms / HOUR))}h`;
	const days = Math.round(ms / DAY);
	return `Opens in ${days} day${days === 1 ? "" : "s"}`;
}

/** Nights a booked stay covers from its day (the days you sleep there), or 0. */
export function nightsAt(ix: GraphIndex, item: GraphItem): number {
	if (!item.dayId || !item.nodeId) return 0;
	const start = ix.days.findIndex((d) => d.id === item.dayId);
	let n = 0;
	for (let i = start; i >= 0 && i < ix.days.length; i++) {
		if (ix.days[i]?.nightNodeId !== item.nodeId) break;
		n++;
	}
	return n;
}

/** What a booking is for: its stop or leg, when and on which day. */
export type BookingFor = {
	kind: "item" | "leg";
	/** Where its confirmation is kept (the stop or the leg). */
	target: BundleTarget;
	/** "Fuji Excursion 7", "Kawaguchiko Ryokan". */
	name: string;
	/** "Itoya 08:30 → Kawaguchiko Ryokan 10:26", "15:00". */
	when: string | null;
	dayId: string | null;
	/** "Car 3, seats 5A and 5B". */
	extra: string | null;
	/** What its window moves with ("the train", "Kawaguchiko Ryokan"). */
	anchor: string;
	/** The stops `anchor` stands for (the stop, or the leg's two ends). */
	anchorIds: string[];
};

function andList(xs: readonly string[]): string {
	if (xs.length <= 1) return xs[0] ?? "";
	return `${xs.slice(0, -1).join(", ")} and ${xs.at(-1)}`;
}

function seatsLabel(
	seats: readonly { seat: string }[],
	car?: string,
): string | null {
	const s = seats.map((x) => x.seat).filter(Boolean);
	const parts = [
		car ? `Car ${car}` : null,
		s.length ? `${s.length === 1 ? "seat" : "seats"} ${andList(s)}` : null,
	].filter((x): x is string => !!x);
	if (!parts.length) return null;
	const out = parts.join(", ");
	return out.charAt(0).toUpperCase() + out.slice(1);
}

function itemFor(
	ix: GraphIndex,
	schedule: ScheduleResult,
	itemId: string,
): BookingFor | null {
	const it = ix.item(itemId);
	if (!it) return null;
	const s = schedule.items[it.id];
	const name = itemName(ix, it.id);
	return {
		kind: "item",
		target: { kind: "item", itemId: it.id },
		name,
		when: s ? hhmm(s.start, s.tz) : null,
		dayId: it.dayId,
		extra: null,
		anchor: name,
		anchorIds: [it.id],
	};
}

/**
 * What a booking is for: a booked stop itself; for a to-do, the visit or leg
 * it hangs on, else the stop its window counts back from, else the first
 * visit to its place. Null for a day, a city or the trip.
 */
export function bookingFor(
	ix: GraphIndex,
	schedule: ScheduleResult,
	e: BookingEntry,
): BookingFor | null {
	if (e.kind === "stop") return itemFor(ix, schedule, e.item.id);
	const t = e.row.target;
	if (t.kind === "item") return itemFor(ix, schedule, t.itemId);
	if (t.kind === "leg") {
		const leg = ix.leg(t.legId);
		if (leg?.kind === "pair" && leg.fromItemId && leg.toItemId) {
			const from = ix.item(leg.fromItemId);
			const to = ix.item(leg.toItemId);
			const s = schedule.legs[pairKey(leg.fromItemId, leg.toItemId)];
			const fromTz = schedule.items[leg.fromItemId]?.tz;
			const toTz = schedule.items[leg.toItemId]?.tz ?? fromTz;
			const a = from ? itemName(ix, from.id) : "?";
			const b = to ? itemName(ix, to.id) : "?";
			const when =
				s && fromTz && toTz
					? `${a} ${hhmm(s.start, fromTz)} → ${b} ${hhmm(s.end, toTz)}`
					: `${a} → ${b}`;
			const d = ix.legDetails(leg);
			const extra =
				d.kind === "transit"
					? seatsLabel(d.booking?.seats ?? [], d.booking?.car)
					: d.kind === "flight"
						? seatsLabel(d.flight.seats ?? [])
						: null;
			const mode =
				d.kind === "flight"
					? "the flight"
					: leg.mode === "transit"
						? "the train"
						: null;
			const name = legLabel(ix, leg.id).replace(/^[^·]*· /, "");
			return {
				kind: "leg",
				target: t,
				name,
				when,
				dayId: from?.dayId ?? null,
				extra,
				anchor: mode ?? name,
				anchorIds: [leg.fromItemId, leg.toItemId],
			};
		}
		return null;
	}
	const itemId = e.row.dueRule?.itemId ?? firstVisit(ix, t);
	return itemId ? itemFor(ix, schedule, itemId) : null;
}

/** What a window following `rule` moves with: the booking's own stop or leg, else the rule's stop. */
export function movesWith(
	ix: GraphIndex,
	f: BookingFor | null,
	rule: DueRule,
): string {
	return f?.anchorIds.includes(rule.itemId)
		? f.anchor
		: itemName(ix, rule.itemId);
}

/** "Day 6 · Thu 7 Oct" pieces: ["Thu 7 Oct", "Day 6"]. */
export function dayBits(ix: GraphIndex, dayId: string | null): string[] {
	const d = dayId ? ix.day(dayId) : undefined;
	return d && dayId ? [shortDate(d.date), `Day ${ix.dayNumber(dayId)}`] : [];
}

/** The expense category a booking most likely is (a stay, a leg, else an activity). */
export function bookingCategory(
	ix: GraphIndex,
	f: BookingFor | null,
): ExpenseCategory {
	if (f?.kind === "leg") return "transport";
	const nodeId =
		f?.target.kind === "item" ? ix.item(f.target.itemId)?.nodeId : null;
	return ix.node(nodeId)?.category === "lodging" ? "lodging" : "activities";
}

/** A stop or a travel leg a booking can be for (the For picker). */
export type ForOption = {
	target: BundleTarget;
	/** "Shibuya Sky", "Leg · Fuji Excursion 7", "Flight · KE 724 KIX → ICN". */
	label: string;
	/** A stop's place (its glyph). */
	nodeId: string | null;
	/** A leg's mode (its glyph). */
	mode: LegMode | null;
};

/**
 * What a booking can be for, day by day: each stop, and after it the travel
 * it leaves on (a flight, or a train, bus or ferry someone has set; never a
 * walk, unless it is the booking's own leg).
 */
export function forOptions(
	ix: GraphIndex,
	current?: BundleTarget,
): { dayId: string; options: ForOption[] }[] {
	const mine = current?.kind === "leg" ? current.legId : null;
	const legFrom = new Map<string, GraphLeg>();
	for (const p of ix.pairs) {
		const leg = ix.legByPair.get(p.key);
		if (!leg) continue;
		const travel =
			leg.mode === "flight" ||
			(!!leg.mode && leg.mode !== "walk" && ix.isSignificant(leg));
		if (travel || leg.id === mine) legFrom.set(p.fromItemId, leg);
	}
	return ix.days.flatMap((d) => {
		const options: ForOption[] = [];
		for (const it of ix.itemsByDay.get(d.id) ?? []) {
			options.push({
				target: { kind: "item", itemId: it.id },
				label: itemName(ix, it.id),
				nodeId: it.nodeId,
				mode: null,
			});
			const leg = legFrom.get(it.id);
			if (leg)
				options.push({
					target: { kind: "leg", legId: leg.id },
					label: legLabel(ix, leg.id),
					nodeId: null,
					mode: leg.mode,
				});
		}
		return options.length ? [{ dayId: d.id, options }] : [];
	});
}
