/**
 * The Plan's layout, as plain data (DESIGN §7.1, SPEC §8.3 "Timeline folding"
 * and "Timeline presentation per lens"). Pure: the index, the model and the
 * schedule in, a list of entries and rows out, so every rule here is unit
 * tested without React.
 *
 * - **Entries** are what the Plan scrolls through: day sections, folds of
 *   whole days ("3 days elsewhere ⋯", "2 days before ⋯"), and at the city,
 *   region and country lenses the visit **bands** with the transition rows
 *   between them.
 * - **Rows** are what a day section renders. An item row carries its `lead`
 *   (the incoming leg, stay leg, flight stub, ghost or free-time gap), so the
 *   leg moves with the card while it is dragged (spikes/dnd). Everything else
 *   (overnight connectors, stay legs at the end of a day, legs that leave the
 *   day, ghosts that leave the scope, stretch folds, unlinked transit) is a
 *   row of its own.
 * - At the **area** lens, consecutive items of one visit on one day are
 *   grouped under a block header ("Shibuya · 5 stops · 10:00–15:30").
 */
import { type GraphIndex, pairKey } from "@/lib/engine/graph-index";
import type { ProposalMark } from "@/lib/engine/proposals";
import { localDateOf, safeTimeZone } from "@/lib/engine/time";
import type {
	DayRange,
	Ghost,
	GraphItem,
	Lens,
	ScheduleResult,
	Transition,
	Visit,
	WorkspaceModel,
} from "@/lib/engine/types";

/** Rows rendered inside an item's sortable `<li>`, above its card. */
export type LeadRow =
	| { kind: "stay"; key: string; dayId: string }
	| {
			kind: "leg";
			key: string;
			fromItemId: string;
			toItemId: string;
			crossDay: boolean;
	  }
	| {
			kind: "continued";
			key: string;
			fromItemId: string;
			toItemId: string;
	  }
	| { kind: "ghost"; ghost: Ghost }
	| { kind: "gap"; itemId: string; minutes: number };

export type PlanRow =
	| {
			kind: "item";
			itemId: string;
			lead: LeadRow[];
			/** A layover inside a flight connection: drawn as a hatched block, not a card. */
			layover: boolean;
			/** Area lens: the block this card belongs to. */
			blockKey: string | null;
	  }
	| {
			kind: "block";
			key: string;
			visitKey: string;
			repId: string;
			itemIds: string[];
			/** The legs into the block (drawn above its header). */
			lead: LeadRow[];
	  }
	| { kind: "overnight"; key: string; fromItemId: string; toItemId: string }
	| { kind: "stay-end"; key: string; dayId: string }
	| {
			kind: "leg-out";
			key: string;
			fromItemId: string;
			toItemId: string;
	  }
	| { kind: "ghost"; ghost: Ghost }
	| {
			kind: "fold";
			dayId: string;
			itemIds: string[];
			labelNodeId: string | null;
	  }
	| { kind: "unlinked"; legId: string; fromItemId: string; toItemId: string };

export type DaySection = {
	dayId: string;
	rows: PlanRow[];
	/** Items hidden by the person filter. */
	hidden: number;
	/** Visible item ids in order (the day's sortable list). */
	itemIds: string[];
};

export type PlanEntry =
	| { kind: "day"; dayId: string; only: readonly string[] | null; key: string }
	| {
			kind: "days-fold";
			key: string;
			dayIds: string[];
			reason: "scope" | "before" | "after";
	  }
	| {
			kind: "band";
			key: string;
			visit: Visit;
			/**
			 * The band's day sections in date order: its visit's days (with the
			 * items the band shows on each) and, at the root, the free days that
			 * fall inside its span (QA TL-01: days always run in date order).
			 */
			days: BandDay[];
	  }
	| { kind: "band-link"; key: string; transition: Transition };

/** One day section inside a band; `only: null` for a free day (no items). */
export type BandDay = {
	dayId: string;
	only: ReadonlySet<string> | null;
	/**
	 * Set when the day is drawn in more than one band (it crosses two
	 * countries): which drawing this is, by the first card it shows. It
	 * qualifies the drawing's live-cursor anchors (FB-17, `copyAnchorId`) so
	 * a cursor on the second drawing lands on the second drawing everywhere.
	 */
	copy?: string;
};

export type PlanContext = {
	ix: GraphIndex;
	model: WorkspaceModel;
	schedule: ScheduleResult;
	scopeId: string | null;
	lens: Lens;
	days: DayRange | null;
	/** Person filter (`who`): a member id, or null for everyone. */
	who: string | null;
	/**
	 * While suggestions are shown, `ix` and `model` simulate the open
	 * proposals (EXTENSIONS §3.6), so a suggested move "breaks" the real leg
	 * into its item. These are the legs detached on the server's own graph:
	 * only they get the amber "Unlinked transit" row (ADDENDUM §10: amber only
	 * for real conflicts; QA COLLAB-R2-01). Absent = `ix` is the server's.
	 */
	realDetached?: ReadonlySet<string> | null;
};

export const COARSE_LENSES: readonly Lens[] = ["country", "region", "city"];
export const isCoarse = (lens: Lens) => COARSE_LENSES.includes(lens);

/**
 * Hidden by the person filter: everything not tagged with `who` (QA TAG-01:
 * "Audrey" shows exactly the items Audrey is tagged on, like the Lists
 * "For: Audrey" filter; unassigned items hide too, so DESIGN §12's "Nothing
 * assigned to Maya here." can happen).
 */
export function hiddenByWho(item: GraphItem, who: string | null): boolean {
	return who !== null && !item.assigneeIds.includes(who);
}

/**
 * True when the person filter hides everything the Plan would show: no item
 * of a shown day (a band's day: only the items it shows) nor of Unscheduled
 * is tagged with `who` (DESIGN §12 "Nothing assigned to Maya here.").
 */
export function nothingFor(
	ix: GraphIndex,
	entries: readonly PlanEntry[],
	unscheduled: readonly string[],
	who: string | null,
): boolean {
	if (who === null) return false;
	const visible = (it: GraphItem | null | undefined) =>
		!!it && !hiddenByWho(it, who);
	for (const e of entries) {
		const days: { dayId: string; only: ReadonlySet<string> | null }[] =
			e.kind === "day"
				? [{ dayId: e.dayId, only: null }]
				: e.kind === "band"
					? e.days
					: [];
		for (const d of days)
			for (const it of ix.itemsByDay.get(d.dayId) ?? [])
				if ((!d.only || d.only.has(it.id)) && visible(it)) return false;
	}
	return !unscheduled.some((id) => visible(ix.item(id)));
}

/**
 * The zone a day ends in: the local zone of its last stop (ADDENDUM §7.2).
 * `schedule.days[id].tz` is the zone the day starts in, so a day that flies
 * Hanoi → Taipei would otherwise read "ends 18:00" for a 19:00 CST arrival.
 */
export function dayEndTz(
	ix: GraphIndex,
	schedule: ScheduleResult,
	dayId: string,
): string | null {
	const sd = schedule.days[dayId];
	if (!sd) return null;
	let tz = sd.tz;
	let end = Number.NEGATIVE_INFINITY;
	for (const it of ix.itemsByDay.get(dayId) ?? []) {
		const s = schedule.items[it.id];
		if (!s) continue;
		const t = s.end.getTime();
		if (t >= end) {
			end = t;
			tz = s.tz;
		}
	}
	return tz;
}

/**
 * When a day ends, for its summary: the end of its last stop or, on a travel
 * day, the moment its flight or night train leaves (QA VIS2-06: "Travel 16h ·
 * ends 00:00" read as if the day were over before NH 9 left JFK at 02:00;
 * "Travel 8h05 · ends 09:00" for SP3 at 21:35). The schedule does the same
 * (`schedule.days[d].end`); this also names the departure's zone. `plusDays`
 * counts the calendar days past the day's date in that zone (the ⁺¹).
 */
export function dayEnd(
	ix: GraphIndex,
	schedule: ScheduleResult,
	dayId: string,
): { at: Date; tz: string; plusDays: number } | null {
	const sd = schedule.days[dayId];
	const date = ix.day(dayId)?.date;
	if (!sd || !date) return null;
	let at = sd.end;
	let tz = dayEndTz(ix, schedule, dayId) ?? sd.tz;
	const last = ix.lastLocated(dayId);
	const next = last ? ix.nextLocated(last.id) : null;
	if (last && next && next.dayId !== dayId && next.nodeId !== last.nodeId) {
		const leg = ix.legByPair.get(pairKey(last.id, next.id));
		if (ix.isTimed(leg)) {
			const d = ix.legDetails(leg);
			const dep = Date.parse(leg.depAt);
			const fromTz = safeTimeZone(
				d.kind === "flight" ? d.flight.from?.tz : null,
				d.kind === "transit" ? d.fixed?.fromTz : null,
				ix.tzOf(last.nodeId),
			);
			// Only a departure on this day's own date ends it.
			if (localDateOf(dep, fromTz) === date && dep >= at.getTime()) {
				at = new Date(dep);
				tz = fromTz;
			}
		}
	}
	const endDate = localDateOf(at.getTime(), tz);
	const plusDays = Math.max(
		0,
		Math.round(
			(Date.parse(`${endDate}T00:00:00Z`) - Date.parse(`${date}T00:00:00Z`)) /
				86_400_000,
		),
	);
	return { at, tz, plusDays };
}

/**
 * A cross-day pair travelled by a timed leg, or by a flight without times
 * (FB-18): drawn on its departure day, "continued" on its arrival day.
 */
export function leavesTheNightBefore(
	ix: GraphIndex,
	fromItemId: string,
	toItemId: string,
): boolean {
	const kind = ix.boundaryKind(fromItemId, toItemId);
	if (kind === "timed") return true;
	if (kind !== "moded") return false;
	const leg = ix.legByPair.get(pairKey(fromItemId, toItemId));
	return !!leg && leg.mode === "flight" && ix.legDetails(leg).kind === "flight";
}

const inRange = (date: string, range: DayRange | null) =>
	!range || (date >= range.from && date <= range.to);

/** The key of an area block: one per visit per day. */
export const blockKeyOf = (dayId: string, visitKey: string) =>
	`${dayId}|${visitKey}`;

/**
 * A layover: an item strictly inside a flight chain (§7.9), e.g. IST between
 * TK 25 and TK 11. Drawn as the hatched "Layover 2h 20m · IST" block.
 */
export function isLayover(ix: GraphIndex, itemId: string): boolean {
	const chain = ix.blockOf(itemId);
	if (!chain) return false;
	const i = chain.indexOf(itemId);
	return i > 0 && i < chain.length - 1;
}

/**
 * One day's rows. `only` limits the section to some items (a band shows the
 * part of a day that belongs to its visit); `skipLeadOf` drops the incoming
 * leg of an item whose transition is drawn elsewhere (a band link).
 */
export function buildDaySection(
	ctx: PlanContext,
	dayId: string,
	opts: { only?: ReadonlySet<string> | null; skipLeadOf?: string | null } = {},
): DaySection {
	const { ix, model, schedule, who, lens } = ctx;
	const all = ix.itemsByDay.get(dayId) ?? [];
	const only = opts.only ?? null;
	const rows: PlanRow[] = [];
	const itemIds: string[] = [];
	let hidden = 0;

	const stretchOf = new Map<
		string,
		{ itemIds: string[]; labelNodeId: string | null }
	>();
	for (const f of model.folds)
		if (f.kind === "stretch" && f.dayId === dayId)
			for (const id of f.itemIds) stretchOf.set(id, f);
	const ghostIn = new Map<string, Ghost>();
	const ghostOut = new Map<string, Ghost[]>();
	for (const g of model.ghosts) {
		if (g.dir === "in") ghostIn.set(g.insideItemId, g);
		else {
			const list = ghostOut.get(g.insideItemId) ?? [];
			list.push(g);
			ghostOut.set(g.insideItemId, list);
		}
	}
	const detachedByFrom = new Map<string, typeof model.detachedLegs>();
	const detachedLoose: typeof model.detachedLegs = [];
	for (const d of model.detachedLegs) {
		if (d.dayId !== dayId) continue;
		// Detached only in the simulation of a suggestion: the ghost and the
		// origin row say what would move; nothing offers Relink or Discard.
		if (ctx.realDetached && !ctx.realDetached.has(d.legId)) continue;
		const from = ix.item(d.fromItemId);
		if (from?.dayId === dayId) {
			const list = detachedByFrom.get(d.fromItemId) ?? [];
			list.push(d);
			detachedByFrom.set(d.fromItemId, list);
		} else detachedLoose.push(d);
	}

	const shown = (it: GraphItem) => (only ? only.has(it.id) : true);
	const visibleIds = new Set(
		all
			.filter(
				(it) => shown(it) && !stretchOf.has(it.id) && !hiddenByWho(it, who),
			)
			.map((it) => it.id),
	);

	// The overnight connector across the day boundary (no stay, no travel).
	const firstLoc = ix.firstLocated(dayId);
	if (
		firstLoc &&
		visibleIds.has(firstLoc.id) &&
		firstLoc.id !== opts.skipLeadOf
	) {
		const p = ix.prevLocated(firstLoc.id);
		if (
			p &&
			p.dayId !== dayId &&
			p.nodeId !== firstLoc.nodeId &&
			!ghostIn.has(firstLoc.id) &&
			ix.boundaryKind(p.id, firstLoc.id) === "overnight"
		)
			rows.push({
				kind: "overnight",
				key: pairKey(p.id, firstLoc.id),
				fromItemId: p.id,
				toItemId: firstLoc.id,
			});
	}

	const morning = ix.morningStay(dayId);

	// The timed leg that leaves this day, drawn at its end (unless the arrival
	// is outside the scope: then the ghost stands for it). A flight without
	// times leaves on its departure day too (FB-18).
	let legOut: { fromItemId: string; toItemId: string } | null = null;
	let deferGhostsOf: string | null = null;
	const lastLoc = ix.lastLocated(dayId);
	if (lastLoc && visibleIds.has(lastLoc.id)) {
		const x = ix.nextLocated(lastLoc.id);
		const outs = ghostOut.get(lastLoc.id) ?? [];
		if (
			x &&
			x.dayId !== dayId &&
			x.nodeId !== lastLoc.nodeId &&
			leavesTheNightBefore(ix, lastLoc.id, x.id) &&
			outs.every((g) => g.reason === "days")
		) {
			legOut = { fromItemId: lastLoc.id, toItemId: x.id };
			if (outs.length) deferGhostsOf = lastLoc.id;
		}
	}

	const seenStretch = new Set<string>();
	let blockKey: string | null = null;

	const leadOf = (it: GraphItem): LeadRow[] => {
		const lead: LeadRow[] = [];
		if (it.id === opts.skipLeadOf) {
			// The band link draws this transition.
		} else if (ghostIn.has(it.id)) {
			lead.push({ kind: "ghost", ghost: ghostIn.get(it.id) as Ghost });
			// The morning's stay leg still leaves from the night's stay (and its
			// minutes count): the ghost says where the day came from, the stay leg
			// how it starts (ADDENDUM §5: its Google Maps link included).
			if (morning?.anchorItemId === it.id)
				lead.push({ kind: "stay", key: `stay:${dayId}:start`, dayId });
		} else {
			if (morning?.anchorItemId === it.id)
				lead.push({ kind: "stay", key: `stay:${dayId}:start`, dayId });
			const p = it.nodeId ? ix.prevLocated(it.id) : null;
			if (p && p.nodeId !== it.nodeId && !hiddenByWho(p, who)) {
				const key = pairKey(p.id, it.id);
				if (p.dayId === it.dayId)
					lead.push({
						kind: "leg",
						key,
						fromItemId: p.id,
						toItemId: it.id,
						crossDay: false,
					});
				else {
					const kind = ix.boundaryKind(p.id, it.id);
					if (leavesTheNightBefore(ix, p.id, it.id))
						lead.push({
							kind: "continued",
							key,
							fromItemId: p.id,
							toItemId: it.id,
						});
					else if (kind === "moded")
						lead.push({
							kind: "leg",
							key,
							fromItemId: p.id,
							toItemId: it.id,
							crossDay: true,
						});
				}
			}
		}
		const free = schedule.items[it.id]?.freeBeforeMin ?? 0;
		if (free > 0) lead.push({ kind: "gap", itemId: it.id, minutes: free });
		return lead;
	};

	for (const it of all) {
		if (!shown(it)) continue;
		const stretch = stretchOf.get(it.id);
		if (stretch) {
			const k = stretch.itemIds[0] ?? it.id;
			if (!seenStretch.has(k)) {
				seenStretch.add(k);
				blockKey = null;
				rows.push({
					kind: "fold",
					dayId,
					itemIds: stretch.itemIds,
					labelNodeId: stretch.labelNodeId,
				});
			}
			continue;
		}
		if (hiddenByWho(it, who)) {
			hidden++;
			continue;
		}
		const lead = leadOf(it);
		const visitKey = model.visitOfItem[it.id];
		if (lens === "area" && visitKey) {
			const key = blockKeyOf(dayId, visitKey);
			if (key !== blockKey) {
				blockKey = key;
				const visit = model.visits.find((v) => v.key === visitKey);
				const members = all
					.filter(
						(x) => visibleIds.has(x.id) && model.visitOfItem[x.id] === visitKey,
					)
					.map((x) => x.id);
				// A one-stop visit of the place itself needs no header.
				const trivial =
					members.length === 1 &&
					visit !== undefined &&
					visit.repId === it.nodeId;
				if (visit && !trivial) {
					// The legs into the block go above its header; the gap stays on the card.
					const moved = lead.filter((l) => l.kind !== "gap");
					rows.push({
						kind: "block",
						key,
						visitKey,
						repId: visit.repId,
						itemIds: members,
						lead: moved,
					});
					rows.push({
						kind: "item",
						itemId: it.id,
						lead: lead.filter((l) => l.kind === "gap"),
						layover: isLayover(ix, it.id),
						blockKey: key,
					});
					itemIds.push(it.id);
					pushAfter(it);
					continue;
				}
				blockKey = trivial ? null : key;
			}
			rows.push({
				kind: "item",
				itemId: it.id,
				lead,
				layover: isLayover(ix, it.id),
				blockKey: blockKey,
			});
		} else {
			blockKey = null;
			rows.push({
				kind: "item",
				itemId: it.id,
				lead,
				layover: isLayover(ix, it.id),
				blockKey: null,
			});
		}
		itemIds.push(it.id);
		pushAfter(it);
	}

	function pushAfter(it: GraphItem) {
		if (it.id !== deferGhostsOf)
			for (const g of ghostOut.get(it.id) ?? [])
				rows.push({ kind: "ghost", ghost: g });
		for (const d of detachedByFrom.get(it.id) ?? [])
			rows.push({
				kind: "unlinked",
				legId: d.legId,
				fromItemId: d.fromItemId,
				toItemId: d.toItemId,
			});
	}

	// A timed leg that leaves this day (an overnight flight or night train).
	if (legOut)
		rows.push({
			kind: "leg-out",
			key: pairKey(legOut.fromItemId, legOut.toItemId),
			fromItemId: legOut.fromItemId,
			toItemId: legOut.toItemId,
		});
	// A day range cuts off the arrival, not the departure (QA UX-01): the stub
	// stays on its departure day, and the ghost to the arrival follows it.
	if (deferGhostsOf)
		for (const g of ghostOut.get(deferGhostsOf) ?? [])
			rows.push({ kind: "ghost", ghost: g });
	for (const d of detachedLoose)
		rows.push({
			kind: "unlinked",
			legId: d.legId,
			fromItemId: d.fromItemId,
			toItemId: d.toItemId,
		});
	const evening = ix.eveningStay(dayId);
	if (evening && visibleIds.has(evening.anchorItemId))
		rows.push({ kind: "stay-end", key: `stay:${dayId}:end`, dayId });

	return { dayId, rows, hidden, itemIds };
}

/**
 * The Plan's entries for the current scope, lens, day range and person
 * filter. Day sections at the place and area lenses (with folds for days
 * elsewhere or outside the range); visit bands with their transitions at the
 * city, region and country lenses.
 */
export function buildPlanEntries(ctx: PlanContext): PlanEntry[] {
	const { ix, model, scopeId, days } = ctx;
	const entries: PlanEntry[] = [];

	// Days outside the selected range fold into "N days before ⋯" / "N days after ⋯".
	const before = days
		? ix.days.filter((d) => d.date < days.from).map((d) => d.id)
		: [];
	const after = days
		? ix.days.filter((d) => d.date > days.to).map((d) => d.id)
		: [];
	if (before.length)
		entries.push({
			kind: "days-fold",
			key: "before",
			dayIds: before,
			reason: "before",
		});

	if (isCoarse(ctx.lens) && model.visits.length) {
		const covered = new Set<string>();
		const dayDate = (id: string) => ix.day(id)?.date ?? "";
		// Free days (no items at all) keep their place between the bands, at the root only.
		const freeDays =
			scopeId === null
				? ix.days.filter(
						(d) =>
							inRange(d.date, days) &&
							(ix.itemsByDay.get(d.id)?.length ?? 0) === 0,
					)
				: [];
		let free = 0;
		const flushFree = (untilDate: string | null) => {
			while (free < freeDays.length) {
				const d = freeDays[free];
				if (!d || (untilDate !== null && d.date >= untilDate)) break;
				entries.push({
					kind: "day",
					dayId: d.id,
					only: null,
					key: `day:${d.id}`,
				});
				free++;
			}
		};
		const ownDays = model.visits.map((v) => bandDays(ix, v));
		// A day in several bands (it crosses two countries) is drawn once per band.
		const drawings = new Map<string, number>();
		for (const own of ownDays)
			for (const d of own)
				drawings.set(d.dayId, (drawings.get(d.dayId) ?? 0) + 1);
		const drawing = (d: BandDay): BandDay => {
			if ((drawings.get(d.dayId) ?? 0) < 2 || !d.only) return d;
			const only = d.only;
			const first = (ix.itemsByDay.get(d.dayId) ?? []).find((it) =>
				only.has(it.id),
			);
			return first ? { ...d, copy: first.id } : d;
		};
		model.visits.forEach((v, i) => {
			const own = ownDays[i] ?? [];
			const firstDay = own[0]?.dayId;
			// Free days before the band go between the bands…
			flushFree(firstDay ? dayDate(firstDay) : null);
			if (i > 0) {
				const t = model.transitions.find((x) => x.toVisit === v.key);
				if (t)
					entries.push({
						kind: "band-link",
						key: `link:${v.key}`,
						transition: t,
					});
			}
			// …and the ones inside its span (Japan: Fri 8, the free 9–13, then the
			// KIX stop on Thu 14) inside it, so the days never run out of order.
			const bandDaysInOrder: BandDay[] = [];
			for (const d of own) {
				const date = dayDate(d.dayId);
				while (free < freeDays.length) {
					const f = freeDays[free];
					if (!f || f.date >= date) break;
					bandDaysInOrder.push({ dayId: f.id, only: null });
					free++;
				}
				bandDaysInOrder.push(drawing(d));
			}
			entries.push({
				kind: "band",
				key: `band:${v.key}`,
				visit: v,
				days: bandDaysInOrder,
			});
			for (const id of v.itemIds) covered.add(id);
		});
		flushFree(null);
	} else {
		const foldDays = new Map<string, string[]>();
		for (const f of model.folds)
			if (f.kind === "days" && f.dayIds[0]) foldDays.set(f.dayIds[0], f.dayIds);
		const folded = new Set(
			model.folds.flatMap((f) => (f.kind === "days" ? f.dayIds : [])),
		);
		for (const d of ix.days) {
			if (!inRange(d.date, days)) continue;
			const fold = foldDays.get(d.id);
			if (fold) {
				entries.push({
					kind: "days-fold",
					key: `fold:${d.id}`,
					dayIds: fold,
					reason: "scope",
				});
				continue;
			}
			if (folded.has(d.id)) continue;
			// Inside a scope, a day with no items folds with the elsewhere days (the model does
			// that without a range); with a range every day in it shows.
			if (
				scopeId !== null &&
				!days &&
				(ix.itemsByDay.get(d.id)?.length ?? 0) === 0
			)
				continue;
			entries.push({
				kind: "day",
				dayId: d.id,
				only: null,
				key: `day:${d.id}`,
			});
		}
	}

	if (after.length)
		entries.push({
			kind: "days-fold",
			key: "after",
			dayIds: after,
			reason: "after",
		});
	return entries;
}

/** Day ids of a band's visit (in date order) with the item ids the band shows on each. */
export function bandDays(
	ix: GraphIndex,
	visit: Visit,
): { dayId: string; only: Set<string> }[] {
	const byDay = new Map<string, Set<string>>();
	for (const id of visit.itemIds) {
		const dayId = ix.item(id)?.dayId;
		if (!dayId) continue;
		const set = byDay.get(dayId) ?? new Set<string>();
		set.add(id);
		byDay.set(dayId, set);
	}
	return [...byDay.entries()]
		.map(([dayId, only]) => ({ dayId, only }))
		.sort((a, b) =>
			(ix.day(a.dayId)?.date ?? "").localeCompare(ix.day(b.dayId)?.date ?? ""),
		);
}

export type BandSummary = {
	from: string | null;
	to: string | null;
	nights: number;
	stops: number;
	plannedDays: number | null;
	scheduledDays: number;
};

/** "12–18 Apr · 6 nights · 23 stops · Planned 4 days · scheduled 3" (SPEC §8.3). */
export function bandSummary(ix: GraphIndex, visit: Visit): BandSummary {
	const dates = visit.dayIds
		.map((id) => ix.day(id)?.date)
		.filter((d): d is string => !!d)
		.sort();
	const from = dates[0] ?? null;
	const to = dates.at(-1) ?? null;
	const nights =
		from && to
			? Math.round(
					(Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) /
						86_400_000,
				)
			: 0;
	const stops = visit.itemIds.filter((id) => ix.item(id)?.nodeId).length;
	const planned = ix.node(visit.repId)?.details?.plannedDays;
	return {
		from,
		to,
		nights,
		stops,
		plannedDays: typeof planned === "number" ? planned : null,
		scheduledDays: new Set(dates).size,
	};
}

/** "Shibuya · 5 stops · 10:00–15:30": the block's located stops and its time span. */
export function blockSpan(
	schedule: ScheduleResult,
	itemIds: readonly string[],
): { start: Date | null; end: Date | null; tz: string | null } {
	let start: Date | null = null;
	let end: Date | null = null;
	let tz: string | null = null;
	for (const id of itemIds) {
		const s = schedule.items[id];
		if (!s) continue;
		if (!start || s.start < start) {
			start = s.start;
			tz = s.tz;
		}
		if (!end || s.end > end) end = s.end;
	}
	return { start, end, tz };
}

/** `originAnchors`: the origin row goes before the day's first card. */
export const ORIGIN_START = "^start";

/**
 * Where a day's E7 origin rows go (EXTENSIONS §3.7 "a 28px dashed row at the
 * old slot"; QA COLLAB-R3-02): after the card that came before the moved item
 * in the server's own order (`real`, the index without the simulated
 * suggestions), skipping cards this section doesn't show, or before the
 * first card (`ORIGIN_START`) when none did. The engine's `origin.afterId`
 * wins when it names a shown card. A mark whose item isn't on that day in
 * `real` stays in `rest` (drawn at the end of the day, as before).
 */
export function originAnchors(
	real: GraphIndex,
	dayId: string,
	shownItemIds: readonly string[],
	marks: readonly ProposalMark[],
): { at: Map<string, ProposalMark[]>; rest: ProposalMark[] } {
	const shown = new Set(shownItemIds);
	const order = (real.itemsByDay.get(dayId) ?? []).map((i) => i.id);
	const at = new Map<string, ProposalMark[]>();
	const rest: ProposalMark[] = [];
	for (const m of marks) {
		const entity = m.origin?.entity ?? "";
		const itemId = entity.startsWith("item:") ? entity.slice(5) : null;
		let anchor: string | null = null;
		const afterId = m.origin?.afterId ?? null;
		if (afterId && shown.has(afterId)) anchor = afterId;
		else if (itemId) {
			const i = order.indexOf(itemId);
			if (i >= 0) {
				anchor = ORIGIN_START;
				for (let k = i - 1; k >= 0; k--) {
					const id = order[k] as string;
					if (shown.has(id)) {
						anchor = id;
						break;
					}
				}
			}
		}
		if (anchor === null) rest.push(m);
		else at.set(anchor, [...(at.get(anchor) ?? []), m]);
	}
	return { at, rest };
}
