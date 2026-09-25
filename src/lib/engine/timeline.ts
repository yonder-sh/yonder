/**
 * Generic timeline time computation: local start/end for every item and
 * depart/arrive for every leg, each in its own IANA zone, with pins, gaps,
 * conflicts, scheduled (fixed-time) legs, overnight legs, midnight overflow and
 * DST ambiguity reporting.
 *
 * Ported unchanged in behaviour from `spikes/core/src/timeline.ts` (including
 * the verifier's fixes: an unscheduled leg between two days departs at the next
 * day's planned start, the wait before an overnight leg counts as idle time on
 * its departure day, and the `before-day-date` warning). It works on its own
 * input shape (days → items, legs between consecutive items) and is independent
 * of the trip graph.
 *
 * The app's Plan uses `computeSchedule` (`schedule.ts`, SPEC §9), which applies
 * the graph rules this module does not know: legs only between located items,
 * stays, flight connections, and unset-leg estimates.
 */
import type { LegMode } from "@/lib/schemas/enums";
import {
	addMinutes,
	diffMinutes,
	endOfLocalDate,
	localDateOf,
	nextWallOccurrence,
	normalizeTimeZone,
	parseDate,
	parseTime,
	parseWallTime,
	toZonedTime,
	type WallResolution,
	wallToEpoch,
	type ZonedTime,
} from "./time";

// ---------------------------------------------------------------------------
// Input
// ---------------------------------------------------------------------------

/** The leg modes (`legs.mode`). */
export type TransitMode = LegMode;
export const TRANSIT_MODES: readonly TransitMode[] = [
	"walk",
	"transit",
	"flight",
	"other",
];

export interface TimelineItemInput {
	id: string;
	nodeId?: string | null;
	title: string;
	durationMin: number;
	/**
	 * Local wall time in the item's zone: "HH:mm" (on the day's date) or
	 * "YYYY-MM-DDTHH:mm" (e.g. a 01:00 bar slot on the next date).
	 */
	pinnedStart?: string | null;
	/** Explicit zone override. Normally derived from the node (or its ancestors). */
	timezone?: string | null;
}

export interface TimelineDayInput {
	id: string;
	/** "YYYY-MM-DD", the local date the day is planned for. */
	date: string;
	/** "HH:mm". When absent, 09:00 (options.defaultStartTime) is used unless an incoming scheduled overnight leg anchors the day. */
	startTime?: string | null;
	/** Zone the day starts in. Normally derived from the first item / carried from the previous day. */
	timezone?: string | null;
	/** Ordered. */
	items: TimelineItemInput[];
}

export interface LegEndpointTime {
	/**
	 * Local wall time. Departure: "HH:mm" is on the from-item's day date.
	 * Arrival: "HH:mm" is the first occurrence at/after departure (airline "+1" semantics).
	 * Either may be a full "YYYY-MM-DDTHH:mm".
	 */
	at: string;
	/** IANA zone of this endpoint. Default: the adjacent item's zone. */
	timezone?: string | null;
}

export interface TransitLegInput {
	id: string;
	/** Must be immediately followed by `toItemId` in the flattened (day, item) order. May cross days. */
	fromItemId: string;
	toItemId: string;
	mode: TransitMode;
	/** Required unless both departure and arrival are given. */
	durationMin?: number | null;
	/** Fixed departure (flights, trains). Makes the leg "scheduled". */
	departure?: LegEndpointTime | null;
	/** Fixed arrival; only honored together with `departure`. */
	arrival?: LegEndpointTime | null;
	label?: string | null;
}

export interface TimelineInput {
	/** Ordered chronologically. */
	days: TimelineDayInput[];
	legs?: TransitLegInput[];
}

/** Anything that can map a node id to its IANA zone (a `Hierarchy` qualifies). */
export interface TimezoneResolver {
	resolveTimezone(nodeId: string): string | undefined;
	has?(nodeId: string): boolean;
}

export interface TimelineOptions {
	/** Default "09:00". */
	defaultStartTime?: string;
	/** Used when no zone can be derived at all. Default "UTC" (with an "unknown-timezone" warning). */
	defaultTimezone?: string;
	/**
	 * Where idle time goes when an unscheduled leg leads into a pinned item.
	 * "after-leg" (default): leave as soon as the previous item ends, wait at the destination.
	 * "before-leg": linger, then leave just in time to arrive at the pinned start.
	 */
	slack?: "after-leg" | "before-leg";
	/** Allowed |durationMin - (arrival - departure)| on scheduled legs before warning. Default 5. */
	durationToleranceMin?: number;
}

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

export type IssueSeverity = "conflict" | "warning" | "info";

export type TimelineIssueCode =
	/** Pinned item starts before the previous item/leg has finished. */
	| "overlap"
	/** Scheduled leg departs before the previous item has finished. */
	| "missed-departure"
	/** Scheduled leg arrival is not after its departure. */
	| "arrival-before-departure"
	/** Day's activities run past local midnight. */
	| "overflows-midnight"
	/** Previous day's activities (or a late arrival) push this day's start later than planned. */
	| "day-start-pushed"
	/** Pinned item starts before an explicit day startTime. */
	| "before-day-start"
	/** The day's first item starts on an earlier local date than the day (e.g. an "HH:mm" arrival of a >24h itinerary resolved too early). */
	| "before-day-date"
	/** No explicit startTime, and the leading items only fit before the first anchor if the day starts before 09:00. */
	| "day-start-moved-earlier"
	/** Consecutive items are in different zones with no transit leg between them. */
	| "implicit-timezone-change"
	| "unknown-timezone"
	| "invalid-timezone"
	| "unknown-node"
	| "invalid-time"
	| "invalid-duration"
	| "missing-duration"
	| "duration-mismatch"
	| "ignored-arrival"
	| "ambiguous-local-time"
	| "nonexistent-local-time"
	| "leg-unknown-item"
	| "leg-not-consecutive"
	| "duplicate-leg";

export interface TimelineIssue {
	code: TimelineIssueCode;
	severity: IssueSeverity;
	message: string;
	dayId?: string;
	itemId?: string;
	legId?: string;
	/** Size of the problem where meaningful (overlap, overflow, lateness...). */
	minutes?: number;
}

export type TimezoneSource =
	| "item"
	| "node"
	| "leg"
	| "day"
	| "carried"
	| "default";

export interface ComputedItem {
	id: string;
	dayId: string;
	/** Index of the day in input order. */
	dayIndex: number;
	indexInDay: number;
	/** Global position in the flattened timeline. */
	sequence: number;
	nodeId: string | null;
	title: string;
	timezone: string;
	timezoneSource: TimezoneSource;
	pinned: boolean;
	durationMin: number;
	/** `dayOffset` is relative to the owning day's date. */
	start: ZonedTime;
	end: ZonedTime;
	/** Idle minutes between the previous activity (or planned day start) and this item. */
	gapBeforeMin: number;
	/** Minutes a pinned start overlaps the previous activity (conflict). */
	overlapMin: number;
	/** Runs past local midnight (ending exactly at 00:00 does not count). */
	crossesMidnight: boolean;
	incomingLegId: string | null;
	outgoingLegId: string | null;
}

export interface ComputedLeg {
	id: string;
	fromItemId: string;
	toItemId: string;
	fromDayId: string;
	toDayId: string;
	/** Connects the last item of one day to the first item of a later day (overnight train, long-haul flight). */
	crossesDays: boolean;
	mode: TransitMode;
	label: string | null;
	/** Has a fixed departure time. */
	scheduled: boolean;
	/** In the departure zone. `dayOffset` relative to the from-item's day. */
	depart: ZonedTime;
	/** In the arrival zone. `dayOffset` relative to the from-item's day. */
	arrive: ZonedTime;
	/** Actual elapsed minutes (arrive - depart). */
	durationMin: number;
	/**
	 * Minutes between the previous item's end and departure. For an unscheduled leg from
	 * the previous day (hotel -> breakfast) this is the night, and it is not counted as idle.
	 */
	waitBeforeMin: number;
	/** arrive.offsetMin - depart.offsetMin (Seoul -> Ho Chi Minh = -120). */
	timezoneShiftMin: number;
}

export interface ComputedDay {
	id: string;
	date: string;
	index: number;
	/** Zone the day starts in. */
	timezone: string;
	/** Planned (soft) start, or null when an incoming scheduled overnight leg anchors the day. */
	plannedStart: ZonedTime | null;
	/** First item start / last item end. Null for an empty day. */
	start: ZonedTime | null;
	end: ZonedTime | null;
	items: ComputedItem[];
	/**
	 * Legs travelled on this day: legs between this day's items, an outgoing SCHEDULED
	 * overnight leg (night train, long-haul flight), and an incoming UNSCHEDULED leg from
	 * the previous day (hotel -> breakfast), which departs at this day's planned start.
	 */
	legs: ComputedLeg[];
	overflowsMidnight: boolean;
	/** Minutes past local midnight (in the zone where the day ends). */
	overflowMin: number;
	/** Sum of item durations. */
	activityMin: number;
	/** Sum of the durations of `legs`, excluding an outgoing scheduled overnight leg. */
	transitMin: number;
	/** Sum of item gaps plus leg waits within the day (including the wait for an outgoing overnight leg). */
	idleMin: number;
	issues: TimelineIssue[];
}

export interface TimelineResult {
	days: ComputedDay[];
	/** Flattened, in sequence order. */
	items: ComputedItem[];
	/** In sequence order (by from-item). */
	legs: ComputedLeg[];
	issues: TimelineIssue[];
}

export class TimelineInputError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "TimelineInputError";
	}
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

interface FlatItem {
	item: TimelineItemInput;
	day: TimelineDayInput;
	dayIndex: number;
	indexInDay: number;
	sequence: number;
}

interface ResolvedTz {
	tz: string;
	source: TimezoneSource;
}

/**
 * Computes local start/end for every item and depart/arrive for every leg.
 *
 * Model: a single cursor (an instant) walks the flattened timeline. Unpinned items
 * start at the cursor; pinned items and scheduled legs are anchors that may open a
 * gap or report a conflict. All arithmetic is on instants (exact time), and each
 * value is rendered in the zone where it happens.
 */
export function computeTimeline(
	input: TimelineInput,
	resolver: TimezoneResolver,
	options: TimelineOptions = {},
): TimelineResult {
	const defaultStart = parseTime(options.defaultStartTime ?? "09:00");
	if (!defaultStart)
		throw new TimelineInputError(
			`invalid defaultStartTime "${options.defaultStartTime}"`,
		);
	const fallbackTz = normalizeTimeZone(options.defaultTimezone ?? "UTC");
	if (!fallbackTz)
		throw new TimelineInputError(
			`invalid defaultTimezone "${options.defaultTimezone}"`,
		);
	const slack = options.slack ?? "after-leg";
	const tolerance = options.durationToleranceMin ?? 5;

	const issues: TimelineIssue[] = [];
	const report = (issue: TimelineIssue) => issues.push(issue);

	// ---- flatten + validate ids ------------------------------------------------
	const flat: FlatItem[] = [];
	const dayIds = new Set<string>();
	const itemPos = new Map<string, number>();
	input.days.forEach((day, dayIndex) => {
		if (dayIds.has(day.id))
			throw new TimelineInputError(`duplicate day id "${day.id}"`);
		dayIds.add(day.id);
		if (!parseDate(day.date))
			throw new TimelineInputError(
				`day "${day.id}" has invalid date "${day.date}"`,
			);
		day.items.forEach((item, indexInDay) => {
			if (itemPos.has(item.id))
				throw new TimelineInputError(`duplicate item id "${item.id}"`);
			itemPos.set(item.id, flat.length);
			flat.push({ item, day, dayIndex, indexInDay, sequence: flat.length });
		});
	});

	// ---- index legs by the position of their from-item ------------------------
	const legIds = new Set<string>();
	const legInto = new Map<number, TransitLegInput>(); // key: position of to-item
	for (const leg of input.legs ?? []) {
		if (legIds.has(leg.id))
			throw new TimelineInputError(`duplicate leg id "${leg.id}"`);
		legIds.add(leg.id);
		const from = itemPos.get(leg.fromItemId);
		const to = itemPos.get(leg.toItemId);
		if (from === undefined || to === undefined) {
			report({
				code: "leg-unknown-item",
				severity: "conflict",
				legId: leg.id,
				message: `leg "${leg.id}" references unknown item "${from === undefined ? leg.fromItemId : leg.toItemId}"; ignored`,
			});
			continue;
		}
		if (to !== from + 1) {
			report({
				code: "leg-not-consecutive",
				severity: "conflict",
				legId: leg.id,
				message: `leg "${leg.id}" does not connect consecutive items ("${leg.fromItemId}" -> "${leg.toItemId}"); ignored`,
			});
			continue;
		}
		if (legInto.has(to)) {
			report({
				code: "duplicate-leg",
				severity: "warning",
				legId: leg.id,
				message: `leg "${leg.id}" duplicates "${legInto.get(to)?.id}" between the same items; ignored`,
			});
			continue;
		}
		legInto.set(to, leg);
	}

	// ---- helpers -------------------------------------------------------------------
	const tzOfItem = (f: FlatItem): ResolvedTz | null => {
		const { item } = f;
		if (item.timezone) {
			const tz = normalizeTimeZone(item.timezone);
			if (tz) return { tz, source: "item" };
			report({
				code: "invalid-timezone",
				severity: "warning",
				dayId: f.day.id,
				itemId: item.id,
				message: `item "${item.id}" has unknown time zone "${item.timezone}"`,
			});
		}
		if (item.nodeId) {
			if (resolver.has && !resolver.has(item.nodeId)) {
				report({
					code: "unknown-node",
					severity: "warning",
					dayId: f.day.id,
					itemId: item.id,
					message: `item "${item.id}" references unknown node "${item.nodeId}"`,
				});
				return null;
			}
			const tz = resolver.resolveTimezone(item.nodeId);
			if (tz) return { tz, source: "node" };
		}
		return null;
	};
	const itemTzCache = new Map<number, ResolvedTz | null>();
	const ownTz = (f: FlatItem): ResolvedTz | null => {
		if (!itemTzCache.has(f.sequence)) itemTzCache.set(f.sequence, tzOfItem(f));
		return itemTzCache.get(f.sequence) ?? null;
	};

	const duration = (
		value: number | null | undefined,
		ctx: Partial<TimelineIssue>,
		what: string,
	): number | null => {
		if (value === null || value === undefined) return null;
		if (!Number.isFinite(value) || value < 0) {
			report({
				...ctx,
				code: "invalid-duration",
				severity: "warning",
				message: `${what} has invalid duration ${value}; using 0`,
			});
			return 0;
		}
		return Math.round(value);
	};

	const noteWall = (
		res: WallResolution,
		ctx: Partial<TimelineIssue>,
		what: string,
		tz: string,
	) => {
		if (res.kind === "ambiguous") {
			report({
				...ctx,
				code: "ambiguous-local-time",
				severity: "info",
				message: `${what} occurs twice in ${tz} (DST fall-back); using the earlier occurrence`,
			});
		} else if (res.kind === "nonexistent") {
			report({
				...ctx,
				code: "nonexistent-local-time",
				severity: "warning",
				message: `${what} does not exist in ${tz} (DST gap); shifted forward`,
			});
		}
	};

	interface PreparedLeg {
		leg: TransitLegInput;
		scheduled: boolean;
		/** Fixed departure instant (scheduled legs). */
		departMs: number | null;
		/** Fixed arrival instant (when departure + arrival are both given). */
		arriveMs: number | null;
		durationMin: number;
		departTz: string;
		arriveTz: string | null;
	}

	const prepared = new Map<number, PreparedLeg>();
	const prepareLeg = (
		toPos: number,
		carriedTz: string | null,
	): PreparedLeg | null => {
		const leg = legInto.get(toPos);
		if (!leg) return null;
		const cached = prepared.get(toPos);
		if (cached) return cached;
		const fromF = flat[toPos - 1] as FlatItem;
		const toF = flat[toPos] as FlatItem;
		const ctx = { dayId: fromF.day.id, legId: leg.id };
		const legTz = (
			endpoint: LegEndpointTime | null | undefined,
		): string | null => {
			if (!endpoint?.timezone) return null;
			const tz = normalizeTimeZone(endpoint.timezone);
			if (!tz) {
				report({
					...ctx,
					code: "invalid-timezone",
					severity: "warning",
					message: `leg "${leg.id}" has unknown time zone "${endpoint.timezone}"`,
				});
			}
			return tz;
		};
		const departTz =
			legTz(leg.departure) ?? ownTz(fromF)?.tz ?? carriedTz ?? fallbackTz;
		const arriveTz = legTz(leg.arrival) ?? ownTz(toF)?.tz ?? null;
		let dur = duration(leg.durationMin, ctx, `leg "${leg.id}"`);
		let departMs: number | null = null;
		let arriveMs: number | null = null;
		if (leg.departure) {
			const wall = parseWallTime(leg.departure.at, fromF.day.date);
			if (!wall) {
				report({
					...ctx,
					code: "invalid-time",
					severity: "warning",
					message: `leg "${leg.id}" has invalid departure "${leg.departure.at}"; treated as unscheduled`,
				});
			} else {
				const res = wallToEpoch(wall.date, wall.time, departTz);
				noteWall(res, ctx, `departure ${wall.date}T${wall.time}`, departTz);
				departMs = res.epochMs;
			}
		}
		if (leg.arrival) {
			if (departMs === null) {
				report({
					...ctx,
					code: "ignored-arrival",
					severity: "warning",
					message: `leg "${leg.id}" has an arrival without a valid departure; arrival ignored`,
				});
			} else {
				const tz = arriveTz ?? departTz;
				const wall = parseWallTime(leg.arrival.at, fromF.day.date);
				if (!wall) {
					report({
						...ctx,
						code: "invalid-time",
						severity: "warning",
						message: `leg "${leg.id}" has invalid arrival "${leg.arrival.at}"; ignored`,
					});
				} else {
					const res = wall.hasDate
						? wallToEpoch(wall.date, wall.time, tz)
						: nextWallOccurrence(wall.time, tz, departMs);
					noteWall(
						res,
						ctx,
						`arrival ${wall.hasDate ? `${wall.date}T` : ""}${wall.time}`,
						tz,
					);
					if (res.epochMs <= departMs) {
						report({
							...ctx,
							code: "arrival-before-departure",
							severity: "conflict",
							message: `leg "${leg.id}" arrives before (or when) it departs; using its duration instead`,
						});
					} else {
						const actual = diffMinutes(departMs, res.epochMs);
						if (dur !== null && Math.abs(dur - actual) > tolerance) {
							report({
								...ctx,
								code: "duration-mismatch",
								severity: "warning",
								minutes: actual - dur,
								message: `leg "${leg.id}" says ${dur} min but departure/arrival imply ${actual} min; using the times`,
							});
						}
						arriveMs = res.epochMs;
						dur = actual;
					}
				}
			}
		}
		if (dur === null) {
			report({
				...ctx,
				code: "missing-duration",
				severity: "warning",
				message: `leg "${leg.id}" has no duration; using 0`,
			});
			dur = 0;
		}
		const p: PreparedLeg = {
			leg,
			scheduled: departMs !== null,
			departMs,
			arriveMs,
			durationMin: dur,
			departTz,
			arriveTz,
		};
		prepared.set(toPos, p);
		return p;
	};

	/** Resolves an item's pinned start to an instant (null if unpinned/invalid). Cached per item. */
	const pinCache = new Map<number, number | null>();
	const pinOf = (f: FlatItem, tz: string): number | null => {
		const cached = pinCache.get(f.sequence);
		if (cached !== undefined) return cached;
		let result: number | null = null;
		const raw = f.item.pinnedStart;
		if (raw) {
			const wall = parseWallTime(raw, f.day.date);
			const ctx = { dayId: f.day.id, itemId: f.item.id };
			if (!wall) {
				report({
					...ctx,
					code: "invalid-time",
					severity: "warning",
					message: `item "${f.item.id}" has invalid pinnedStart "${raw}"; treated as unpinned`,
				});
			} else {
				const res = wallToEpoch(wall.date, wall.time, tz);
				noteWall(res, ctx, `pinned start ${wall.date}T${wall.time}`, tz);
				result = res.epochMs;
			}
		}
		pinCache.set(f.sequence, result);
		return result;
	};

	const durationCache = new Map<number, number>();
	const itemDuration = (f: FlatItem): number => {
		let d = durationCache.get(f.sequence);
		if (d === undefined) {
			d =
				duration(
					f.item.durationMin,
					{ dayId: f.day.id, itemId: f.item.id },
					`item "${f.item.id}"`,
				) ?? 0;
			durationCache.set(f.sequence, d);
		}
		return d;
	};

	/** Zone an item happens in: its own (item/node), else the incoming leg's arrival zone, else the day's start zone (first item) or the carried zone. */
	const itemZone = (
		f: FlatItem,
		p: PreparedLeg | null,
		prevTz: string,
		dayStartTz: ResolvedTz,
	): ResolvedTz =>
		ownTz(f) ??
		(p?.arriveTz ? { tz: p.arriveTz, source: "leg" } : null) ??
		(f.indexInDay === 0 ? dayStartTz : { tz: prevTz, source: "carried" });

	/**
	 * Default (non-explicit) day start: 09:00, moved EARLIER when the leading
	 * unpinned items would otherwise collide with the day's first anchor
	 * (pinned item or scheduled departure). E.g. a 30 min breakfast before an
	 * 08:30 train starts the day at 08:00 instead of reporting a conflict.
	 * When the very first item is pinned, the day starts at that pin.
	 * `incomingLead`: an unscheduled leg from the previous day (hotel -> breakfast)
	 * is the first thing the day does, so it counts as leading time.
	 */
	const backScheduledStart = (
		dayFlat: FlatItem[],
		def: number,
		dayStartTz: ResolvedTz,
		incomingLead = 0,
	): { start: number; movedFor: string | null } => {
		let tz = dayStartTz.tz;
		let lead = incomingLead;
		const fitBefore = (anchor: number, what: string) => {
			const start = addMinutes(anchor, -lead);
			return start < def
				? { start, movedFor: what }
				: { start: def, movedFor: null };
		};
		for (const f of dayFlat) {
			const p = f.indexInDay > 0 ? prepareLeg(f.sequence, tz) : null;
			if (p) {
				if (p.departMs !== null)
					return fitBefore(p.departMs, `"${p.leg.label ?? p.leg.id}"`);
				lead += p.durationMin;
			}
			tz = itemZone(f, p, tz, dayStartTz).tz;
			const pin = pinOf(f, tz);
			if (pin !== null) {
				// A pinned first item IS the start of the day (no phantom gap since 09:00).
				if (lead === incomingLead)
					return { start: addMinutes(pin, -lead), movedFor: null };
				return fitBefore(pin, `"${f.item.title}"`);
			}
			lead += itemDuration(f);
		}
		return { start: def, movedFor: null };
	};

	// ---- walk -----------------------------------------------------------------------
	const outItems: ComputedItem[] = [];
	const outLegs: ComputedLeg[] = [];
	const outDays: ComputedDay[] = [];
	const dayById = new Map<string, ComputedDay>();

	let cursor: number | null = null; // end of the last activity (instant)
	let currentTz: string | null = null;

	input.days.forEach((day, dayIndex) => {
		const dayFlat = flat.filter((f) => f.dayIndex === dayIndex);
		const dayCtx = { dayId: day.id };

		let explicitStart: string | null = null;
		if (day.startTime) {
			explicitStart = parseTime(day.startTime);
			if (!explicitStart) {
				report({
					...dayCtx,
					code: "invalid-time",
					severity: "warning",
					message: `day "${day.id}" has invalid startTime "${day.startTime}"; using default`,
				});
			}
		}
		let explicitDayTz: string | null = null;
		if (day.timezone) {
			explicitDayTz = normalizeTimeZone(day.timezone);
			if (!explicitDayTz) {
				report({
					...dayCtx,
					code: "invalid-timezone",
					severity: "warning",
					message: `day "${day.id}" has unknown time zone "${day.timezone}"`,
				});
			}
		}

		// Zone the day starts in: explicit > first item's own > carried from yesterday > first item in the day that has one > default.
		const first = dayFlat[0];
		const startTz: ResolvedTz =
			(explicitDayTz ? { tz: explicitDayTz, source: "day" } : null) ??
			(first ? ownTz(first) : null) ??
			(currentTz ? { tz: currentTz, source: "carried" } : null) ??
			dayFlat.map(ownTz).find((t) => t !== null) ??
			(() => {
				if (!options.defaultTimezone) {
					report({
						...dayCtx,
						code: "unknown-timezone",
						severity: "warning",
						message: `no time zone could be derived for day "${day.id}"; using ${fallbackTz}`,
					});
				}
				return { tz: fallbackTz, source: "default" } as const;
			})();
		if (!currentTz) currentTz = startTz.tz;

		const dayItems: ComputedItem[] = [];
		const dayLegs: ComputedLeg[] = [];
		let plannedStartMs: number | null = null;
		let idleMin = 0;
		let transitMin = 0;

		for (const f of dayFlat) {
			const k = f.indexInDay;
			const prevTz: string = currentTz ?? startTz.tz;
			const p = prepareLeg(f.sequence, prevTz);
			const own = ownTz(f);
			const zone = itemZone(f, p, prevTz, startTz);
			const itemCtx = { dayId: day.id, itemId: f.item.id };
			const dur = itemDuration(f);
			const pin = pinOf(f, zone.tz);
			const prevItem =
				f.sequence > 0 ? (flat[f.sequence - 1] as FlatItem) : null;

			if (!p && own && prevItem && own.tz !== prevTz) {
				report({
					...itemCtx,
					code: "implicit-timezone-change",
					severity: "warning",
					message: `"${f.item.title}" is in ${own.tz} but the previous activity was in ${prevTz}, with no transit leg between them`,
				});
			}

			// `hard`: physically cannot start earlier (previous activity end / arrival).
			// `soft`: the planned day start (first item of the day only).
			let hard: number | null = cursor;
			let soft: number | null = null;
			let movedFor: string | null = null;
			let leg: ComputedLeg | null = null;

			// Planned (soft) start of the day. A scheduled incoming leg (overnight train,
			// long-haul flight) anchors the day instead, unless the start time is explicit.
			// An UNSCHEDULED leg from the previous day (hotel -> breakfast walk) is the
			// first thing the day does: it departs at the planned start, not last night.
			if (k === 0) {
				if (explicitStart) {
					soft = wallToEpoch(day.date, explicitStart, startTz.tz).epochMs;
				} else if (!p || p.departMs === null) {
					const planned = backScheduledStart(
						dayFlat,
						wallToEpoch(day.date, defaultStart, startTz.tz).epochMs,
						startTz,
						p?.durationMin ?? 0,
					);
					soft = planned.start;
					movedFor = planned.movedFor;
				}
			}

			if (p && prevItem && cursor !== null) {
				let depart: number;
				if (p.departMs !== null) {
					depart = p.departMs;
					if (cursor > depart) {
						const late = diffMinutes(depart, cursor);
						report({
							dayId: prevItem.day.id,
							itemId: prevItem.item.id,
							legId: p.leg.id,
							code: "missed-departure",
							severity: "conflict",
							minutes: late,
							message: `"${p.leg.label ?? p.leg.id}" departs ${late} min before "${prevItem.item.title}" ends`,
						});
					}
				} else {
					depart = cursor;
					// Unscheduled leg from the previous day: leave at this day's planned start
					// (or earlier, in time for a pinned first item).
					if (k === 0 && soft !== null)
						depart = Math.max(
							depart,
							pin !== null
								? Math.min(soft, addMinutes(pin, -p.durationMin))
								: soft,
						);
					if (slack === "before-leg" && pin !== null)
						depart = Math.max(depart, addMinutes(pin, -p.durationMin));
				}
				const arrive = p.arriveMs ?? addMinutes(depart, p.durationMin);
				const departZ = toZonedTime(depart, p.departTz, prevItem.day.date);
				const arriveZ = toZonedTime(
					arrive,
					p.arriveTz ?? zone.tz,
					prevItem.day.date,
				);
				leg = {
					id: p.leg.id,
					fromItemId: p.leg.fromItemId,
					toItemId: p.leg.toItemId,
					fromDayId: prevItem.day.id,
					toDayId: day.id,
					crossesDays: prevItem.dayIndex !== dayIndex,
					mode: p.leg.mode,
					label: p.leg.label ?? null,
					scheduled: p.scheduled,
					depart: departZ,
					arrive: arriveZ,
					durationMin: diffMinutes(depart, arrive),
					waitBeforeMin: Math.max(0, diffMinutes(cursor, depart)),
					timezoneShiftMin: arriveZ.offsetMin - departZ.offsetMin,
				};
				// After a leg you are wherever it arrived, whenever it arrived. (For a
				// missed scheduled departure the conflict is reported and the plan
				// continues as if the leg was taken.)
				hard = arrive;
			}

			if (k === 0) {
				if (soft !== null && movedFor) {
					report({
						...dayCtx,
						code: "day-start-moved-earlier",
						severity: "info",
						message: `day "${day.id}" starts at ${toZonedTime(soft, startTz.tz).time} (before ${defaultStart}) to fit everything before ${movedFor}`,
					});
				}
				plannedStartMs = soft;
				// When the day actually begins: the arrival of a scheduled incoming leg, the
				// departure of an unscheduled one, else the end of the previous activity.
				const begins = leg && !leg.scheduled ? leg.depart.epochMs : hard;
				if (soft !== null && begins !== null && begins > soft && pin === null) {
					const late = diffMinutes(soft, begins);
					report({
						...itemCtx,
						code: "day-start-pushed",
						severity: "warning",
						minutes: late,
						message: leg?.scheduled
							? `day "${day.id}" starts ${late} min late: "${leg.label ?? leg.id}" arrives ${leg.arrive.time}`
							: `day "${day.id}" starts ${late} min late: the previous day's activities run until ${toZonedTime(begins, startTz.tz).time}`,
					});
				}
			}

			const earliest = maxOf(hard, soft) as number; // non-null: first item overall has soft, later items have hard
			let start = earliest;
			let gap = 0;
			let overlap = 0;
			if (pin !== null) {
				start = pin;
				if (hard !== null && pin < hard) {
					overlap = diffMinutes(pin, hard);
					const what = leg
						? `arriving via "${leg.label ?? leg.id}"`
						: `"${prevItem?.item.title}" finishes`;
					report({
						...itemCtx,
						code: "overlap",
						severity: "conflict",
						minutes: overlap,
						message: `"${f.item.title}" is pinned ${overlap} min before ${what}`,
					});
				} else if (k === 0 && explicitStart && soft !== null && pin < soft) {
					report({
						...itemCtx,
						code: "before-day-start",
						severity: "warning",
						minutes: diffMinutes(pin, soft),
						message: `"${f.item.title}" is pinned before the day's start time ${explicitStart}`,
					});
				} else if (pin > earliest) {
					gap = diffMinutes(earliest, pin);
				}
			} else if (leg && hard !== null && start > hard) {
				// Arrived (e.g. overnight train at 05:30) before an explicit day start (07:00).
				gap = diffMinutes(hard, start);
			}
			const end = addMinutes(start, dur);
			// A conflicting pin never pulls the timeline earlier than it already is.
			cursor = hard === null ? end : Math.max(hard, end);
			currentTz = zone.tz;

			if (leg) {
				outLegs.push(leg);
				// A scheduled overnight leg belongs to the day it departs from: the wait at the
				// station/airport is that day's idle time; the ride itself is not its transit.
				// An unscheduled leg from the previous day departs this morning, so it is ours.
				const fromDay =
					leg.crossesDays && leg.scheduled
						? dayById.get(leg.fromDayId)
						: undefined;
				if (fromDay) {
					fromDay.legs.push(leg);
					fromDay.idleMin += leg.waitBeforeMin;
				} else if (leg.crossesDays) {
					dayLegs.push(leg);
					transitMin += leg.durationMin;
				} else {
					dayLegs.push(leg);
					transitMin += leg.durationMin;
					idleMin += leg.waitBeforeMin;
				}
			}
			idleMin += gap;

			const startZ = toZonedTime(start, zone.tz, day.date);
			if (k === 0 && startZ.dayOffset < 0) {
				report({
					...itemCtx,
					code: "before-day-date",
					severity: "warning",
					message: `"${f.item.title}" starts ${startZ.local} (${zone.tz}), before day "${day.id}" (${day.date}) begins`,
				});
			}
			const endZ = toZonedTime(end, zone.tz, day.date);
			const computed: ComputedItem = {
				id: f.item.id,
				dayId: day.id,
				dayIndex,
				indexInDay: k,
				sequence: f.sequence,
				nodeId: f.item.nodeId ?? null,
				title: f.item.title,
				timezone: zone.tz,
				timezoneSource: zone.source,
				pinned: pin !== null,
				durationMin: dur,
				start: startZ,
				end: endZ,
				gapBeforeMin: gap,
				overlapMin: overlap,
				crossesMidnight:
					dur > 0 && localDateOf(end - 1, zone.tz) !== startZ.date,
				incomingLegId: leg?.id ?? null,
				outgoingLegId: legInto.get(f.sequence + 1)?.id ?? null,
			};
			dayItems.push(computed);
			outItems.push(computed);
		}

		if (dayFlat.length === 0)
			plannedStartMs = wallToEpoch(
				day.date,
				explicitStart ?? defaultStart,
				startTz.tz,
			).epochMs;

		// ---- day summary ----------------------------------------------------------
		let endItem: ComputedItem | undefined;
		for (const it of dayItems)
			if (!endItem || it.end.epochMs >= endItem.end.epochMs) endItem = it;
		let overflowMin = 0;
		if (endItem) {
			overflowMin = Math.max(
				0,
				diffMinutes(
					endOfLocalDate(day.date, endItem.timezone),
					endItem.end.epochMs,
				),
			);
			if (overflowMin > 0) {
				report({
					dayId: day.id,
					itemId: endItem.id,
					code: "overflows-midnight",
					severity: "warning",
					minutes: overflowMin,
					message: `day "${day.id}" runs ${overflowMin} min past midnight (until ${endItem.end.time} ${endItem.timezone})`,
				});
			}
		}
		const computedDay: ComputedDay = {
			id: day.id,
			date: day.date,
			index: dayIndex,
			timezone: startTz.tz,
			plannedStart:
				plannedStartMs !== null
					? toZonedTime(plannedStartMs, startTz.tz, day.date)
					: null,
			start: dayItems[0]?.start ?? null,
			end: endItem?.end ?? null,
			items: dayItems,
			legs: dayLegs,
			overflowsMidnight: overflowMin > 0,
			overflowMin,
			activityMin: dayItems.reduce((s, i) => s + i.durationMin, 0),
			transitMin,
			idleMin,
			issues: [], // filled below: e.g. a missed overnight departure is found while processing the next day
		};
		outDays.push(computedDay);
		dayById.set(day.id, computedDay);
	});

	for (const issue of issues) {
		if (issue.dayId) dayById.get(issue.dayId)?.issues.push(issue);
	}

	return { days: outDays, items: outItems, legs: outLegs, issues };
}

function maxOf(a: number | null, b: number | null): number | null {
	if (a === null) return b;
	if (b === null) return a;
	return Math.max(a, b);
}
