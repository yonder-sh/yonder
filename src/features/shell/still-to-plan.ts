/**
 * ADDENDUM §10 "Still to plan" (the trip overview panel), pure: what the trip
 * is still missing, each with enough to link to a filtered view.
 *
 * - **Nights with no stay:** every day but the last whose `nightNodeId` is
 *   empty or only a town (the day split's "Tokyo", no hotel yet), unless a
 *   timed leg (overnight flight, night train) leaves that day and lands on a
 *   later one.
 * - **Still to book:** open to-dos that are booking tasks ("Book ahead",
 *   "Book Shibuya Sky…", or a booking window: `dueKind: 'opens'`).
 * - **Windows opening in the next 14 days:** open `opens` to-dos whose
 *   effective due instant (relative rules resolved by WP-Lists' `effectiveDue`)
 *   falls within 14 days from now.
 * - **Unrated places per member:** the Rate screen's places (WP-Places'
 *   `rateableNodes`: not dropped, not a stay or a transit hub, and live — a
 *   suggestion nobody has accepted yet is not a place to rate, PLAN-R3-02)
 *   without that member's priority, for the people who rate (active members
 *   and placeholders who can edit or suggest).
 * - **City-to-city moves with no transport mode:** schedule legs with no mode
 *   whose endpoints sit in different cities (a region or country when a place
 *   has no city: Kawaguchiko's ryokan is "Mt. Fuji"). Cross-day pairs covered
 *   by a stay are skipped (their stay legs are checked instead).
 * - **Days per city:** the planned days against the trip's length, from
 *   WP-Places' own `cityDayTable` (cities plus region/area stand-ins such as
 *   Mt. Fuji), so the header and the table's footer are one number.
 *
 * Privacy: list items come from F's `listTripListItems`, which already drops
 * other people's private rows, so a private to-do only counts for its author.
 */
import { dayLabel, itemName, legLabel } from "@/features/lists/list-model";
import type { ListItemDto } from "@/features/lists/lists.functions";
import { cityDayTable } from "@/features/places/lib/days";
import {
	isRateable as isRateableNode,
	rateableNodes,
} from "@/features/places/lib/rate";
import type { GraphIndex } from "@/lib/engine/graph-index";
import { localDateOf } from "@/lib/engine/time";
import type { GraphMember, ScheduleResult } from "@/lib/engine/types";
import { type BundleTarget, bundleTargetColumns } from "@/lib/schemas/targets";
import { serializeSel, type WorkspaceSearch } from "@/lib/workspace/search";
import { selForRefs } from "./activity-sel";

export const OPENING_WINDOW_DAYS = 14;
const DAY_MS = 86_400_000;

export type StillToPlan = {
	nights: { dayId: string; date: string }[];
	/** Open booking to-dos (the row expands to them; each opens its own context). */
	toBook: {
		listItemId: string;
		text: string;
		/** What it's for ("JAL Sky Museum · Day 2"), see `todoContext`. */
		context: string | null;
		target: BundleTarget;
		/** Its due instant, when it has one (shown next to it). */
		due: StillToPlanDue | null;
	}[];
	opening: {
		listItemId: string;
		text: string;
		context: string | null;
		at: number;
		target: BundleTarget;
		due: StillToPlanDue;
	}[];
	unrated: {
		memberId: string;
		name: string;
		count: number;
		total: number;
	}[];
	moves: {
		/** The workspace `sel` that opens the leg editor. */
		sel: string;
		dayId: string | null;
		from: string;
		to: string;
	}[];
	days: {
		tripDays: number;
		planned: number;
		/** `tripDays − planned`; negative = over-allocated (the table's footer). */
		unallocated: number;
		cities: {
			nodeId: string;
			name: string;
			planned: number | null;
			scheduled: number;
		}[];
	};
	/** Rows with something to do (the panel's "all planned" state when 0). */
	open: number;
};

/** A due instant in its own zone (see `trip-deadlines.ts` `TripDue`). */
export type StillToPlanDue = {
	at: number;
	tz: string;
	date: string;
	timed: boolean;
};

export type StillToPlanInput = {
	ix: GraphIndex;
	schedule: ScheduleResult;
	members: readonly GraphMember[];
	/** Undefined while loading (or for fixture mode): list rows are skipped. */
	listItems?: readonly ListItemDto[];
	/** The effective due instant (epoch ms) of a to-do, or null. */
	dueAt?: (li: ListItemDto) => number | null;
	/** The effective due with its zone (preferred over `dueAt` when given). */
	due?: (li: ListItemDto) => StillToPlanDue | null;
	/**
	 * The server graph's node ids. `ix` is built from the proposal overlay
	 * while suggestions are shown, so it holds ghosts ("Tōfuku-ji, suggested
	 * by Maya"); the Rate screen leaves them out, and so do the unrated counts
	 * (PLAN-R3-02, VIS3-04). Omitted: every node in `ix` is live.
	 */
	liveIds?: ReadonlySet<string>;
	now: number;
};

const BOOKING_TEXT = /\bbook(?:ing|ed)?\b|\breserv(?:e|ation)\b/i;

/**
 * Rateable: the Rate screen's rule (places to go and neighbourhood areas, not
 * lodging or airports/stations), so "Audrey: N of M" here matches the Rate
 * screen's "Audrey N/M" (WP-Places CONTRACT_REQUESTS 7).
 */
export function isRateable(
	n: Parameters<typeof isRateableNode>[0],
	dropped: boolean,
): boolean {
	if (dropped) return false;
	return isRateableNode(n);
}

/**
 * Where a "Still to plan" (or Upcoming deadlines) to-do opens (PLAN-I2-14,
 * PLAN-R2-05: a filtered view, not the whole list): Lists › To-do narrowed to
 * the to-do's own place (the scope) or day (`days`), with its item, place,
 * leg or day selected and the inspector on that selection's Lists tab, so
 * the to-do itself is on screen. A trip-wide to-do (or one whose target is
 * gone) has nothing to narrow to and opens the list itself.
 */
export type TodoView = {
	/** The scope to open: the to-do's place, or null for the trip root. */
	scopeId: string | null;
	search: Partial<WorkspaceSearch>;
	/** The inspector tab to open on `search.sel`, or null (stay on Overview). */
	inspectorTab: "lists" | null;
};

export function todoView(ix: GraphIndex, target: BundleTarget): TodoView {
	const list = { tab: "lists", list: "todo" } as const;
	const sel = selForRefs(ix, bundleTargetColumns(target));
	if (!sel) return { scopeId: null, search: { ...list }, inspectorTab: null };
	const dateOf = (dayId: string | null | undefined) =>
		dayId ? (ix.day(dayId)?.date ?? null) : null;
	let scopeId: string | null = null;
	let days: string | undefined;
	switch (target.kind) {
		case "node":
			scopeId = target.nodeId;
			break;
		case "item": {
			const it = ix.item(target.itemId);
			if (it?.nodeId && ix.node(it.nodeId)) scopeId = it.nodeId;
			else days = dateOf(it?.dayId) ?? undefined;
			break;
		}
		case "day":
			days = dateOf(target.dayId) ?? undefined;
			break;
		case "leg": {
			const leg = ix.leg(target.legId);
			const from =
				leg?.kind === "pair"
					? dateOf(ix.item(leg.fromItemId ?? "")?.dayId)
					: dateOf(leg?.stayDayId);
			const to =
				leg?.kind === "pair"
					? dateOf(ix.item(leg.toItemId ?? "")?.dayId)
					: null;
			// An overnight flight spans its two days ("2027-10-02..2027-10-03").
			const ds = [from, to].filter((d): d is string => !!d).sort();
			const first = ds[0];
			const last = ds.at(-1);
			if (first) days = last && last !== first ? `${first}..${last}` : first;
			break;
		}
	}
	return {
		scopeId,
		search: { ...list, sel: serializeSel(sel), ...(days ? { days } : {}) },
		inspectorTab: "lists",
	};
}

/** The Lists search for a to-do (`todoView` without the scope). */
export function todoSearch(
	ix: GraphIndex,
	target: BundleTarget,
): Partial<WorkspaceSearch> {
	return todoView(ix, target).search;
}

/**
 * What a to-do is for, so eleven "Book ahead" rows can be told apart (the
 * Lists tab's source crumb, name first): "JAL Sky Museum · Day 2", "Leg · Fuji
 * Excursion 7 · Day 4", "Day 3 · Tue 5 Oct", "Shibuya Sky". A name the text
 * already says is left out ("Book Shibuya Sky tickets" needs no "Shibuya
 * Sky"); a trip-wide to-do has none.
 */
export function todoContext(
	ix: GraphIndex,
	target: BundleTarget,
	text: string,
): string | null {
	const lower = text.toLowerCase();
	const says = (name: string) => lower.includes(name.toLowerCase());
	const dayOf = (dayId: string | null | undefined) =>
		dayId && ix.day(dayId) ? `Day ${ix.dayNumber(dayId)}` : null;
	const join = (parts: (string | null)[]) =>
		parts.filter(Boolean).join(" · ") || null;
	switch (target.kind) {
		case "trip":
			return null;
		case "node": {
			const n = ix.node(target.nodeId);
			return n && !says(n.name) ? n.name : null;
		}
		case "item": {
			const name = itemName(ix, target.itemId);
			return join([
				says(name) ? null : name,
				dayOf(ix.item(target.itemId)?.dayId),
			]);
		}
		case "day":
			return dayLabel(ix, target.dayId);
		case "leg": {
			const leg = ix.leg(target.legId);
			// Stay legs already say their day ("Morning · Day 5 · Thu 7 Oct").
			const day =
				leg?.kind === "pair"
					? dayOf(ix.item(leg.fromItemId ?? "")?.dayId)
					: null;
			return join([legLabel(ix, target.legId), day]);
		}
	}
}

/** "Book ahead · JAL Sky Museum · Day 2": a to-do's text and what it's for. */
export function todoTitle(text: string, context: string | null): string {
	return context ? `${text} · ${context}` : text;
}

/** The city a node belongs to: its nearest city, else region, else country. */
export function cityOf(ix: GraphIndex, nodeId: string | null): string | null {
	if (!nodeId || !ix.node(nodeId)) return null;
	const path = ix.path(nodeId);
	for (const type of ["city", "region", "country"] as const) {
		for (let i = path.length - 1; i >= 0; i--) {
			const n = path[i];
			if (n?.type === type) return n.id;
		}
	}
	return null;
}

/** Nights with no stay, or only a town (no hotel yet); a night flight covers its night. */
export function nightsWithoutStay(ix: GraphIndex): StillToPlan["nights"] {
	const days = ix.days;
	const covered = new Set<string>();
	// A timed leg that departs one day and lands on a later one covers that night.
	for (const p of ix.pairs) {
		if (!p.crossDay) continue;
		const leg = ix.legByPair.get(p.key);
		if (!ix.isTimed(leg)) continue;
		const d = ix.item(p.fromItemId)?.dayId;
		if (d) covered.add(d);
	}
	return days
		.slice(0, -1)
		.filter(
			(d) => ix.node(d.nightNodeId)?.type !== "place" && !covered.has(d.id),
		)
		.map((d) => ({ dayId: d.id, date: d.date }));
}

function movesWithoutMode(
	ix: GraphIndex,
	schedule: ScheduleResult,
): StillToPlan["moves"] {
	const out: StillToPlan["moves"] = [];
	const nameOf = (id: string | null) => ix.node(id)?.name ?? "?";
	for (const [key, leg] of Object.entries(schedule.legs)) {
		if (!leg.unset) continue;
		let fromNode: string | null = null;
		let toNode: string | null = null;
		let sel: string;
		let dayId: string | null = null;
		if (key.startsWith("stay:")) {
			const [, d = "", end] = key.split(":");
			const plan = end === "start" ? ix.morningStay(d) : ix.eveningStay(d);
			if (!plan) continue;
			fromNode = plan.fromNodeId;
			toNode = plan.toNodeId;
			sel = `s.${d}.${end}`;
			dayId = d;
		} else {
			const [a = "", b = ""] = key.split(">");
			if (leg.kind === "overnight" && ix.boundaryKind(a, b) !== "overnight")
				continue; // a stay covers the night: its stay legs are the moves
			fromNode = ix.item(a)?.nodeId ?? null;
			toNode = ix.item(b)?.nodeId ?? null;
			sel = `l.${a}.${b}`;
			dayId = ix.item(b)?.dayId ?? null;
		}
		const ca = cityOf(ix, fromNode);
		const cb = cityOf(ix, toNode);
		if (!ca || !cb || ca === cb) continue;
		out.push({ sel, dayId, from: nameOf(ca), to: nameOf(cb) });
	}
	// Trip order: by the day of the arrival.
	const order = (d: string | null) =>
		d ? (ix.dayIndex.get(ix.day(d)?.date ?? "") ?? 1e9) : 1e9;
	return out.sort((x, y) => order(x.dayId) - order(y.dayId));
}

function daysPerCity(
	ix: GraphIndex,
	schedule: ScheduleResult,
): StillToPlan["days"] {
	// The same table the panel expands to (WP-Places' DaysPerCityTable).
	const table = cityDayTable(ix, schedule, null);
	return {
		tripDays: table.tripDays,
		planned: table.plannedTotal,
		unallocated: table.unallocated,
		cities: table.rows.map((r) => ({
			nodeId: r.nodeId,
			name: r.name,
			planned: r.planned,
			scheduled: r.scheduled,
		})),
	};
}

/**
 * The "Days per city" row's hint, the same number as the table's footer
 * ("Unallocated 4 days · 31 planned of 35 trip days"): "4 of 35 unallocated",
 * "2 over-allocated", "all 35 planned", "not planned yet".
 */
export function daysHint(days: StillToPlan["days"]): string {
	if (!days.planned) return "not planned yet";
	const n = formatHalf(Math.abs(days.unallocated));
	if (days.unallocated > 0) return `${n} of ${days.tripDays} unallocated`;
	if (days.unallocated < 0) return `${n} over-allocated`;
	return `all ${days.tripDays} planned`;
}

/** "3", "2.5" (planned days allow halves). */
function formatHalf(n: number): string {
	return Number.isInteger(n) ? String(n) : n.toFixed(1).replace(/\.0$/, "");
}

export function stillToPlan(input: StillToPlanInput): StillToPlan {
	const { ix, schedule, members, listItems, now } = input;
	const dueOf = (li: ListItemDto): StillToPlanDue | null => {
		if (input.due) return input.due(li);
		const at = input.dueAt?.(li) ?? null;
		if (at === null) return null;
		return {
			at,
			tz: ix.defaultTz,
			date: localDateOf(at, ix.defaultTz),
			timed: true,
		};
	};
	const nights = nightsWithoutStay(ix);
	const todos = (listItems ?? []).filter(
		(li) => li.list === "todo" && li.status === "open",
	);
	const toBook = todos
		.filter((li) => li.dueKind === "opens" || BOOKING_TEXT.test(li.text))
		.map((li) => ({
			listItemId: li.id,
			text: li.text,
			context: todoContext(ix, li.target, li.text),
			target: li.target,
			due: dueOf(li),
		}));
	const horizon = now + OPENING_WINDOW_DAYS * DAY_MS;
	const opening = todos
		.filter((li) => li.dueKind === "opens")
		.map((li) => ({ li, due: dueOf(li) }))
		.filter(
			(x): x is { li: ListItemDto; due: StillToPlanDue } =>
				x.due !== null && x.due.at >= now && x.due.at <= horizon,
		)
		.sort((a, b) => a.due.at - b.due.at)
		.map(({ li, due }) => ({
			listItemId: li.id,
			text: li.text,
			context: todoContext(ix, li.target, li.text),
			at: due.at,
			target: li.target,
			due,
		}));
	// The Rate screen's own set, so "You 47 of 125" here reads "You 78/125" there.
	const rateable = rateableNodes(ix, null, { liveIds: input.liveIds });
	// People who rate: members and placeholders who can edit, suggest or rate
	// (a viewer can't set a priority, PLACES §1c; invites haven't joined yet).
	const unrated = members
		.filter(
			(m) =>
				(m.status === "active" || m.status === "placeholder") &&
				m.role !== "viewer",
		)
		.map((m) => ({
			memberId: m.id,
			name: m.name,
			count: rateable.filter((n) => !n.priorities[m.id]).length,
			total: rateable.length,
		}));
	const moves = movesWithoutMode(ix, schedule);
	const days = daysPerCity(ix, schedule);
	const open =
		(nights.length ? 1 : 0) +
		(toBook.length ? 1 : 0) +
		(opening.length ? 1 : 0) +
		(unrated.some((u) => u.count > 0) ? 1 : 0) +
		(moves.length ? 1 : 0) +
		(days.unallocated !== 0 && days.planned > 0 ? 1 : 0);
	return { nights, toBook, opening, unrated, moves, days, open };
}
