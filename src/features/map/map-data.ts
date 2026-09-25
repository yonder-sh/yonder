/**
 * What the map draws, as plain data (pure; unit-tested): pin view models and
 * the GeoJSON sources for edges, ghost stubs and their labels, built from the
 * workspace model (SPEC §8.3) plus the map's own options (DESIGN §9):
 *
 * - **Edges** keep the engine's one-feature-per-transition at place lens and
 *   one-per-edge coarser. A leg with a stored track (a walk, a chosen transit
 *   route, a Japan `estimate` or custom route with N02 geometry, JAPAN_TRANSIT
 *   §3) is drawn on that track at EVERY lens, snapped to its pins, instead of a
 *   straight line; only legs with no geometry stay straight (`approx`).
 *   Estimates are dashed (ADDENDUM §10: dashed = proposals and estimates),
 *   return trips bow to the left, a single transit line uses its own colour.
 * - **Ghost stubs** point off-scope (or off the selected days) and fade out.
 * - **Pins** carry their shape, size, number, dimming (day range "Dim others",
 *   the person filter, the shared `f` filter), E7 proposal marks and an
 *   accessible label ("2. Shibuya, 5 stops, Day 4").
 */
import type { Feature, FeatureCollection, LineString, Point } from "geojson";
import { PRIORITIES } from "@/lib/domain/taxonomy";
import type { LngLat } from "@/lib/engine/geo";
import {
	type GraphIndex,
	pairKey as toPairKey,
} from "@/lib/engine/graph-index";
import { repAt } from "@/lib/engine/lens";
import type { MarkKey, ProposalMark } from "@/lib/engine/proposals";
import type {
	DayRange,
	GraphLeg,
	Lens,
	MapEdge,
	NodeType,
	Pin,
	RepMode,
	WorkspaceModel,
} from "@/lib/engine/types";
import { legIsEstimate, storedGeometry } from "@/lib/engine/visits";
import { formatLeg } from "@/lib/format";
import { type Sel, serializeSel } from "@/lib/workspace/search";
import {
	type Bounds,
	boundsDiagonal,
	boundsOf,
	GLOBE_MAX_CAP,
	quadCurve,
	snapEnds,
	sphericalCap,
	toward,
} from "./geo-utils";
import { isHex, type LinePalette, type MapTheme, presenceHex } from "./palette";

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export type MapShow = { ideas: boolean; dropped: boolean; stays: boolean };

export type MapDataOptions = {
	theme: MapTheme;
	palette: LinePalette;
	lens: Lens;
	scopeId: string | null;
	/** The selected days (`days=`); with `dayMode: 'dim'` the model is the full one. */
	days: DayRange | null;
	dayMode: "only" | "dim";
	/** The person filter (`who`), a member id. */
	who: string | null;
	show: MapShow;
	/** `repId → matches the shared filter` (always true without one). */
	matches: (repId: string) => boolean;
	/** E7 marks (empty for viewers). */
	marks: ReadonlyMap<MarkKey, readonly ProposalMark[]>;
};

// ---------------------------------------------------------------------------
// Pins
// ---------------------------------------------------------------------------

export type PinShape =
	| "country"
	| "region"
	| "city"
	| "area"
	| "place"
	| "stay";

export type PinView = {
	repId: string;
	name: string;
	type: NodeType;
	shape: PinShape;
	lng: number;
	lat: number;
	number: number | null;
	/** Visits of this rep in scope (the "2×" badge). */
	visits: number;
	stops: number;
	minutes: number;
	hollow: boolean;
	dropped: boolean;
	stay: boolean;
	repMode: RepMode;
	/** The node has no own coordinates (drawn on its descendants'/ancestor's). */
	approx: boolean;
	/** Pixel diameter of the shape (level size × minutes × priority × finer/hollow). */
	size: number;
	/** Opacity from dimming (1 = none). */
	opacity: number;
	/** Hidden by the shared filter (hollow pins) or dimmed (visited ones). */
	filteredOut: boolean;
	dayIds: string[];
	countryCode: string | null;
	category: string | null;
	ariaLabel: string;
	proposal: {
		color: string;
		name: string;
		kind: ProposalMark["kind"];
		deleted: boolean;
		conflict: boolean;
	} | null;
};

const BASE_SIZE: Record<PinShape, number> = {
	country: 26,
	region: 22,
	city: 22,
	area: 20,
	place: 24,
	stay: 22,
};

function shapeOf(pin: Pin, ix: GraphIndex): PinShape {
	if (pin.stay && pin.visits === 0) return "stay";
	const node = ix.node(pin.repId);
	if (pin.type === "place" && node?.category === "lodging" && pin.stay)
		return "stay";
	return pin.type;
}

/** The size factor for a node's highest rating (CATEGORIES.md §4). */
function priorityOf(
	ix: GraphIndex,
	repId: string,
): { scale: number; fade: boolean } {
	const node = ix.node(repId);
	if (node?.type !== "place") return { scale: 1, fade: false };
	let best: keyof typeof PRIORITIES | null = null;
	for (const p of Object.values(node.priorities)) {
		if (!best || PRIORITIES[p].score > PRIORITIES[best].score) best = p;
	}
	if (!best) return { scale: 1, fade: false };
	return {
		scale: PRIORITIES[best].pinScale,
		fade: best === "meh" || best === "nah",
	};
}

const inRange = (date: string | undefined, r: DayRange | null) =>
	!r || (!!date && date >= r.from && date <= r.to);

function dayLabel(ix: GraphIndex, dayIds: readonly string[]): string | null {
	const nums = dayIds
		.map((d) => ix.dayNumber(d))
		.filter((n) => n > 0)
		.sort((a, b) => a - b);
	if (nums.length === 0) return null;
	const first = nums[0] as number;
	const last = nums.at(-1) as number;
	return first === last ? `Day ${first}` : `Days ${first}–${last}`;
}

/** Items of the pin's visits (for stop counts and the person filter). */
function itemsByRep(model: WorkspaceModel): Map<string, string[]> {
	const out = new Map<string, string[]>();
	for (const v of model.visits) {
		const list = out.get(v.repId) ?? [];
		list.push(...v.itemIds);
		out.set(v.repId, list);
	}
	return out;
}

/**
 * E7 marks for a pin: the node's own (a suggested place, rename, removal…),
 * else those of an item that visits this very node (a suggested move or
 * removal of "Shibuya Sky" marks the Shibuya Sky pin). Items that only roll up
 * into a coarser pin don't mark it (fewer badges, ADDENDUM §10).
 */
export function pinMarks(
	marks: MapDataOptions["marks"],
	ix: GraphIndex,
	repId: string,
	itemIds: readonly string[],
): readonly ProposalMark[] | undefined {
	if (marks.size === 0) return undefined;
	const own = marks.get(`node:${repId}`);
	if (own?.length) return own;
	for (const id of itemIds) {
		if (ix.item(id)?.nodeId !== repId) continue;
		const m = marks.get(`item:${id}`);
		if (m?.length) return m;
	}
	return undefined;
}

function proposalOf(
	marks: readonly ProposalMark[] | undefined,
	theme: MapTheme,
): PinView["proposal"] {
	if (!marks?.length) return null;
	const lead = marks.find((m) => !m.stacked) ?? marks[0];
	if (!lead) return null;
	return {
		color: presenceHex(lead.author.color, theme),
		name: lead.author.name,
		kind: lead.kind,
		deleted: lead.kind === "delete",
		conflict: marks.some((m) => m.conflict),
	};
}

const PROPOSAL_WORDS: Record<ProposalMark["kind"], string> = {
	create: "suggested",
	update: "change suggested",
	move: "move suggested",
	delete: "removal suggested",
	other: "change suggested",
};

/** The nearest ancestor with coordinates (QA GRAN-07), and its name. */
function ancestorCoord(
	ix: GraphIndex,
	id: string,
): { at: LngLat; name: string } | null {
	const path = ix.path(id);
	for (let i = path.length - 2; i >= 0; i--) {
		const n = path[i];
		const at = n ? ix.coordOf(n.id) : null;
		if (n && at) return { at, name: n.name };
	}
	return null;
}

/**
 * QA GRAN-07: a visited node with no coordinates of its own (nor located
 * children) is "listed, not drawn" by the engine; the map still pins it on its
 * nearest located ancestor, marked approximate (dashed, "location not set").
 * Since integration the engine pins visits there itself (and draws their
 * lines); this still covers anything it leaves out and names the ancestor.
 */
export function approxPins(
	model: WorkspaceModel,
	ix: GraphIndex,
): { pins: Pin[]; shownAt: Map<string, string> } {
	const drawn = new Set(model.pins.map((p) => p.repId));
	const out = new Map<string, Pin>();
	/** repId → the ancestor the pin is drawn on ("Shibuya"). */
	const shownAt = new Map<string, string>();
	for (const v of model.visits) {
		if (drawn.has(v.repId)) {
			// The engine already pins it on its nearest located ancestor
			// (`buildModel`); only the "shown at …" name is needed here.
			if (!shownAt.has(v.repId) && !ix.coordOf(v.repId)) {
				const anc = ancestorCoord(ix, v.repId);
				if (anc) shownAt.set(v.repId, anc.name);
			}
			continue;
		}
		const node = ix.node(v.repId);
		if (!node || ix.coordOf(v.repId)) continue;
		let pin = out.get(v.repId);
		if (!pin) {
			const anc = ancestorCoord(ix, v.repId);
			if (!anc) continue;
			shownAt.set(v.repId, anc.name);
			pin = {
				repId: v.repId,
				type: node.type,
				repMode: v.repMode,
				lng: anc.at[0],
				lat: anc.at[1],
				number: v.pinNumber,
				visits: 0,
				minutes: 0,
				hollow: false,
				stay: false,
				dayIds: [],
			};
			out.set(v.repId, pin);
		}
		pin.visits += 1;
		for (const id of v.itemIds) pin.minutes += ix.item(id)?.durationMin ?? 0;
		for (const d of v.dayIds) if (!pin.dayIds.includes(d)) pin.dayIds.push(d);
	}
	return { pins: [...out.values()], shownAt };
}

export function buildPins(
	model: WorkspaceModel,
	ix: GraphIndex,
	o: MapDataOptions,
): PinView[] {
	const items = itemsByRep(model);
	const approx = approxPins(model, ix);
	const dimDays = o.dayMode === "dim" && o.days !== null;
	const out: PinView[] = [];
	const seen = new Set<string>();
	const push = (pin: Pin, extra: { dropped?: boolean } = {}) => {
		const node = ix.node(pin.repId);
		if (!node) return;
		const shape = shapeOf(pin, ix);
		const hollow = pin.hollow || !!extra.dropped;
		if (hollow && (o.days || (!o.show.ideas && !extra.dropped))) return;
		if (shape === "stay" && pin.visits === 0 && !o.show.stays) return;
		const matches = o.matches(pin.repId);
		if (hollow && !matches) return; // ideas that don't match simply go away
		const pr = priorityOf(ix, pin.repId);
		let size =
			BASE_SIZE[shape] * (1 + Math.min(0.35, pin.minutes / 1440)) * pr.scale;
		if (pin.repMode === "finer") size *= 0.75;
		if (hollow) size *= 0.85;
		let opacity = pr.fade ? 0.6 : 1;
		const repItems = items.get(pin.repId) ?? [];
		if (dimDays && !pin.dayIds.some((d) => inRange(ix.day(d)?.date, o.days)))
			opacity = Math.min(opacity, 0.25);
		if (o.who && repItems.length > 0) {
			const forWho = repItems.some((id) => {
				const it = ix.item(id);
				return (
					!it ||
					it.assigneeIds.length === 0 ||
					it.assigneeIds.includes(o.who as string)
				);
			});
			if (!forWho) opacity = Math.min(opacity, 0.3);
		}
		if (!matches) opacity = Math.min(opacity, 0.25);
		const stops = repItems.length;
		const days = dayLabel(ix, pin.dayIds);
		const proposal = proposalOf(
			pinMarks(o.marks, ix, pin.repId, repItems),
			o.theme,
		);
		const unlocated = node.lat == null || node.lng == null;
		const parts = [
			`${pin.number ? `${pin.number}. ` : ""}${node.name}`,
			hollow ? (extra.dropped ? "dropped" : "idea, not scheduled") : null,
			// QA GRAN-07: drawn on an ancestor's coordinates.
			unlocated && node.type === "place"
				? `location not set${approx.shownAt.has(pin.repId) ? `, shown at ${approx.shownAt.get(pin.repId)}` : ""}`
				: null,
			stops > 0 ? `${stops} ${stops === 1 ? "stop" : "stops"}` : null,
			pin.visits > 1 ? `${pin.visits} visits` : null,
			days,
			proposal ? `${PROPOSAL_WORDS[proposal.kind]} by ${proposal.name}` : null,
		].filter(Boolean);
		seen.add(pin.repId);
		out.push({
			repId: pin.repId,
			name: node.name,
			type: node.type,
			shape,
			lng: pin.lng,
			lat: pin.lat,
			number: pin.number,
			visits: pin.visits,
			stops,
			minutes: pin.minutes,
			hollow,
			dropped: !!extra.dropped,
			stay: pin.stay,
			repMode: pin.repMode,
			approx: unlocated,
			size: Math.round(size * 10) / 10,
			opacity,
			filteredOut: !matches,
			dayIds: pin.dayIds,
			countryCode: node.countryCode,
			category: node.category,
			ariaLabel: parts.join(", "),
			proposal,
		});
	};
	for (const p of model.pins) push(p);
	for (const p of approx.pins) push(p);

	// "Show dropped" (DESIGN §5.1): dropped nodes in scope, as struck-out hollow pins.
	if (o.show.dropped && !o.days) {
		const nodes = o.scopeId ? ix.hierarchy.descendants(o.scopeId) : ix.outline;
		for (const n of nodes) {
			if (!ix.isDropped(n.id) || ix.scheduledNodeIds.has(n.id)) continue;
			const r = repAt(ix, n.id, o.lens, o.scopeId);
			if (seen.has(r.id) || !ix.isDropped(r.id)) continue;
			const c = ix.coordOf(r.id);
			const rn = ix.node(r.id);
			if (!c || !rn) continue;
			push(
				{
					repId: r.id,
					type: rn.type,
					repMode: r.mode,
					lng: c[0],
					lat: c[1],
					number: null,
					visits: 0,
					minutes: 0,
					hollow: true,
					stay: false,
					dayIds: [],
				},
				{ dropped: true },
			);
		}
	}
	// DOM (= keyboard) order: visited pins by number, then ideas. Stacking is
	// explicit on the markers (low numbers on top), not by DOM order.
	out.sort(
		(a, b) =>
			Number(a.hollow) - Number(b.hollow) ||
			(a.number ?? Number.POSITIVE_INFINITY) -
				(b.number ?? Number.POSITIVE_INFINITY),
	);
	return out;
}

// ---------------------------------------------------------------------------
// Edges
// ---------------------------------------------------------------------------

export type EdgeStyle =
	| "walk"
	| "transit"
	| "flight"
	| "other"
	| "unset"
	| "stay"
	| "overnight";

export type EdgeProps = {
	fid: string;
	edgeKey: string;
	from: string;
	to: string;
	kind: MapEdge["kind"];
	style: EdgeStyle;
	/** An estimate (no provider or manual value): dashed. */
	est: boolean;
	/** Straight because no geometry is known: 60% opacity. */
	approx: boolean;
	/** Drawn on a stored track (walk path, transit route, N02 rail geometry). */
	track: boolean;
	color: string;
	/** Opacity factor from dimming (1 = none). */
	o: number;
	/** E7: the lead author's colour when a marked item touches the edge. */
	proposed: string | null;
	pairKey: string | null;
	legId: string | null;
	/** The serialized selection a click makes (`l.…`, `s.…`, `e.…`). */
	sel: string;
	arrows: boolean;
	count: number;
};

export type EdgeFC = FeatureCollection<LineString, EdgeProps>;

const WIDTH: Record<EdgeStyle, number> = {
	walk: 3,
	transit: 4.5,
	flight: 2.5,
	other: 2.5,
	unset: 1.75,
	stay: 2,
	overnight: 1.5,
};
export const edgeWidth = (s: EdgeStyle) => WIDTH[s];

function modeColor(style: EdgeStyle, p: LinePalette): string {
	switch (style) {
		case "walk":
			return p.walk;
		case "transit":
			return p.transit;
		case "flight":
			return p.flight;
		case "other":
		case "stay":
			return p.other;
		default:
			return p.muted;
	}
}

/** The one transit line colour of a leg's chosen route, if it rides exactly one coloured line. */
export function lineColorOf(
	ix: GraphIndex,
	leg: GraphLeg | null,
): string | null {
	if (leg?.mode !== "transit") return null;
	const d = ix.legDetails(leg);
	if (d.kind !== "transit" || !d.route) return null;
	const colours = new Set(
		d.route.segments
			.filter((s) => s.mode !== "walk")
			.map((s) => s.color)
			.filter(isHex)
			.map((c) => c.toLowerCase()),
	);
	return colours.size === 1 ? ([...colours][0] as string) : null;
}

/**
 * Boxes `[west, south, east, north]` around Japan's railways (Hokkaido;
 * Honshu, Shikoku and northern Kyushu; Kyushu; Okinawa) that leave out Korea,
 * Russia and Taiwan (Busan, Vladivostok and Taipei are outside).
 */
const JAPAN_RAIL_BOXES: readonly (readonly [number, number, number, number])[] =
	[
		[139, 41.3, 146, 45.6],
		[130, 33.5, 142.2, 41.6],
		[129.4, 30.9, 132.1, 33.9],
		[122.9, 24, 131.4, 28.5],
	];
export function inJapan(c: readonly number[] | undefined): boolean {
	const lng = c?.[0];
	const lat = c?.[1];
	if (lng === undefined || lat === undefined) return false;
	return JAPAN_RAIL_BOXES.some(
		([w, s, e, n]) => lng >= w && lng <= e && lat >= s && lat <= n,
	);
}

/**
 * JAPAN_TRANSIT §5: the map credits "Rail: MLIT N02 (CC BY 4.0)" whenever it
 * draws N02-derived geometry. Estimates carry it by definition (`dataBuild`).
 * A custom route gets its ride shapes from the N02 station look-up
 * (`railRide`), and the stored route keeps no build id, so a manual route
 * with a ride track inside Japan counts too (Google has no Japan transit).
 */
export function legUsesN02(ix: GraphIndex, leg: GraphLeg | null): boolean {
	if (leg?.mode !== "transit") return false;
	const d = ix.legDetails(leg);
	if (d.kind !== "transit" || !d.route) return false;
	const r = d.route;
	if (r.source === "estimate" || r.dataBuild) return true;
	if (r.source !== "manual") return false;
	return (r.segments ?? []).some((s) => {
		const cs = s.geometry?.coordinates;
		return (
			s.mode !== "walk" &&
			!!cs &&
			cs.length >= 2 &&
			inJapan(cs[0]) &&
			inJapan(cs.at(-1))
		);
	});
}

/** The first leg with a stored (non-flight) track among an edge's transitions. */
function trackOf(ix: GraphIndex, e: MapEdge): LineString | null {
	if (e.kind !== "travel" || e.mode === "flight") return null;
	for (const t of e.transitions) {
		if (!t.leg || t.leg.mode === "flight") continue;
		const g = storedGeometry(ix, t.leg);
		if (g && g.coordinates.length >= 2) return g;
	}
	return null;
}

function markColor(
	o: MapDataOptions,
	keys: readonly (MarkKey | null)[],
): string | null {
	for (const k of keys) {
		if (!k) continue;
		const marks = o.marks.get(k);
		if (!marks?.length) continue;
		const lead = marks.find((m) => !m.stacked) ?? marks[0];
		if (lead) return presenceHex(lead.author.color, o.theme);
	}
	return null;
}

const isStraight = (g: LineString) => g.coordinates.length === 2;

function edgeSel(e: MapEdge): string {
	if (e.kind === "stay") {
		const s = e.stays?.[0];
		return s
			? (serializeSel({
					kind: "leg",
					target: { kind: "stay", dayId: s.dayId, end: s.end },
				}) as string)
			: (serializeSel({
					kind: "edge",
					from: e.fromRepId,
					to: e.toRepId,
				}) as string);
	}
	if (e.kind === "overnight" || e.transitions.length === 1) {
		const t = e.transitions[0];
		if (t)
			return serializeSel({
				kind: "leg",
				target: {
					kind: "pair",
					fromItemId: t.fromItemId,
					toItemId: t.toItemId,
				},
			}) as string;
	}
	return serializeSel({
		kind: "edge",
		from: e.fromRepId,
		to: e.toRepId,
	}) as string;
}

function pairSel(pk: string): string {
	const [a = "", b = ""] = pk.split(">");
	return serializeSel({
		kind: "leg",
		target: { kind: "pair", fromItemId: a, toItemId: b },
	}) as string;
}

export function buildEdges(
	model: WorkspaceModel,
	ix: GraphIndex,
	pins: readonly PinView[],
	o: MapDataOptions,
): EdgeFC {
	const pinBy = new Map(pins.map((p) => [p.repId, p]));
	const coord = (repId: string): LngLat | null => {
		const p = pinBy.get(repId);
		if (p) return [p.lng, p.lat];
		const mp = model.pins.find((x) => x.repId === repId);
		return mp ? [mp.lng, mp.lat] : null;
	};
	const placeLens = o.lens === "place";
	const dimDays = o.dayMode === "dim" && o.days !== null;
	const features: Feature<LineString, EdgeProps>[] = [];
	for (const e of model.edges) {
		if (e.kind === "stay" && !o.show.stays) continue;
		const a = coord(e.fromRepId);
		const b = coord(e.toRepId);
		const baseStyle: EdgeStyle =
			e.kind === "overnight"
				? "overnight"
				: e.kind === "stay"
					? "stay"
					: e.mode;
		// Dimming: day range "Dim others", the person filter and the shared filter.
		let o1 = 1;
		if (dimDays) {
			const any =
				e.transitions.some(
					(t) =>
						inRange(ix.day(ix.item(t.fromItemId)?.dayId)?.date, o.days) ||
						inRange(ix.day(ix.item(t.toItemId)?.dayId)?.date, o.days),
				) ||
				(e.stays ?? []).some((s) => inRange(ix.day(s.dayId)?.date, o.days));
			if (!any) o1 = 0.25;
		}
		const pa = pinBy.get(e.fromRepId);
		const pb = pinBy.get(e.toRepId);
		if (pa && pb && pa.opacity < 1 && pb.opacity < 1)
			o1 = Math.min(o1, Math.max(pa.opacity, pb.opacity, 0.25));
		if (pa?.filteredOut || pb?.filteredOut) o1 = Math.min(o1, 0.35);

		const transitionFor = (pk: string | null) =>
			pk
				? e.transitions.find((t) => toPairKey(t.fromItemId, t.toItemId) === pk)
				: undefined;
		const trackGeom = placeLens ? null : trackOf(ix, e);
		const edgeLineColor = (() => {
			if (e.mode !== "transit") return null;
			const cs = new Set(
				e.transitions.map((t) => lineColorOf(ix, t.leg) ?? "none"),
			);
			return cs.size === 1 && !cs.has("none") ? ([...cs][0] as string) : null;
		})();

		for (const f of e.features) {
			const t = transitionFor(f.pairKey);
			const leg = placeLens
				? (t?.leg ?? (f.legId ? (ix.leg(f.legId) ?? null) : null))
				: null;
			const style: EdgeStyle =
				f.mode === "overnight"
					? "overnight"
					: f.mode === "stay"
						? "stay"
						: placeLens
							? (f.mode as EdgeStyle)
							: baseStyle;
			let geometry: LineString = f.geometry;
			let approx = f.approx;
			let track = false;
			if (placeLens) {
				if (!f.approx && style !== "flight" && style !== "overnight") {
					track = !isStraight(f.geometry);
					if (track) geometry = snapEnds(f.geometry, a, b);
				}
			} else if (trackGeom && style !== "overnight" && style !== "stay") {
				geometry = snapEnds(trackGeom, a, b);
				approx = false;
				track = true;
			}
			if (e.curved && isStraight(geometry) && style !== "flight") {
				const [p0, p1] = geometry.coordinates as [LngLat, LngLat];
				geometry = quadCurve(p0, p1);
			}
			const est =
				style === "unset" || style === "overnight" || style === "stay"
					? false
					: placeLens
						? leg
							? legIsEstimate(ix, leg)
							: true
						: e.estimate;
			const color =
				style === "transit"
					? ((placeLens ? lineColorOf(ix, leg) : edgeLineColor) ??
						o.palette.transit)
					: modeColor(style, o.palette);
			const pk = f.pairKey;
			const itemKeys: (MarkKey | null)[] = [];
			const ts = pk ? (t ? [t] : []) : e.transitions;
			for (const x of ts) {
				itemKeys.push(`item:${x.fromItemId}`, `item:${x.toItemId}`);
				itemKeys.push(`leg:${toPairKey(x.fromItemId, x.toItemId)}`);
				if (x.leg) itemKeys.push(`leg:${x.leg.id}`);
			}
			features.push({
				type: "Feature",
				id: f.fid,
				geometry,
				properties: {
					fid: f.fid,
					edgeKey: e.key,
					from: e.fromRepId,
					to: e.toRepId,
					kind: e.kind,
					style,
					est,
					approx,
					track,
					color,
					o: o1,
					proposed: markColor(o, itemKeys),
					pairKey: pk,
					legId: f.legId,
					sel:
						placeLens && pk && e.kind !== "stay"
							? pairSel(pk)
							: placeLens && e.kind === "stay"
								? (stayFeatureSel(f.fid) ?? edgeSel(e))
								: edgeSel(e),
					arrows: e.kind === "travel",
					count: e.count,
				},
			});
		}
	}
	return { type: "FeatureCollection", features };
}

/** Place-lens stay features carry `…|<dayId>:<end>` in their fid. */
function stayFeatureSel(fid: string): string | null {
	const m = /\|([0-9a-f-]{36}):(start|end)$/.exec(fid);
	if (!m) return null;
	return serializeSel({
		kind: "leg",
		target: {
			kind: "stay",
			dayId: m[1] as string,
			end: m[2] as "start" | "end",
		},
	}) as string;
}

// ---------------------------------------------------------------------------
// Ghost stubs
// ---------------------------------------------------------------------------

export type GhostProps = {
	fid: string;
	style: EdgeStyle;
	color: string;
	sel: string;
	/** Double-click target: the common parent of both ends (zoom out to it). */
	parentId: string | null;
	label: string;
};

/** Minimum stub length per lens (metres), used when the scope has one pin. */
const MIN_STUB: Record<Lens, number> = {
	country: 300_000,
	region: 80_000,
	city: 25_000,
	area: 3_000,
	place: 1_200,
};

export function buildGhosts(
	model: WorkspaceModel,
	ix: GraphIndex,
	pins: readonly PinView[],
	o: MapDataOptions,
): {
	lines: FeatureCollection<LineString, GhostProps>;
	labels: FeatureCollection<Point, { label: string; fid: string }>;
} {
	const pinBy = new Map(pins.map((p) => [p.repId, p]));
	const visitRep = new Map(model.visits.map((v) => [v.key, v.repId]));
	const diag = boundsDiagonal(
		boundsOf(pins.filter((p) => !p.hollow).map((p) => [p.lng, p.lat])),
	);
	const maxLen = Math.max(MIN_STUB[o.lens], diag * 0.3);
	const lines: Feature<LineString, GhostProps>[] = [];
	const labels: Feature<Point, { label: string; fid: string }>[] = [];
	const seen = new Set<string>();
	for (const g of model.ghosts) {
		const rep = visitRep.get(g.visitKey);
		const pin = rep ? pinBy.get(rep) : undefined;
		if (!pin || !rep) continue;
		const [from = "", to = ""] = g.pairKey.split(">");
		const outsideNode = ghostOutsideNode(ix, g, from, to);
		// Off the selected days, the neighbour is usually in the same scope: point
		// at its rep at this lens (and skip it when that is this very pin). Off
		// scope, point at the engine's coarser rep ("→ Osaka").
		const outRep =
			g.reason === "days" && outsideNode
				? repAt(ix, outsideNode, o.lens, o.scopeId).id
				: (g.outsideRepId ?? outsideNode);
		if (!outRep || outRep === rep) continue;
		const far = ix.coordOf(outRep) ?? ix.coordOf(outsideNode);
		if (!far) continue;
		const mode = (g.leg?.mode ?? "unset") as EdgeStyle;
		const key = `${rep}|${outRep}|${g.dir}|${mode}`;
		if (seen.has(key)) continue;
		seen.add(key);
		const start: LngLat = [pin.lng, pin.lat];
		const end = toward(start, far, maxLen);
		if (end[0] === start[0] && end[1] === start[1]) continue;
		const name = ix.node(outRep)?.name ?? ix.node(outsideNode)?.name ?? "";
		// The stub is clamped, so its end can sit over somewhere else entirely
		// (a Kawaguchiko stub ends over Tokyo): say which way it goes.
		const label = name ? `${g.dir === "out" ? "to" : "from"} ${name}` : "";
		const fid = `ghost|${key}`;
		lines.push({
			type: "Feature",
			id: fid,
			geometry: { type: "LineString", coordinates: [start, end] },
			properties: {
				fid,
				style: mode,
				color: modeColor(mode, o.palette),
				sel: serializeSel({
					kind: "leg",
					target: { kind: "pair", fromItemId: from, toItemId: to },
				}) as string,
				parentId: commonParent(ix, rep, outRep),
				label,
			},
		});
		if (label)
			labels.push({
				type: "Feature",
				geometry: { type: "Point", coordinates: end },
				properties: { label, fid },
			});
	}
	return {
		lines: { type: "FeatureCollection", features: lines },
		labels: { type: "FeatureCollection", features: labels },
	};
}

/**
 * The located stop on the far side of a ghost: the outside end of its located
 * pair (the leg the stub selects). The raw neighbour item is often unlocated
 * (the next day opens with "Breakfast"), and falling back to the engine's
 * country rep drew the stub to Japan's centroid, labelled "to Japan" (GRAN-14).
 */
function ghostOutsideNode(
	ix: GraphIndex,
	g: WorkspaceModel["ghosts"][number],
	from: string,
	to: string,
): string | null {
	const pairEnd = g.dir === "out" ? to : from;
	const located =
		pairEnd && pairEnd !== g.insideItemId ? ix.item(pairEnd)?.nodeId : null;
	return located ?? ix.item(g.outsideItemId)?.nodeId ?? null;
}

/** The deepest common ancestor of two nodes (null = the trip root). */
export function commonParent(
	ix: GraphIndex,
	a: string | null,
	b: string | null,
): string | null {
	if (!a || !b) return null;
	const pb = new Set(ix.path(b).map((n) => n.id));
	let out: string | null = null;
	for (const n of ix.path(a)) if (pb.has(n.id)) out = n.id;
	return out;
}

// ---------------------------------------------------------------------------
// Chips, selection, bounds
// ---------------------------------------------------------------------------

export type EdgeChip = {
	key: string;
	lng: number;
	lat: number;
	count: number;
	kind: "count" | "stay";
	sel: string;
};

/** Count chips ("3") for edges travelled several times, bed glyphs on stay edges. */
export function buildChips(
	edges: EdgeFC,
	mid: (g: LineString) => LngLat | null,
): EdgeChip[] {
	const out: EdgeChip[] = [];
	const done = new Set<string>();
	for (const f of edges.features) {
		const p = f.properties;
		if (done.has(p.edgeKey)) continue;
		if (p.kind === "stay" || (p.count > 1 && p.kind === "travel")) {
			const m = mid(f.geometry);
			if (!m) continue;
			done.add(p.edgeKey);
			out.push({
				key: p.edgeKey,
				lng: m[0],
				lat: m[1],
				count: p.count,
				kind: p.kind === "stay" ? "stay" : "count",
				sel: p.sel,
			});
		}
	}
	return out;
}

/** Feature ids to mark `selected` for the current selection. */
export function selectedFids(
	edges: EdgeFC,
	model: WorkspaceModel,
	sel: Sel | null,
): Set<string> {
	const out = new Set<string>();
	if (!sel) return out;
	if (sel.kind === "edge") {
		const key = `${sel.from}>${sel.to}`;
		for (const f of edges.features)
			if (f.properties.edgeKey === key) out.add(f.properties.fid);
		return out;
	}
	if (sel.kind !== "leg") return out;
	const s = serializeSel(sel);
	const target = sel.target;
	const edgeKeys = new Set<string>();
	for (const e of model.edges) {
		if (target.kind === "pair") {
			if (
				e.transitions.some(
					(t) =>
						t.fromItemId === target.fromItemId &&
						t.toItemId === target.toItemId,
				)
			)
				edgeKeys.add(e.key);
		} else if (
			(e.stays ?? []).some(
				(x) => x.dayId === target.dayId && x.end === target.end,
			)
		)
			edgeKeys.add(e.key);
	}
	for (const f of edges.features) {
		const p = f.properties;
		if (p.sel === s) out.add(p.fid);
		else if (!p.pairKey && edgeKeys.has(p.edgeKey)) out.add(p.fid);
	}
	return out;
}

/**
 * What the camera frames: the visited pins (or the ideas when nothing is
 * visited yet). With `all`, every pin on show, ideas included: the whole
 * trip's first view frames all its countries (FB-10), not only the one with
 * days so far.
 */
export function fitPointsFor(
	pins: readonly PinView[],
	{ all = false }: { all?: boolean } = {},
): LngLat[] {
	const visible = pins.filter((p) => !p.filteredOut || !p.hollow);
	const visited = visible.filter((p) => !p.hollow);
	const use = all || !visited.length ? visible : visited;
	return use.map((p) => [p.lng, p.lat]);
}

export function fitBoundsFor(
	pins: readonly PinView[],
	opts?: { all?: boolean },
): Bounds | null {
	return boundsOf(fitPointsFor(pins, opts));
}

/**
 * FB-10 / QA MAP-01: the whole trip (country lens, no scope) is a globe when
 * it spans more than one country and they all fit on the visible side of the
 * Earth (`GLOBE_MAX_CAP`). One country, or a trip round the world, stays flat.
 */
export function wantsGlobe(pins: readonly PinView[]): boolean {
	const shown = pins.filter((p) => !p.filteredOut || !p.hollow);
	const countries = new Set(shown.map((p) => p.countryCode ?? p.repId));
	if (countries.size < 2) return false;
	const cap = sphericalCap(shown.map((p) => [p.lng, p.lat]));
	return !!cap && cap.radius <= GLOBE_MAX_CAP;
}

// ---------------------------------------------------------------------------
// Hover tooltip and the one-pin hint
// ---------------------------------------------------------------------------

export type EdgeTip = { title: string; detail: string };

const capitalise = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/**
 * Unlocated items between a located pair ("Lunch"), which the line skips
 * (SPEC §8.1, QA GRAN-06 "via Lunch"). Same-day pairs only.
 */
export function viaItems(
	ix: GraphIndex,
	fromItemId: string,
	toItemId: string,
): string[] {
	const a = ix.orderOf(fromItemId);
	const b = ix.orderOf(toItemId);
	if (a < 0 || b <= a + 1) return [];
	const day = ix.item(fromItemId)?.dayId;
	const out: string[] = [];
	for (const it of ix.ordered.slice(a + 1, b)) {
		if (it.dayId !== day) continue;
		if (it.nodeId && ix.coordOf(it.nodeId)) continue;
		const name = it.title ?? ix.node(it.nodeId)?.name;
		if (name) out.push(name);
	}
	return out;
}

/**
 * What hovering an edge says (desktop): "Nakano Broadway → Yodobashi Camera"
 * over "Transit · 20m · via Lunch", "3 trips · transit", "Overnight", "To your
 * stay", or the suggestion for an unset leg ("Not set · walk ~12m?").
 */
export function edgeTip(
	p: Pick<EdgeProps, "edgeKey" | "pairKey">,
	model: WorkspaceModel,
	ix: GraphIndex,
	suggestionOf?: (pairKey: string) => string | null,
): EdgeTip | null {
	const e = model.edges.find((x) => x.key === p.edgeKey);
	if (!e) return null;
	const name = (id: string) => ix.node(id)?.name ?? "";
	const title = `${name(e.fromRepId)} → ${name(e.toRepId)}`;
	if (e.kind === "overnight") return { title, detail: "Overnight" };
	if (e.kind === "stay") {
		const toStay = e.stays?.some((s) => s.end === "end") ?? false;
		const fromStay = e.stays?.some((s) => s.end === "start") ?? false;
		return {
			title,
			detail:
				toStay && fromStay
					? "To and from your stay"
					: fromStay
						? "From your stay"
						: "To your stay",
		};
	}
	const ts = p.pairKey
		? e.transitions.filter(
				(t) => toPairKey(t.fromItemId, t.toItemId) === p.pairKey,
			)
		: e.transitions;
	const only = ts.length === 1 ? ts[0] : undefined;
	if (!only) {
		const n = e.count || ts.length;
		const mode = e.mode === "unset" ? "no travel set" : e.mode;
		return { title, detail: `${n} trips · ${mode}` };
	}
	const pk = toPairKey(only.fromItemId, only.toItemId);
	const leg = only.leg;
	let detail: string;
	if (leg?.mode) {
		detail = capitalise(formatLeg(leg));
		if (legIsEstimate(ix, leg) && !detail.includes("est.")) detail += " est.";
	} else {
		const hint = suggestionOf?.(pk) ?? null;
		detail = hint ? `Not set · ${hint}` : "No travel set yet";
	}
	const via = viaItems(ix, only.fromItemId, only.toItemId);
	if (via.length) detail += ` · via ${via.join(", ")}`;
	return { title, detail };
}

/**
 * QA GRAN-10: when everything in the scope collapses into one pin at this lens
 * (a trip only in Japan at the country lens, a Japan scope whose visits are all
 * in Tokyo at the city lens), the map says so: "Everything here is in Japan".
 * Not at the place lens (a pin can't get finer) or while days are selected.
 */
export function oneRepHint(
	pins: readonly PinView[],
	edges: EdgeFC,
	o: Pick<MapDataOptions, "lens" | "scopeId" | "days">,
): string | null {
	if (o.lens === "place" || o.days) return null;
	const visited = pins.filter((x) => !x.hollow);
	if (visited.length !== 1 || edges.features.length > 0) return null;
	const only = visited[0] as PinView;
	if (only.repId === o.scopeId || only.repMode !== "exact") return null;
	return `Everything here is in ${only.name}`;
}
