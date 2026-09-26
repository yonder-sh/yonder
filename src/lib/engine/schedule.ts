/**
 * `computeSchedule(ix)` (SPEC §9): clock times for every scheduled item and
 * leg of the whole trip, plus per-day summaries. Day ranges and scopes only
 * filter what is shown; the schedule always covers the trip.
 *
 * The model (§9.2): each day starts at its `startTime` in the zone of its first
 * item with an effective node, and one cursor walks its items in order.
 * - A pair leg P→I (consecutive located items with different nodes) is
 *   travelled right before I. Across a night with a stay, or with nothing at
 *   all, it is a 0-minute overnight connector.
 * - Timed legs (flights, fixed transit) are anchors: you must be ready by
 *   `depAt` (fixed transit: `depAt − access`), and you continue from `arrAt`
 *   (+ egress), even before the day's start time (a 05:00 landing).
 * - Flights have no built-in airport buffers (owner, FEEDBACK-3): time at the
 *   airport is the airport stop's own duration. An unpinned departure-airport
 *   stop is placed to end at the departure, and boarding ends it.
 * - Flights without times (FB-18) are untimed pair legs of the great-circle
 *   estimate ("est."). They leave when the previous stop ends; across a night
 *   they leave at the end of the departure day and count there, like an
 *   overnight flight. With only a departure time the server stores the
 *   estimated arrival, so the leg is timed.
 * - Unset legs count their suggestion's estimate (never 0 by accident).
 * - Pinned items are anchors in their own zone. A first item pinned before the
 *   day's start time starts the day early; a later pin that early means after
 *   midnight. A pin before the cursor is late, and the plan flows on from the
 *   pinned end.
 * - Morning and evening stay legs (§7.6) run before the first and after the
 *   last located item.
 *
 * Zone arithmetic goes through `time.ts` (Temporal); nothing reads the host zone.
 */
import type { Airport, FlightDetails } from "@/lib/schemas/legs";
import { flightEstimateBetween, nodeIsAirport } from "./flights";
import { type GraphIndex, pairKey, stayKey } from "./graph-index";
import { suggestBetween, suggestPair } from "./suggest";
import {
	addDays,
	diffMinutes,
	hhmm,
	localDateOf,
	MS_PER_MINUTE,
	parseTime,
	safeTimeZone,
	tzOffsetMin,
	zonedEpoch,
} from "./time";
import type {
	GraphItem,
	GraphLeg,
	ScheduledDay,
	ScheduledItem,
	ScheduledLeg,
	ScheduleResult,
	Suggestion,
} from "./types";

/** Fixed transit: be at the platform this long before departure (zod default). */
export const DEFAULT_ACCESS_MIN = 10;
/** Layovers shorter than this are "tight" (§7.9). */
export const TIGHT_CONNECTION_MIN = {
	international: 60,
	domestic: 45,
} as const;

/** "NH9" → "NH 9" (stored without the space, shown with it). */
export function formatFlightNumber(
	value: string | null | undefined,
): string | null {
	if (!value) return null;
	const m = /^([A-Z0-9]{2})\s*(\d{1,4}[A-Z]?)$/i.exec(value.trim());
	return m ? `${(m[1] as string).toUpperCase()} ${m[2]}` : value.trim();
}

/** The name a late label uses: "NH 9", "Fuji Excursion 7", "the departure". */
export function timedLegName(ix: GraphIndex, leg: GraphLeg): string {
	const d = ix.legDetails(leg);
	if (d.kind === "flight")
		return (
			formatFlightNumber(d.flight.flightNumber) ??
			d.flight.airline?.name ??
			"the flight"
		);
	if (d.kind === "transit")
		return d.route?.label ?? d.booking?.trainNumber ?? "the departure";
	if (d.kind === "other" && d.label) return d.label;
	return leg.mode === "flight" ? "the flight" : "the departure";
}

interface TimedWindow {
	depMs: number;
	arrMs: number;
	/** depAt (− access time for fixed transit). */
	readyBy: number;
	/** arrAt (+ egress time for fixed transit). */
	doneAt: number;
	flight: boolean;
	/** Zone of the departure, for the "dep 08:30" label. */
	fromTz: string;
	/** Flights: which times are known (the others are estimated, FB-18). */
	depKnown: boolean;
	arrKnown: boolean;
}

const flightOfLeg = (
	ix: GraphIndex,
	leg: GraphLeg | null | undefined,
): FlightDetails | null => {
	if (!leg) return null;
	const d = ix.legDetails(leg);
	return d.kind === "flight" ? d.flight : null;
};

/**
 * The item stands at this airport and plans time there (a 0-minute item plans
 * none). Matched like FB-19's detection: IATA, else coordinates plus a name
 * that fits.
 */
function stopAtAirport(
	ix: GraphIndex,
	item: GraphItem | null | undefined,
	airport: Airport | undefined,
): boolean {
	if (!item?.nodeId || !airport || safeDuration(item.durationMin) <= 0)
		return false;
	return nodeIsAirport(ix.node(item.nodeId), ix.coordOf(item.nodeId), airport);
}

function timedWindow(
	ix: GraphIndex,
	leg: GraphLeg & { depAt: string; arrAt: string },
	fromItem: GraphItem,
): TimedWindow {
	const d = ix.legDetails(leg);
	const depMs = Date.parse(leg.depAt);
	const arrMs = Date.parse(leg.arrAt);
	const flight = leg.mode === "flight" || d.kind === "flight";
	let before = 0;
	let after = 0;
	let tz: string | undefined;
	let arrKnown = true;
	if (d.kind === "flight") {
		tz = d.flight.from?.tz;
		// Only a departure time (FB-18): the stored arrival is dep + estimate.
		arrKnown = !!d.flight.arrLocal;
	} else if (d.kind === "transit" && d.fixed) {
		before = d.fixed.accessMin ?? DEFAULT_ACCESS_MIN;
		after = d.fixed.egressMin ?? 0;
		tz = d.fixed.fromTz;
	}
	return {
		depMs,
		arrMs,
		readyBy: depMs - before * MS_PER_MINUTE,
		doneAt: arrMs + after * MS_PER_MINUTE,
		flight,
		fromTz: safeTimeZone(tz, ix.tzOf(fromItem.nodeId)),
		depKnown: true,
		arrKnown,
	};
}

/**
 * A flight without times (FB-18): it leaves at `readyMs` and takes the
 * great-circle estimate.
 */
function untimedFlightWindow(
	ix: GraphIndex,
	f: FlightDetails,
	fromItem: GraphItem,
	readyMs: number,
): TimedWindow {
	const arrMs = readyMs + flightEstimateBetween(f.from, f.to) * MS_PER_MINUTE;
	return {
		depMs: readyMs,
		arrMs,
		readyBy: readyMs,
		doneAt: arrMs,
		flight: true,
		fromTz: safeTimeZone(f.from?.tz, ix.tzOf(fromItem.nodeId)),
		depKnown: false,
		arrKnown: false,
	};
}

/** A flight row that has no times yet (FB-18). */
function untimedFlight(
	ix: GraphIndex,
	row: GraphLeg | null,
): FlightDetails | null {
	if (row?.mode !== "flight" || ix.isTimed(row)) return null;
	return flightOfLeg(ix, row);
}

/**
 * FB-19a: the timed flight that leaves right after this item from its own
 * airport (nothing in between), so the stop ends at the departure.
 */
function flightOutOf(ix: GraphIndex, it: GraphItem): { depMs: number } | null {
	if (!it.nodeId) return null;
	const n = ix.nextLocated(it.id);
	if (!n || n.nodeId === it.nodeId) return null;
	const between = ix.ordered[ix.orderOf(it.id) + 1];
	if (between && between.id !== n.id && between.dayId === it.dayId) return null;
	const row = ix.legByPair.get(pairKey(it.id, n.id));
	if (!ix.isTimed(row)) return null;
	const f = flightOfLeg(ix, row);
	if (!f || f.connection?.prevLegId || !stopAtAirport(ix, it, f.from))
		return null;
	return { depMs: Date.parse(row.depAt) };
}

/** The flight fields of a scheduled leg (the plan's dep/arr). */
function flightFields(w: TimedWindow): Pick<ScheduledLeg, "flight"> {
	if (!w.flight) return {};
	return {
		flight: {
			depMs: w.depMs,
			arrMs: w.arrMs,
			depKnown: w.depKnown,
			arrKnown: w.arrKnown,
		},
	};
}

/**
 * The gap in a late label: "10 min" under an hour (SPEC §9.2), else like
 * every other duration, "23h 40m" / "2h" (QA MT-R2-05: never "1420 min").
 */
export function lateGap(minutes: number): string {
	const m = Math.max(0, Math.round(minutes));
	if (m < 60) return `${m} min`;
	const h = Math.floor(m / 60);
	const r = m % 60;
	return r ? `${h}h ${r}m` : `${h}h`;
}

function lateLabel(
	ix: GraphIndex,
	leg: GraphLeg,
	w: TimedWindow,
	minutes: number,
): NonNullable<ScheduledLeg["late"]> {
	return {
		minutes,
		cause: w.flight ? "flight" : "departure",
		label: `Misses ${timedLegName(ix, leg)} (dep ${hhmm(w.depMs, w.fromTz)}) by ${lateGap(minutes)}`,
	};
}

/** Countries of a flight's endpoints, from the details, else from the items' nodes. */
function isInternational(ix: GraphIndex, leg: GraphLeg): boolean {
	const d = ix.legDetails(leg);
	if (d.kind === "flight" && d.flight.from?.country && d.flight.to?.country)
		return d.flight.from.country !== d.flight.to.country;
	const country = (itemId: string | null) => {
		const nodeId = itemId ? ix.item(itemId)?.nodeId : null;
		return nodeId
			? ix.hierarchy.nearestOfType(nodeId, "country")?.id
			: undefined;
	};
	const a = country(leg.fromItemId);
	const b = country(leg.toItemId);
	return !!a && !!b && a !== b;
}

/** A layover under 60 min (international) or 45 min (domestic) before a connecting segment (§7.9). */
function tightConnection(
	ix: GraphIndex,
	outbound: GraphLeg & { depAt: string },
): ScheduledLeg["warn"] {
	const d = ix.legDetails(outbound);
	if (d.kind !== "flight" || !d.flight.connection?.prevLegId) return undefined;
	const inbound = ix.leg(d.flight.connection.prevLegId);
	if (!ix.isTimed(inbound)) return undefined;
	const minutes = diffMinutes(
		Date.parse(inbound.arrAt),
		Date.parse(outbound.depAt),
	);
	const limit =
		isInternational(ix, inbound) || isInternational(ix, outbound)
			? TIGHT_CONNECTION_MIN.international
			: TIGHT_CONNECTION_MIN.domestic;
	return minutes < limit ? { kind: "tight_connection", minutes } : undefined;
}

interface DayAcc {
	activities: number;
	travel: number;
	free: number;
	walkM: number;
	rides: number;
	unset: number;
	conflicts: number;
}

const newAcc = (): DayAcc => ({
	activities: 0,
	travel: 0,
	free: 0,
	walkM: 0,
	rides: 0,
	unset: 0,
	conflicts: 0,
});

/** Adds a leg row's walk distance and ride count to a day. */
function countRow(ix: GraphIndex, acc: DayAcc, leg: GraphLeg | null) {
	if (!leg?.mode) return;
	if (leg.mode === "walk" && leg.distanceM != null) acc.walkM += leg.distanceM;
	if (leg.mode === "transit") {
		const d = ix.legDetails(leg);
		acc.rides += (d.kind === "transit" ? (d.route?.transfers ?? 0) : 0) + 1;
	}
}

const safeDuration = (min: number) =>
	Number.isFinite(min) && min > 0 ? Math.round(min) : 0;

/**
 * Minutes of an untimed leg: its own duration when it has a mode, else the
 * estimate. A computed time is labelled (DESIGN §1.6): an unset or durationless
 * leg, and a stored rail estimate (`source: 'estimate'`, JAPAN_TRANSIT §3) that
 * nobody edited.
 */
function untimedMinutes(
	leg: GraphLeg | null,
	s: Suggestion,
): { minutes: number; unset: boolean; estimate: boolean } {
	const est = s.estimateMin ?? 0;
	if (leg?.mode) {
		const own = leg.durationMin;
		return {
			minutes: own != null ? safeDuration(own) : est,
			unset: false,
			estimate: own == null || (leg.source === "estimate" && !leg.isEdited),
		};
	}
	return { minutes: est, unset: true, estimate: true };
}

export function computeSchedule(ix: GraphIndex): ScheduleResult {
	const items: Record<string, ScheduledItem> = {};
	const legs: Record<string, ScheduledLeg> = {};
	const days: Record<string, ScheduledDay> = {};
	/** Cross-day timed legs, flagged late at the end of their departure day. */
	const pendingLate = new Map<string, NonNullable<ScheduledLeg["late"]>>();
	/** Cross-day flights without times: when their departure day's last stop ends (FB-18). */
	const pendingDeparture = new Map<string, number>();
	let prevTz = ix.defaultTz;

	for (const day of ix.days) {
		const list = ix.itemsByDay.get(day.id) ?? [];
		const firstWithNode = list.find((it) => ix.effectiveNodeId(it.id) !== null);
		const tzD = firstWithNode
			? ix.tzOf(ix.effectiveNodeId(firstWithNode.id))
			: prevTz;
		const configuredStart =
			parseTime(day.startTime) ?? ix.settings.defaultDayStart;
		// A first item pinned before the start time starts the day early (JFK at
		// 00:00 for a 02:00 flight); only a LATER pin that early means after midnight.
		const firstPin = parseTime(list[0]?.pinnedStart);
		const startTime =
			firstPin && firstPin < configuredStart ? firstPin : configuredStart;
		const dayStart = zonedEpoch(day.date, startTime, tzD);
		const acc = newAcc();
		const first = ix.firstLocated(day.id);
		let cursor = dayStart;
		// The furthest point reached (a late pin can move the cursor back). Not
		// seeded with the day start: a day that begins with an early arrival and
		// is done before its configured start ends then, not at the start
		// (SPEC §9.2 `end: cursor`; QA TZ-05/TL-13).
		let latest = Number.NEGATIVE_INFINITY;
		let lastTz = tzD;
		let itemZoneChanged = false;

		for (const it of list) {
			const eff = ix.effectiveNodeId(it.id);
			const tzI = eff ? ix.tzOf(eff) : tzD;

			// Morning stay leg: after any leading unlocated items ("Breakfast").
			if (first && it.id === first.id) {
				const plan = ix.morningStay(day.id);
				if (plan) {
					const key = `stay:${stayKey(day.id, "start")}`;
					const row = ix.legByStay.get(stayKey(day.id, "start")) ?? null;
					const s = suggestBetween(ix, plan.fromNodeId, plan.toNodeId);
					const m = untimedMinutes(row, s);
					legs[key] = {
						start: new Date(cursor),
						end: new Date(cursor + m.minutes * MS_PER_MINUTE),
						minutes: m.minutes,
						kind: "stay",
						unset: m.unset,
						estimate: m.estimate,
						// A row without an anchor was created for content, not computed: not stale.
						...(row?.anchorItemId != null &&
						row.anchorItemId !== plan.anchorItemId
							? { stale: true }
							: {}),
						timed: false,
						crossDay: false,
						legId: row?.id ?? null,
						suggestion: s,
					};
					cursor += m.minutes * MS_PER_MINUTE;
					acc.travel += m.minutes;
					if (m.unset) acc.unset += 1;
					countRow(ix, acc, row);
				}
			}

			// The pair leg into I.
			const p = it.nodeId ? ix.prevLocated(it.id) : null;
			if (p && p.nodeId !== it.nodeId) {
				const key = pairKey(p.id, it.id);
				const row = ix.legByPair.get(key) ?? null;
				const crossDay = p.dayId !== it.dayId;
				const kind = crossDay ? ix.boundaryKind(p.id, it.id) : "same-day";
				if (kind === "stay" || kind === "overnight") {
					legs[key] = {
						start: new Date(cursor),
						end: new Date(cursor),
						minutes: 0,
						kind: "overnight",
						unset: !row?.mode,
						estimate: false,
						timed: false,
						crossDay: true,
						legId: row?.id ?? null,
					};
				} else if (ix.isTimed(row)) {
					const w = timedWindow(ix, row, p);
					let late: ScheduledLeg["late"];
					if (!crossDay && cursor > w.readyBy) {
						late = lateLabel(ix, row, w, diffMinutes(w.readyBy, cursor));
						acc.conflicts += 1;
					} else if (crossDay) {
						late = pendingLate.get(key);
					}
					const warn = tightConnection(ix, row);
					const minutes = diffMinutes(w.readyBy, w.doneAt);
					legs[key] = {
						start: new Date(w.readyBy),
						end: new Date(w.doneAt),
						minutes,
						kind: "pair",
						unset: false,
						// Only a departure time: the arrival is estimated (FB-18).
						estimate: w.flight && !w.arrKnown,
						timed: true,
						crossDay,
						legId: row.id,
						...(late ? { late } : {}),
						...(warn ? { warn } : {}),
						...flightFields(w),
					};
					// A cross-day timed leg counts on its departure day (added there).
					if (!crossDay) {
						acc.travel += minutes;
						countRow(ix, acc, row);
					}
					cursor = w.doneAt; // may be before the day's start time (a 05:00 landing): allowed
				} else if (untimedFlight(ix, row)) {
					// FB-18: a flight without times, the great-circle estimate.
					const f = untimedFlight(ix, row) as FlightDetails;
					const leaves = crossDay ? pendingDeparture.get(key) : cursor;
					const w = untimedFlightWindow(ix, f, p, leaves ?? cursor);
					const minutes = diffMinutes(w.readyBy, w.doneAt);
					legs[key] = {
						start: new Date(w.readyBy),
						end: new Date(w.doneAt),
						minutes,
						kind: "pair",
						unset: false,
						estimate: true,
						timed: false,
						crossDay,
						legId: row?.id ?? null,
						...flightFields(w),
					};
					// Across a night it counts on its departure day (added there).
					if (!crossDay) {
						acc.travel += minutes;
						countRow(ix, acc, row);
					}
					// An estimate that lands before this day's date: the day starts as planned.
					if (!crossDay || localDateOf(w.doneAt, tzI) >= day.date)
						cursor = w.doneAt;
				} else {
					const s = suggestPair(ix, p.id, it.id);
					const m = untimedMinutes(row, s);
					legs[key] = {
						start: new Date(cursor),
						end: new Date(cursor + m.minutes * MS_PER_MINUTE),
						minutes: m.minutes,
						kind: "pair",
						unset: m.unset,
						estimate: m.estimate,
						timed: false,
						crossDay,
						legId: row?.id ?? null,
						suggestion: s,
					};
					cursor += m.minutes * MS_PER_MINUTE; // a cross-day 'moded' leg departs at the day start
					acc.travel += m.minutes;
					if (m.unset) acc.unset += 1;
					countRow(ix, acc, row);
				}
				latest = Math.max(latest, cursor);
			}

			// The item itself.
			let start = cursor;
			let free = 0;
			let late: ScheduledItem["late"];
			const pin = parseTime(it.pinnedStart);
			const dur = safeDuration(it.durationMin);
			// FB-19a: the departure airport's stop before its flight.
			const boards = flightOutOf(ix, it);
			if (pin) {
				const pDate = pin < startTime ? addDays(day.date, 1) : day.date; // "00:30" on an evening day = after midnight
				const p0 = zonedEpoch(pDate, pin, tzI);
				if (p0 < cursor) {
					late = { minutes: diffMinutes(p0, cursor), cause: "pinned" };
					acc.conflicts += 1;
				} else {
					free = diffMinutes(cursor, p0);
				}
				start = p0;
			} else if (boards) {
				// Unpinned: placed to end at the departure, the free time before it.
				const at = boards.depMs - dur * MS_PER_MINUTE;
				if (at > cursor) {
					free = diffMinutes(cursor, at);
					start = at;
				}
			}
			let end = start + dur * MS_PER_MINUTE;
			// Boarding ends the airport stop: it never runs past the departure.
			if (boards && end > boards.depMs) end = Math.max(start, boards.depMs);
			cursor = end; // flows on from the pinned end, even when the pin was late
			latest = Math.max(latest, end);
			items[it.id] = {
				start: new Date(start),
				end: new Date(end),
				tz: tzI,
				startsNextDay: localDateOf(start, tzI) > day.date,
				endsNextDay: localDateOf(end, tzI) > day.date,
				pinned: pin !== null,
				freeBeforeMin: free,
				...(late ? { late } : {}),
			};
			acc.activities += boards ? diffMinutes(start, end) : dur;
			acc.free += free;
			if (tzOffsetMin(tzI, start) !== tzOffsetMin(tzD, start))
				itemZoneChanged = true;
			lastTz = tzI;
		}

		// Evening stay leg: after any trailing unlocated items.
		const evening = ix.eveningStay(day.id);
		if (evening) {
			const key = `stay:${stayKey(day.id, "end")}`;
			const row = ix.legByStay.get(stayKey(day.id, "end")) ?? null;
			const s = suggestBetween(ix, evening.fromNodeId, evening.toNodeId);
			const m = untimedMinutes(row, s);
			legs[key] = {
				start: new Date(cursor),
				end: new Date(cursor + m.minutes * MS_PER_MINUTE),
				minutes: m.minutes,
				kind: "stay",
				unset: m.unset,
				estimate: m.estimate,
				...(row?.anchorItemId != null &&
				row.anchorItemId !== evening.anchorItemId
					? { stale: true }
					: {}),
				timed: false,
				crossDay: false,
				legId: row?.id ?? null,
				suggestion: s,
			};
			cursor += m.minutes * MS_PER_MINUTE;
			latest = Math.max(latest, cursor);
			acc.travel += m.minutes;
			if (m.unset) acc.unset += 1;
			countRow(ix, acc, row);
		}

		// A timed leg that departs on this day but lands on a later one (overnight flight, night train).
		const last = ix.lastLocated(day.id);
		const next = last ? ix.nextLocated(last.id) : null;
		if (last && next && next.dayId !== day.id && next.nodeId !== last.nodeId) {
			const row = ix.legByPair.get(pairKey(last.id, next.id)) ?? null;
			const untimed = untimedFlight(ix, row);
			if (untimed && row) {
				// FB-18: an untimed overnight flight leaves when this day's stops
				// end and counts here, like a timed one.
				pendingDeparture.set(pairKey(last.id, next.id), cursor);
				const w = untimedFlightWindow(ix, untimed, last, cursor);
				acc.travel += diffMinutes(w.readyBy, w.doneAt);
				countRow(ix, acc, row);
			} else if (ix.isTimed(row)) {
				const w = timedWindow(ix, row, last);
				acc.travel += diffMinutes(w.readyBy, w.doneAt);
				countRow(ix, acc, row);
				const departsToday = localDateOf(w.depMs, w.fromTz) === day.date;
				if (departsToday && cursor > w.readyBy) {
					pendingLate.set(
						pairKey(last.id, next.id),
						lateLabel(ix, row, w, diffMinutes(w.readyBy, cursor)),
					);
					acc.conflicts += 1;
				}
				// The day ends when the train or flight leaves ("ends 21:35" for
				// SP3), never at a "Board SP3" item that finished hours earlier
				// (QA TZ-02/05/06 day summary).
				if (departsToday) latest = Math.max(latest, w.depMs);
			}
		}

		const capacityMin = ix.settings.dayCapacityMin;
		const morning = ix.prevDay(day.id)?.nightNodeId ?? null;
		days[day.id] = {
			start: new Date(dayStart),
			end: new Date(Math.max(cursor, latest)),
			tz: tzD,
			tzChanged:
				tzOffsetMin(tzD, dayStart) !== tzOffsetMin(prevTz, dayStart) ||
				itemZoneChanged,
			activitiesMin: acc.activities,
			travelMin: acc.travel,
			freeMin: acc.free,
			capacityMin,
			// The day is the waking day: stops and the travel between them (owner, 2026-09-25).
			overCapacityMin: Math.max(0, acc.activities + acc.travel - capacityMin),
			walkKm: acc.walkM / 1000,
			rides: acc.rides,
			unsetLegs: acc.unset,
			conflicts: acc.conflicts,
			stay: {
				morning: morning && ix.node(morning) ? morning : null,
				night:
					day.nightNodeId && ix.node(day.nightNodeId) ? day.nightNodeId : null,
			},
		};
		prevTz = list.length ? lastTz : tzD;
	}
	return { items, legs, days };
}
