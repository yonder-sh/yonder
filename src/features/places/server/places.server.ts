/**
 * Server helpers behind `places.functions.ts`: the trip's nodes for filing and
 * duplicate checks, previews by provider ref, and the E8 shared-link resolver
 * (short links followed through Google Maps hosts only, ≤ 3 hops, reading
 * only `Location`).
 */
import { and, eq, isNull } from "drizzle-orm";
import { db } from "@/db/db.server";
import { nodes } from "@/db/schema";
import { fail } from "@/server/authz/session.server";
import { type FilingNode, suggestFiling } from "../lib/filing";
import { parseMapsUrl } from "../lib/maps-url";
import {
	GOOGLE_PLACE_ID_RE,
	PHOTON_REF_RE,
	type PlacePreview,
	type PlaceProvider,
	type PlaceSearchResult,
	type PreviewCore,
} from "../lib/providers";
import { expandShortLink } from "../lib/short-link";
import { nameSimilarity } from "../lib/similarity";
import {
	googleDetails,
	googleSearch,
	photonLookup,
	photonReverse,
	photonSearch,
	provider,
} from "./providers.server";

/** Searches per user per minute (typing is debounced 300 ms client-side). */
export const SEARCH_PER_MIN = 90;
export const DETAILS_PER_MIN = 40;

export async function filingNodes(tripId: string): Promise<FilingNode[]> {
	return db
		.select({
			id: nodes.id,
			parentId: nodes.parentId,
			type: nodes.type,
			name: nodes.name,
			localName: nodes.localName,
			countryCode: nodes.countryCode,
			status: nodes.status,
			googlePlaceId: nodes.googlePlaceId,
			osmRef: nodes.osmRef,
			lat: nodes.lat,
			lng: nodes.lng,
		})
		.from(nodes)
		.where(and(eq(nodes.tripId, tripId), isNull(nodes.deletedAt)));
}

export function withFiling(
	core: PreviewCore,
	all: readonly FilingNode[],
): PlacePreview {
	const { parts, level, ...rest } = core;
	const osmRef =
		core.provider === "photon" ? core.ref.replace(/^osm:/, "") : undefined;
	return {
		...rest,
		level,
		...(osmRef ? { osmRef } : {}),
		filing: suggestFiling(all, parts, level),
	};
}

export async function previewFor(
	p: PlaceProvider,
	ref: string,
	sessionToken: string,
): Promise<PreviewCore> {
	if (p === "google") {
		if (!GOOGLE_PLACE_ID_RE.test(ref))
			return fail("VALIDATION", "bad place id");
		return googleDetails(ref, sessionToken);
	}
	if (!PHOTON_REF_RE.test(ref)) return fail("VALIDATION", "bad place ref");
	return photonLookup(ref);
}

export function crumbOf(all: readonly FilingNode[], id: string): string {
	const byId = new Map(all.map((n) => [n.id, n]));
	const names: string[] = [];
	let cur = byId.get(id);
	for (let guard = 0; cur && guard < 16; guard++) {
		names.unshift(cur.name);
		cur = cur.parentId ? byId.get(cur.parentId) : undefined;
	}
	return names.slice(0, -1).join(" › ");
}

const near300 = (
	r: Pick<PlaceSearchResult, "lat" | "lng">,
	at: { lat: number; lng: number } | undefined,
) =>
	!at ||
	r.lat === undefined ||
	r.lng === undefined ||
	Math.hypot(
		(r.lat - at.lat) * 111_000,
		(r.lng - at.lng) * 111_000 * Math.cos((at.lat * Math.PI) / 180),
	) <= 300;

export type SharedLinkSpot = { lat: number; lng: number; name?: string };

/**
 * A shared URL → a preview core (or what it named, for a search prefill):
 * a place id (Google), else a search for its name biased to 300 m (the top
 * result within 300 m, or a similar name ≥ 0.6), else a dropped pin. `link`
 * is the spot the URL itself named (`@lat,lng`, `!3d…!4d…`).
 */
export async function resolveUrl(
	raw: string,
	userId: string,
): Promise<{
	core: PreviewCore | null;
	query?: string;
	/** The spot (and name) the link itself named, for the duplicate check. */
	link?: SharedLinkSpot;
}> {
	let parsed = parseMapsUrl(raw);
	if (parsed?.kind === "short") {
		const expanded = await expandShortLink(parsed.url);
		parsed = expanded ? parseMapsUrl(expanded) : null;
	}
	if (parsed?.kind !== "place") return { core: null };
	const name = parsed.name ?? parsed.query;
	const at =
		parsed.lat !== undefined && parsed.lng !== undefined
			? { lat: parsed.lat, lng: parsed.lng }
			: undefined;
	const link = at ? { ...at, ...(name ? { name } : {}) } : undefined;
	const found = await resolveParsed(parsed, name, at, userId);
	return link ? { ...found, link } : found;
}

async function resolveParsed(
	parsed: { placeId?: string },
	name: string | undefined,
	at: { lat: number; lng: number } | undefined,
	userId: string,
): Promise<{ core: PreviewCore | null; query?: string }> {
	const p = provider();
	const token = `share-${userId.slice(0, 20)}`;
	if (parsed.placeId && p === "google") {
		try {
			return { core: await googleDetails(parsed.placeId, token) };
		} catch {
			// fall through to a search
		}
	}
	if (name) {
		const bias = at ? { ...at, radiusM: 300 } : undefined;
		const results =
			p === "google"
				? await googleSearch(name, token, { bias })
				: await photonSearch(name, { bias });
		const top = results[0];
		const pick =
			(at
				? results.find((r) => r.lat !== undefined && near300(r, at))
				: undefined) ??
			(top && nameSimilarity(top.title, name) >= 0.6 && near300(top, at)
				? top
				: undefined);
		if (pick) {
			try {
				return { core: await previewFor(p, pick.ref, token) };
			} catch {
				// fall through
			}
		}
	}
	if (at) {
		const rev = await photonReverse(at.lat, at.lng);
		// A dropped pin at the shared spot, named from the link when it had one.
		if (rev)
			return {
				core: {
					...rev,
					lat: at.lat,
					lng: at.lng,
					...(name ? { name, level: "place" as const } : {}),
				},
			};
	}
	return { core: null, query: name };
}
