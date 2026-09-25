/**
 * "In this trip" matching for the palette (SPEC §13.3: filtered client-side,
 * V): accent-, case- and punctuation-insensitive ("daan" finds Da'an
 * District, "mt fuji" Mt. Fuji), name or local name, every word of the
 * query must appear; prefix matches first, then outline order. Named legs
 * match too (QA HIER-10: "Shinjuku" also lists the "Fuji Excursion
 * (Shinjuku → Kawaguchiko)" leg). Pure.
 */
import { formatFlightNumber } from "@/lib/engine/schedule";
import type { GraphLeg, GraphNode } from "@/lib/engine/types";
import type { LegDetails } from "@/lib/schemas/legs";
import type { LegTarget } from "@/lib/schemas/targets";

/** Apostrophes and quote marks vanish ("Da'an" → "daan"). */
const APOSTROPHES = /['‘’‛`´ʹʻʼʽ′"“”]/g;

export function fold(s: string | null | undefined): string {
	return (s ?? "")
		.normalize("NFKD")
		.replace(/[̀-ͯ]/g, "")
		.toLowerCase()
		.replace(APOSTROPHES, "")
		.replace(/[^\p{L}\p{N}]+/gu, " ")
		.trim();
}

export function matchTripNodes(
	nodes: readonly GraphNode[],
	q: string,
	limit = 8,
): GraphNode[] {
	const words = fold(q).split(/\s+/).filter(Boolean);
	if (!words.length) return [];
	const hits: { n: GraphNode; score: number; i: number }[] = [];
	nodes.forEach((n, i) => {
		const name = fold(n.name);
		const local = fold(n.localName);
		// Spaced and run-together forms: "mt fuji" and "mtfuji" both match.
		const hay = `${name} ${local} ${name.replace(/ /g, "")} ${local.replace(/ /g, "")}`;
		if (!words.every((w) => hay.includes(w))) return;
		const first = words[0] as string;
		const score = name === words.join(" ") ? 0 : name.startsWith(first) ? 1 : 2;
		hits.push({ n, score, i });
	});
	hits.sort((a, b) => a.score - b.score || a.i - b.i);
	return hits.slice(0, limit).map((h) => h.n);
}

/** What a leg is called and the words it can be found by (null: nameless). */
export function legSearchText(
	d: LegDetails,
): { title: string; words: string[] } | null {
	if (d.kind === "transit") {
		const segs = (d.route?.segments ?? []).filter((s) => s.mode !== "walk");
		const lines = segs.map((s) => s.lineName ?? s.lineShort).filter(Boolean);
		const first = segs[0]?.from?.name;
		const last = segs.at(-1)?.to?.name;
		const title =
			d.route?.label ??
			d.booking?.trainNumber ??
			(lines.length
				? `${lines.join(" · ")}${first && last ? ` (${first} → ${last})` : ""}`
				: null);
		if (!title) return null;
		return {
			title,
			words: [
				title,
				d.booking?.trainNumber,
				...segs.flatMap((s) => [
					s.lineName,
					s.lineShort,
					s.from?.name,
					s.to?.name,
				]),
			].filter((w): w is string => !!w),
		};
	}
	if (d.kind === "flight") {
		const f = d.flight;
		const number = formatFlightNumber(f.flightNumber);
		const title = `${number ?? f.airline?.name ?? "Flight"} (${f.from.iata} → ${f.to.iata})`;
		return {
			title,
			words: [
				title,
				f.flightNumber,
				f.airline?.name,
				f.from.name,
				f.to.name,
			].filter((w): w is string => !!w),
		};
	}
	if (d.kind === "other" && d.label?.trim())
		return { title: d.label.trim(), words: [d.label] };
	return null;
}

/** The `sel` target of a leg row. */
export function legTargetOf(leg: GraphLeg): LegTarget | null {
	if (leg.kind === "pair" && leg.fromItemId && leg.toItemId)
		return {
			kind: "pair",
			fromItemId: leg.fromItemId,
			toItemId: leg.toItemId,
		};
	if (leg.stayDayId && (leg.kind === "stay_start" || leg.kind === "stay_end"))
		return {
			kind: "stay",
			dayId: leg.stayDayId,
			end: leg.kind === "stay_start" ? "start" : "end",
		};
	return null;
}

export type LegHit = { leg: GraphLeg; title: string; target: LegTarget };

/**
 * Named legs (a train, a flight, a labelled bus) whose name, line, stops or
 * number hold every word of the query. Booked or hand-entered legs come
 * before autofilled estimates (a search for "Shinjuku" must not lose the
 * Fuji Excursion to three estimated metro rides), then title matches, then
 * trip order.
 */
export function matchTripLegs(
	legs: readonly GraphLeg[],
	details: (leg: GraphLeg) => LegDetails,
	q: string,
	limit = 3,
): LegHit[] {
	const words = fold(q).split(/\s+/).filter(Boolean);
	if (!words.length) return [];
	const hits: (LegHit & { score: number; i: number })[] = [];
	legs.forEach((leg, i) => {
		const text = legSearchText(details(leg));
		const target = legTargetOf(leg);
		if (!text || !target) return;
		const folded = text.words.map(fold);
		const hay = folded.flatMap((w) => [w, w.replace(/ /g, "")]).join(" ");
		if (!words.every((w) => hay.includes(w))) return;
		const title = fold(text.title);
		const estimate = leg.source === "estimate" && !leg.isEdited && !leg.depAt;
		const score =
			(estimate ? 2 : 0) + (title.startsWith(words[0] as string) ? 0 : 1);
		hits.push({ leg, title: text.title, target, score, i });
	});
	hits.sort((a, b) => a.score - b.score || a.i - b.i);
	return hits
		.slice(0, limit)
		.map(({ leg, title, target }) => ({ leg, title, target }));
}

/** Words that mean the rate screen in the palette (FB-05: easy to find). */
const RATE_WORDS = [
	"rate",
	"rate places",
	"rating",
	"ratings",
	"rank",
	"ranking",
	"compare ratings",
	"ideas",
	"triage",
];

/**
 * Whether the palette text asks for the rate screen: "rat", "rate",
 * "ranking", "rate tokyo", "Ideas" (3 letters at least). Pure.
 */
export function matchesRateCommand(q: string): boolean {
	const s = fold(q);
	if (s.length < 3) return false;
	return RATE_WORDS.some(
		(w) => w.startsWith(s) || s.startsWith(`${w} `) || s === w,
	);
}

/** "day 4", "d4", "Day 12" → 4 / 12. */
export function parseDayQuery(q: string): number | null {
	const m = /^\s*(?:day|d)\s*(\d{1,3})\s*$/i.exec(q);
	return m ? Number(m[1]) : null;
}

export function looksLikeUrl(q: string): boolean {
	return /^https?:\/\/\S+$/i.test(q.trim());
}

/**
 * Whether the text is a place search at all: not a link, not a pasted
 * "lat, lng" (except in "Where to first?", which takes countries and
 * cities only), at least 2 characters. Results kept from an earlier search
 * never show under text that isn't one (HIER-12).
 */
export function isPlaceSearch(q: string, coordsAllowed = true): boolean {
	const t = q.trim();
	return (
		t.length >= 2 && !looksLikeUrl(t) && !(coordsAllowed && parseLatLngQuery(t))
	);
}

export type LatLngQuery =
	| { ok: true; lat: number; lng: number }
	| { ok: false; error: string };

const COORD = String.raw`(-?\d{1,3}(?:\.\d+)?)\s*°?\s*([NSEW])?`;
const LATLNG_QUERY = new RegExp(
	`^\\s*${COORD}\\s*(,|\\s)\\s*${COORD}\\s*$`,
	"i",
);

/**
 * A pasted coordinate pair ("35.6941, 139.7045", "35.6941 139.7045",
 * "35.6941° N, 139.7045° E"): the numbers, or why they can't be a place
 * (out of range). Null when the text isn't a coordinate pair at all (two
 * whole numbers need a comma: "12 34" stays a search). Pure.
 */
export function parseLatLngQuery(q: string): LatLngQuery | null {
	const m = LATLNG_QUERY.exec(q);
	if (!m) return null;
	const [, a, ha, sep, b, hb] = m;
	if (sep !== "," && !`${a}${b}`.includes(".") && !ha && !hb) return null;
	const sign = (v: number, h: string | undefined) =>
		h && /[SW]/i.test(h) ? -Math.abs(v) : v;
	let lat = sign(Number(a), ha);
	let lng = sign(Number(b), hb);
	// "139.7° E, 35.6° N": the hemispheres say which is which.
	if (ha && /[EW]/i.test(ha) && hb && /[NS]/i.test(hb)) [lat, lng] = [lng, lat];
	if (Math.abs(lat) > 90 || Math.abs(lng) > 180)
		return {
			ok: false,
			error:
				"Those coordinates are out of range: latitude is −90 to 90, longitude −180 to 180.",
		};
	return { ok: true, lat, lng };
}
