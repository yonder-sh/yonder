/**
 * The filing suggestion (SPEC §14.4): where a new place goes in the trip
 * tree, from a provider's address parts. Pure; the server runs it for
 * `getPlacePreview` and the tests pin the Tokyo cases.
 *
 * - country: matched by ISO code, then by name; created when missing.
 * - region: never created (a trip's regions are its own idea, like "Mt. Fuji");
 *   an existing region only hosts a NEW city whose admin area matches it.
 * - city: matched by name anywhere under the country (Tokyo's wards come from
 *   Google as `locality`, so a ward whose admin area is an existing city is
 *   treated as an area of that city); a REGION with the city's name stands in
 *   for it (Tokyo saved as the metropolis).
 * - area: matched by the neighbourhood or ward name anywhere under the city;
 *   when nothing matches, the neighbourhood becomes a new area ("Ginza 2"
 *   → "Ginza (new)").
 *
 * Names match case-, accent-, suffix- ("City", "-ku") and chōme-insensitively.
 */
import type { NodeType } from "@/lib/schemas/enums";

export type AddressParts = {
	country?: string;
	/** ISO 3166-1 alpha-2, upper case. */
	countryCode?: string;
	/** State / prefecture / `administrative_area_level_1`. */
	region?: string;
	/** City / town / `locality` (Tokyo's wards arrive here from Google). */
	city?: string;
	/** Ward / district / `sublocality_level_1`. */
	district?: string;
	/** Neighbourhood / Photon `locality` ("Ginza 2"). */
	locality?: string;
};

export type FilingNode = {
	id: string;
	parentId: string | null;
	type: NodeType;
	name: string;
	localName?: string | null;
	countryCode?: string | null;
	status?: "active" | "dropped";
	googlePlaceId?: string | null;
	osmRef?: string | null;
	lat?: number | null;
	lng?: number | null;
};

export type Filing = {
	/** Existing node ids, root-most first (the deepest is the parent, unless `create` follows). */
	existing: string[];
	/** New ancestors to create below the last existing one, root-most first. */
	create: { type: NodeType; name: string }[];
};

const RANK: Record<NodeType, number> = {
	country: 0,
	region: 1,
	city: 2,
	area: 3,
	place: 4,
};

/** Folds a place name for matching: accents, case, admin suffixes, chōme numbers, punctuation. */
export function normName(raw: string | null | undefined): string {
	if (!raw) return "";
	let s = raw.normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase().trim();
	s = s.replace(/\s*\([^)]*\)\s*$/, ""); // "Ginza (Chuo)"
	s = s.replace(/\s*\d+\s*(-?\s*chome)?$/, ""); // "Ginza 2", "Ginza 2-chome"
	s = s.replace(/\d+丁目$/, "");
	s = s.replace(
		/\s+(city|ward|district|prefecture|province|metropolis|special city|municipality)$/,
		"",
	);
	s = s.replace(/-(ku|shi|to|fu|ken|gun|machi|cho|mura|gu|dong|si)$/, "");
	s = s.replace(/[区市都府県]$/, "");
	return s.replace(/[^\p{L}\p{N}]+/gu, "");
}

/** A display name for a new node: "Ginza 2" → "Ginza", "Chuo City" → "Chuo". */
export function cleanNewName(raw: string): string {
	return raw
		.trim()
		.replace(/\s*\d+\s*(-?\s*chome)?$/i, "")
		.replace(/\d+丁目$/, "")
		.replace(/\s+(City|Ward)$/, "")
		.trim();
}

function same(node: FilingNode, name: string | undefined): boolean {
	const n = normName(name);
	if (!n) return false;
	return normName(node.name) === n || normName(node.localName) === n;
}

function indexNodes(nodes: readonly FilingNode[]) {
	const byId = new Map(nodes.map((n) => [n.id, n]));
	const kids = new Map<string | null, FilingNode[]>();
	for (const n of nodes) {
		const list = kids.get(n.parentId) ?? [];
		list.push(n);
		kids.set(n.parentId, list);
	}
	const subtree = (rootId: string | null): FilingNode[] => {
		const out: FilingNode[] = [];
		const stack = [...(kids.get(rootId) ?? [])];
		while (stack.length) {
			const n = stack.shift() as FilingNode;
			out.push(n);
			stack.push(...(kids.get(n.id) ?? []));
		}
		return out;
	};
	const path = (id: string): string[] => {
		const out: string[] = [];
		let cur = byId.get(id);
		for (let guard = 0; cur && guard < 32; guard++) {
			out.unshift(cur.id);
			cur = cur.parentId ? byId.get(cur.parentId) : undefined;
		}
		return out;
	};
	return { byId, kids, subtree, path };
}

/**
 * Where a result of `level` goes: the existing chain and the ancestors to
 * create. Countries go to the top level; a city under its country; an area
 * under its city; a place under its area.
 */
export function suggestFiling(
	nodes: readonly FilingNode[],
	parts: AddressParts,
	level: NodeType,
): Filing {
	const live = nodes.filter((n) => n.status !== "dropped");
	const ix = indexNodes(live);
	const none: Filing = { existing: [], create: [] };
	if (level === "country") return none;

	// ---- country --------------------------------------------------------
	const code = parts.countryCode?.toUpperCase();
	const country =
		live.find(
			(n) =>
				n.type === "country" && code && n.countryCode?.toUpperCase() === code,
		) ?? live.find((n) => n.type === "country" && same(n, parts.country));
	const countryName = parts.country?.trim() || code;
	if (!country && !countryName) return none;
	if (level === "region") {
		return country
			? { existing: ix.path(country.id), create: [] }
			: {
					existing: [],
					create: [{ type: "country", name: countryName as string }],
				};
	}
	const scope = country ? ix.subtree(country.id) : [];

	// ---- city -----------------------------------------------------------
	const cityCandidates = [parts.city, parts.region].filter(
		(s): s is string => !!s?.trim(),
	);
	let city: FilingNode | undefined;
	let wardFromCity: string | undefined;
	if (country) {
		city = scope.find((n) => n.type === "city" && same(n, parts.city));
		// A region named like the result's city hosts it as its city: "Where
		// to first?" saves Tokyo as the metropolis (a region), and a place in
		// Tokyo must then go under it, not under a second "Tokyo".
		if (!city && parts.city)
			city = scope.find((n) => n.type === "region" && same(n, parts.city));
		if (!city && parts.region) {
			city = scope.find((n) => n.type === "city" && same(n, parts.region));
			// Google gives Tokyo's wards as `locality`: "Chuo City" is then an area.
			if (city && parts.city && !same(city, parts.city))
				wardFromCity = parts.city;
		}
	}
	if (level === "city") {
		// A city is filed under its country (or an existing matching region).
		const region =
			country && parts.region
				? scope.find((n) => n.type === "region" && same(n, parts.region))
				: undefined;
		if (region) return { existing: ix.path(region.id), create: [] };
		if (country) return { existing: ix.path(country.id), create: [] };
		return {
			existing: [],
			create: [{ type: "country", name: countryName as string }],
		};
	}

	// ---- area / place ---------------------------------------------------
	const create: Filing["create"] = [];
	let existing: string[] = [];
	if (city) {
		existing = ix.path(city.id);
	} else {
		if (country) {
			const region = parts.region
				? scope.find((n) => n.type === "region" && same(n, parts.region))
				: undefined;
			existing = ix.path((region ?? country).id);
		} else create.push({ type: "country", name: countryName as string });
		const cityName = cityCandidates[0];
		if (cityName) create.push({ type: "city", name: cleanNewName(cityName) });
	}
	if (level === "area") return { existing, create };

	const areaCandidates = [parts.locality, parts.district, wardFromCity].filter(
		(s): s is string => !!s?.trim(),
	);
	const within = city ? ix.subtree(city.id) : [];
	for (const cand of areaCandidates) {
		const hit = within.find(
			(n) => RANK[n.type] > RANK.city && n.type !== "place" && same(n, cand),
		);
		if (hit) return { existing: ix.path(hit.id), create: [] };
	}
	const newArea = areaCandidates[0] ? cleanNewName(areaCandidates[0]) : "";
	const cityName = city?.name ?? create.find((c) => c.type === "city")?.name;
	if (newArea && normName(newArea) !== normName(cityName))
		create.push({ type: "area", name: newArea });
	return { existing, create };
}

/** Great-circle distance in metres. */
export function distanceM(
	a: { lat: number; lng: number },
	b: { lat: number; lng: number },
): number {
	const R = 6_371_000;
	const rad = Math.PI / 180;
	const dLat = (b.lat - a.lat) * rad;
	const dLng = (b.lng - a.lng) * rad;
	const h =
		Math.sin(dLat / 2) ** 2 +
		Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLng / 2) ** 2;
	return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** The same folded name counts this far apart: a provider's point and a
 * geocoded (imported) one can sit a block apart ("Itoya" 110 m off). */
export const DUP_SAME_NAME_M = 250;
/** One folded name containing the other ("Itoya" / "Itoya Ginza"): nearer. */
export const DUP_SIMILAR_NAME_M = 100;

type DupPoint = { lat: number; lng: number; name?: string | null };

/**
 * A live node that is the same place (E8 duplicate check): the same Google
 * place id or OSM ref, else a place whose folded name is the same within
 * 250 m, or contains / is contained in it within 100 m. `also` is a second
 * point (and name) to compare, the spot a shared Maps link named: the
 * provider's match for it may sit further from the trip's own pin than the
 * link does. The nearest match wins.
 */
export function findDuplicate(
	nodes: readonly FilingNode[],
	p: {
		googlePlaceId?: string | null;
		osmRef?: string | null;
		name: string;
		lat?: number | null;
		lng?: number | null;
		also?: DupPoint | null;
	},
): FilingNode | undefined {
	const live = nodes.filter((n) => n.status !== "dropped");
	if (p.googlePlaceId) {
		const hit = live.find((n) => n.googlePlaceId === p.googlePlaceId);
		if (hit) return hit;
	}
	if (p.osmRef) {
		const hit = live.find((n) => n.osmRef === p.osmRef);
		if (hit) return hit;
	}
	const points: { at: { lat: number; lng: number }; name: string }[] = [];
	const own = normName(p.name);
	if (p.lat != null && p.lng != null && own)
		points.push({ at: { lat: p.lat, lng: p.lng }, name: own });
	if (p.also) {
		const at = { lat: p.also.lat, lng: p.also.lng };
		for (const name of new Set([own, normName(p.also.name)]))
			if (name) points.push({ at, name });
	}
	if (!points.length) return undefined;
	// "Itoya" vs "Itoya Ginza": one folded name containing the other counts
	// when the shorter is at least 4 characters.
	const radiusFor = (a: string, b: string): number =>
		a === b
			? DUP_SAME_NAME_M
			: Math.min(a.length, b.length) >= 4 && (a.includes(b) || b.includes(a))
				? DUP_SIMILAR_NAME_M
				: -1;
	let best: { node: FilingNode; d: number } | undefined;
	for (const n of live) {
		if (n.type !== "place" || n.lat == null || n.lng == null) continue;
		const names = [normName(n.name), normName(n.localName)].filter(Boolean);
		for (const pt of points) {
			const r = Math.max(...names.map((nm) => radiusFor(nm, pt.name)));
			if (r < 0) continue;
			const d = distanceM(pt.at, { lat: n.lat, lng: n.lng });
			if (d <= r && (!best || d < best.d)) best = { node: n, d };
		}
	}
	return best?.node;
}
