/**
 * N02 look-ups for custom routes (ADDENDUM §5 "Custom (manual) routes get N02
 * line/station autocomplete + geometry"; JAPAN_TRANSIT §3 "Map"):
 *
 * - `searchStations` — Japanese or English names and station numbers
 *   ("Shinjuku", "新宿", "KK14"), one row per station (N02 group), nearest
 *   first when a point is given, with the lines that serve it.
 * - `railSegment` — the ride between two stations (optionally on one line):
 *   minutes, stops, the real track shape, the line's chip.
 *
 * Stations are identified by name + coordinates (re-snapped within 600 m), so
 * saved routes survive a data rebuild.
 */
import type { LineString, TransitSegment } from "@/lib/schemas/legs";
import { haversineM, type LngLat } from "./jp/geo.server";
import type { Graph, RuntimeLine } from "./jp/graph.server";
import { operatorEn } from "./jp/line-names.server";
import { lineColor, shortLineName } from "./jp/line-style.server";
import { MODE_BY_CLASS } from "./jp/profiles.server";
import { alternatives, type RideSegment } from "./jp/router.server";
import { capPoints } from "./jp/transit-route.server";

export type RailLine = {
	key: string;
	name: string;
	nameEn?: string;
	short: string;
	operator: string;
	/** "JR East" for 東日本旅客鉄道, when known. */
	operatorEn?: string;
	color?: string;
	textColor?: string;
};

export type RailStation = {
	/** N02 group code + name: stable within a build (for React keys). */
	key: string;
	name: string;
	nameEn?: string;
	/** Station numbering, e.g. "KK14 JK23". */
	no?: string;
	lat: number;
	lng: number;
	lines: RailLine[];
	/** Metres from the `near` point, when given. */
	distanceM?: number;
};

const fold = (s: string) =>
	s
		.normalize("NFKC")
		.normalize("NFD")
		.replace(/\p{M}/gu, "")
		.toLowerCase()
		.replace(/[\s\-・'’.]/g, "")
		.replace(/(station|eki|駅)$/, "");

function lineOf(g: Graph, idx: number): RailLine {
	const l = g.lines[idx] as RuntimeLine;
	const color = lineColor(l.key);
	const out: RailLine = {
		key: l.key,
		name: l.name,
		short: shortLineName(l.profile.en, l.name),
		operator: l.operator,
	};
	if (l.profile.en) out.nameEn = l.profile.en;
	const opEn = operatorEn(l.operator);
	if (opEn !== l.operator) out.operatorEn = opEn;
	if (color) {
		out.color = color.bg;
		out.textColor = color.fg;
	}
	return out;
}

type StationGroup = {
	key: string;
	name: string;
	nameEn?: string;
	no: Set<string>;
	lat: number;
	lng: number;
	nodes: number[];
	fold: string[];
};

const groupsMemo = new WeakMap<Graph, StationGroup[]>();

/** One entry per station group (connected platforms only). */
function stationGroups(g: Graph): StationGroup[] {
	const memo = groupsMemo.get(g);
	if (memo) return memo;
	const byKey = new Map<string, StationGroup>();
	for (let i = 0; i < g.n; i++) {
		const name = g.name[i];
		if (name === undefined || !g.connected[i]) continue;
		const key = `${g.group[i] ?? i}|${name}`;
		let s = byKey.get(key);
		if (!s) {
			s = {
				key,
				name,
				no: new Set(),
				lat: g.lat[i] as number,
				lng: g.lng[i] as number,
				nodes: [],
				fold: [fold(name)],
			};
			byKey.set(key, s);
		}
		s.nodes.push(i);
		const en = g.nameEn[i];
		if (en && !s.nameEn) {
			s.nameEn = en;
			s.fold.push(fold(en));
		}
		for (const no of (g.stationNo[i] ?? "").split(" ").filter(Boolean)) {
			s.no.add(no);
			s.fold.push(fold(no));
		}
	}
	const out = [...byKey.values()];
	groupsMemo.set(g, out);
	return out;
}

function toStation(
	g: Graph,
	s: StationGroup,
	near?: { lat: number; lng: number },
): RailStation {
	const lines = [...new Set(s.nodes.map((i) => g.line[i] as number))].map((l) =>
		lineOf(g, l),
	);
	const out: RailStation = {
		key: s.key,
		name: s.name,
		lat: s.lat,
		lng: s.lng,
		lines,
	};
	if (s.nameEn) out.nameEn = s.nameEn;
	if (s.no.size) out.no = [...s.no].join(" ");
	if (near)
		out.distanceM = Math.round(haversineM(near.lat, near.lng, s.lat, s.lng));
	return out;
}

export function searchStations(
	g: Graph,
	q: string,
	opts: {
		near?: { lat: number; lng: number };
		line?: string;
		limit?: number;
	} = {},
): RailStation[] {
	const needle = fold(q);
	const limit = opts.limit ?? 8;
	const scored: { s: StationGroup; score: number; d: number }[] = [];
	for (const s of stationGroups(g)) {
		if (
			opts.line &&
			!s.nodes.some((i) => g.lines[g.line[i] as number]?.key === opts.line)
		)
			continue;
		let score = -1;
		if (!needle) score = 0;
		else
			for (const f of s.fold) {
				if (f === needle) score = Math.max(score, 3);
				else if (f.startsWith(needle)) score = Math.max(score, 2);
				else if (needle.length >= 2 && f.includes(needle))
					score = Math.max(score, 1);
			}
		if (score < 0) continue;
		const d = opts.near
			? haversineM(opts.near.lat, opts.near.lng, s.lat, s.lng)
			: 0;
		if (!needle && d > 3000) continue; // empty query: stations nearby only
		scored.push({ s, score, d });
	}
	scored.sort(
		(a, b) =>
			b.score - a.score || a.d - b.d || a.s.name.localeCompare(b.s.name),
	);
	return scored.slice(0, limit).map((x) => toStation(g, x.s, opts.near));
}

export function searchLines(g: Graph, q: string, limit = 8): RailLine[] {
	const needle = fold(q);
	if (!needle) return [];
	const out: { l: RailLine; score: number }[] = [];
	g.lines.forEach((l, idx) => {
		const fields = [l.name, l.profile.en ?? "", l.operator].map(fold);
		let score = -1;
		for (const f of fields) {
			if (f === needle) score = Math.max(score, 3);
			else if (f.startsWith(needle)) score = Math.max(score, 2);
			else if (needle.length >= 2 && f.includes(needle))
				score = Math.max(score, 1);
		}
		if (score >= 0) out.push({ l: lineOf(g, idx), score });
	});
	return out
		.sort((a, b) => b.score - a.score || a.l.name.localeCompare(b.l.name))
		.slice(0, limit)
		.map((x) => x.l);
}

/** "新宿", "Shinjuku" or the stored label "Shinjuku (新宿)". */
const namedAs = (s: StationGroup, name: string): boolean =>
	s.name === name ||
	s.nameEn === name ||
	(!!s.nameEn && name === `${s.nameEn} (${s.name})`);

/** The station group named `name` nearest to the point (≤ 600 m). */
function findGroup(
	g: Graph,
	p: { name: string; lat: number; lng: number },
): StationGroup | null {
	let best: StationGroup | null = null;
	let bestD = 600;
	for (const s of stationGroups(g)) {
		if (!namedAs(s, p.name)) continue;
		const d = haversineM(p.lat, p.lng, s.lat, s.lng);
		if (d <= bestD) {
			best = s;
			bestD = d;
		}
	}
	return best;
}

export type RailSegmentResult = {
	segment: TransitSegment;
	/** Station-to-station minutes (estimate, no timetable). */
	durationMin: number;
	distanceKm: number;
};

/**
 * The ride between two stations, as one custom-route segment with real track
 * geometry. With `line`, the route must stay on it (else null).
 */
export function railSegment(
	g: Graph,
	from: { name: string; lat: number; lng: number },
	to: { name: string; lat: number; lng: number },
	line?: string,
): RailSegmentResult | null {
	const a = findGroup(g, from);
	const b = findGroup(g, to);
	if (!a || !b || a === b) return null;
	const onLine = (i: number) =>
		!line || g.lines[g.line[i] as number]?.key === line;
	const ep = (grp: StationGroup) =>
		grp.nodes.filter(onLine).map((node) => ({ node, walkM: 0, walkMin: 0 }));
	const src = ep(a);
	const dst = ep(b);
	if (!src.length || !dst.length) return null;
	const routes = alternatives(g, src, dst, {
		k: 3,
		origin: { name: a.name, lat: a.lat, lng: a.lng },
		destination: { name: b.name, lat: b.lat, lng: b.lng },
		geometry: true,
	});
	const candidates = routes.filter((x) => {
		const rides = x.segments.filter((s): s is RideSegment => s.kind === "ride");
		return (
			rides.length > 0 && (!line || rides.every((s) => s.lineKey === line))
		);
	});
	const best = candidates[0];
	if (!best) return null;
	const rides = best.segments.filter(
		(s): s is RideSegment => s.kind === "ride",
	);
	const first = rides[0] as RideSegment;
	const last = rides.at(-1) as RideSegment;
	const lineIdx = g.lines.findIndex((l) => l.key === first.lineKey);
	const info = lineOf(g, lineIdx);
	const coords: LngLat[] = rides.flatMap((s) => s.geometry ?? []);
	const minutes = Math.max(
		1,
		Math.round(
			best.segments
				.filter((s) => s.kind !== "walk")
				.reduce((t, s) => t + s.durationMin, 0),
		),
	);
	const label = (p: { name: string; nameEn?: string }) =>
		(p.nameEn ? `${p.nameEn} (${p.name})` : p.name).slice(0, 200);
	const segment: TransitSegment = {
		mode: MODE_BY_CLASS[first.cls],
		vehicleType: first.cls.toUpperCase(),
		lineName: (info.nameEn ?? info.name).slice(0, 200),
		lineShort: info.short.slice(0, 40),
		agency: (info.operatorEn ?? info.operator).slice(0, 200),
		stopCount: rides.reduce((t, s) => t + s.stopCount, 0),
		from: { name: label(first.from), lat: first.from.lat, lng: first.from.lng },
		to: { name: label(last.to), lat: last.to.lat, lng: last.to.lng },
		durationMin: minutes,
	};
	if (info.color) {
		segment.color = info.color;
		segment.textColor = info.textColor;
	}
	if (coords.length >= 2) {
		const geometry: LineString = {
			type: "LineString",
			coordinates: capPoints(coords, 120),
		};
		segment.geometry = geometry;
	}
	return {
		segment,
		durationMin: minutes,
		distanceKm:
			Math.round(rides.reduce((t, s) => t + s.distanceKm, 0) * 10) / 10,
	};
}
