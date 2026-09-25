// Runtime graph: CSR adjacency over platform nodes with ride, transfer and through edges.
import { GridIndex, haversineM } from "./geo.server";
import {
	curveAt,
	lineKey,
	operatorFamily,
	type Profile,
	profileFor,
	type RailClass,
	ROUTING_RUN_KM,
	THROUGH_RUNNING,
	type TimingModel,
	TRANSFER,
	walkMinutes,
} from "./profiles.server";
import type { GraphData, LineRecord } from "./types.server";

export const RIDE = 0;
export const TRANSFER_EDGE = 1;
export const THROUGH = 2;
/** heuristic: same operator, same station, one line ends there — often the same train carries on */
export const CONTINUE = 3;
export type LinkKind =
	| typeof RIDE
	| typeof TRANSFER_EDGE
	| typeof THROUGH
	| typeof CONTINUE;

export interface RuntimeLine extends LineRecord {
	key: string;
	cls: RailClass;
	profile: Profile;
}

export interface Graph {
	data: GraphData;
	lines: RuntimeLine[];
	n: number;
	line: Int32Array;
	lat: Float64Array;
	lng: Float64Array;
	name: (string | undefined)[];
	nameEn: (string | undefined)[];
	/** Station numbering (e.g. "KK14"), from the English names table when present. */
	stationNo: (string | undefined)[];
	group: (string | undefined)[];
	/** CSR adjacency */
	start: Int32Array;
	to: Int32Array;
	kind: Uint8Array;
	/** RIDE: edge id; TRANSFER/THROUGH: -1 */
	edge: Int32Array;
	/** RIDE: km; TRANSFER: walk metres; THROUGH: 0 */
	dist: Float32Array;
	/** routing minutes (RIDE: km at the routing speed; TRANSFER: walk + fixed + board wait; THROUGH: dwell) */
	cost: Float32Array;
	/** TRANSFER: minutes split for reporting */
	walkMin: Float32Array;
	waitMin: Float32Array;
	/** station nodes with at least one ride edge */
	stationGrid: GridIndex;
	byName: Map<string, number[]>;
	connected: Uint8Array;
	stats: { transfers: number; through: number; continuations: number };
}

export interface PrepareOptions {
	walkKmh?: number;
	nearM?: number;
	/** speed model for JR/private lines without a tuned curve (see profiles.ts) */
	timing?: TimingModel;
	/** English station names keyed by N02 station code (N02_005c), e.g. from ../n02/n02-names-en.json */
	namesEn?: Record<string, string>;
	/** Station numbering keyed like `namesEn`, e.g. "KK14" (Wikidata P296). */
	numbering?: Record<string, string>;
}

export function prepareGraph(
	data: GraphData,
	opts: PrepareOptions = {},
): Graph {
	const nearM = opts.nearM ?? TRANSFER.nearM;
	const lines: RuntimeLine[] = data.lines.map((l) => {
		const p = profileFor(l, opts.timing);
		return { ...l, key: lineKey(l), cls: p.cls, profile: p };
	});
	const n = data.nodes.length;
	const line = new Int32Array(n);
	const lat = new Float64Array(n);
	const lng = new Float64Array(n);
	const name: (string | undefined)[] = new Array(n);
	const nameEn: (string | undefined)[] = new Array(n);
	const stationNo: (string | undefined)[] = new Array(n);
	const group: (string | undefined)[] = new Array(n);
	data.nodes.forEach((r, i) => {
		line[i] = r.l;
		lat[i] = r.lat;
		lng[i] = r.lng;
		name[i] = r.n;
		group[i] = r.g;
		if (r.c && opts.namesEn) nameEn[i] = opts.namesEn[r.c];
		if (r.c && opts.numbering) stationNo[i] = opts.numbering[r.c];
	});
	// share an English name across a station group (the lookup may only know one line's code)
	if (opts.namesEn) {
		const byG = new Map<string, string>();
		for (let i = 0; i < n; i++)
			if (nameEn[i] && group[i])
				byG.set(`${group[i]}|${name[i]}`, nameEn[i] as string);
		for (let i = 0; i < n; i++)
			if (!nameEn[i] && group[i]) nameEn[i] = byG.get(`${group[i]}|${name[i]}`);
	}

	type Link = {
		from: number;
		to: number;
		kind: LinkKind;
		edge: number;
		dist: number;
		cost: number;
		walk: number;
		wait: number;
	};
	const links: Link[] = [];
	const lineDeg = new Int32Array(n);
	const connected = new Uint8Array(n);
	data.edges.forEach((e, id) => {
		const l = lines[line[e.a] as number] as RuntimeLine;
		const km = e.m / 1000;
		const p = l.profile;
		const kmh = p.fast
			? Math.max(p.fast.kmh, curveAt(p.curve, ROUTING_RUN_KM))
			: curveAt(p.curve, ROUTING_RUN_KM);
		const run = p.stops
			? (km / p.stops.cruiseKmh) * 60
			: p.express
				? (km / p.express.cruiseKmh) * 60
				: (km / kmh) * 60;
		const loss = p.stops
			? p.stops.lossMin
			: p.express
				? p.express.lossMin * curveAt(p.express.share, ROUTING_RUN_KM)
				: 0;
		const stop = (i: number) => (data.nodes[i]?.n !== undefined ? loss : 0);
		links.push({
			from: e.a,
			to: e.b,
			kind: RIDE,
			edge: id,
			dist: km,
			cost: run + stop(e.b),
			walk: 0,
			wait: 0,
		});
		links.push({
			from: e.b,
			to: e.a,
			kind: RIDE,
			edge: id,
			dist: km,
			cost: run + stop(e.a),
			walk: 0,
			wait: 0,
		});
		lineDeg[e.a] = (lineDeg[e.a] as number) + 1;
		lineDeg[e.b] = (lineDeg[e.b] as number) + 1;
		connected[e.a] = 1;
		connected[e.b] = 1;
	});

	const stationGrid = new GridIndex(500);
	const byName = new Map<string, number[]>();
	const byGroup = new Map<string, number[]>();
	for (let i = 0; i < n; i++) {
		const nm = name[i];
		if (nm === undefined) continue;
		const arr = byName.get(nm);
		if (arr) arr.push(i);
		else byName.set(nm, [i]);
		const g = group[i] as string;
		const ga = byGroup.get(g);
		if (ga) ga.push(i);
		else byGroup.set(g, [i]);
		if (connected[i]) stationGrid.add(i, lat[i] as number, lng[i] as number);
	}

	// through-running lookup: "lineKeyA|lineKeyB|station" (both orders)
	const through = new Map<string, number>();
	for (const t of THROUGH_RUNNING) {
		through.set(`${t.a}#${t.b}#${t.at}`, t.costMin);
		through.set(`${t.b}#${t.a}#${t.at}`, t.costMin);
	}

	const stats = { transfers: 0, through: 0, continuations: 0 };
	for (let s = 0; s < n; s++) {
		if (!connected[s] || name[s] === undefined) continue;
		const cand = new Map<number, number>();
		for (const { id, m } of stationGrid.within(
			lat[s] as number,
			lng[s] as number,
			nearM,
		))
			cand.set(id, m);
		for (const t of byGroup.get(group[s] as string) ?? [])
			if (connected[t] && !cand.has(t))
				cand.set(
					t,
					haversineM(
						lat[s] as number,
						lng[s] as number,
						lat[t] as number,
						lng[t] as number,
					),
				);
		const ls = lines[line[s] as number] as RuntimeLine;
		for (const [t, m] of cand) {
			if (t === s || line[t] === line[s]) continue;
			const lt = lines[line[t] as number] as RuntimeLine;
			const sameGroup = group[t] === group[s];
			const tc =
				through.get(`${ls.key}#${lt.key}#${name[s]}`) ??
				through.get(`${ls.key}#${lt.key}#${name[t]}`);
			if (tc !== undefined && m < 800) {
				links.push({
					from: s,
					to: t,
					kind: THROUGH,
					edge: -1,
					dist: 0,
					cost: tc,
					walk: 0,
					wait: 0,
				});
				stats.through++;
				continue;
			}
			const sameFamily =
				operatorFamily(ls.operator) === operatorFamily(lt.operator);
			if (
				sameGroup &&
				ls.operator === lt.operator &&
				(lineDeg[s] === 1 || lineDeg[t] === 1) &&
				ls.cls === lt.cls &&
				m <= TRANSFER.continuationMaxM
			) {
				// e.g. an official line ending where the service often carries on under another line name.
				// Unlike THROUGH it does not extend the run (no express-speed bonus) and is flagged "likely".
				links.push({
					from: s,
					to: t,
					kind: CONTINUE,
					edge: -1,
					dist: 0,
					cost: TRANSFER.terminalContinuationMin,
					walk: 0,
					wait: 0,
				});
				stats.continuations++;
				continue;
			}
			const walk = Math.max(1, walkMinutes(m, opts.walkKmh));
			const fixed = sameFamily
				? TRANSFER.sameFamilyMin
				: TRANSFER.otherOperatorMin;
			const wait = lt.profile.boardWaitMin;
			links.push({
				from: s,
				to: t,
				kind: TRANSFER_EDGE,
				edge: -1,
				dist: m,
				cost: walk + fixed + wait,
				walk,
				wait,
			});
			stats.transfers++;
		}
	}

	// CSR
	const start = new Int32Array(n + 1);
	for (const k of links) start[k.from + 1] = (start[k.from + 1] as number) + 1;
	for (let i = 0; i < n; i++)
		start[i + 1] = (start[i + 1] as number) + (start[i] as number);
	const fill = start.slice(0, n);
	const L = links.length;
	const to = new Int32Array(L);
	const kind = new Uint8Array(L);
	const edge = new Int32Array(L);
	const dist = new Float32Array(L);
	const cost = new Float32Array(L);
	const walkMin = new Float32Array(L);
	const waitMin = new Float32Array(L);
	for (const k of links) {
		const at = fill[k.from] as number;
		fill[k.from] = at + 1;
		to[at] = k.to;
		kind[at] = k.kind;
		edge[at] = k.edge;
		dist[at] = k.dist;
		cost[at] = k.cost;
		walkMin[at] = k.walk;
		waitMin[at] = k.wait;
	}
	return {
		data,
		lines,
		n,
		line,
		lat,
		lng,
		name,
		nameEn,
		stationNo,
		group,
		start,
		to,
		kind,
		edge,
		dist,
		cost,
		walkMin,
		waitMin,
		stationGrid,
		byName,
		connected,
		stats,
	};
}

/** Station nodes named `stationName`, optionally restricted to operators/lines containing `lineHint`. */
export function stationNodes(
	g: Graph,
	stationName: string,
	lineHint?: string,
): number[] {
	const ids = (g.byName.get(stationName) ?? []).filter((i) => g.connected[i]);
	if (!lineHint) return ids;
	return ids.filter((i) =>
		(g.lines[g.line[i] as number] as RuntimeLine).key.includes(lineHint),
	);
}
