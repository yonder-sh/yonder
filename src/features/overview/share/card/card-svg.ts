/**
 * docs/OVERVIEW.md §Sharing: the share card as an SVG string, from the trip's
 * route model (`tripRoute`). Pure (a `Measurer` in for text widths), so the
 * server renders it with resvg and tests read it as text.
 *
 * The design is the approved mockups' (`.data/mock/ShareCard*.png`, built by
 * `build_overview.py` + `overview_shared.js`) in their 540-wide units; the SVG
 * is 1080 wide (2×).
 *
 * - **story** 1080×1920: dates, the title on one line (scaled down to fit),
 *   the globe or flat map, four big stats, the route list, "planned with
 *   Yonder". Leftover height is shared evenly between the gaps above the
 *   map, above the list and above the footer.
 * - **square** 1080×1080: the same header; the map with the stats under it
 *   on the left, the route list on the right.
 * - **Route list tiers** by row count: 1–4 two lines each (name, dotted
 *   leader, nights; cities below; a mode icon between rows), 5–8 one line on
 *   a thin coloured rail, 9–12 the same, tighter. Over 12, regions fold, then
 *   "+N more" (`cardRows`). Nights never truncate; cities, then names do.
 * - **Labels**: one or two cities per country, greedily placed (biggest
 *   stays first, every country's first city before any second one), never
 *   over another label, a dot or the card's edge.
 */

import { haversineKm, type LngLat } from "@/lib/engine/geo";
import type { EdgeMode } from "@/lib/engine/types";
import { ROUTE_NEUTRAL, type TripRoute } from "../../lib/trip-route";
import {
	EE_HALF_H,
	EE_HALF_W,
	graticulePath,
	landPath,
	legPath,
	type MapFrame,
	mapFrame,
	projectPoint,
	spherePath,
} from "./geo";
import { CARD_FONTS, type CardFont, type Measurer } from "./metrics";
import { type CardRow, cardRows } from "./regions";

export type CardSize = "story" | "square";
export const CARD_SIZES: Record<CardSize, { width: number; height: number }> = {
	story: { width: 1080, height: 1920 },
	square: { width: 1080, height: 1080 },
};

export interface ShareCardData {
	title: string;
	/** "Oct 2 – Nov 7 · 2027" (upper-cased on the card). */
	dates: string;
	route: TripRoute;
}

const C = {
	text: "#f5f5f5",
	muted: "#a3a3a3",
	faint: "#8e8e8e",
	leader: "#333333",
	flight: "#f5f5f5",
	brand: "#9fabf7",
	brandDot: "#f8b564",
};

// ---------------------------------------------------------------------------
// SVG bits
// ---------------------------------------------------------------------------

const esc = (s: string) =>
	s
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;");
const n1 = (n: number) => (Math.round(n * 10) / 10).toString();

interface TextOpts {
	anchor?: "start" | "middle" | "end";
	ls?: number;
	opacity?: number;
	filter?: string;
}
function text(
	x: number,
	y: number,
	s: string,
	font: CardFont,
	size: number,
	fill: string,
	o: TextOpts = {},
): string {
	const f = CARD_FONTS[font];
	return `<text x="${n1(x)}" y="${n1(y)}" font-family="${f.family}" font-weight="${f.weight}" font-size="${n1(size)}" fill="${fill}"${o.anchor && o.anchor !== "start" ? ` text-anchor="${o.anchor}"` : ""}${o.ls ? ` letter-spacing="${n1(o.ls)}"` : ""}${o.opacity !== undefined ? ` opacity="${o.opacity}"` : ""}${o.filter ? ` filter="url(#${o.filter})"` : ""}>${esc(s)}</text>`;
}

/** `s`, cut with an ellipsis to fit `max` (empty when not even "X…" fits). */
export function truncate(
	m: Measurer,
	font: CardFont,
	size: number,
	s: string,
	max: number,
	ls = 0,
): string {
	if (m.width(font, size, s, ls) <= max) return s;
	const chars = [...s];
	for (let n = chars.length - 1; n > 0; n--) {
		const t = `${chars.slice(0, n).join("").trimEnd()}…`;
		if (m.width(font, size, t, ls) <= max) return t;
	}
	return "";
}

/** Material icons (24×24), as in the mockup. */
const ICONS = {
	flight:
		"M21 16v-2l-8-5V3.5c0-.83-.67-1.5-1.5-1.5S10 2.67 10 3.5V9l-8 5v2l8-2.5V19l-2 1.5V22l3.5-1 3.5 1v-1.5L13 19v-5.5l8 2.5z",
	train:
		"M12 2c-4 0-8 .5-8 4v9.5C4 17.43 5.57 19 7.5 19L6 20.5v.5h2.23l2-2H14l2 2h2v-.5L16.5 19c1.93 0 3.5-1.57 3.5-3.5V6c0-3.5-3.58-4-8-4zM7.5 17c-.83 0-1.5-.67-1.5-1.5S6.67 14 7.5 14s1.5.67 1.5 1.5S8.33 17 7.5 17zm3.5-7H6V6h5v4zm2 0V6h5v4h-5zm3.5 7c-.83 0-1.5-.67-1.5-1.5s.67-1.5 1.5-1.5 1.5.67 1.5 1.5-.67 1.5-1.5 1.5z",
	car: "M18.92 6.01C18.72 5.42 18.16 5 17.5 5h-11c-.66 0-1.21.42-1.42 1.01L3 12v8c0 .55.45 1 1 1h1c.55 0 1-.45 1-1v-1h12v1c0 .55.45 1 1 1h1c.55 0 1-.45 1-1v-8l-2.08-5.99zM6.5 16c-.83 0-1.5-.67-1.5-1.5S5.67 13 6.5 13s1.5.67 1.5 1.5S7.33 16 6.5 16zm11 0c-.83 0-1.5-.67-1.5-1.5s.67-1.5 1.5-1.5 1.5.67 1.5 1.5-.67 1.5-1.5 1.5zM5 11l1.5-4.5h11L19 11H5z",
	walk: "M13.5 5.5c1.1 0 2-.9 2-2s-.9-2-2-2-2 .9-2 2 .9 2 2 2zM9.8 8.9L7 23h2.1l1.8-8 2.1 2v6h2v-7.5l-2.1-2 .6-3C14.8 12 16.8 13 19 13v-2c-1.9 0-3.5-1-4.3-2.4l-1-1.6c-.4-.6-1-1-1.7-1-.3 0-.5.1-.8.1L6 8.3V13h2V9.6l1.8-.7",
} as const;

/** Mode between two rows: a plane (pointing down the list), a train, a car or a walker. */
function modeIcon(
	mode: EdgeMode,
	cx: number,
	cy: number,
	size: number,
): string {
	const d =
		mode === "flight"
			? ICONS.flight
			: mode === "transit"
				? ICONS.train
				: mode === "other"
					? ICONS.car
					: mode === "walk"
						? ICONS.walk
						: null;
	if (!d) return "";
	const k = size / 24;
	const rot = mode === "flight" ? " rotate(180 12 12)" : "";
	return `<path d="${d}" fill="${C.faint}" transform="translate(${n1(cx - size / 2)} ${n1(cy - size / 2)}) scale(${Math.round(k * 1000) / 1000})${rot}"/>`;
}

/** A country dot with its glow; a region's dot is split between its countries' colours. */
function dot(
	cx: number,
	cy: number,
	r: number,
	colors: string[],
	glow = true,
): string {
	const main = colors[0] ?? ROUTE_NEUTRAL;
	let s = glow
		? `<circle cx="${n1(cx)}" cy="${n1(cy)}" r="${n1(r)}" fill="${main}" filter="url(#dotglow)" opacity="0.9"/>`
		: "";
	if (colors.length <= 1)
		return `${s}<circle cx="${n1(cx)}" cy="${n1(cy)}" r="${n1(r)}" fill="${main}"/>`;
	const k = colors.length;
	colors.forEach((c, i) => {
		const a0 = -Math.PI / 2 + (i / k) * 2 * Math.PI;
		const a1 = -Math.PI / 2 + ((i + 1) / k) * 2 * Math.PI;
		const large = a1 - a0 > Math.PI ? 1 : 0;
		s += `<path d="M${n1(cx)} ${n1(cy)}L${n1(cx + r * Math.cos(a0))} ${n1(cy + r * Math.sin(a0))}A${n1(r)} ${n1(r)} 0 ${large} 1 ${n1(cx + r * Math.cos(a1))} ${n1(cy + r * Math.sin(a1))}Z" fill="${c}"/>`;
	});
	return s;
}

/** The Yonder mark (`brand/logo/yonder-mark-dark.svg`), `h` tall with its top-left at x, y. */
function logo(x: number, y: number, h: number): string {
	const k = h / 32.4;
	return `<g transform="translate(${n1(x)} ${n1(y)}) scale(${Math.round(k * 1000) / 1000}) translate(-10.7 -7.9)"><path d="M13 12C13 19 24 19 24 27L24 38M24 27C24 21.5 28 18.5 30.5 16.5" fill="none" stroke="${C.brand}" stroke-width="4.6" stroke-linecap="round" stroke-linejoin="round"/><circle cx="36.6" cy="11.6" r="3.7" fill="${C.brandDot}"/></g>`;
}

// ---------------------------------------------------------------------------
// Header, stats, footer
// ---------------------------------------------------------------------------

/** Title size: as big as `max`, down to `min`, one line within `width`. */
export function fitTitle(
	m: Measurer,
	title: string,
	width: number,
	max: number,
	min: number,
): { size: number; text: string } {
	const at1 = m.width("display", 100, title, -2) / 100;
	const size = Math.max(
		min,
		Math.min(max, Math.floor(width / Math.max(at1, 0.01))),
	);
	return {
		size,
		text: truncate(m, "display", size, title, width, -0.02 * size),
	};
}

interface Stat {
	v: string;
	k: string;
}
function statsOf(route: TripRoute): Stat[] {
	const s = route.stats;
	const plural = (n: number, one: string, many: string) =>
		n === 1 ? one : many;
	return [
		{ v: String(s.days), k: plural(s.days, "day", "days") },
		{ v: String(s.countries), k: plural(s.countries, "country", "countries") },
		{ v: String(s.cities), k: plural(s.cities, "city", "cities") },
		{ v: s.km.toLocaleString("en-US"), k: "km" },
	];
}

function statsRow(
	m: Measurer,
	stats: Stat[],
	cx: number,
	top: number,
	o: { num: number; label: number; gap: number; maxW: number },
): { svg: string; h: number } {
	let num = o.num;
	let label = o.label;
	const widths = () =>
		stats.map((s) =>
			Math.max(m.width("display", num, s.v), m.width("text", label, s.k)),
		);
	let ws = widths();
	const total = () => ws.reduce((a, b) => a + b, 0) + o.gap * (ws.length - 1);
	if (total() > o.maxW) {
		const k = o.maxW / total();
		num *= k;
		label *= k;
		ws = widths();
	}
	let x = cx - total() / 2;
	const numLh = m.lineHeight("display", num);
	const base1 = top + m.ascent("display", num);
	const base2 = top + numLh + m.ascent("text", label);
	let svg = "";
	stats.forEach((s, i) => {
		const w = ws[i] ?? 0;
		svg += text(x + w / 2, base1, s.v, "display", num, C.text, {
			anchor: "middle",
		});
		svg += text(x + w / 2, base2, s.k, "text", label, C.muted, {
			anchor: "middle",
		});
		x += w + o.gap;
	});
	return { svg, h: numLh + m.lineHeight("text", label) };
}

function footer(m: Measurer, cx: number, top: number, size: number): string {
	const icon = size * 1.3;
	const label = "planned with Yonder";
	const w = icon + size * 0.6 + m.width("text", size, label);
	const x = cx - w / 2;
	const lh = m.lineHeight("text", size);
	const h = Math.max(icon, lh);
	const base = top + (h - lh) / 2 + m.ascent("text", size);
	return (
		logo(x + icon * 0.05, top + (h - icon) / 2, icon) +
		text(x + icon + size * 0.6, base, label, "text", size, C.faint)
	);
}

// ---------------------------------------------------------------------------
// The map
// ---------------------------------------------------------------------------

export interface Rect {
	x: number;
	y: number;
	w: number;
	h: number;
}
const overlaps = (a: Rect, b: Rect) =>
	a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
const inside = (a: Rect, b: Rect) =>
	a.x >= b.x && a.y >= b.y && a.x + a.w <= b.x + b.w && a.y + a.h <= b.y + b.h;

const MAX_COUNTRIES_FOR_SECOND_LABEL = 6;

export interface PlacedLabel {
	name: string;
	countryKey: string;
	rect: Rect;
	x: number;
	baseline: number;
	size: number;
	anchor: "start" | "end" | "middle";
}

interface MapDot {
	id: string;
	name: string;
	countryKey: string;
	color: string;
	nights: number;
	firstIndex: number;
	x: number;
	y: number;
	r: number;
	stay: boolean;
}

/**
 * Greedy label placement: each country's biggest stay first (then the
 * second-biggest, from 2 nights, on maps of up to 6 countries), right of the
 * dot, else left, above, below;
 * a label never overlaps another label or a dot and stays inside `bounds`.
 */
export function placeLabels(
	m: Measurer,
	dots: readonly MapDot[],
	bounds: Rect,
	sizes: { big: number; small: number },
): PlacedLabel[] {
	const byCountry = new Map<string, MapDot[]>();
	for (const d of dots) {
		if (!d.stay) continue;
		const list = byCountry.get(d.countryKey) ?? [];
		list.push(d);
		byCountry.set(d.countryKey, list);
	}
	const primary: MapDot[] = [];
	const secondary: MapDot[] = [];
	// A second city per country only while the map isn't busy anyway.
	const seconds = byCountry.size <= MAX_COUNTRIES_FOR_SECOND_LABEL;
	for (const list of byCountry.values()) {
		list.sort((a, b) => b.nights - a.nights || a.firstIndex - b.firstIndex);
		if (list[0]) primary.push(list[0]);
		if (seconds && list[1] && list[1].nights >= 2) secondary.push(list[1]);
	}
	const order = (a: MapDot, b: MapDot) =>
		b.nights - a.nights || a.firstIndex - b.firstIndex;
	const queue = [...primary.sort(order), ...secondary.sort(order)];
	const obstacles: Rect[] = dots.map((d) => ({
		x: d.x - d.r - 2,
		y: d.y - d.r - 2,
		w: 2 * d.r + 4,
		h: 2 * d.r + 4,
	}));
	const placed: PlacedLabel[] = [];
	for (const d of queue) {
		const size = d.nights >= 3 ? sizes.big : sizes.small;
		const w = m.width("textSemi", size, d.name);
		const cap = m.capHeight("textSemi", size);
		const asc = m.ascent("textSemi", size);
		const lh = m.lineHeight("textSemi", size);
		const gap = d.r + 5;
		const candidates: Omit<
			PlacedLabel,
			"rect" | "name" | "countryKey" | "size"
		>[] = [
			{ x: d.x + gap, baseline: d.y + cap / 2, anchor: "start" },
			{ x: d.x - gap, baseline: d.y + cap / 2, anchor: "end" },
			{ x: d.x, baseline: d.y - gap - (lh - asc), anchor: "middle" },
			{ x: d.x, baseline: d.y + gap + asc, anchor: "middle" },
		];
		for (const c of candidates) {
			const left =
				c.anchor === "start" ? c.x : c.anchor === "end" ? c.x - w : c.x - w / 2;
			const rect = {
				x: left - 2,
				y: c.baseline - asc - 1,
				w: w + 4,
				h: lh + 2,
			};
			if (!inside(rect, bounds)) continue;
			if (placed.some((p) => overlaps(p.rect, rect))) continue;
			// Its own dot is next to it, never under it; every other dot is an obstacle.
			if (obstacles.some((o) => overlaps(o, rect))) continue;
			placed.push({ ...c, rect, name: d.name, countryKey: d.countryKey, size });
			break;
		}
	}
	return placed;
}

interface RoutePoint {
	id: string;
	name: string;
	countryKey: string;
	coord: LngLat;
	color: string;
	nights: number;
	/** How you got here from the previous point. */
	mode: EdgeMode;
	stay: boolean;
}

/** Start, stays, the way home: every located point in order. */
function routePoints(route: TripRoute): RoutePoint[] {
	const pts: RoutePoint[] = [];
	const add = (
		p: { id: string; name: string; countryKey: string; coord: LngLat | null },
		mode: EdgeMode,
		extra: { color: string; nights: number; stay: boolean },
	) => {
		if (p.coord) pts.push({ ...p, coord: p.coord, mode, ...extra });
	};
	const neutral = { color: ROUTE_NEUTRAL, nights: 0, stay: false };
	if (route.start) add(route.start, "unset", neutral);
	for (const s of route.stays)
		add(s, s.modeIn, { color: s.color, nights: s.nights, stay: true });
	for (const v of route.viaPlaces ?? []) add(v, route.modeOut, neutral);
	if (route.end) add(route.end, route.modeOut, neutral);
	return pts;
}

const FLIGHT_GUESS_KM = 900;

function drawMap(
	m: Measurer,
	route: TripRoute,
	frame: MapFrame,
	labelBounds: Rect,
	o: { labelBig: number; labelSmall: number; dotScale: number },
): { svg: string; labels: PlacedLabel[]; dots: Rect[] } {
	let s = "";
	const clipId = "mapclip";
	if (frame.kind === "globe") {
		const { cx, cy, r } = frame;
		s += `<circle cx="${n1(cx)}" cy="${n1(cy)}" r="${n1(r + 8)}" fill="rgb(111,180,255)" opacity="0.1" filter="url(#halo)"/>`;
		s += `<clipPath id="${clipId}"><circle cx="${n1(cx)}" cy="${n1(cy)}" r="${n1(r)}"/></clipPath>`;
		s += `<circle cx="${n1(cx)}" cy="${n1(cy)}" r="${n1(r)}" fill="url(#sphere)"/>`;
		s += `<g clip-path="url(#${clipId})">`;
		s += `<path d="${landPath(frame)}" fill="#ffffff" fill-opacity="0.07" stroke="#ffffff" stroke-opacity="0.09" stroke-width="0.5"/>`;
		s += `<path d="${graticulePath(frame)}" fill="none" stroke="#ffffff" stroke-opacity="0.07" stroke-width="1"/>`;
		s += `<circle cx="${n1(cx)}" cy="${n1(cy)}" r="${n1(r)}" fill="url(#sphereShade)"/>`;
		s += "</g>";
		s += `<circle cx="${n1(cx)}" cy="${n1(cy)}" r="${n1(r)}" fill="none" stroke="#1f2937" stroke-width="1"/>`;
	} else {
		const sphere = spherePath(frame);
		s += `<clipPath id="${clipId}"><path d="${sphere}"/></clipPath>`;
		s += `<path d="${sphere}" fill="#0c1117" stroke="#1f2937" stroke-width="1"/>`;
		s += `<g clip-path="url(#${clipId})">`;
		s += `<path d="${landPath(frame)}" fill="#ffffff" fill-opacity="0.075" stroke="#ffffff" stroke-opacity="0.1" stroke-width="0.5"/>`;
		s += `<path d="${graticulePath(frame)}" fill="none" stroke="#ffffff" stroke-opacity="0.07" stroke-width="1"/>`;
		s += "</g>";
	}

	// Route: flights are lifted white arcs, everything else a ground line in the arriving country's colour.
	const pts = routePoints(route);
	let glow = "";
	let lines = "";
	for (let i = 1; i < pts.length; i++) {
		const a = pts[i - 1] as RoutePoint;
		const b = pts[i] as RoutePoint;
		if (a.coord[0] === b.coord[0] && a.coord[1] === b.coord[1]) continue;
		const km = haversineKm(a.coord, b.coord);
		const flight =
			b.mode === "flight" || (b.mode === "unset" && km > FLIGHT_GUESS_KM);
		const d = legPath(frame, a.coord, b.coord, flight);
		if (!d) continue;
		const color = flight ? C.flight : b.color;
		glow += `<path d="${d}" fill="none" stroke="${color}" stroke-width="${flight ? 6 : 8}" stroke-linecap="round" stroke-linejoin="round" opacity="0.18"/>`;
		lines += `<path d="${d}" fill="none" stroke="${color}" stroke-width="${flight ? 1.6 : 2.6}" stroke-linecap="round" stroke-linejoin="round" opacity="${flight ? 0.85 : 1}"/>`;
	}
	const clipRoute =
		frame.kind === "globe" && frame.zoom > 1
			? ` clip-path="url(#${clipId})"`
			: "";
	s += `<g${clipRoute}><g filter="url(#lineglow)">${glow}</g>${lines}</g>`;

	// Dots: one per city (stays sized by nights), grey for home and transit.
	const dots: MapDot[] = [];
	const seen = new Map<string, MapDot>();
	pts.forEach((p, i) => {
		const prev = seen.get(p.id);
		if (prev) {
			prev.nights += p.nights;
			// Home is also a stay (a round trip from Tokyo): it's that country's dot.
			if (p.stay && !prev.stay)
				Object.assign(prev, {
					stay: true,
					color: p.color,
					countryKey: p.countryKey,
					firstIndex: i,
				});
			return;
		}
		const q = projectPoint(frame, p.coord);
		if (!q) return;
		if (
			frame.kind === "globe" &&
			frame.zoom > 1 &&
			Math.hypot(q.x - frame.cx, q.y - frame.cy) > frame.r - 2
		)
			return;
		const d: MapDot = {
			id: p.id,
			name: p.name,
			countryKey: p.countryKey,
			color: p.color,
			nights: p.nights,
			firstIndex: i,
			x: q.x,
			y: q.y,
			r: 0,
			stay: p.stay,
		};
		seen.set(p.id, d);
		dots.push(d);
	});
	for (const d of dots) d.r = (d.nights >= 3 ? 5 : 3.5) * o.dotScale;
	// Small first, so the big stays sit on top.
	const drawOrder = [...dots].sort((a, b) => a.r - b.r);
	for (const d of drawOrder) {
		s += `<circle cx="${n1(d.x)}" cy="${n1(d.y)}" r="${n1(d.r * 1.6)}" fill="${d.color}" opacity="0.55" filter="url(#dotglow)"/>`;
		s += `<circle cx="${n1(d.x)}" cy="${n1(d.y)}" r="${n1(d.r + 3 * o.dotScale)}" fill="${d.color}" fill-opacity="0.33"/>`;
		s += `<circle cx="${n1(d.x)}" cy="${n1(d.y)}" r="${n1(d.r)}" fill="${d.color}"/>`;
	}
	const labels = placeLabels(m, dots, labelBounds, {
		big: o.labelBig,
		small: o.labelSmall,
	});
	for (const l of labels)
		s += text(l.x, l.baseline, l.name, "textSemi", l.size, C.text, {
			anchor: l.anchor,
			filter: "labelshadow",
		});
	return {
		svg: s,
		labels,
		dots: dots.map((d) => ({
			x: d.x - d.r,
			y: d.y - d.r,
			w: 2 * d.r,
			h: 2 * d.r,
		})),
	};
}

// ---------------------------------------------------------------------------
// Route list
// ---------------------------------------------------------------------------

interface ListStyle {
	x: number;
	w: number;
	/** Two lines per row (name ··· nights / cities) or one. */
	twoLine: boolean;
	/** Mode icons between rows (1–4 rows) instead of a continuous rail. */
	icons: boolean;
	name: number;
	nights: number;
	city: number;
	from: number;
	padTop: number;
	padBottom: number;
	dotR: number;
	/** One-line rows: the name column (widened to fit region names). */
	nameCol: number;
	/** Left column (dot, rail, icons) width and the gap after it. */
	col: number;
	gap: number;
	icon: number;
}

const MIN_CITIES_W = 64;
const nightsText = (n: number) => `${n} ${n === 1 ? "night" : "nights"}`;
const rowLabel = (r: CardRow) =>
	r.kind === "more" ? r.label : r.label.toUpperCase();
const alpha = (hex: string, a: string) =>
	/^#[0-9a-f]{6}$/i.test(hex) ? `${hex}${a}` : hex;

function rowHeight(m: Measurer, st: ListStyle): number {
	if (st.twoLine)
		return (
			st.padTop +
			Math.max(
				m.lineHeight("textBold", st.name),
				m.lineHeight("mono", st.nights),
			) +
			2 +
			m.lineHeight("text", st.city) +
			st.padBottom
		);
	return (
		st.padTop +
		Math.max(
			m.lineHeight("textBold", st.name),
			m.lineHeight("mono", st.nights),
			m.lineHeight("text", st.city),
		) +
		st.padBottom
	);
}

function listHeight(
	m: Measurer,
	route: TripRoute,
	rows: CardRow[],
	st: ListStyle,
): number {
	let h = 0;
	if (route.start) h += m.lineHeight("text", st.from) + 6;
	if (!rows.length) h += m.lineHeight("text", st.city) + 8;
	h += rows.length * rowHeight(m, st);
	if (route.end) h += 4 + Math.max(st.icon, m.lineHeight("text", st.from));
	return h;
}

function homeLine(route: TripRoute): string | null {
	if (!route.end) return null;
	const via = route.via.length ? ` via ${route.via.join(", ")}` : "";
	return `${route.endsHome ? "Home" : `To ${route.end.name}`}${via}`;
}

function drawList(
	m: Measurer,
	route: TripRoute,
	rows: CardRow[],
	st: ListStyle,
	top: number,
): string {
	let s = "";
	let y = top;
	const colX = st.x + st.col / 2;
	const textX = st.x + st.col + st.gap;
	const right = st.x + st.w;
	const rail = 2;
	if (route.start) {
		s += text(
			textX,
			y + m.ascent("text", st.from),
			`From ${route.start.name}`,
			"text",
			st.from,
			C.muted,
		);
		y += m.lineHeight("text", st.from) + 6;
	}
	if (!rows.length) {
		s += text(
			textX,
			y + 4 + m.ascent("text", st.city),
			"No stays planned yet",
			"text",
			st.city,
			C.faint,
		);
		y += m.lineHeight("text", st.city) + 8;
	}
	const rh = rowHeight(m, st);
	// Names shrink together (to 80%) before any of them is cut.
	const lsOf = (size: number) => (st.twoLine ? 0.14 : 0.12) * size;
	const widestAt = (size: number) =>
		Math.max(
			0,
			...rows.map((r) => m.width("textBold", size, rowLabel(r), lsOf(size))),
		);
	const widestNights = Math.max(
		0,
		...rows.map((r) => m.width("mono", st.nights, nightsText(r.nights))),
	);
	const nameRoom = st.twoLine
		? right - textX - widestNights - 24
		: st.nameCol * 1.45;
	const nameSize =
		st.name *
		Math.min(1, Math.max(0.8, nameRoom / Math.max(1, widestAt(st.name))));
	const nameLs = lsOf(nameSize);
	const nameCol = Math.min(
		Math.max(st.nameCol, widestAt(nameSize)),
		st.nameCol * 1.45,
	);
	rows.forEach((r, i) => {
		const color = r.colors[0] ?? ROUTE_NEUTRAL;
		const nameColor = r.kind === "more" ? C.muted : color;
		const nights = nightsText(r.nights);
		const nightsW = m.width("mono", st.nights, nights);
		const parts = r.parts.join(" · ");
		if (st.twoLine) {
			const lineH = Math.max(
				m.lineHeight("textBold", nameSize),
				m.lineHeight("mono", st.nights),
			);
			const base =
				y +
				st.padTop +
				m.ascent("textBold", nameSize) +
				(lineH - m.lineHeight("textBold", nameSize)) / 2;
			const dotY = base - m.capHeight("textBold", nameSize) / 2;
			if (st.icons) {
				// Icon above the dot, then the country's line down to the next row.
				const iconY = y + st.padTop - st.icon / 2 - 1;
				s += modeIcon(
					r.modeIn,
					colX,
					Math.max(
						y + st.icon / 2 + 1,
						Math.min(iconY, dotY - st.dotR - st.icon / 2 - 2),
					),
					st.icon,
				);
				s += `<rect x="${n1(colX - rail / 2)}" y="${n1(dotY + st.dotR)}" width="${rail}" height="${n1(Math.max(0, y + rh - dotY - st.dotR))}" fill="${alpha(color, "66")}"/>`;
			} else {
				const from = i === 0 ? dotY : y;
				s += `<rect x="${n1(colX - rail / 2)}" y="${n1(from)}" width="${rail}" height="${n1(y + rh - from)}" fill="${alpha(color, "66")}"/>`;
			}
			s += dot(
				colX,
				dotY,
				st.dotR,
				r.colors.length ? r.colors : [ROUTE_NEUTRAL],
			);
			const nameMax = right - textX - nightsW - 24;
			const label = truncate(
				m,
				"textBold",
				nameSize,
				rowLabel(r),
				nameMax,
				nameLs,
			);
			const labelW = m.width("textBold", nameSize, label, nameLs);
			s += text(textX, base, label, "textBold", nameSize, nameColor, {
				ls: nameLs,
			});
			const l0 = textX + labelW + 10 - nameLs;
			const l1 = right - nightsW - 10;
			if (l1 - l0 > 8)
				s += `<line x1="${n1(l0)}" y1="${n1(base - 4.5)}" x2="${n1(l1)}" y2="${n1(base - 4.5)}" stroke="${C.leader}" stroke-width="1" stroke-dasharray="1 2"/>`;
			s += text(right, base, nights, "mono", st.nights, C.text, {
				anchor: "end",
			});
			if (parts) {
				const cityBase = y + st.padTop + lineH + 2 + m.ascent("text", st.city);
				s += text(
					textX,
					cityBase,
					truncate(m, "text", st.city, parts, right - textX),
					"text",
					st.city,
					C.faint,
				);
			}
		} else {
			const cy = y + rh / 2;
			const base = (font: CardFont, size: number) =>
				cy - m.lineHeight(font, size) / 2 + m.ascent(font, size);
			const from = i === 0 ? cy : y;
			s += `<rect x="${n1(colX - rail / 2)}" y="${n1(from)}" width="${rail}" height="${n1(y + rh - from)}" fill="${alpha(color, "66")}"/>`;
			s += dot(colX, cy, st.dotR, r.colors.length ? r.colors : [ROUTE_NEUTRAL]);
			const citiesX = textX + nameCol + 12;
			const citiesMax = right - nightsW - 12 - citiesX;
			// Cities get their own column only when there's room for more than a stub.
			const withCities = !!parts && citiesMax >= MIN_CITIES_W;
			const label = truncate(
				m,
				"textBold",
				nameSize,
				rowLabel(r),
				withCities ? nameCol : right - nightsW - 12 - textX,
				nameLs,
			);
			s += text(
				textX,
				base("textBold", nameSize),
				label,
				"textBold",
				nameSize,
				nameColor,
				{ ls: nameLs },
			);
			if (withCities)
				s += text(
					citiesX,
					base("text", st.city),
					truncate(m, "text", st.city, parts, citiesMax),
					"text",
					st.city,
					C.faint,
				);
			s += text(
				right,
				base("mono", st.nights),
				nights,
				"mono",
				st.nights,
				C.text,
				{ anchor: "end" },
			);
		}
		y += rh;
	});
	const home = homeLine(route);
	if (home) {
		const h = Math.max(st.icon, m.lineHeight("text", st.from));
		const cy = y + 4 + h / 2;
		s += modeIcon(
			route.modeOut === "unset" ? "flight" : route.modeOut,
			colX,
			cy,
			st.icon,
		);
		s += text(
			textX,
			cy - m.lineHeight("text", st.from) / 2 + m.ascent("text", st.from),
			truncate(m, "text", st.from, home, right - textX),
			"text",
			st.from,
			C.muted,
		);
	}
	return s;
}

type Tier = "roomy" | "compact" | "dense";

/** What the builder decided, for tests (and nothing else). */
export interface CardLayout {
	width: number;
	height: number;
	tier: Tier;
	rows: CardRow[];
	title: { size: number; text: string };
	map: { kind: "globe" | "flat"; zoom: number; box: Rect };
	labels: PlacedLabel[];
	/** The city dots on the map. */
	dots: Rect[];
	/** Where labels may go. */
	labelBounds: Rect;
}

export interface ShareCard {
	svg: string;
	layout: CardLayout;
}
export const tierOf = (rows: number): Tier =>
	rows <= 4 ? "roomy" : rows <= 8 ? "compact" : "dense";

function storyList(tier: Tier): ListStyle {
	const base = {
		x: 44,
		w: 452,
		from: 12,
		city: 12,
		col: 18,
		gap: 12,
		icon: 15,
	};
	if (tier === "roomy")
		return {
			...base,
			twoLine: true,
			icons: true,
			name: 15,
			nights: 14,
			padTop: 12,
			padBottom: 6,
			dotR: 6,
			nameCol: 120,
		};
	if (tier === "compact")
		return {
			...base,
			twoLine: false,
			icons: false,
			name: 13,
			nights: 13,
			padTop: 8,
			padBottom: 8,
			dotR: 5,
			nameCol: 120,
		};
	return {
		...base,
		twoLine: false,
		icons: false,
		name: 12,
		nights: 12,
		padTop: 5,
		padBottom: 5,
		dotR: 5,
		nameCol: 112,
	};
}

function squareList(tier: Tier, x: number, w: number): ListStyle {
	const base = { x, w, col: 16, gap: 10, icon: 13 };
	if (tier === "roomy")
		return {
			...base,
			twoLine: true,
			icons: true,
			name: 13,
			nights: 12,
			city: 10.5,
			from: 10.5,
			padTop: 10,
			padBottom: 5,
			dotR: 5,
			nameCol: 100,
		};
	if (tier === "compact")
		return {
			...base,
			twoLine: true,
			icons: false,
			name: 11,
			nights: 10.5,
			city: 9.5,
			from: 10,
			padTop: 6,
			padBottom: 5,
			dotR: 4,
			nameCol: 90,
		};
	return {
		...base,
		twoLine: false,
		icons: false,
		name: 10,
		nights: 10,
		city: 9,
		from: 9.5,
		padTop: 4.5,
		padBottom: 4.5,
		dotR: 3.5,
		nameCol: 84,
	};
}

// ---------------------------------------------------------------------------
// The card
// ---------------------------------------------------------------------------

function defs(bg: { cx: number; cy: number; r: number }): string {
	return `<defs>
<radialGradient id="bg" gradientUnits="userSpaceOnUse" cx="${n1(bg.cx)}" cy="${n1(bg.cy)}" r="${n1(bg.r)}"><stop offset="0" stop-color="#111827"/><stop offset="0.58" stop-color="#000000"/></radialGradient>
<radialGradient id="sphere" cx="0.35" cy="0.3" r="0.955"><stop offset="0" stop-color="#1b2330"/><stop offset="0.55" stop-color="#0e1218"/><stop offset="1" stop-color="#07090c"/></radialGradient>
<radialGradient id="sphereShade" cx="0.42" cy="0.36" r="0.72"><stop offset="0.6" stop-color="#000000" stop-opacity="0"/><stop offset="1" stop-color="#000000" stop-opacity="0.55"/></radialGradient>
<filter id="halo" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="30"/></filter>
<filter id="lineglow" filterUnits="userSpaceOnUse" x="0" y="0" width="540" height="960"><feGaussianBlur stdDeviation="3"/></filter>
<filter id="dotglow" x="-200%" y="-200%" width="500%" height="500%"><feGaussianBlur stdDeviation="4"/></filter>
<filter id="labelshadow" x="-20%" y="-60%" width="140%" height="220%"><feDropShadow dx="0" dy="1" stdDeviation="3" flood-color="#000000" flood-opacity="0.95"/><feDropShadow dx="0" dy="0" stdDeviation="1" flood-color="#000000" flood-opacity="0.9"/></filter>
</defs>`;
}

function wrap(
	size: CardSize,
	h: number,
	body: string,
	bg: { cx: number; cy: number; r: number },
): string {
	const px = CARD_SIZES[size];
	return `<svg xmlns="http://www.w3.org/2000/svg" width="${px.width}" height="${px.height}" viewBox="0 0 540 ${h}">${defs(bg)}<rect width="540" height="${h}" fill="#000000"/><rect width="540" height="${h}" fill="url(#bg)"/>${body}</svg>`;
}

/** Splits `leftover` between gaps, each at least its minimum (CSS flex-grow with min-height). */
function shareGaps(leftover: number, mins: number[]): number[] {
	const out = mins.map(() => 0);
	let free = [...mins.keys()];
	let rest = leftover;
	for (;;) {
		const each = rest / Math.max(1, free.length);
		const under = free.filter((i) => (mins[i] ?? 0) > each);
		if (!under.length) {
			for (const i of free) out[i] = each;
			return out;
		}
		for (const i of under) {
			out[i] = mins[i] ?? 0;
			rest -= mins[i] ?? 0;
		}
		free = free.filter((i) => !under.includes(i));
		if (!free.length) return out;
	}
}

function story(m: Measurer, data: ShareCardData): ShareCard {
	const W = 540;
	const H = 960;
	const { route } = data;
	const rows = cardRows(route.rows);
	const tier = tierOf(rows.length);
	const st = storyList(tier);

	const top = 36;
	const bottom = H - 28;
	const datesSize = 15;
	const datesH = m.lineHeight("text", datesSize);
	const title = fitTitle(m, data.title, 470, 72, 30);
	const titleTop = top + datesH + 6;
	const titleH = title.size;
	const statsH = 4 + m.lineHeight("display", 34) + m.lineHeight("text", 13);
	const listH = listHeight(m, route, rows, st);
	const footH = Math.max(18, m.lineHeight("text", 14));
	const fixed = datesH + 6 + titleH + statsH + listH + footH;
	const mins = [6, 20, 0];
	const breathing = 3 * 16;
	const room = bottom - top - fixed - breathing;

	// Map box: the mockups' sizes, shrunk to fit.
	const flat = route.view.kind === "flat";
	let box: { w: number; h: number };
	if (flat) {
		const bw = tier === "roomy" ? 520 : 460;
		let r = (bw - 8) / (2 * EE_HALF_W);
		r = Math.min(r, (room - 16) / (2 * EE_HALF_H));
		box = { w: 2 * EE_HALF_W * r + 8, h: 2 * EE_HALF_H * r + 16 };
	} else {
		const pref = tier === "roomy" ? 384 : tier === "compact" ? 360 : 320;
		box = { w: 460, h: Math.max(160, Math.min(pref, room)) };
	}
	const [g1 = 0, g2 = 0] = shareGaps(bottom - top - fixed - box.h, mins);
	const mapTop = titleTop + titleH + g1;
	const frame = mapFrame(route.view, {
		x: (W - box.w) / 2,
		y: mapTop,
		w: box.w,
		h: box.h,
	});
	const statsTop = mapTop + box.h + 4;
	const listTop = statsTop + statsH - 4 + g2;
	const footTop = bottom - footH;

	let body = "";
	body += textCentredSpaced(
		m,
		W / 2,
		top + m.ascent("text", datesSize),
		data.dates.toUpperCase(),
		"text",
		datesSize,
		C.muted,
		0.3 * datesSize,
	);
	body += text(
		W / 2,
		titleTop +
			(titleH - m.lineHeight("display", title.size)) / 2 +
			m.ascent("display", title.size),
		title.text,
		"display",
		title.size,
		C.text,
		{
			anchor: "middle",
			ls: -0.02 * title.size,
		},
	);
	const labelBounds = { x: 6, y: mapTop - 4, w: W - 12, h: box.h + 8 };
	const map = drawMap(m, route, frame, labelBounds, {
		labelBig: 13,
		labelSmall: 11,
		dotScale: 1,
	});
	body += map.svg;
	body += statsRow(m, statsOf(route), W / 2, statsTop, {
		num: 34,
		label: 13,
		gap: 28,
		maxW: 470,
	}).svg;
	body += drawList(m, route, rows, st, listTop);
	body += footer(m, W / 2, footTop, 14);
	return {
		svg: wrap("story", H, body, { cx: W / 2, cy: frame.cy - 28, r: 697 }),
		layout: {
			width: W,
			height: H,
			tier,
			rows,
			title,
			map: {
				kind: frame.kind,
				zoom: frame.zoom,
				box: { x: frame.x, y: frame.y, w: frame.w, h: frame.h },
			},
			labels: map.labels,
			dots: map.dots,
			labelBounds,
		},
	};
}

function square(m: Measurer, data: ShareCardData): ShareCard {
	const W = 540;
	const H = 540;
	const { route } = data;
	const rows = cardRows(route.rows);
	const tier = tierOf(rows.length);
	const top = 28;
	const bottom = H - 20;
	const side = 28;
	const datesSize = 12;
	const datesH = m.lineHeight("text", datesSize);
	const title = fitTitle(m, data.title, W - 2 * side, 50, 24);
	const titleTop = top + datesH + 4;
	const footSize = 11.5;
	const footH = Math.max(15, m.lineHeight("text", footSize));
	const bodyTop = titleTop + title.size + 18;
	const bodyBottom = bottom - footH - 14;
	const bodyH = bodyBottom - bodyTop;

	// Left: map + stats. Right: the route list.
	const leftW = 238;
	const listX = side + leftW + 24;
	const st = squareList(tier, listX, W - side - listX);
	const statsO = { num: 24, label: 10, gap: 16, maxW: leftW };
	const statsH = m.lineHeight("display", 24) + m.lineHeight("text", 10) + 6;
	let box: { w: number; h: number };
	if (route.view.kind === "flat") {
		const r = (leftW - 8) / (2 * EE_HALF_W);
		box = { w: leftW, h: 2 * EE_HALF_H * r + 20 };
	} else {
		box = { w: leftW, h: Math.min(leftW, bodyH - statsH) };
	}
	const leftH = box.h + statsH;
	const mapTop = bodyTop + Math.max(0, (bodyH - leftH) / 2);
	const frame = mapFrame(route.view, {
		x: side,
		y: mapTop,
		w: box.w,
		h: box.h,
	});
	const listH = listHeight(m, route, rows, st);
	const listTop = bodyTop + Math.max(0, (bodyH - listH) / 2);

	let body = "";
	body += textCentredSpaced(
		m,
		W / 2,
		top + m.ascent("text", datesSize),
		data.dates.toUpperCase(),
		"text",
		datesSize,
		C.muted,
		0.3 * datesSize,
	);
	body += text(
		W / 2,
		titleTop +
			(title.size - m.lineHeight("display", title.size)) / 2 +
			m.ascent("display", title.size),
		title.text,
		"display",
		title.size,
		C.text,
		{
			anchor: "middle",
			ls: -0.02 * title.size,
		},
	);
	const labelBounds = { x: 4, y: mapTop - 4, w: listX - 10, h: box.h + 8 };
	const map = drawMap(m, route, frame, labelBounds, {
		labelBig: 10.5,
		labelSmall: 9,
		dotScale: 0.8,
	});
	body += map.svg;
	body += statsRow(
		m,
		statsOf(route),
		side + leftW / 2,
		mapTop + box.h + 6,
		statsO,
	).svg;
	body += drawList(m, route, rows, st, listTop);
	body += footer(m, W / 2, bottom - footH, footSize);
	return {
		svg: wrap("square", H, body, { cx: frame.cx, cy: frame.cy, r: 520 }),
		layout: {
			width: W,
			height: H,
			tier,
			rows,
			title,
			map: {
				kind: frame.kind,
				zoom: frame.zoom,
				box: { x: frame.x, y: frame.y, w: frame.w, h: frame.h },
			},
			labels: map.labels,
			dots: map.dots,
			labelBounds,
		},
	};
}

/** Centred text with letter spacing: CSS puts the spacing after every letter, so centre without the last. */
function textCentredSpaced(
	m: Measurer,
	cx: number,
	y: number,
	s: string,
	font: CardFont,
	size: number,
	fill: string,
	ls: number,
): string {
	const w = m.width(font, size, s, ls) - ls;
	return text(cx - w / 2, y, s, font, size, fill, { ls });
}

export function buildShareCard(
	data: ShareCardData,
	size: CardSize,
	m: Measurer,
): ShareCard {
	return size === "story" ? story(m, data) : square(m, data);
}

export const buildShareCardSvg = (
	data: ShareCardData,
	size: CardSize,
	m: Measurer,
): string => buildShareCard(data, size, m).svg;
