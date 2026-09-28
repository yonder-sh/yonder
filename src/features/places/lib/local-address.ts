/**
 * Today's "Show this to the driver" (One Yonder P16): a place's address in
 * local script, from a Photon reverse result asked with `lang=default`, in the
 * country's own order. Japan, China and Taiwan run large to small with no
 * spaces (東京都中野区中野5丁目52-15), Korea large to small with spaces
 * (서울특별시 세종대로 110), elsewhere small to large ("17 Phố Trần Nguyên Hãn,
 * Khu phố cổ, Hoàn Kiếm, Hà Nội"). Pure.
 */
import { haversineKm, type LngLat } from "@/lib/engine/geo";
import {
	type PhotonFeature,
	type PhotonProperties,
	photonRef,
} from "./providers";

/** A result this far from the place is a neighbour: its house number isn't ours. */
export const EXACT_WITHIN_M = 60;

const HAN = new Set(["CN", "TW", "HK", "MO"]);
const KANJI_DIGIT: Record<string, number> = {
	一: 1,
	二: 2,
	三: 3,
	四: 4,
	五: 5,
	六: 6,
	七: 7,
	八: 8,
	九: 9,
};

/** 五 → 5, 十二 → 12, 二十 → 20; null for anything else. */
function kanjiNumber(k: string): number | null {
	const ten = k.indexOf("十");
	if (ten < 0) return k.length === 1 ? (KANJI_DIGIT[k] ?? null) : null;
	const tens = ten === 0 ? 1 : (KANJI_DIGIT[k.slice(0, ten)] ?? null);
	const ones =
		ten === k.length - 1 ? 0 : (KANJI_DIGIT[k.slice(ten + 1)] ?? null);
	return tens === null || ones === null ? null : tens * 10 + ones;
}

/** "中野五丁目" → "中野5丁目", as addresses are written on cards and in maps. */
export function arabicChome(s: string): string {
	return s.replace(/([一二三四五六七八九十]+)丁目/g, (all, k: string) => {
		const n = kanjiNumber(k);
		return n === null ? all : `${n}丁目`;
	});
}

/** Trimmed, non-empty, each once (a ward that is also the city: 中野区). */
function parts(xs: (string | undefined)[]): string[] {
	const out: string[] = [];
	for (const x of xs) {
		const v = x?.trim();
		if (v && !out.includes(v)) out.push(v);
	}
	return out;
}

function japanese(p: PhotonProperties, exact: boolean): string {
	// A ward that is a city in itself (台東区, no 市 above it) is one of Tokyo's.
	const state = p.state ?? (p.city?.endsWith("区") ? "東京都" : undefined);
	// OSM files the block (番) as the street; a real street name isn't part of a Japanese address.
	const block = p.street && /^\d+$/.test(p.street) ? p.street : undefined;
	const number = !exact
		? undefined
		: block
			? p.housenumber
				? `${block}-${p.housenumber}`
				: block
			: p.housenumber;
	return arabicChome(
		parts([state, p.county, p.city, p.district, p.locality, number]).join(""),
	);
}

function chinese(p: PhotonProperties, exact: boolean, cc: string): string {
	const mark = cc === "CN" ? "号" : "號";
	const number =
		exact && p.housenumber
			? /^[\d-]+$/.test(p.housenumber)
				? `${p.housenumber}${mark}`
				: p.housenumber
			: undefined;
	// Without a number the street is often a footbridge or an alley: the locality says more.
	const tail = number ? [p.street, number] : [p.locality];
	return parts([p.state, p.city, p.district, ...tail]).join("");
}

function korean(p: PhotonProperties, exact: boolean): string {
	// Road-name addresses name the 구/군/시, not the 동 Photon sometimes gives as the district.
	const gu =
		p.district && /[구군시]$/.test(p.district) ? p.district : undefined;
	const road =
		exact && p.street
			? parts([p.street, p.housenumber]).join(" ")
			: parts([p.locality, exact ? p.housenumber : undefined]).join(" ");
	return parts([p.state, p.city, gu, road]).join(" ");
}

function smallToLarge(p: PhotonProperties, exact: boolean): string {
	const street = exact ? parts([p.housenumber, p.street]).join(" ") : undefined;
	return parts([
		street,
		p.locality,
		p.district,
		p.city ?? p.county,
		p.state,
	]).join(", ");
}

/**
 * The address in local script, or null when Photon knows nothing useful.
 * `exact: false` (the result is a neighbour) leaves out the street and number.
 */
export function localAddressOf(
	p: PhotonProperties,
	opts: { exact: boolean },
): string | null {
	const cc = p.countrycode?.toUpperCase() ?? "";
	const s =
		cc === "JP"
			? japanese(p, opts.exact)
			: HAN.has(cc)
				? chinese(p, opts.exact, cc)
				: cc === "KR"
					? korean(p, opts.exact)
					: smallToLarge(p, opts.exact);
	return s.trim() || null;
}

/**
 * The result is the place itself: the same OSM object, a shape that covers
 * the place, or a point within `EXACT_WITHIN_M`.
 */
export function isExactResult(
	f: PhotonFeature,
	place: { lat: number; lng: number; osmRef?: string | null },
): boolean {
	// Stored as `N123` or `osm:N123`.
	const bare = (r: string | null | undefined) =>
		r?.replace(/^osm:/i, "").toUpperCase() || null;
	const ref = bare(photonRef(f.properties));
	if (ref && ref === bare(place.osmRef)) return true;
	const e = f.properties.extent;
	if (e?.length === 4) {
		const [w, n, east, s] = e as [number, number, number, number];
		if (
			place.lng >= Math.min(w, east) &&
			place.lng <= Math.max(w, east) &&
			place.lat >= Math.min(n, s) &&
			place.lat <= Math.max(n, s)
		)
			return true;
	}
	const at: LngLat = f.geometry.coordinates;
	return haversineKm(at, [place.lng, place.lat]) * 1000 <= EXACT_WITHIN_M;
}
