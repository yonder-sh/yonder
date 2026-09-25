// biome-ignore-all lint/style/noNonNullAssertion: ported verbatim from spikes/japan-transit/estimate (typed arrays, bounds checked by construction).
// Multi-source Dijkstra, route assembly with run-based timing, and penalty-method alternatives.
import type { LngLat } from "./geo.server";
import {
	CONTINUE,
	type Graph,
	RIDE,
	type RuntimeLine,
	THROUGH,
	TRANSFER_EDGE,
} from "./graph.server";
import {
	curveAt,
	legSpeedKmh,
	MODE_BY_CLASS,
	type RailClass,
	type SegmentMode,
	zoneKmh,
} from "./profiles.server";
import type { Endpoint } from "./snap.server";

export interface Place {
	name: string;
	/** English name when a names table was supplied (N02 itself is Japanese-only) */
	nameEn?: string;
	lat: number;
	lng: number;
}

export interface WalkSegment {
	kind: "walk";
	from: Place;
	to: Place;
	distanceM: number;
	durationMin: number;
}

export interface RideSegment {
	kind: "ride";
	mode: SegmentMode;
	cls: RailClass;
	lineKey: string;
	lineName: string;
	lineNameEn?: string;
	operator: string;
	from: Place;
	to: Place;
	/** stations passed on the track (N02 does not say which ones a given train serves) */
	stopCount: number;
	distanceKm: number;
	/** effective km/h used for this leg */
	speedKmh: number;
	durationMin: number;
	/** stays on the same train from the previous ride: true = listed through service,
	 *  "likely" = same-operator line change at a terminal (heuristic, may be a quick change) */
	through: boolean | "likely";
	geometry?: LngLat[];
}

export interface TransferSegment {
	kind: "transfer";
	at: string;
	from: Place;
	to: Place;
	distanceM: number;
	walkMin: number;
	waitMin: number;
	penaltyMin: number;
	durationMin: number;
}

export type Segment = WalkSegment | RideSegment | TransferSegment;

export interface EstimateRoute {
	id: string;
	source: "estimate";
	/** Always "estimate": modelled from track length and typical speeds, never a timetable. */
	confidence: "estimate";
	/** Door to door, excluding the initial wait (SPEC TransitRoute semantics). */
	durationMin: number;
	/** Plausible range from the accuracy run (see ERROR_BAND). */
	rangeMin: [number, number];
	walkMin: number;
	transfers: number;
	rideKm: number;
	label: string;
	signature: string;
	segments: Segment[];
}

/** Observed error band (scripts/accuracy.ts): real time is usually within [-15 %, +20 % + 3 min] of the estimate. */
export const ERROR_BAND = {
	lowFactor: 0.85,
	highFactor: 1.2,
	highPlusMin: 3,
} as const;

export interface Path {
	/** nodes[0] is the boarding platform; slots[i] leads from nodes[i] to nodes[i+1] */
	nodes: number[];
	slots: number[];
	access: Endpoint;
	egress: Endpoint;
	cost: number;
}

// ── binary heap keyed on float cost ─────────────────────────────────────────
class Heap {
	private k: number[] = [];
	private v: number[] = [];
	get size() {
		return this.k.length;
	}
	push(key: number, val: number) {
		const k = this.k;
		const v = this.v;
		let i = k.length;
		k.push(key);
		v.push(val);
		while (i > 0) {
			const p = (i - 1) >> 1;
			if ((k[p] as number) <= key) break;
			k[i] = k[p] as number;
			v[i] = v[p] as number;
			i = p;
		}
		k[i] = key;
		v[i] = val;
	}
	pop(): [number, number] {
		const k = this.k;
		const v = this.v;
		const top: [number, number] = [k[0] as number, v[0] as number];
		const lk = k.pop() as number;
		const lv = v.pop() as number;
		const n = k.length;
		if (n > 0) {
			let i = 0;
			for (;;) {
				const l = 2 * i + 1;
				if (l >= n) break;
				const r = l + 1;
				const c = r < n && (k[r] as number) < (k[l] as number) ? r : l;
				if ((k[c] as number) >= lk) break;
				k[i] = k[c] as number;
				v[i] = v[c] as number;
				i = c;
			}
			k[i] = lk;
			v[i] = lv;
		}
		return top;
	}
}

export function dijkstra(
	g: Graph,
	sources: readonly Endpoint[],
	targets: readonly Endpoint[],
	rideMult?: Float32Array,
): Path | null {
	const dist = new Float64Array(g.n).fill(Number.POSITIVE_INFINITY);
	const prevSlot = new Int32Array(g.n).fill(-1);
	const prevNode = new Int32Array(g.n).fill(-1);
	const srcEp = new Map<number, Endpoint>();
	const heap = new Heap();
	for (const s of sources) {
		if (s.walkMin < dist[s.node]!) {
			dist[s.node] = s.walkMin;
			srcEp.set(s.node, s);
			heap.push(s.walkMin, s.node);
		}
	}
	const tgt = new Map<number, Endpoint>();
	for (const t of targets) {
		const prev = tgt.get(t.node);
		if (!prev || t.walkMin < prev.walkMin) tgt.set(t.node, t);
	}
	let best = Number.POSITIVE_INFINITY;
	let bestNode = -1;
	const done = new Uint8Array(g.n);
	while (heap.size) {
		const [d, v] = heap.pop();
		if (done[v] || d > dist[v]!) continue;
		done[v] = 1;
		if (d >= best) break;
		const te = tgt.get(v);
		if (te && prevSlot[v] !== -1) {
			// must have ridden something; pure walks are handled separately
			const total = d + te.walkMin;
			if (total < best) {
				best = total;
				bestNode = v;
			}
		}
		for (let s = g.start[v]!; s < g.start[v + 1]!; s++) {
			const w = g.to[s]!;
			let c = g.cost[s]!;
			if (rideMult && g.kind[s] === RIDE) c *= rideMult[g.edge[s]!]!;
			const nd = d + c;
			if (nd < dist[w]!) {
				dist[w] = nd;
				prevSlot[w] = s;
				prevNode[w] = v;
				heap.push(nd, w);
			}
		}
	}
	if (bestNode < 0) return null;
	const nodes: number[] = [bestNode];
	const slots: number[] = [];
	let cur = bestNode;
	while (prevSlot[cur] !== -1) {
		slots.push(prevSlot[cur]!);
		cur = prevNode[cur]!;
		nodes.push(cur);
	}
	nodes.reverse();
	slots.reverse();
	// Trim leading/trailing non-ride links (walking between platforms of the origin/destination station
	// cluster is already covered by access/egress snapping).
	while (slots.length && g.kind[slots[0]!] !== RIDE) {
		slots.shift();
		nodes.shift();
	}
	while (slots.length && g.kind[slots[slots.length - 1]!] !== RIDE) {
		slots.pop();
		nodes.pop();
	}
	if (!slots.length) return null;
	const first = nodes[0]!;
	const last = nodes[nodes.length - 1]!;
	const access = srcEp.get(first) ?? nearestEndpoint(g, sources, first);
	const egress = tgt.get(last) ?? nearestEndpoint(g, targets, last);
	return { nodes, slots, access, egress, cost: best };
}

function nearestEndpoint(
	g: Graph,
	eps: readonly Endpoint[],
	node: number,
): Endpoint {
	// the trimmed path starts/ends at a platform that was reached by a transfer from an endpoint;
	// use the endpoint's walk plus the straight-line hop to this platform.
	let bestEp: Endpoint | null = null;
	let bestD = Number.POSITIVE_INFINITY;
	for (const e of eps) {
		const dLat = (g.lat[e.node]! - g.lat[node]!) * 110_540;
		const dLng = (g.lng[e.node]! - g.lng[node]!) * 90_000;
		const d = Math.hypot(dLat, dLng);
		if (d < bestD) {
			bestD = d;
			bestEp = e;
		}
	}
	const e = bestEp as Endpoint;
	return {
		node,
		walkM: e.walkM + bestD,
		walkMin: e.walkMin + (bestD * 1.3) / 75,
	};
}

const place = (g: Graph, i: number): Place => {
	const p: Place = {
		name: g.name[i] ?? "(junction)",
		lat: g.lat[i]!,
		lng: g.lng[i]!,
	};
	const en = g.nameEn[i];
	if (en) p.nameEn = en;
	return p;
};

function edgeGeom(g: Graph, slot: number, fromNode: number): LngLat[] {
	const e = g.data.edges[g.edge[slot]!]!;
	const flat = e.geom;
	if (!flat)
		return [
			[g.lng[fromNode]!, g.lat[fromNode]!],
			[g.lng[g.to[slot]!]!, g.lat[g.to[slot]!]!],
		];
	const pts: LngLat[] = [];
	for (let i = 0; i < flat.length; i += 2) pts.push([flat[i]!, flat[i + 1]!]);
	return e.a === fromNode ? pts : pts.reverse();
}

export interface AssembleOptions {
	origin: Place;
	destination: Place;
	geometry?: boolean;
}

export function assemble(g: Graph, p: Path, o: AssembleOptions): EstimateRoute {
	type Leg = {
		line: number;
		nodes: number[];
		slots: number[];
		km: number;
		through: boolean | "likely";
		dwell: number;
		geom: LngLat[];
	};
	type Xfer = {
		from: number;
		to: number;
		m: number;
		walk: number;
		wait: number;
		cost: number;
	};
	const items: (Leg | Xfer)[] = [];
	let pendingThrough = false;
	let pendingLikely = false;
	let pendingDwell = 0;
	for (let i = 0; i < p.slots.length; i++) {
		const s = p.slots[i]!;
		const a = p.nodes[i]!;
		const b = p.nodes[i + 1]!;
		const k = g.kind[s];
		if (k === RIDE) {
			const last = items[items.length - 1];
			if (
				last &&
				"line" in last &&
				last.line === g.line[a] &&
				!pendingThrough
			) {
				last.nodes.push(b);
				last.slots.push(s);
				last.km += g.dist[s]!;
				if (o.geometry) last.geom.push(...edgeGeom(g, s, a).slice(1));
			} else {
				items.push({
					line: g.line[a]!,
					nodes: [a, b],
					slots: [s],
					km: g.dist[s]!,
					through: pendingThrough ? (pendingLikely ? "likely" : true) : false,
					dwell: pendingDwell,
					geom: o.geometry ? edgeGeom(g, s, a) : [],
				});
			}
			pendingThrough = false;
			pendingLikely = false;
			pendingDwell = 0;
		} else if (k === THROUGH || k === CONTINUE) {
			pendingThrough = true;
			if (k === CONTINUE) pendingLikely = true;
			pendingDwell += g.cost[s]!;
		} else if (k === TRANSFER_EDGE) {
			const last = items[items.length - 1];
			if (last && !("line" in last)) {
				last.to = b;
				last.m += g.dist[s]!;
				last.walk += g.walkMin[s]!;
				last.wait = g.waitMin[s]!;
				last.cost += g.cost[s]!;
			} else
				items.push({
					from: a,
					to: b,
					m: g.dist[s]!,
					walk: g.walkMin[s]!,
					wait: g.waitMin[s]!,
					cost: g.cost[s]!,
				});
			pendingThrough = false;
			pendingLikely = false;
			pendingDwell = 0;
		}
	}
	// run lengths: consecutive legs joined by through links
	const runKm = new Map<Leg, number>();
	let run: Leg[] = [];
	const flush = () => {
		const km = run.reduce((t, l) => t + l.km, 0);
		for (const l of run) runKm.set(l, km);
		run = [];
	};
	for (const it of items) {
		if ("line" in it) {
			if (it.through !== true) flush();
			run.push(it);
		} else flush();
	}
	flush();

	const segments: Segment[] = [];
	const first = p.nodes[0]!;
	const last = p.nodes[p.nodes.length - 1]!;
	if (p.access.walkM >= 1)
		segments.push({
			kind: "walk",
			from: o.origin,
			to: place(g, first),
			distanceM: Math.round(p.access.walkM),
			durationMin: p.access.walkMin,
		});
	let rideKm = 0;
	for (const it of items) {
		if ("line" in it) {
			const l = g.lines[it.line] as RuntimeLine;
			const from = it.nodes[0]!;
			const to = it.nodes[it.nodes.length - 1]!;
			const { min, kmh } = legMinutes(
				g,
				l,
				it.nodes,
				it.slots,
				runKm.get(it) ?? it.km,
			);
			const seg: RideSegment = {
				kind: "ride",
				mode: MODE_BY_CLASS[l.cls],
				cls: l.cls,
				lineKey: l.key,
				lineName: l.name,
				operator: l.operator,
				from: place(g, from),
				to: place(g, to),
				stopCount: it.nodes.slice(1).filter((x) => g.name[x] !== undefined)
					.length,
				distanceKm: Math.round(it.km * 10) / 10,
				speedKmh: Math.round(kmh),
				durationMin: min + it.dwell,
				through: it.through,
			};
			if (l.profile.en) seg.lineNameEn = l.profile.en;
			if (o.geometry) seg.geometry = it.geom;
			segments.push(seg);
			rideKm += it.km;
		} else {
			segments.push({
				kind: "transfer",
				at: g.name[it.from] ?? "?",
				from: place(g, it.from),
				to: place(g, it.to),
				distanceM: Math.round(it.m),
				walkMin: it.walk,
				waitMin: it.wait,
				penaltyMin: it.cost - it.walk - it.wait,
				durationMin: it.cost,
			});
		}
	}
	if (p.egress.walkM >= 1)
		segments.push({
			kind: "walk",
			from: place(g, last),
			to: o.destination,
			distanceM: Math.round(p.egress.walkM),
			durationMin: p.egress.walkMin,
		});
	return finishRoute(segments, rideKm);
}

/**
 * Leg time, hop by hop (station to station): zone speed if the hop is inside a zone, else the
 * all-stops model (cruise + loss per stop) if the profile has one, else the run-length curve.
 */
export function legMinutes(
	g: Graph,
	l: RuntimeLine,
	nodes: readonly number[],
	slots: readonly number[],
	runKm: number,
): { min: number; kmh: number } {
	const p = l.profile;
	const firstName = g.name[nodes[0]!];
	const lastName = g.name[nodes[nodes.length - 1]!];
	const curveKmh = legSpeedKmh(p, runKm, firstName, lastName);
	let min = 0;
	let km = 0;
	let hopKm = 0;
	let prev = firstName;
	for (let i = 0; i < slots.length; i++) {
		hopKm += g.dist[slots[i]!]!;
		const nm = g.name[nodes[i + 1]!];
		if (nm === undefined && i < slots.length - 1) continue;
		const z = zoneKmh(p, prev, nm);
		if (z) min += (hopKm / z) * 60;
		else if (p.stops) min += (hopKm / p.stops.cruiseKmh) * 60 + p.stops.lossMin;
		else if (p.express)
			min +=
				(hopKm / p.express.cruiseKmh) * 60 +
				p.express.lossMin * curveAt(p.express.share, runKm);
		else min += (hopKm / curveKmh) * 60;
		if (
			p.changeAt &&
			nm !== undefined &&
			i < slots.length - 1 &&
			p.changeAt.stations.includes(nm)
		)
			min += p.changeAt.min;
		km += hopKm;
		hopKm = 0;
		prev = nm;
	}
	return { min, kmh: min > 0 ? km / (min / 60) : curveKmh };
}

export function finishRoute(
	segments: Segment[],
	rideKm: number,
): EstimateRoute {
	const total = segments.reduce((t, s) => t + s.durationMin, 0);
	const walk = segments.reduce(
		(t, s) =>
			t +
			(s.kind === "walk"
				? s.durationMin
				: s.kind === "transfer"
					? s.walkMin
					: 0),
		0,
	);
	const rides = segments.filter((s): s is RideSegment => s.kind === "ride");
	const transfers = segments.filter((s) => s.kind === "transfer").length;
	for (const s of segments) s.durationMin = Math.round(s.durationMin * 10) / 10;
	const durationMin = Math.round(total);
	const names: string[] = [];
	for (const r of rides) {
		const n = (r.lineNameEn ?? r.lineName).replace(/ \(.*\)$/, "");
		if (names[names.length - 1] !== n) names.push(n);
	}
	const label = rides.length ? names.join(" → ").slice(0, 80) : "Walk";
	const signature = rides.length
		? rides.map((r) => r.lineKey).join(">")
		: "walk";
	return {
		id: `est:${hash(signature + segments.map((s) => ("at" in s ? s.at : "")).join(","))}`,
		source: "estimate",
		confidence: "estimate",
		durationMin,
		rangeMin: [
			Math.round(total * ERROR_BAND.lowFactor),
			Math.round(total * ERROR_BAND.highFactor + ERROR_BAND.highPlusMin),
		],
		walkMin: Math.round(walk),
		transfers,
		rideKm: Math.round(rideKm * 10) / 10,
		label,
		signature,
		segments,
	};
}

function hash(s: string): string {
	let h = 2166136261;
	for (let i = 0; i < s.length; i++)
		h = Math.imul(h ^ s.charCodeAt(i), 16777619);
	return (h >>> 0).toString(36);
}

export interface AlternativesOptions extends AssembleOptions {
	k?: number;
	maxIterations?: number;
	/** multiply the routing cost of every ride edge on a found path by this factor */
	penalty?: number;
	/** drop alternatives slower than best × slack + slackMin */
	slack?: number;
	slackMin?: number;
}

/** Penalty-method alternatives: repeat Dijkstra, inflating used ride edges, keep distinct line sequences. */
export function alternatives(
	g: Graph,
	sources: readonly Endpoint[],
	targets: readonly Endpoint[],
	o: AlternativesOptions,
): EstimateRoute[] {
	const k = o.k ?? 3;
	const maxIter = o.maxIterations ?? k * 3;
	const penalty = o.penalty ?? 2;
	const mult = new Float32Array(g.data.edges.length).fill(1);
	const found = new Map<string, EstimateRoute>();
	for (let it = 0; it < maxIter; it++) {
		const p = dijkstra(g, sources, targets, mult);
		if (!p) break;
		const r = assemble(g, p, o);
		const prev = found.get(r.signature);
		if (!prev || r.durationMin < prev.durationMin) found.set(r.signature, r);
		for (const s of p.slots)
			if (g.kind[s] === RIDE) mult[g.edge[s]!] = mult[g.edge[s]!]! * penalty;
		if (found.size >= k + 2) break;
	}
	return rank([...found.values()], k, o.slack ?? 1.6, o.slackMin ?? 15);
}

export function rank(
	routes: EstimateRoute[],
	k: number,
	slack: number,
	slackMin: number,
): EstimateRoute[] {
	const sorted = routes.sort(
		(a, b) => a.durationMin - b.durationMin || a.transfers - b.transfers,
	);
	const best = sorted[0];
	if (!best) return [];
	return sorted
		.filter((r) => r.durationMin <= best.durationMin * slack + slackMin)
		.slice(0, k);
}
