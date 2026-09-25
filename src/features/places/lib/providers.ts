/**
 * Pure mappers from provider payloads (Photon GeoJSON, Google Places (New)
 * JSON) to our search results, previews and filing parts. No I/O: the
 * fetches live in `server/providers.server.ts`; the tests feed recorded
 * payloads through these.
 */
import type { NodeType, PlaceCategory } from "@/lib/schemas/enums";
import { type ResultKind, resultKind } from "./categorize";
import type { AddressParts } from "./filing";

// ---------------------------------------------------------------------------
// Shapes shared with the client (the server-function return types).
// ---------------------------------------------------------------------------

export type PlaceProvider = "google" | "photon";

export type PlaceSearchResult = {
	ref: string;
	title: string;
	subtitle: string;
	types: string[];
	lat?: number;
	lng?: number;
};

export type PlacePhoto = {
	idx: number;
	width: number;
	height: number;
	attributions: { name: string; uri?: string }[];
};

/** What `getPlacePreview` returns: the normalised place plus its filing (§14.4). */
export type PlacePreview = {
	provider: PlaceProvider;
	ref: string;
	name: string;
	localName?: string;
	address?: string;
	lat: number;
	lng: number;
	countryCode?: string;
	category?: string;
	website?: string;
	phone?: string;
	rating?: number;
	userRatingCount?: number;
	openHoursText?: string;
	photos: PlacePhoto[];
	/** The suggested filing: existing node ids and new ancestors to create (§14.4). */
	filing: { existing: string[]; create: { type: string; name: string }[] };
	/** The level the result stands for (a country, a city, an area or a place). */
	level?: NodeType;
	/** `[west, south, east, north]` for coarse results. */
	bbox?: [number, number, number, number];
	googleMapsUri?: string;
	/** Photon results: the OSM ref to store (`N123`), for duplicate checks. */
	osmRef?: string;
};

/** A normalised preview without the trip-specific filing. */
export type PreviewCore = {
	provider: PlaceProvider;
	ref: string;
	name: string;
	localName?: string;
	address?: string;
	lat: number;
	lng: number;
	countryCode?: string;
	level: NodeType;
	category?: PlaceCategory;
	website?: string;
	phone?: string;
	rating?: number;
	userRatingCount?: number;
	openHoursText?: string;
	googleMapsUri?: string;
	bbox?: [number, number, number, number];
	photos: PlacePhoto[];
	parts: AddressParts;
};

// ---------------------------------------------------------------------------
// Photon
// ---------------------------------------------------------------------------

export type PhotonProperties = {
	osm_type?: string;
	osm_id?: number;
	osm_key?: string;
	osm_value?: string;
	type?: string;
	name?: string;
	housenumber?: string;
	street?: string;
	locality?: string;
	district?: string;
	city?: string;
	county?: string;
	state?: string;
	country?: string;
	countrycode?: string;
	postcode?: string;
	extent?: number[];
};

export type PhotonFeature = {
	type?: string;
	properties: PhotonProperties;
	geometry: { type?: string; coordinates: [number, number] };
};

export const PHOTON_REF_RE = /^osm:[NWR]\d{1,15}$/;

/** `osm:N123` — the stable id of an OSM object (stored as `nodes.osm_ref`). */
export function photonRef(p: PhotonProperties): string | null {
	const t = p.osm_type?.toUpperCase();
	if (!t || !["N", "W", "R"].includes(t) || !Number.isFinite(p.osm_id))
		return null;
	return `osm:${t}${p.osm_id}`;
}

export function photonTypes(p: PhotonProperties): string[] {
	const out: string[] = [];
	if (p.osm_key && p.osm_value) out.push(`osm:${p.osm_key}=${p.osm_value}`);
	if (p.type) out.push(`photon:${p.type}`);
	return out;
}

function joinParts(xs: (string | undefined)[]): string {
	const seen = new Set<string>();
	const out: string[] = [];
	for (const x of xs) {
		const v = x?.trim();
		if (!v || seen.has(v.toLowerCase())) continue;
		seen.add(v.toLowerCase());
		out.push(v);
	}
	return out.join(", ");
}

/** "Ginza 2, Chuo, Tokyo, Japan" (the name itself left out). */
export function photonAddress(p: PhotonProperties): string {
	const street = p.street
		? p.housenumber
			? `${p.housenumber} ${p.street}`
			: p.street
		: undefined;
	return joinParts([
		street,
		p.locality,
		p.district,
		p.city ?? p.county,
		p.state && p.state !== p.city ? p.state : undefined,
		p.country,
	]).replace(new RegExp(`^${escapeRe(p.name ?? "")}, `), "");
}

function escapeRe(s: string): string {
	return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function photonParts(p: PhotonProperties): AddressParts {
	const kind = resultKind(photonTypes(p));
	// A city result names itself; an area result names its city.
	return {
		country: p.country,
		countryCode: p.countrycode?.toUpperCase(),
		region: p.state,
		city: kind.level === "city" ? p.name : (p.city ?? p.county),
		district:
			kind.level === "area" && p.type === "district" ? p.name : p.district,
		locality:
			kind.level === "area" && p.type !== "district" ? p.name : p.locality,
	};
}

export function photonResult(f: PhotonFeature): PlaceSearchResult | null {
	const p = f.properties;
	const ref = photonRef(p);
	const [lng, lat] = f.geometry?.coordinates ?? [];
	if (!ref || !p.name || !Number.isFinite(lat) || !Number.isFinite(lng))
		return null;
	return {
		ref,
		title: p.name,
		subtitle: photonAddress(p),
		types: photonTypes(p),
		lat: lat as number,
		lng: lng as number,
	};
}

export function photonPreview(f: PhotonFeature): PreviewCore | null {
	const r = photonResult(f);
	if (!r || r.lat === undefined || r.lng === undefined) return null;
	const p = f.properties;
	const kind: ResultKind = resultKind(r.types);
	const e = p.extent;
	const bbox =
		e && e.length === 4 && e.every(Number.isFinite)
			? ([
					Math.min(e[0] as number, e[2] as number),
					Math.min(e[1] as number, e[3] as number),
					Math.max(e[0] as number, e[2] as number),
					Math.max(e[1] as number, e[3] as number),
				] as [number, number, number, number])
			: undefined;
	return {
		provider: "photon",
		ref: r.ref,
		name: r.title,
		address: r.subtitle || undefined,
		lat: r.lat,
		lng: r.lng,
		countryCode: p.countrycode?.toUpperCase(),
		level: kind.level,
		category: kind.category,
		bbox: kind.level === "place" ? undefined : bbox,
		photos: [],
		parts: photonParts(p),
	};
}

/**
 * Photon often returns the same place twice (a building and its grounds, a
 * node and its way). Keep the first of results with the same name within
 * ~150 m, and cap the list.
 */
export function dedupeResults(
	results: readonly PlaceSearchResult[],
	limit = 8,
): PlaceSearchResult[] {
	const out: PlaceSearchResult[] = [];
	for (const r of results) {
		const dup = out.some(
			(o) =>
				o.title.toLowerCase() === r.title.toLowerCase() &&
				o.lat !== undefined &&
				r.lat !== undefined &&
				o.lng !== undefined &&
				r.lng !== undefined &&
				Math.abs(o.lat - r.lat) < 0.0015 &&
				Math.abs(o.lng - r.lng) < 0.0015,
		);
		if (!dup) out.push(r);
		if (out.length >= limit) break;
	}
	return out;
}

// ---------------------------------------------------------------------------
// Google Places (New)
// ---------------------------------------------------------------------------

export type GoogleSuggestion = {
	placePrediction?: {
		placeId?: string;
		structuredFormat?: {
			mainText?: { text?: string };
			secondaryText?: { text?: string };
		};
		text?: { text?: string };
		types?: string[];
	};
};

export function googleResult(s: GoogleSuggestion): PlaceSearchResult | null {
	const p = s.placePrediction;
	if (!p?.placeId) return null;
	const title = p.structuredFormat?.mainText?.text ?? p.text?.text;
	if (!title) return null;
	return {
		ref: p.placeId,
		title,
		subtitle: p.structuredFormat?.secondaryText?.text ?? "",
		types: p.types ?? [],
	};
}

export type GoogleAddressComponent = {
	longText?: string;
	shortText?: string;
	types?: string[];
	languageCode?: string;
};

export type GooglePlace = {
	id?: string;
	displayName?: { text?: string; languageCode?: string };
	formattedAddress?: string;
	location?: { latitude?: number; longitude?: number };
	viewport?: {
		low?: { latitude?: number; longitude?: number };
		high?: { latitude?: number; longitude?: number };
	};
	types?: string[];
	primaryType?: string;
	addressComponents?: GoogleAddressComponent[];
	photos?: {
		name?: string;
		widthPx?: number;
		heightPx?: number;
		authorAttributions?: { displayName?: string; uri?: string }[];
	}[];
	googleMapsUri?: string;
	timeZone?: { id?: string };
	websiteUri?: string;
	nationalPhoneNumber?: string;
	internationalPhoneNumber?: string;
	rating?: number;
	userRatingCount?: number;
	priceLevel?: string;
	regularOpeningHours?: {
		periods?: {
			open?: { day?: number; hour?: number; minute?: number };
			close?: { day?: number; hour?: number; minute?: number };
		}[];
		weekdayDescriptions?: string[];
	};
};

export const GOOGLE_PLACE_ID_RE = /^[A-Za-z0-9_-]{10,300}$/;
export const GOOGLE_PHOTO_NAME_RE =
	/^places\/[A-Za-z0-9_-]+\/photos\/[A-Za-z0-9_-]+$/;

function component(
	cs: readonly GoogleAddressComponent[] | undefined,
	type: string,
	short = false,
): string | undefined {
	const c = cs?.find((x) => x.types?.includes(type));
	return (short ? c?.shortText : c?.longText) ?? undefined;
}

export function googleParts(g: GooglePlace): AddressParts {
	const cs = g.addressComponents;
	return {
		country: component(cs, "country"),
		countryCode: component(cs, "country", true)?.toUpperCase(),
		region: component(cs, "administrative_area_level_1"),
		city: component(cs, "locality") ?? component(cs, "postal_town"),
		district:
			component(cs, "sublocality_level_1") ?? component(cs, "sublocality"),
		locality: component(cs, "neighborhood"),
	};
}

/** Google photos without their names (names never leave the server, §14.1). */
export function googlePhotos(g: GooglePlace): PlacePhoto[] {
	return (g.photos ?? []).slice(0, 10).map((p, idx) => ({
		idx,
		width: p.widthPx ?? 0,
		height: p.heightPx ?? 0,
		attributions: (p.authorAttributions ?? [])
			.filter((a) => a.displayName)
			.map((a) => ({
				name: a.displayName as string,
				...(a.uri && /^https:\/\//.test(a.uri) ? { uri: a.uri } : {}),
			})),
	}));
}

export function googlePreview(g: GooglePlace): PreviewCore | null {
	const lat = g.location?.latitude;
	const lng = g.location?.longitude;
	if (!g.id || !g.displayName?.text || lat === undefined || lng === undefined)
		return null;
	const types = [g.primaryType, ...(g.types ?? [])].filter(
		(t): t is string => !!t,
	);
	const kind = resultKind(types);
	const lo = g.viewport?.low;
	const hi = g.viewport?.high;
	const bbox =
		kind.level !== "place" &&
		lo?.longitude !== undefined &&
		lo.latitude !== undefined &&
		hi?.longitude !== undefined &&
		hi.latitude !== undefined
			? ([lo.longitude, lo.latitude, hi.longitude, hi.latitude] as [
					number,
					number,
					number,
					number,
				])
			: undefined;
	const parts = googleParts(g);
	return {
		provider: "google",
		ref: g.id,
		name: g.displayName.text,
		address: g.formattedAddress,
		lat,
		lng,
		countryCode: parts.countryCode,
		level: kind.level,
		category: kind.category,
		website:
			g.websiteUri && /^https?:\/\//.test(g.websiteUri)
				? g.websiteUri
				: undefined,
		phone: g.nationalPhoneNumber ?? g.internationalPhoneNumber,
		rating: g.rating,
		userRatingCount: g.userRatingCount,
		openHoursText: g.regularOpeningHours?.weekdayDescriptions?.join("; "),
		googleMapsUri: g.googleMapsUri,
		bbox,
		photos: googlePhotos(g),
		parts,
	};
}

/** "Open in Google Maps" for any node (a place id when known, else the coordinates). */
export function googleMapsLink(n: {
	name: string;
	lat: number | null;
	lng: number | null;
	googlePlaceId?: string | null;
	googleMapsUri?: string | null;
}): string | null {
	if (
		n.googleMapsUri &&
		/^https:\/\/(maps\.google\.|www\.google\.)/.test(n.googleMapsUri)
	)
		return n.googleMapsUri;
	if (n.lat == null || n.lng == null) return null;
	const q = encodeURIComponent(`${n.lat},${n.lng}`);
	const id = n.googlePlaceId
		? `&query_place_id=${encodeURIComponent(n.googlePlaceId)}`
		: "";
	return `https://www.google.com/maps/search/?api=1&query=${q}${id}`;
}
