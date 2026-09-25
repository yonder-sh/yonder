/**
 * `buildModel(ix, scopeId, lens, dayRange?)` (SPEC §8.3): the workspace model
 * behind the Plan, the map and the outline counts, for one scope, lens and day
 * range. One pass over the trip's ordered items:
 *
 * - **Visits**: runs of consecutive in-scope items that share a representative
 *   (`repAt`) at the lens. Unlocated items never open a visit; they join the
 *   open one (or the next). Visits never merge across a gap.
 * - **Transitions** between consecutive visits, travelled by the located pair
 *   that crosses them: a leg, a stay night or an overnight connector.
 * - **Ghosts** where the timeline leaves or re-enters the scope (or the day
 *   range), so boundary legs still show as stubs.
 * - **Folds**: whole days with nothing in scope, and stretches of out-of-scope
 *   items within a day.
 * - **Pins** (visited reps, hollow idea pins, stay pins) and **edges** with one
 *   GeoJSON feature per transition at place lens (one per edge coarser).
 */
import type { LineString } from "geojson";
import { concatLines, greatCircleLine, type LngLat, straightLine } from "./geo";
import { type GraphIndex, pairKey, stayKey } from "./graph-index";
import { repAt } from "./lens";
import type {
	DayRange,
	DetachedLeg,
	EdgeMode,
	Fold,
	Ghost,
	GraphItem,
	GraphLeg,
	Lens,
	MapEdge,
	Pin,
	Rep,
	Transition,
	Visit,
	WorkspaceModel,
} from "./types";

const MODE_WEIGHT: Record<EdgeMode, number> = {
	flight: 4,
	transit: 3,
	walk: 2,
	other: 1,
	unset: 0,
};

/** The heaviest mode among legs (flight > transit > walk > other), `unset` when none has one. */
export function heaviestMode(legs: readonly (GraphLeg | null)[]): EdgeMode {
	let best: EdgeMode = "unset";
	for (const l of legs) {
		const m: EdgeMode = l?.mode ?? "unset";
		if (MODE_WEIGHT[m] > MODE_WEIGHT[best]) best = m;
	}
	return best;
}

/** No provider or manual value: no row, no mode, an estimate source, or an untimed leg without minutes. */
export function legIsEstimate(ix: GraphIndex, leg: GraphLeg | null): boolean {
	if (!leg?.mode) return true;
	if (leg.source === "estimate") return true;
	if (ix.isTimed(leg)) return false;
	return leg.durationMin == null;
}

/**
 * A leg's stored line: walk geometry, the chosen transit route's geometry
 * (else its segment geometries in order), or the `other` geometry. Null when
 * there is none (duration-only custom routes, estimates, unset legs, NAVITIME
 * without shapes).
 */
export function storedGeometry(
	ix: GraphIndex,
	leg: GraphLeg | null,
): LineString | null {
	if (!leg) return null;
	const d = ix.legDetails(leg);
	if (d.kind === "walk" || d.kind === "other") return d.geometry ?? null;
	if (d.kind === "transit" && d.route) {
		if (d.route.geometry) return d.route.geometry;
		const segs = (d.route.segments ?? [])
			.map((s) => s.geometry)
			.filter((g): g is NonNullable<typeof g> => !!g);
		return segs.length ? concatLines(segs) : null;
	}
	return null;
}

export const inDayRange = (
	date: string | undefined,
	range: DayRange | null | undefined,
): boolean => !range || (!!date && date >= range.from && date <= range.to);

type Status = "in" | "scope" | "days" | "none";

export function buildModel(
	ix: GraphIndex,
	scopeId: string | null,
	lens: Lens,
	dayRange?: DayRange | null,
): WorkspaceModel {
	const range = dayRange ?? null;
	const scope = scopeId ? ix.node(scopeId) : undefined;
	const scopeKey = scope ? scope.id : null;
	const placeLens = lens === "place";

	// ---- helpers -------------------------------------------------------------
	const repCache = new Map<string, Rep>();
	const rep = (nodeId: string): Rep => {
		let r = repCache.get(nodeId);
		if (!r) {
			r = repAt(ix, nodeId, lens, scopeKey);
			repCache.set(nodeId, r);
		}
		return r;
	};
	const dateOf = (item: GraphItem) => ix.day(item.dayId)?.date;
	const status = (item: GraphItem): Status => {
		if (!inDayRange(dateOf(item), range)) return "days";
		const eff = ix.effectiveNodeId(item.id);
		if (eff === null) return scopeKey === null ? "none" : "scope";
		return ix.isWithin(eff, scopeKey) ? "in" : "scope";
	};
	const statusOf = new Map<string, Status>();
	for (const it of ix.ordered) statusOf.set(it.id, status(it));
	const isIn = (id: string) => statusOf.get(id) === "in";
	/** Nearest located item at or before / at or after an item in `ordered`. */
	const locatedAtOrBefore = (it: GraphItem) =>
		it.nodeId ? it : ix.prevLocated(it.id);
	const locatedAtOrAfter = (it: GraphItem) =>
		it.nodeId ? it : ix.nextLocated(it.id);
	const outsideRepType = scope?.type ?? "country";

	// ---- the walk ------------------------------------------------------------
	const visits: Visit[] = [];
	const transitions: Transition[] = [];
	const ghosts: Ghost[] = [];
	const visitOfItem: Record<string, string> = {};
	const lastLocatedOf = new Map<string, GraphItem>();
	const pinNumberOf = new Map<string, number>();
	const occurrences = new Map<string, number>();

	let cur: Visit | null = null;
	let lastIn: GraphItem | null = null;
	let outRun: { item: GraphItem; reason: "scope" | "days" }[] = [];
	let held: GraphItem[] = [];
	let pendingIn: { item: GraphItem; reason: "scope" | "days" } | null = null;

	const addToVisit = (v: Visit, it: GraphItem) => {
		v.itemIds.push(it.id);
		if (it.dayId && !v.dayIds.includes(it.dayId)) v.dayIds.push(it.dayId);
		visitOfItem[it.id] = v.key;
	};

	const ghost = (
		dir: "in" | "out",
		reason: "scope" | "days",
		visitKey: string,
		inside: GraphItem,
		outside: GraphItem,
	): Ghost => {
		const from =
			dir === "out" ? locatedAtOrBefore(inside) : locatedAtOrBefore(outside);
		const to =
			dir === "out" ? locatedAtOrAfter(outside) : locatedAtOrAfter(inside);
		const leg =
			from && to && from.nodeId !== to.nodeId
				? (ix.legByPair.get(pairKey(from.id, to.id)) ?? null)
				: null;
		const eff = ix.effectiveNodeId(outside.id);
		return {
			dir,
			reason,
			visitKey,
			insideItemId: inside.id,
			outsideItemId: outside.id,
			outsideRepId: eff ? repAt(ix, eff, outsideRepType, null).id : null,
			leg,
			pairKey:
				from && to ? pairKey(from.id, to.id) : pairKey(inside.id, outside.id),
		};
	};

	const transitionVia = (from: GraphItem, to: GraphItem): Transition["via"] => {
		const kind = ix.boundaryKind(from.id, to.id);
		return kind === "stay"
			? "stay"
			: kind === "overnight"
				? "overnight"
				: "leg";
	};

	for (const it of ix.ordered) {
		const s = statusOf.get(it.id) as Status;
		if (s === "none") continue; // root only: no effective node anywhere; shown, but no visit
		if (s !== "in") {
			outRun.push({ item: it, reason: s });
			continue;
		}
		if (outRun.length) {
			// A gap: close the open visit; transitions never cross it.
			const firstOut = outRun[0] as (typeof outRun)[number];
			if (lastIn && cur)
				ghosts.push(
					ghost("out", firstOut.reason, cur.key, lastIn, firstOut.item),
				);
			cur = null;
			pendingIn = outRun.at(-1) ?? null;
			outRun = [];
		}
		if (!it.nodeId) {
			if (cur) addToVisit(cur, it);
			else held.push(it);
			lastIn = it;
			continue;
		}
		const r = rep(it.nodeId);
		if (cur && cur.repId === r.id) {
			addToVisit(cur, it);
		} else {
			if (!pinNumberOf.has(r.id)) pinNumberOf.set(r.id, pinNumberOf.size + 1);
			const occurrence = (occurrences.get(r.id) ?? 0) + 1;
			occurrences.set(r.id, occurrence);
			const v: Visit = {
				key: `${r.id}#${occurrence}`,
				repId: r.id,
				repMode: r.mode,
				itemIds: [],
				dayIds: [],
				ordinal: visits.length + 1,
				pinNumber: pinNumberOf.get(r.id) as number,
				occurrence,
			};
			for (const h of held) addToVisit(v, h);
			held = [];
			addToVisit(v, it);
			visits.push(v);
			const prev = cur ? lastLocatedOf.get(cur.key) : undefined;
			if (cur && prev) {
				const via = transitionVia(prev, it);
				const t: Transition = {
					fromVisit: cur.key,
					toVisit: v.key,
					fromItemId: prev.id,
					toItemId: it.id,
					via,
					leg: ix.legByPair.get(pairKey(prev.id, it.id)) ?? null,
				};
				if (via === "stay")
					t.stayLegs = {
						end: prev.dayId
							? (ix.legByStay.get(stayKey(prev.dayId, "end")) ?? null)
							: null,
						start: it.dayId
							? (ix.legByStay.get(stayKey(it.dayId, "start")) ?? null)
							: null,
					};
				transitions.push(t);
			}
			cur = v;
		}
		if (pendingIn) {
			ghosts.push(ghost("in", pendingIn.reason, cur.key, it, pendingIn.item));
			pendingIn = null;
		}
		lastLocatedOf.set(cur.key, it);
		lastIn = it;
	}
	const trailing = outRun[0];
	if (trailing && lastIn && cur)
		ghosts.push(ghost("out", trailing.reason, cur.key, lastIn, trailing.item));

	// ---- folds ---------------------------------------------------------------
	const folds: Fold[] = [];
	if (scopeKey !== null) {
		let run: string[] = [];
		const closeRun = () => {
			if (run.length) folds.push({ kind: "days", dayIds: run });
			run = [];
		};
		const labelOf = (items: readonly GraphItem[]): string | null => {
			let label: string | null | undefined;
			for (const it of items) {
				const eff = ix.effectiveNodeId(it.id);
				if (!eff) continue;
				const id = repAt(ix, eff, outsideRepType, null).id;
				if (label === undefined) label = id;
				else if (label !== id) return null;
			}
			return label ?? null;
		};
		for (const day of ix.days) {
			if (!inDayRange(day.date, range)) continue;
			const list = ix.itemsByDay.get(day.id) ?? [];
			const anyIn = list.some((it) => isIn(it.id));
			// Days outside the scope fold together, unless a day range asked for them (it expands them).
			if (!anyIn && !range) {
				run.push(day.id);
				continue;
			}
			closeRun();
			let stretch: GraphItem[] = [];
			const closeStretch = () => {
				if (stretch.length)
					folds.push({
						kind: "stretch",
						dayId: day.id,
						itemIds: stretch.map((i) => i.id),
						labelNodeId: labelOf(stretch),
					});
				stretch = [];
			};
			for (const it of list) {
				if (isIn(it.id)) closeStretch();
				else stretch.push(it);
			}
			closeStretch();
		}
		closeRun();
	}

	// ---- pins ----------------------------------------------------------------
	/**
	 * QA GRAN-07: a visited node with no coordinates of its own (nor located
	 * children) is pinned on its nearest located ancestor, so the day's line
	 * still runs through it (its features are `approx`). Ideas stay unpinned.
	 */
	const locatedCoord = (id: string | null | undefined): LngLat | null => {
		if (!id) return null;
		const own = ix.coordOf(id);
		if (own) return own;
		for (const a of ix.hierarchy.ancestors(id)) {
			const c = ix.coordOf(a.id);
			if (c) return c;
		}
		return null;
	};
	const pinCoord = (repId: string): LngLat | null => locatedCoord(repId);
	const pinsByRep = new Map<string, Pin>();
	const itemMinutes = (id: string) => ix.item(id)?.durationMin ?? 0;
	for (const v of visits) {
		const node = ix.node(v.repId);
		const c = pinCoord(v.repId);
		if (!node || !c) continue; // listed, not drawn
		let pin = pinsByRep.get(v.repId);
		if (!pin) {
			pin = {
				repId: v.repId,
				type: node.type,
				repMode: v.repMode,
				lng: c[0],
				lat: c[1],
				number: v.pinNumber,
				visits: 0,
				minutes: 0,
				hollow: false,
				stay: false,
				dayIds: [],
			};
			pinsByRep.set(v.repId, pin);
		}
		pin.visits += 1;
		pin.minutes += v.itemIds.reduce((s, id) => s + itemMinutes(id), 0);
		for (const d of v.dayIds) if (!pin.dayIds.includes(d)) pin.dayIds.push(d);
	}
	// Stay pins: stay nodes in scope (and range) with no visit get a bed pin.
	for (const day of ix.days) {
		if (!inDayRange(day.date, range) || !day.nightNodeId) continue;
		const stay = day.nightNodeId;
		if (!ix.node(stay) || !ix.isWithin(stay, scopeKey)) continue;
		const r = rep(stay);
		const existing = pinsByRep.get(r.id);
		if (existing) {
			if (r.id === stay) existing.stay = true;
			if (!existing.dayIds.includes(day.id)) existing.dayIds.push(day.id);
			continue;
		}
		const node = ix.node(r.id);
		const c = pinCoord(r.id);
		if (!node || !c) continue;
		pinsByRep.set(r.id, {
			repId: r.id,
			type: node.type,
			repMode: r.mode,
			lng: c[0],
			lat: c[1],
			number: null,
			visits: 0,
			minutes: 0,
			hollow: false,
			stay: r.id === stay,
			dayIds: [day.id],
		});
	}
	// Hollow (idea) pins: live, active, unscheduled nodes in scope. Hidden while a day range is active.
	if (!range) {
		const candidates = scope ? ix.hierarchy.descendants(scope.id) : ix.outline;
		for (const n of candidates) {
			if (ix.scheduledNodeIds.has(n.id) || ix.isDropped(n.id)) continue;
			const r = rep(n.id);
			if (pinsByRep.has(r.id)) continue;
			const node = ix.node(r.id);
			const c = ix.coordOf(r.id);
			if (!node || !c) continue;
			pinsByRep.set(r.id, {
				repId: r.id,
				type: node.type,
				repMode: r.mode,
				lng: c[0],
				lat: c[1],
				number: null,
				visits: 0,
				minutes: 0,
				hollow: true,
				stay: false,
				dayIds: [],
			});
		}
	}
	const pins = [...pinsByRep.values()].sort(
		(a, b) =>
			(a.number ?? Number.POSITIVE_INFINITY) -
				(b.number ?? Number.POSITIVE_INFINITY) ||
			ix.outlineIndex(a.repId) - ix.outlineIndex(b.repId),
	);

	// ---- edges ---------------------------------------------------------------
	const edgeMap = new Map<string, MapEdge>();
	const visitRep = new Map(visits.map((v) => [v.key, v.repId]));
	const edgeFor = (
		kind: MapEdge["kind"],
		from: string,
		to: string,
	): MapEdge => {
		const key = (
			kind === "travel" ? `${from}>${to}` : `${from}>${to}#${kind}`
		) as MapEdge["key"];
		let e = edgeMap.get(key);
		if (!e) {
			e = {
				key,
				kind,
				fromRepId: from,
				toRepId: to,
				transitions: [],
				legIds: [],
				mode: "unset",
				estimate: false,
				count: 0,
				curved: false,
				features: [],
			};
			edgeMap.set(key, e);
		}
		return e;
	};
	const nodeLine = (
		fromNodeId: string | null | undefined,
		toNodeId: string | null | undefined,
		flight: boolean,
	): LineString | null => {
		const a = locatedCoord(fromNodeId);
		const b = locatedCoord(toNodeId);
		if (!a || !b) return null;
		return flight ? greatCircleLine(a, b) : straightLine(a, b);
	};
	const edgeLegs = new Map<string, (GraphLeg | null)[]>();

	for (const t of transitions) {
		const from = visitRep.get(t.fromVisit) as string;
		const to = visitRep.get(t.toVisit) as string;
		if (from === to || !pinsByRep.has(from) || !pinsByRep.has(to)) continue; // no coordinates: not drawn
		if (t.via === "stay") continue; // drawn as stay edges below
		const e = edgeFor(t.via === "overnight" ? "overnight" : "travel", from, to);
		e.transitions.push(t);
		e.count += 1;
		if (e.kind === "travel") {
			const legs = edgeLegs.get(e.key) ?? [];
			legs.push(t.leg);
			edgeLegs.set(e.key, legs);
			if (t.leg && !e.legIds.includes(t.leg.id)) e.legIds.push(t.leg.id);
		}
		if (placeLens) {
			const flight = t.leg?.mode === "flight";
			const stored =
				e.kind === "travel" && !flight ? storedGeometry(ix, t.leg) : null;
			const line =
				stored ??
				nodeLine(
					ix.item(t.fromItemId)?.nodeId,
					ix.item(t.toItemId)?.nodeId,
					flight,
				);
			if (line)
				e.features.push({
					fid: `${e.key}|${t.fromItemId}>${t.toItemId}`,
					edgeKey: e.key,
					pairKey: pairKey(t.fromItemId, t.toItemId),
					legId: t.leg?.id ?? null,
					mode: e.kind === "overnight" ? "overnight" : (t.leg?.mode ?? "unset"),
					approx: !stored && !flight,
					geometry: line,
				});
		}
	}

	// Stay edges: rep(last item) → rep(stay) in the evening, rep(stay) → rep(first item) in the morning.
	for (const day of ix.days) {
		if (!inDayRange(day.date, range)) continue;
		for (const plan of [ix.eveningStay(day.id), ix.morningStay(day.id)]) {
			if (
				!plan ||
				!isIn(plan.anchorItemId) ||
				!ix.isWithin(plan.stayNodeId, scopeKey)
			)
				continue;
			const from = rep(plan.fromNodeId).id;
			const to = rep(plan.toNodeId).id;
			if (from === to || !pinsByRep.has(from) || !pinsByRep.has(to)) continue;
			const e = edgeFor("stay", from, to);
			const row = ix.legByStay.get(stayKey(plan.dayId, plan.end)) ?? null;
			e.count += 1;
			e.stays = [...(e.stays ?? []), { dayId: plan.dayId, end: plan.end }];
			if (row && !e.legIds.includes(row.id)) e.legIds.push(row.id);
			const legs = edgeLegs.get(e.key) ?? [];
			legs.push(row);
			edgeLegs.set(e.key, legs);
			if (placeLens) {
				const stored = storedGeometry(ix, row);
				const line = stored ?? nodeLine(plan.fromNodeId, plan.toNodeId, false);
				if (line)
					e.features.push({
						fid: `${e.key}|${plan.dayId}:${plan.end}`,
						edgeKey: e.key,
						pairKey: null,
						legId: row?.id ?? null,
						mode: "stay",
						approx: !stored,
						geometry: line,
					});
			}
		}
	}

	const edges = [...edgeMap.values()];
	for (const e of edges) {
		const legs = edgeLegs.get(e.key) ?? [];
		if (e.kind !== "overnight") {
			e.mode = heaviestMode(legs);
			e.estimate = legs.some((l) => legIsEstimate(ix, l));
		}
		e.curved =
			e.fromRepId > e.toRepId &&
			edgeMap.has(
				e.kind === "travel"
					? `${e.toRepId}>${e.fromRepId}`
					: `${e.toRepId}>${e.fromRepId}#${e.kind}`,
			);
		// Coarser lenses: one straight (or great-circle) feature per edge, pin to pin.
		if (!placeLens) {
			const a = coordsOf(pinsByRep.get(e.fromRepId));
			const b = coordsOf(pinsByRep.get(e.toRepId));
			const flight = e.mode === "flight";
			e.features = [
				{
					fid: e.key,
					edgeKey: e.key,
					pairKey: null,
					legId: null,
					mode: e.kind === "travel" ? e.mode : e.kind,
					approx: false,
					geometry: flight ? greatCircleLine(a, b) : straightLine(a, b),
				},
			];
		}
	}

	// ---- detached legs and unscheduled ---------------------------------------
	const itemInScope = (id: string): boolean => {
		const it = ix.item(id);
		if (!it) return scopeKey === null;
		if (it.dayId === null || !ix.day(it.dayId))
			return scopeKey === null || ix.isWithin(it.nodeId, scopeKey);
		const eff = ix.effectiveNodeId(id);
		return scopeKey === null || ix.isWithin(eff, scopeKey);
	};
	const detachedLegs: DetachedLeg[] = ix.detachedLegs.filter((d) => {
		if (!itemInScope(d.fromItemId) && !itemInScope(d.toItemId)) return false;
		if (!range) return true;
		return d.dayId !== null && inDayRange(ix.day(d.dayId)?.date, range);
	});
	const unscheduled = ix.unscheduled
		.filter((it) => scopeKey === null || ix.isWithin(it.nodeId, scopeKey))
		.map((it) => it.id);

	return {
		scopeId: scopeKey,
		lens,
		dayRange: range,
		visits,
		transitions,
		ghosts,
		folds,
		pins,
		edges,
		detachedLegs,
		unscheduled,
		visitOfItem,
	};
}

function coordsOf(pin: Pin | undefined): LngLat {
	return pin ? [pin.lng, pin.lat] : [0, 0];
}
