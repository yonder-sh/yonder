/**
 * Today (One Yonder phase 5, flow 10 "Today, on the road"): the day as it is
 * lived, not as planned. It follows your pace, not the clock. Pure: the graph
 * index, the schedule, a day and "now" in; plain data out.
 *
 * - Done stops end when they were marked Done. A stop that isn't Done keeps
 *   you there until now, even past its planned end (you're still there).
 * - A custom stop with no place and no start time ("Dinner") floats: it
 *   keeps its time in the flow, but it's never Now; it's Next "whenever you
 *   like" until it's Done.
 * - The rest re-times from there: each stop starts at the previous one's
 *   actual end plus the schedule's travel between them (never re-routed).
 *   Flexible stops flow as soon as possible; fixed ones hold their time: a
 *   start time, or the arrival of a timed departure (a flight, a train).
 * - Pace: the next stop's re-timed arrival against the plan's (the next one
 *   with a place or a time: a floating stop has none to keep).
 * - Risks: a fixed stop or departure the flow reaches late, or with little
 *   room left (within `PACE_MIN` of the plan's own is on time), with up to
 *   two fixes: shorten the longest flexible stop before it, skip the nearest
 *   place.
 * - Free time: room before the next fixed stop, less the stops with a place
 *   before it (a floating stop's time is part of it), when that stop isn't
 *   at risk; and the ideas nearby that fit it (open then, a short walk away,
 *   the group's favourites first).
 *
 * `todayDayId` picks the day being lived; `computeToday` builds the view;
 * `stopHere` is "Looks like you're at Bic Camera?".
 */
import { groupScore } from "@/features/places/tab/score";
import type { Holiday } from "@/lib/schemas/trips";
import { haversineKm, type LngLat } from "./geo";
import { type GraphIndex, pairKey, stayKey } from "./graph-index";
import {
	checkVisit,
	effectiveHours,
	fromMinutes,
	holidayFinder,
	hoursApply,
	hoursOnDate,
	toMinutes,
} from "./hours";
import { timedLegName } from "./schedule";
import { suggestBetween, walkEstimateMin } from "./suggest";
import { addDays, hhmm, localDateOf, MS_PER_MINUTE, zonedEpoch } from "./time";
import type {
	GraphItem,
	GraphNode,
	LegMode,
	ScheduledLeg,
	ScheduleResult,
} from "./types";

/** Pace within this many minutes of the plan is "on time". */
export const PACE_MIN = 5;
/** Less room than this before a fixed stop is a risk (when the plan had more). */
export const TIGHT_MIN = 15;
/** Room before a fixed stop that counts as free time. */
export const FREE_MIN = 30;
/** Ideas at most this many minutes' walk away. */
export const IDEA_WALK_MIN = 15;
/** A shortened stop keeps at least this long. */
export const SHORTEN_FLOOR_MIN = 30;
/** A fix aims to give back this much room (the plan's own, when smaller). */
const COMFORT_MIN = 30;
/** "Looks like you're at …" within this distance of a stop. */
export const HERE_RADIUS_M = 150;
/** Closing at or after this (minutes after midnight) is "open till late". */
const LATE_CLOSE_MIN = 23 * 60;

export type TodayPace =
	| { kind: "on_time"; minutes: 0 }
	/** "35 min behind" / "30 min ahead". */
	| { kind: "behind" | "ahead"; minutes: number };

/** A timed departure (a flight, a train with fixed times) into a stop. */
export interface TodayDeparture {
	legId: string;
	/** "NH 9", "Nozomi 7" (the schedule's `timedLegName`). */
	name: string;
	/** Be there by this: the departure, minus the platform time of a train. */
	readyBy: number;
	/** The departure itself. */
	depMs: number;
	flight: boolean;
	/** The zone you board in (its times read there, not at the other end). */
	tz: string;
}

/** One stop of today. Times are epoch ms. */
export interface TodayStop {
	itemId: string;
	/** Its place; null for a stop without one ("Dinner"). */
	nodeId: string | null;
	name: string;
	/** The stop's zone (format times in it). */
	tz: string;
	/** Re-timed from now. Done stops end at `doneAt`. */
	start: number;
	end: number;
	/** As planned (the schedule). */
	plannedStart: number;
	plannedEnd: number;
	/** When the re-timed flow gets you there: after `start` only for a fixed stop reached late. */
	arrive: number;
	/** Leave the stop before by this: "Leave by 09:20" (`start` minus the travel). */
	leaveBy: number;
	/** Travel into it from the stop before (the schedule's minutes, 0 when none), and how. */
	travelMin: number;
	mode: LegMode | null;
	/** Holds its time: a set start time, or the arrival of a timed departure. */
	fixed: boolean;
	/** No place and no start time ("Dinner"): Next whenever you like, never Now. */
	floating: boolean;
	/** "Booked for this date". */
	booked: boolean;
	/** The timed departure that takes you there, if it leaves today (an overnight one only holds the time). */
	departure: TodayDeparture | null;
	/** When it was marked Done (a stamp outside the day reads as now) and by whom (a user id). */
	doneAt: number | null;
	doneBy: string | null;
}

export type TodayFix =
	/** "Shorten dinner to 1 h": set the stop's duration to `toMin`. */
	| {
			kind: "shorten";
			itemId: string;
			name: string;
			toMin: number;
			/** Minutes it gives back. */
			recoverMin: number;
	  }
	/** "Skip Bic Camera": take the stop off today into Ideas. */
	| { kind: "skip"; itemId: string; name: string; recoverMin: number };

/** "Tight before Bar Benfiddich · 20:00, booked — You'd arrive 19:55: 5 min spare instead of 40." */
export interface TodayRisk {
	/** The stop that holds its time; for a departure, the stop it takes you to. */
	itemId: string;
	/** Set when it's a departure (be there by `at`). */
	departure: TodayDeparture | null;
	/** "Bar Benfiddich", or the departure's "NH 9". */
	name: string;
	/** The fixed time: the stop's start, or a departure's be-there-by. */
	at: number;
	tz: string;
	booked: boolean;
	/** When the re-timed flow gets you there. */
	arrive: number;
	/** `at − arrive` in minutes (negative: late), now and as planned. */
	spareMin: number;
	plannedSpareMin: number;
	late: boolean;
	/** Up to two: a shorten, then a skip. */
	fixes: TodayFix[];
}

/** "Leave for Bar Benfiddich by 19:50 (booked for 20:00, 10 min walk)": the next fixed stop or departure. */
export interface TodayLeave {
	/** When you must leave for the fixed stop. */
	before: number;
	/** The fixed stop (for a departure, the stop it takes you to). */
	itemId: string;
	name: string;
	/** Its fixed time (a departure: be there by). */
	at: number;
	tz: string;
	booked: boolean;
	travelMin: number;
	mode: LegMode | null;
	departure: TodayDeparture | null;
}

/** "2 h 40 free before 19:50": a floating stop's time is part of it. */
export interface TodayFree extends TodayLeave {
	minutes: number;
	/** When it starts (the stops with a place before are over). */
	from: number;
}

/** An idea that fits the free time: "Omoide Yokocho · 6 min walk · open till late". */
export interface TodayIdea {
	nodeId: string;
	/** Its stop waiting in Ideas, if there is one (a move puts it back on the day). */
	itemId: string | null;
	name: string;
	walkMin: number;
	/** The group score (`groupScore`). */
	score: number;
	/** "open 24 h", "open till late", "open till 17:00"; null when the hours aren't known. */
	hours: string | null;
}

/** Where you sleep tonight, with directions. */
export interface TodayNight {
	nodeId: string;
	name: string;
	coord: LngLat | null;
	/** From the day's last stop (the schedule's evening travel), when it applies, and how. */
	travelMin: number | null;
	mode: LegMode | null;
}

/** The first stop of the next day with stops (when today is over). */
export interface TodayNextDay {
	dayId: string;
	date: string;
	itemId: string;
	name: string;
	tz: string;
	start: number;
	leaveBy: number;
}

export interface TodayView {
	dayId: string;
	/** The day's date and zone. */
	date: string;
	tz: string;
	now: number;
	/** Marked Done, in plan order. */
	done: TodayStop[];
	/** Not Done, but a later stop is: passed over, out of the flow. */
	passed: TodayStop[];
	/** Now: the first stop not Done that has started and you've reached ("Now · since 14:40": its `start`, or `arrive` when later); never a floating one. */
	current: TodayStop | null;
	/** Next: the stop after it (before anything started, or with a floating stop first: that stop). */
	next: TodayStop | null;
	/** "Rest of today", after `next`. */
	rest: TodayStop[];
	/** Nothing started or Done yet: `next` is the day's first stop ("Leave by …"). */
	starting: boolean;
	/** Nothing left today: see `tomorrow`. */
	ended: boolean;
	pace: TodayPace;
	risks: TodayRisk[];
	/** The next fixed stop or departure after Now, and when to leave for it. */
	leave: TodayLeave | null;
	/** Room before it (at least `FREE_MIN`), else null. */
	free: TodayFree | null;
	/** Up to three ideas for the free time (empty without it). */
	ideas: TodayIdea[];
	tonight: TodayNight | null;
	/** Only when `ended`. */
	tomorrow: TodayNextDay | null;
}

export interface TodayOptions {
	/** The counted raters' member ids for the group score (every rating when omitted). */
	raterIds?: readonly string[];
	/** Where you are ("Use my location", on the device only): ideas are near it. */
	here?: LngLat | null;
	/** Public holidays for opening hours (`trip.settings.holidays`). */
	holidays?: readonly Holiday[];
}

const round = (ms: number) => Math.round(ms / MS_PER_MINUTE);

/** "Itoya Ginza", "Lunch" (the stop's title, else its place's name). */
function nameOf(ix: GraphIndex, it: GraphItem): string {
	return it.title ?? ix.node(it.nodeId)?.name ?? "Untitled";
}

type Travel = {
	minutes: number;
	mode: LegMode | null;
	/** A timed departure into the stop that leaves on this day (from `since`). */
	departure: TodayDeparture | null;
	/** Reached by a timed departure, even one that left the day before: it holds its time. */
	held: boolean;
};

/**
 * The travel the schedule placed right before a stop: the morning's from the
 * stay, the pair leg in. A departure before `since` (an overnight flight
 * that left yesterday) still holds the stop's time, but there's nothing to
 * leave for today.
 */
function travelInto(
	ix: GraphIndex,
	schedule: ScheduleResult,
	dayId: string,
	it: GraphItem,
	since: number,
): Travel {
	const out: Travel = { minutes: 0, mode: null, departure: null, held: false };
	if (!it.nodeId) return out;
	const add = (s: ScheduledLeg | undefined, mode: LegMode | null) => {
		if (!s) return;
		out.minutes += s.minutes;
		out.mode = mode ?? s.suggestion?.mode ?? out.mode;
	};
	if (ix.firstLocated(dayId)?.id === it.id)
		add(
			schedule.legs[`stay:${stayKey(dayId, "start")}`],
			ix.legByStay.get(stayKey(dayId, "start"))?.mode ?? null,
		);
	const p = ix.prevLocated(it.id);
	if (p && p.nodeId !== it.nodeId) {
		const key = pairKey(p.id, it.id);
		const s = schedule.legs[key];
		const row = ix.legByPair.get(key);
		if (s?.timed && row?.depAt) {
			out.held = true;
			const depMs = s.flight?.depMs ?? Date.parse(row.depAt);
			if (depMs >= since)
				out.departure = {
					legId: row.id,
					name: timedLegName(ix, row),
					readyBy: s.start.getTime(),
					depMs,
					flight: !!s.flight,
					tz: schedule.items[p.id]?.tz ?? ix.defaultTz,
				};
		} else if (s && s.kind !== "overnight") add(s, row?.mode ?? null);
	}
	return out;
}

/** The trip day being lived at `now`: its date there, or the day before while that plan runs past midnight. */
export function todayDayId(
	ix: GraphIndex,
	schedule: ScheduleResult,
	now: number,
): string | null {
	const day = ix.days.find(
		(d) => localDateOf(now, schedule.days[d.id]?.tz ?? ix.defaultTz) === d.date,
	);
	if (!day) return null;
	const prev = ix.prevDay(day.id);
	const prevEnd = prev ? schedule.days[prev.id]?.end.getTime() : undefined;
	return prev && prevEnd !== undefined && now < prevEnd ? prev.id : day.id;
}

/** A pending stop while re-timing, with what the risks and fixes need. */
interface Row {
	stop: TodayStop;
	index: number;
	item: GraphItem;
	/** Reaching the stop, or the departure before it: the flow's time and the plan's. */
	flowArrive: number;
	plannedArrive: number;
	/** The fixed time to reach (a start time, or a departure's be-there-by); null when flexible. */
	target: number | null;
}

/** "open 24 h", "open till late", "open till 17:00" at a local time, or null. */
function openHint(
	node: GraphNode,
	ix: GraphIndex,
	holidays: readonly Holiday[],
	date: string,
	startMin: number,
): string | null {
	const eh = effectiveHours(node, ix.trip.settings);
	if (!eh || eh.confidence === "low") return null;
	const holidayOf = holidayFinder(ix, holidays, node.id);
	const today = hoursOnDate(eh.hours, date, holidayOf(date));
	if (today.state === "always") return "open 24 h";
	const prevDate = addDays(date, -1);
	const prev = hoursOnDate(eh.hours, prevDate, holidayOf(prevDate));
	const periods = [
		...(prev.state === "open"
			? prev.periods
					.filter((p) => p.close > 1440)
					.map((p) => ({ open: 0, close: p.close - 1440 }))
			: []),
		...(today.state === "open" ? today.periods : []),
	];
	const covering = periods
		.filter((p) => p.open <= startMin && startMin < p.close)
		.sort((a, b) => b.close - a.close)[0];
	if (!covering) return null;
	if (covering.close >= LATE_CLOSE_MIN) return "open till late";
	return `open till ${fromMinutes(covering.close)}`;
}

/** Open for a short visit at `at` (unknown hours count as open). */
function openAt(
	node: GraphNode,
	ix: GraphIndex,
	holidays: readonly Holiday[],
	at: number,
	stayMin: number,
): boolean {
	const eh = effectiveHours(node, ix.trip.settings);
	if (!eh) return true;
	const tz = ix.tzOf(node.id);
	const startMin = toMinutes(hhmm(at, tz));
	const issues = checkVisit({
		eh,
		date: localDateOf(at, tz),
		startMin,
		endMin: startMin + stayMin,
		holidayOf: holidayFinder(ix, holidays, node.id),
	});
	return !issues.some((i) => i.severity === "warn" || i.kind === "before_open");
}

/** The city (else region) a node is in, for "ideas in today's city". */
function cityOf(ix: GraphIndex, nodeId: string | null): string | null {
	if (!nodeId) return null;
	const up = [...ix.path(nodeId)].reverse();
	return (
		(up.find((n) => n.type === "city") ?? up.find((n) => n.type === "region"))
			?.id ?? null
	);
}

/** Ideas within `IDEA_WALK_MIN` of `point`, open at `at`: best group score first, then nearest; at most 3. */
function ideasNear(
	ix: GraphIndex,
	point: LngLat,
	scopeId: string | null,
	at: number,
	freeMin: number,
	onToday: ReadonlySet<string>,
	opts: TodayOptions,
): TodayIdea[] {
	const holidays = opts.holidays ?? ix.trip.settings.holidays ?? [];
	const waiting = new Map<string, string>();
	for (const it of ix.unscheduled)
		if (it.nodeId && !waiting.has(it.nodeId)) waiting.set(it.nodeId, it.id);
	const candidates = new Set<string>(waiting.keys());
	for (const n of ix.outline)
		if (n.type === "place" && !ix.scheduledNodeIds.has(n.id))
			candidates.add(n.id);
	const out: TodayIdea[] = [];
	for (const id of candidates) {
		const n = ix.node(id);
		if (n?.type !== "place" || n.status !== "active" || ix.isDropped(id))
			continue;
		if (onToday.has(id) || !hoursApply(n)) continue;
		if (scopeId && !ix.isWithin(id, scopeId)) continue;
		const c = ix.coordOf(id);
		if (!c) continue;
		const walkMin = Math.max(
			1,
			walkEstimateMin(haversineKm(point, c), ix.settings.walkSpeedKmh),
		);
		if (walkMin > IDEA_WALK_MIN) continue;
		const arrive = at + walkMin * MS_PER_MINUTE;
		const stay = Math.max(15, Math.min(COMFORT_MIN, freeMin - 2 * walkMin));
		if (!openAt(n, ix, holidays, arrive, stay)) continue;
		const tz = ix.tzOf(id);
		out.push({
			nodeId: id,
			itemId: waiting.get(id) ?? null,
			name: n.name,
			walkMin,
			score: groupScore(n.priorities, opts.raterIds),
			hours: openHint(
				n,
				ix,
				holidays,
				localDateOf(arrive, tz),
				toMinutes(hhmm(arrive, tz)),
			),
		});
	}
	return out
		.sort(
			(a, b) =>
				b.score - a.score ||
				a.walkMin - b.walkMin ||
				a.name.localeCompare(b.name),
		)
		.slice(0, 3);
}

/**
 * The day as lived at `now` (epoch ms; `nowFor` for `?asOf=`). Stops without
 * a scheduled time are left out; `schedule` is `computeSchedule(ix)`.
 */
export function computeToday(
	ix: GraphIndex,
	schedule: ScheduleResult,
	dayId: string,
	now: number,
	opts: TodayOptions = {},
): TodayView {
	const day = ix.day(dayId);
	const sd = schedule.days[dayId];
	const tz = sd?.tz ?? ix.defaultTz;
	const list = (ix.itemsByDay.get(dayId) ?? []).filter(
		(it) => schedule.items[it.id],
	);
	const midnight = day ? zonedEpoch(day.date, "00:00", tz) : now;

	// A stamp outside the day (a demo's `asOf`, a clock a little off) reads as now.
	const doneMs = (it: GraphItem): number | null => {
		const raw = it.doneAt ? Date.parse(it.doneAt) : Number.NaN;
		if (!Number.isFinite(raw)) return null;
		return raw < midnight ? now : Math.min(raw, now);
	};
	let lastDone = -1;
	list.forEach((it, i) => {
		if (doneMs(it) !== null) lastDone = i;
	});

	const done: TodayStop[] = [];
	const passed: TodayStop[] = [];
	const rows: Row[] = [];
	/** The actual end of the stop before, in the flow (null before the first). */
	let cursor: number | null = null;
	for (const [i, it] of list.entries()) {
		const s = schedule.items[it.id];
		if (!s) continue;
		const t = travelInto(ix, schedule, dayId, it, midnight);
		const plannedStart = s.start.getTime();
		const plannedEnd = s.end.getTime();
		const fixed = s.pinned || t.held;
		const floating = !it.nodeId && !fixed;
		// The plan's own arrival: before a start time's free room, after a late one.
		const plannedArriveHere =
			plannedStart -
			s.freeBeforeMin * MS_PER_MINUTE +
			(s.late?.minutes ?? 0) * MS_PER_MINUTE;
		const plannedBefore =
			i > 0
				? (schedule.items[list[i - 1]?.id ?? ""]?.end.getTime() ?? null)
				: null;
		const base = {
			itemId: it.id,
			nodeId: it.nodeId,
			name: nameOf(ix, it),
			tz: s.tz,
			plannedStart,
			plannedEnd,
			travelMin: t.minutes,
			mode: t.mode,
			fixed,
			floating,
			booked: it.fixedDate === true,
			departure: t.departure,
		};
		const at = doneMs(it);
		if (at !== null) {
			const flow =
				cursor === null ? plannedStart : cursor + t.minutes * MS_PER_MINUTE;
			const start = Math.min(fixed ? plannedStart : flow, at);
			done.push({
				...base,
				start,
				end: at,
				arrive: start,
				leaveBy: start - t.minutes * MS_PER_MINUTE,
				doneAt: at,
				doneBy: it.doneBy ?? null,
			});
			cursor = at;
			continue;
		}
		if (i < lastDone) {
			passed.push({
				...base,
				start: plannedStart,
				end: plannedEnd,
				arrive: plannedStart,
				leaveBy: plannedStart - t.minutes * MS_PER_MINUTE,
				doneAt: null,
				doneBy: null,
			});
			continue;
		}
		// A departure is reached when the stop before it ends; the train or flight brings you here.
		const flowArrive: number = t.departure
			? (cursor ?? plannedBefore ?? t.departure.readyBy)
			: cursor === null
				? plannedArriveHere
				: cursor + t.minutes * MS_PER_MINUTE;
		const plannedArrive = t.departure
			? (plannedBefore ?? t.departure.readyBy)
			: plannedArriveHere;
		const arrive: number = t.held ? plannedStart : flowArrive;
		const start = fixed ? plannedStart : arrive;
		let end: number = fixed
			? Math.max(plannedEnd, arrive)
			: start + (plannedEnd - plannedStart);
		// Not Done yet: you're still there.
		if (start <= now && end < now) end = now;
		cursor = end;
		rows.push({
			stop: {
				...base,
				start,
				end,
				arrive,
				leaveBy: t.departure
					? t.departure.readyBy
					: start - t.minutes * MS_PER_MINUTE,
				doneAt: null,
				doneBy: null,
			},
			index: i,
			item: it,
			flowArrive,
			plannedArrive,
			target: t.departure
				? t.departure.readyBy
				: s.pinned
					? plannedStart
					: null,
		});
	}

	// Started, and you're there: a booking you're still walking to is Next (and
	// late), not Now; a floating stop is Next whenever its time comes.
	const reachedAt = rows.findIndex(
		(r) => Math.max(r.stop.start, r.stop.arrive) <= now,
	);
	const currentAt = rows[reachedAt]?.stop.floating ? -1 : reachedAt;
	const current = currentAt >= 0 ? rows[currentAt] : undefined;
	const nextRow = rows[currentAt + 1];

	// ---- pace --------------------------------------------------------------
	const paced = rows.slice(currentAt + 1).find((r) => !r.stop.floating);
	const drift = paced ? round(paced.flowArrive - paced.plannedArrive) : 0;
	const pace: TodayPace =
		drift >= PACE_MIN
			? { kind: "behind", minutes: drift }
			: drift <= -PACE_MIN
				? { kind: "ahead", minutes: -drift }
				: { kind: "on_time", minutes: 0 };

	// ---- fixed targets ahead: stops, departures, and a departure tonight ----
	type Target = {
		row: Row | null;
		/** Rows before it that can give room back (the flow into it). */
		before: Row[];
		itemId: string;
		name: string;
		at: number;
		tz: string;
		booked: boolean;
		arrive: number;
		plannedArrive: number;
		travelMin: number;
		mode: LegMode | null;
		departure: TodayDeparture | null;
	};
	const targets: Target[] = [];
	let segment: Row[] = [];
	for (const [k, r] of rows.entries()) {
		// Every fixed one after where you are, even one whose time has come (you're late).
		if (r.target !== null && k > currentAt)
			targets.push({
				row: r,
				before: segment,
				itemId: r.stop.itemId,
				name: r.stop.departure?.name ?? r.stop.name,
				at: r.target,
				tz: r.stop.departure?.tz ?? r.stop.tz,
				booked: r.stop.booked,
				arrive: r.flowArrive,
				plannedArrive: r.plannedArrive,
				travelMin: r.stop.departure ? 0 : r.stop.travelMin,
				mode: r.stop.departure ? null : r.stop.mode,
				departure: r.stop.departure,
			});
		// A fixed stop holds its end: what comes before it can't change what comes after.
		segment = r.stop.fixed ? [] : [...segment, r];
	}
	const last = ix.lastLocated(dayId);
	const onward = last ? ix.nextLocated(last.id) : null;
	if (last && onward && onward.dayId !== dayId) {
		const key = pairKey(last.id, onward.id);
		const s = schedule.legs[key];
		const row = ix.legByPair.get(key);
		const lastPlanned = list.at(-1);
		// Ahead, or passed while stops are still to do (you're late for it).
		if (
			s?.timed &&
			row?.depAt &&
			lastPlanned &&
			localDateOf(s.start, tz) === day?.date &&
			(s.start.getTime() > now || rows.length > 0)
		) {
			const departure: TodayDeparture = {
				legId: row.id,
				name: timedLegName(ix, row),
				readyBy: s.start.getTime(),
				depMs: s.flight?.depMs ?? Date.parse(row.depAt),
				flight: !!s.flight,
				tz: schedule.items[last.id]?.tz ?? tz,
			};
			targets.push({
				row: null,
				before: segment,
				itemId: onward.id,
				name: departure.name,
				at: departure.readyBy,
				tz: departure.tz,
				booked: onward.fixedDate === true,
				arrive: cursor ?? departure.readyBy,
				plannedArrive:
					schedule.items[lastPlanned.id]?.end.getTime() ?? departure.readyBy,
				travelMin: 0,
				mode: null,
				departure,
			});
		}
	}

	// ---- risks and their fixes -----------------------------------------------
	/**
	 * Minutes a skip gives back: the stop, and its travel in and out less the
	 * new direct hop (a straight-line estimate). Null where you board a
	 * departure, and for a stop without a place ("Dinner": shortened, never
	 * sent to Ideas, which hold places).
	 */
	const skipSaves = (r: Row, target: Target): number | null => {
		if (!r.item.nodeId) return null;
		let saved = round(r.stop.end - r.stop.start);
		const tin = r.stop.travelMin;
		const n = ix.nextLocated(r.item.id);
		const nRow = n ? rows.find((x) => x.item.id === n.id) : undefined;
		if (nRow?.stop.departure) return null;
		if (target.departure && !target.row && n?.dayId !== dayId) return null;
		const reached =
			nRow && (target.row ? nRow.index <= target.row.index : true);
		if (!n?.nodeId || !nRow || !reached) return saved + tin;
		const p = ix.prevLocated(r.item.id);
		const from =
			p && p.dayId === dayId
				? p.nodeId
				: (ix.morningStay(dayId)?.stayNodeId ?? null);
		const tout = nRow.stop.travelMin;
		const direct = from
			? (suggestBetween(ix, from, n.nodeId).estimateMin ?? tin + tout)
			: tout;
		saved += Math.max(0, tin + tout - direct);
		return saved;
	};
	const fixesFor = (target: Target, spare: number, plannedSpare: number) => {
		const need = Math.min(TIGHT_MIN, plannedSpare) - spare;
		const want = Math.max(need, Math.min(plannedSpare, COMFORT_MIN) - spare);
		// Not started, or under way (the stop you're at, a floating one in its time).
		const open = target.before.filter(
			(r) => !r.stop.booked && (r.stop.start >= now || r.stop.end > now),
		);
		const fixes: TodayFix[] = [];
		// The longest first; on a tie, the one nearer the fixed stop.
		const byLength = [...open].sort(
			(a, b) =>
				b.stop.end - b.stop.start - (a.stop.end - a.stop.start) ||
				b.index - a.index,
		);
		for (const r of byLength) {
			const dur = round(r.stop.end - r.stop.start);
			const toMin = Math.max(
				SHORTEN_FLOOR_MIN,
				Math.floor((dur - want) / 15) * 15,
			);
			if (toMin >= dur) continue;
			const newEnd = Math.max(now, r.stop.start + toMin * MS_PER_MINUTE);
			const recoverMin = round(r.stop.end - newEnd);
			if (recoverMin >= need) {
				fixes.push({
					kind: "shorten",
					itemId: r.stop.itemId,
					name: r.stop.name,
					toMin,
					recoverMin,
				});
				break;
			}
		}
		for (const r of open) {
			if (r === current) continue;
			const recoverMin = skipSaves(r, target);
			if (recoverMin !== null && recoverMin >= need) {
				fixes.push({
					kind: "skip",
					itemId: r.stop.itemId,
					name: r.stop.name,
					recoverMin,
				});
				break;
			}
		}
		return fixes;
	};
	const risks: TodayRisk[] = [];
	const risky = new Set<Target>();
	for (const t of targets) {
		const spare = round(t.at - t.arrive);
		const plannedSpare = round(t.at - t.plannedArrive);
		// Within `PACE_MIN` of the plan's own room is on time, as the pace says.
		if (spare >= TIGHT_MIN || plannedSpare - spare < PACE_MIN) continue;
		risky.add(t);
		risks.push({
			itemId: t.itemId,
			departure: t.departure,
			name: t.name,
			at: t.at,
			tz: t.tz,
			booked: t.booked,
			arrive: t.arrive,
			spareMin: spare,
			plannedSpareMin: plannedSpare,
			late: spare < 0,
			fixes: fixesFor(t, spare, plannedSpare),
		});
	}

	// ---- the next fixed stop, free time before it, and ideas for it -----------
	let leave: TodayLeave | null = null;
	let free: TodayFree | null = null;
	let ideas: TodayIdea[] = [];
	const first = targets[0];
	if (first) {
		leave = {
			before: first.at - first.travelMin * MS_PER_MINUTE,
			itemId: first.itemId,
			name: first.name,
			at: first.at,
			tz: first.tz,
			booked: first.booked,
			travelMin: first.travelMin,
			mode: first.mode,
			departure: first.departure,
		};
		const spare = round(first.at - first.arrive);
		// A floating stop happens in the free time: what's left of it counts.
		const minutes = first.before.reduce(
			(m, r) =>
				r.stop.floating
					? m + round(r.stop.end - Math.max(r.stop.start, now))
					: m,
			spare,
		);
		if (spare >= 0 && !risky.has(first) && minutes >= FREE_MIN) {
			free = {
				...leave,
				minutes,
				from: leave.before - minutes * MS_PER_MINUTE,
			};
			// Where you'll be: here, else the last place before it.
			const prev = first.row ? list[first.row.index - 1] : list.at(-1);
			const where =
				(prev ? ix.effectiveNodeId(prev.id) : null) ??
				(first.row ? first.row.item.nodeId : null);
			const point = opts.here ?? ix.coordOf(where);
			if (point) {
				const scope = cityOf(ix, where) ?? cityOf(ix, day?.nightNodeId ?? null);
				const onToday = new Set(
					list.map((it) => it.nodeId).filter((id): id is string => !!id),
				);
				// Your own location may be outside the plan's city: the walk alone decides.
				ideas = ideasNear(
					ix,
					point,
					opts.here ? null : scope,
					Math.max(now, free.from),
					minutes,
					onToday,
					opts,
				);
			}
		}
	}

	// ---- tonight, and tomorrow once today is over -----------------------------
	const night = day?.nightNodeId ? ix.node(day.nightNodeId) : undefined;
	const evening = schedule.legs[`stay:${stayKey(dayId, "end")}`];
	const tonight: TodayNight | null = night
		? {
				nodeId: night.id,
				name: night.name,
				coord: ix.coordOf(night.id),
				travelMin: evening ? evening.minutes : null,
				mode: evening
					? (ix.legByStay.get(stayKey(dayId, "end"))?.mode ??
						evening.suggestion?.mode ??
						null)
					: null,
			}
		: null;
	const ended = !current && !nextRow;
	let tomorrow: TodayNextDay | null = null;
	if (ended && day) {
		// The next day with a timed stop, and that stop.
		const firstTimed = (id: string) =>
			(ix.itemsByDay.get(id) ?? []).find((it) => schedule.items[it.id]);
		const later = ix.days.find((d) => d.date > day.date && firstTimed(d.id));
		const it = later ? firstTimed(later.id) : undefined;
		const s = it ? schedule.items[it.id] : undefined;
		if (later && it && s) {
			const t = travelInto(
				ix,
				schedule,
				later.id,
				it,
				zonedEpoch(later.date, "00:00", schedule.days[later.id]?.tz ?? s.tz),
			);
			tomorrow = {
				dayId: later.id,
				date: later.date,
				itemId: it.id,
				name: nameOf(ix, it),
				tz: s.tz,
				start: s.start.getTime(),
				leaveBy: s.start.getTime() - t.minutes * MS_PER_MINUTE,
			};
		}
	}

	return {
		dayId,
		date: day?.date ?? localDateOf(now, tz),
		tz,
		now,
		done,
		passed,
		current: current?.stop ?? null,
		next: nextRow?.stop ?? null,
		rest: rows
			.slice((currentAt >= 0 ? currentAt + 1 : 0) + 1)
			.map((r) => r.stop),
		starting: !done.length && !passed.length && !current,
		ended,
		pace,
		risks,
		leave,
		free,
		ideas,
		tonight,
		tomorrow,
	};
}

/**
 * "Looks like you're at Bic Camera?": the next stop, or a later one today,
 * within `radiusM` of `here`. Null while you're still at the current stop.
 */
export function stopHere(
	ix: GraphIndex,
	view: Pick<TodayView, "current" | "next" | "rest">,
	here: LngLat,
	radiusM = HERE_RADIUS_M,
): TodayStop | null {
	const near = (s: TodayStop | null) => {
		const c = s?.nodeId ? ix.coordOf(s.nodeId) : null;
		return !!c && haversineKm(c, here) * 1000 <= radiusM;
	};
	if (near(view.current)) return null;
	return [view.next, ...view.rest].find((s) => near(s)) ?? null;
}
