// Builds a compact line-level rail graph from N02 RailroadSection + Station features.
//
// N02 topology facts this relies on (checked against N02-25, see test/build.test.ts):
//  - every section is a LineString; sections are split at station ends, and each Station
//    feature is also present as a RailroadSection with the same endpoints;
//  - a station on a multi-track line can appear several times (one feature per track/platform)
//    with the same station code N02_005c;
//  - sections of one line share exact endpoint coordinates.
// Nodes are per (line, station) "platforms" plus junctions; lines are joined later by
// transfer edges (graph.ts), never by shared coordinates.

import { type LngLat, polylineLengthM, simplify } from "./geo.server";
import type {
	EdgeRecord,
	GraphData,
	LineRecord,
	N02Collection,
	N02Feature,
	NodeRecord,
} from "./types.server";

export interface BuildOptions {
	/** Douglas–Peucker tolerance for stored edge geometry, metres. 0 = keep none. */
	simplifyM?: number;
	dataset?: string;
	url?: string;
}

interface LocalEdge {
	u: number;
	v: number;
	m: number;
	coords: LngLat[];
}

const vkey = (c: LngLat): string =>
	`${Math.round(c[0] * 1e6)},${Math.round(c[1] * 1e6)}`;

function lineStrings(f: N02Feature): LngLat[][] {
	return f.geometry.type === "LineString"
		? [f.geometry.coordinates]
		: f.geometry.coordinates;
}

export function buildGraph(
	sections: N02Collection,
	stations: N02Collection,
	opts: BuildOptions = {},
): GraphData {
	const simplifyM = opts.simplifyM ?? 25;
	const byLine = new Map<string, { secs: N02Feature[]; sts: N02Feature[] }>();
	const get = (f: N02Feature) => {
		const k = `${f.properties.N02_004}\t${f.properties.N02_003}`;
		let e = byLine.get(k);
		if (!e) {
			e = { secs: [], sts: [] };
			byLine.set(k, e);
		}
		return e;
	};
	for (const f of sections.features) get(f).secs.push(f);
	for (const f of stations.features) get(f).sts.push(f);

	const lines: LineRecord[] = [];
	const nodes: NodeRecord[] = [];
	const edges: EdgeRecord[] = [];
	const stats = {
		lines: 0,
		stations: 0,
		junctions: 0,
		edges: 0,
		isolatedStations: 0,
		attachedStations: 0,
	};

	for (const [, { secs, sts }] of [...byLine.entries()].sort(([a], [b]) =>
		a < b ? -1 : 1,
	)) {
		const first = (secs[0] ?? sts[0]) as N02Feature;
		const typeLen = new Map<string, number>();
		for (const f of secs) {
			const m = lineStrings(f).reduce((s, c) => s + polylineLengthM(c), 0);
			typeLen.set(
				f.properties.N02_001,
				(typeLen.get(f.properties.N02_001) ?? 0) + m,
			);
		}
		const railType =
			[...typeLen.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ??
			first.properties.N02_001;
		const lineIdx = lines.length;
		lines.push({
			name: first.properties.N02_003,
			operator: first.properties.N02_004,
			railType,
			operatorType: first.properties.N02_002,
		});
		stats.lines++;

		// ── local vertex table ──
		const vIndex = new Map<string, number>();
		const vCoord: LngLat[] = [];
		const vStation: (null | { name: string; code: string; group: string })[] =
			[];
		const vertex = (c: LngLat): number => {
			const k = vkey(c);
			let i = vIndex.get(k);
			if (i === undefined) {
				i = vCoord.length;
				vIndex.set(k, i);
				vCoord.push(c);
				vStation.push(null);
			}
			return i;
		};
		const local: LocalEdge[] = [];

		// stations grouped by code → one vertex each, joined to the ends of every platform feature
		const stationPairs = new Set<string>();
		const byCode = new Map<string, N02Feature[]>();
		for (const f of sts) {
			const code = f.properties.N02_005c ?? `${f.properties.N02_005}`;
			const arr = byCode.get(code);
			if (arr) arr.push(f);
			else byCode.set(code, [f]);
		}
		for (const [code, feats] of byCode) {
			let sx = 0;
			let sy = 0;
			let n = 0;
			for (const f of feats)
				for (const ls of lineStrings(f)) {
					for (const p of [ls[0], ls[ls.length - 1]] as LngLat[]) {
						sx += p[0];
						sy += p[1];
						n++;
					}
				}
			const sc: LngLat = [sx / n, sy / n];
			const s = vCoord.length;
			vIndex.set(`S:${code}`, s);
			vCoord.push(sc);
			const p = (feats[0] as N02Feature).properties;
			vStation.push({
				name: p.N02_005 ?? "?",
				code,
				group: p.N02_005g ?? code,
			});
			for (const f of feats)
				for (const ls of lineStrings(f)) {
					const a = ls[0] as LngLat;
					const b = ls[ls.length - 1] as LngLat;
					const ka = vkey(a);
					const kb = vkey(b);
					stationPairs.add(ka < kb ? `${ka}|${kb}` : `${kb}|${ka}`);
					const half = polylineLengthM(ls) / 2;
					const mid = Math.floor(ls.length / 2);
					local.push({
						u: vertex(a),
						v: s,
						m: half,
						coords: [...ls.slice(0, mid + 1), sc],
					});
					local.push({
						u: s,
						v: vertex(b),
						m: half,
						coords: [sc, ...ls.slice(mid)],
					});
				}
		}
		for (const f of secs)
			for (const ls of lineStrings(f)) {
				if (ls.length < 2) continue;
				const a = ls[0] as LngLat;
				const b = ls[ls.length - 1] as LngLat;
				const ka = vkey(a);
				const kb = vkey(b);
				if (ka === kb) continue;
				if (stationPairs.has(ka < kb ? `${ka}|${kb}` : `${kb}|${ka}`)) continue; // station duplicated as a section
				local.push({
					u: vertex(a),
					v: vertex(b),
					m: polylineLengthM(ls),
					coords: ls,
				});
			}

		// ── incidence ──
		const inc: number[][] = vCoord.map(() => []);
		for (let i = 0; i < local.length; i++) {
			const e = local[i] as LocalEdge;
			(inc[e.u] as number[]).push(i);
			(inc[e.v] as number[]).push(i);
		}

		// attach stations whose platforms don't touch any section (data gaps): nearest section vertex ≤ 300 m
		for (let s = 0; s < vCoord.length; s++) {
			const st = vStation[s];
			if (!st) continue;
			const touching = (inc[s] as number[]).some((ei) => {
				const e = local[ei] as LocalEdge;
				const o = e.u === s ? e.v : e.u;
				return (inc[o] as number[]).length > 1;
			});
			if (touching) continue;
			stats.isolatedStations++;
			let best = -1;
			let bestM = 300;
			const sc = vCoord[s] as LngLat;
			for (let v = 0; v < vCoord.length; v++) {
				if (v === s || vStation[v] || (inc[v] as number[]).length === 0)
					continue;
				const c = vCoord[v] as LngLat;
				const m = polylineLengthM([sc, c]);
				if (m < bestM) {
					bestM = m;
					best = v;
				}
			}
			if (best >= 0) {
				const ei = local.length;
				local.push({
					u: s,
					v: best,
					m: bestM,
					coords: [sc, vCoord[best] as LngLat],
				});
				(inc[s] as number[]).push(ei);
				(inc[best] as number[]).push(ei);
				stats.attachedStations++;
			}
		}

		// ── prune dead-end non-station spurs, then contract degree-2 chains ──
		const alive = new Uint8Array(local.length).fill(1);
		const deg = inc.map((l) => l.length);
		const queue: number[] = [];
		for (let v = 0; v < vCoord.length; v++)
			if (!vStation[v] && deg[v] === 1) queue.push(v);
		while (queue.length) {
			const v = queue.pop() as number;
			if (deg[v] !== 1) continue;
			for (const ei of inc[v] as number[]) {
				if (!alive[ei]) continue;
				alive[ei] = 0;
				const e = local[ei] as LocalEdge;
				const o = e.u === v ? e.v : e.u;
				deg[v] = (deg[v] as number) - 1;
				deg[o] = (deg[o] as number) - 1;
				if (!vStation[o] && deg[o] === 1) queue.push(o);
			}
		}
		const isKey = (v: number) => vStation[v] !== null || deg[v] !== 2;
		const globalId = new Map<number, number>();
		const gid = (v: number): number => {
			let g = globalId.get(v);
			if (g === undefined) {
				g = nodes.length;
				globalId.set(v, g);
				const c = vCoord[v] as LngLat;
				const st = vStation[v];
				const rec: NodeRecord = {
					l: lineIdx,
					lat: round6(c[1]),
					lng: round6(c[0]),
				};
				if (st) {
					rec.n = st.name;
					rec.c = st.code;
					rec.g = st.group;
					stats.stations++;
				} else stats.junctions++;
				nodes.push(rec);
			}
			return g;
		};
		const visited = new Uint8Array(local.length);
		const best = new Map<string, EdgeRecord>();
		for (let k = 0; k < vCoord.length; k++) {
			if (!isKey(k) || deg[k] === 0) continue;
			for (const e0 of inc[k] as number[]) {
				if (!alive[e0] || visited[e0]) continue;
				visited[e0] = 1;
				let e = local[e0] as LocalEdge;
				let cur = e.u === k ? e.v : e.u;
				let m = e.m;
				const coords: LngLat[] =
					e.u === k ? e.coords.slice() : e.coords.slice().reverse();
				let guard = 0;
				while (!isKey(cur) && guard++ < 100_000) {
					const nextEi = (inc[cur] as number[]).find(
						(x) => alive[x] && !visited[x],
					);
					if (nextEi === undefined) break;
					visited[nextEi] = 1;
					e = local[nextEi] as LocalEdge;
					const fwd = e.u === cur;
					const seg = fwd ? e.coords : e.coords.slice().reverse();
					coords.push(...seg.slice(1));
					m += e.m;
					cur = fwd ? e.v : e.u;
				}
				if (cur === k) continue; // loop back to itself
				const a = gid(k);
				const b = gid(cur);
				const pk = a < b ? `${a}|${b}` : `${b}|${a}`;
				const prev = best.get(pk);
				if (prev && prev.m <= m) continue;
				const rec: EdgeRecord = { a, b, m: Math.round(m) };
				if (simplifyM > 0) {
					const simp = simplify(coords, simplifyM);
					rec.geom = simp.flatMap(([x, y]) => [round5(x), round5(y)]);
				}
				best.set(pk, rec);
			}
		}
		// isolated stations still get a node (so name lookup works), they just have no edges
		for (let v = 0; v < vCoord.length; v++)
			if (vStation[v] && !globalId.has(v)) gid(v);
		for (const e of best.values()) edges.push(e);
	}
	stats.edges = edges.length;
	return {
		format: "yonder-n02-graph@1",
		source: {
			dataset: opts.dataset ?? "N02-25",
			url:
				opts.url ??
				"https://nlftp.mlit.go.jp/ksj/gml/datalist/KsjTmplt-N02-2025.html",
			license: "CC BY 4.0",
			attribution: "「国土数値情報（鉄道データ）」（国土交通省）を加工して作成",
			builtAt: new Date().toISOString(),
		},
		stats,
		lines,
		nodes,
		edges,
	};
}

const round6 = (x: number) => Math.round(x * 1e6) / 1e6;
const round5 = (x: number) => Math.round(x * 1e5) / 1e5;
