/**
 * Place providers (SPEC §14.1, §14.4): Google Places (New) when
 * `GOOGLE_MAPS_API_KEY` is set, else Photon (OpenStreetMap). Plain `fetch`
 * against fixed, env-configured hosts (no user-supplied URLs, so no SSRF
 * surface), with timeouts, a minimal field mask, an identifying User-Agent for
 * Photon, Redis caches with TTLs and a global Photon pace (~4/s, its fair-use
 * policy). Photo NAMES never leave this module (Google forbids caching them
 * beyond an hour, and they expire): callers get indexes and attributions.
 */
import { createHash } from "node:crypto";
import type { NodeType } from "@/lib/schemas/enums";
import { fail } from "@/server/authz/session.server";
import { cacheGet, cacheSet, rateLimitPer } from "@/server/cache.server";
import { getEnv, osmUserAgent } from "@/server/env.server";
import { googlePrimaryTypes, photonLayers } from "../lib/categorize";
import {
	dedupeResults,
	GOOGLE_PHOTO_NAME_RE,
	type GooglePlace,
	type GoogleSuggestion,
	googlePreview,
	googleResult,
	type PhotonFeature,
	type PlaceProvider,
	type PlaceSearchResult,
	type PreviewCore,
	photonPreview,
	photonRef,
	photonResult,
} from "../lib/providers";

const TIMEOUT_MS = 8_000;
const PHOTON_TTL = 10 * 60;
const PHOTON_FEATURE_TTL = 60 * 60;
const GOOGLE_PHOTO_TTL = 55 * 60; // "no more than 1 hour" (§14.1)
const DETAILS_MASK =
	"id,formattedAddress,location,viewport,types,addressComponents,photos,displayName,primaryType,googleMapsUri,timeZone";
const ENTERPRISE_MASK =
	"websiteUri,regularOpeningHours,rating,userRatingCount,nationalPhoneNumber,priceLevel";

export type Bias = { lat: number; lng: number; radiusM?: number };

export function provider(): PlaceProvider {
	return getEnv().GOOGLE_MAPS_API_KEY ? "google" : "photon";
}

function hash(...parts: unknown[]): string {
	return createHash("sha256")
		.update(JSON.stringify(parts))
		.digest("hex")
		.slice(0, 32);
}

async function getJson<T>(url: string, init: RequestInit): Promise<T> {
	let res: Response;
	try {
		res = await fetch(url, {
			...init,
			redirect: "error",
			signal: AbortSignal.timeout(TIMEOUT_MS),
		});
	} catch (e) {
		console.warn(
			"[places] provider unreachable:",
			e instanceof Error ? e.name : "error",
		);
		return fail("PROVIDER", "The place search didn't answer. Try again.");
	}
	if (res.status === 429)
		return fail("RATE_LIMITED", "The place search is busy. Try again soon.");
	if (!res.ok) {
		console.warn(`[places] provider answered ${res.status}`);
		return fail("PROVIDER");
	}
	const text = await res.text();
	if (text.length > 2_000_000) return fail("PROVIDER");
	try {
		return JSON.parse(text) as T;
	} catch {
		return fail("PROVIDER");
	}
}

// ---------------------------------------------------------------------------
// Photon
// ---------------------------------------------------------------------------

async function photonPace(): Promise<void> {
	try {
		await rateLimitPer("photon:global", 4, 1);
	} catch (e) {
		if (e instanceof Error && e.message.startsWith("RATE_LIMITED")) throw e;
		// Redis down: the per-user limit still applies.
	}
}

function photonUrl(path: string, params: Record<string, string | string[]>) {
	const u = new URL(path, getEnv().PHOTON_URL);
	for (const [k, v] of Object.entries(params))
		for (const x of Array.isArray(v) ? v : [v]) u.searchParams.append(k, x);
	return u.toString();
}

async function rememberFeatures(features: PhotonFeature[]): Promise<void> {
	await Promise.all(
		features.map((f) => {
			const ref = photonRef(f.properties ?? {});
			return ref
				? cacheSet(["photon", "feature", ref], f, PHOTON_FEATURE_TTL)
				: undefined;
		}),
	);
}

export async function photonSearch(
	q: string,
	opts: { bias?: Bias; level?: NodeType } = {},
): Promise<PlaceSearchResult[]> {
	const norm = q.trim().toLowerCase().replace(/\s+/g, " ");
	const bias = opts.bias
		? {
				lat: Math.round(opts.bias.lat * 100) / 100,
				lng: Math.round(opts.bias.lng * 100) / 100,
			}
		: null;
	const layers = photonLayers(opts.level);
	const cacheKey = hash(norm, bias, layers);
	const cached = await cacheGet<PlaceSearchResult[]>("photon", "q", cacheKey);
	if (cached) return cached;
	await photonPace();
	const params: Record<string, string | string[]> = {
		q: norm,
		limit: "12",
		lang: "en",
	};
	if (bias) {
		params.lat = String(bias.lat);
		params.lon = String(bias.lng);
	}
	if (layers.length) params.layer = layers;
	const body = await getJson<{ features?: PhotonFeature[] }>(
		photonUrl("/api/", params),
		{ headers: { "User-Agent": osmUserAgent(), Accept: "application/json" } },
	);
	const features = (body.features ?? []).filter(
		(f) => f?.properties && Array.isArray(f.geometry?.coordinates),
	);
	await rememberFeatures(features);
	const results = dedupeResults(
		features
			.map(photonResult)
			.filter((r): r is PlaceSearchResult => r !== null),
	);
	await cacheSet(["photon", "q", cacheKey], results, PHOTON_TTL);
	return results;
}

/** A Photon result by its ref: from the search that returned it (cached an hour). */
export async function photonLookup(ref: string): Promise<PreviewCore> {
	const f = await cacheGet<PhotonFeature>("photon", "feature", ref);
	const preview = f ? photonPreview(f) : null;
	if (!preview) return fail("NOT_FOUND", "That result expired. Search again.");
	return preview;
}

export async function photonReverse(
	lat: number,
	lng: number,
): Promise<PreviewCore | null> {
	const key = hash(lat.toFixed(5), lng.toFixed(5));
	const cached = await cacheGet<PreviewCore | { none: true }>(
		"photon",
		"rev",
		key,
	);
	if (cached) return "none" in cached ? null : cached;
	await photonPace();
	const body = await getJson<{ features?: PhotonFeature[] }>(
		photonUrl("/reverse", {
			lat: String(lat),
			lon: String(lng),
			lang: "en",
			limit: "1",
		}),
		{ headers: { "User-Agent": osmUserAgent(), Accept: "application/json" } },
	);
	const f = body.features?.[0];
	if (f) await rememberFeatures([f]);
	const preview = f ? photonPreview(f) : null;
	await cacheSet(["photon", "rev", key], preview ?? { none: true }, PHOTON_TTL);
	return preview;
}

// ---------------------------------------------------------------------------
// Google Places (New)
// ---------------------------------------------------------------------------

function googleHeaders(mask: string): Record<string, string> {
	const key = getEnv().GOOGLE_MAPS_API_KEY;
	if (!key) return fail("PROVIDER", "Google isn't set up here.");
	return {
		"X-Goog-Api-Key": key,
		"X-Goog-FieldMask": mask,
		"Content-Type": "application/json",
	};
}

function googleUrl(path: string, params: Record<string, string> = {}): string {
	const u = new URL(path, getEnv().GOOGLE_PLACES_URL);
	for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
	return u.toString();
}

export async function googleSearch(
	q: string,
	sessionToken: string,
	opts: { bias?: Bias; level?: NodeType } = {},
): Promise<PlaceSearchResult[]> {
	const body: Record<string, unknown> = {
		input: q,
		languageCode: "en",
		...(sessionToken ? { sessionToken } : {}),
	};
	if (opts.bias)
		body.locationBias = {
			circle: {
				center: { latitude: opts.bias.lat, longitude: opts.bias.lng },
				radius: Math.min(opts.bias.radiusM ?? 30_000, 50_000),
			},
		};
	const types = googlePrimaryTypes(opts.level);
	if (types.length) body.includedPrimaryTypes = types;
	const res = await getJson<{ suggestions?: GoogleSuggestion[] }>(
		googleUrl("/v1/places:autocomplete"),
		{
			method: "POST",
			headers: googleHeaders(
				"suggestions.placePrediction.placeId,suggestions.placePrediction.structuredFormat,suggestions.placePrediction.types",
			),
			body: JSON.stringify(body),
		},
	);
	return (res.suggestions ?? [])
		.map(googleResult)
		.filter((r): r is PlaceSearchResult => r !== null)
		.slice(0, 8);
}

async function googlePlace(
	placeId: string,
	mask: string,
	sessionToken?: string,
): Promise<GooglePlace> {
	return getJson<GooglePlace>(
		googleUrl(`/v1/places/${encodeURIComponent(placeId)}`, {
			languageCode: "en",
			...(sessionToken ? { sessionToken } : {}),
		}),
		{ headers: googleHeaders(mask) },
	);
}

/** Place Details (Pro mask) → preview core. Photo names are cached, never returned. */
export async function googleDetails(
	placeId: string,
	sessionToken: string,
): Promise<PreviewCore> {
	const cached = await cacheGet<PreviewCore>("gdetails", placeId);
	if (cached) return cached;
	const g = await googlePlace(placeId, DETAILS_MASK, sessionToken);
	await rememberPhotoNames(placeId, g);
	const preview = googlePreview(g);
	if (!preview) return fail("NOT_FOUND");
	// Place data (not photo names) may be cached briefly for the palette.
	await cacheSet(["gdetails", placeId], preview, 60 * 60);
	return preview;
}

/** Enterprise fields (`getPlaceMoreDetails`), fetched on demand. */
export async function googleEnterprise(placeId: string): Promise<GooglePlace> {
	return googlePlace(placeId, ENTERPRISE_MASK);
}

async function rememberPhotoNames(placeId: string, g: GooglePlace) {
	const names = (g.photos ?? [])
		.map((p) => p.name)
		.filter((n): n is string => !!n && GOOGLE_PHOTO_NAME_RE.test(n))
		.slice(0, 10);
	await cacheSet(["gphotos", placeId], names, GOOGLE_PHOTO_TTL);
	return names;
}

/** Fresh photo metadata (§14.1 Photos): a Details call with mask `photos`. */
export async function googlePhotoMeta(placeId: string): Promise<GooglePlace> {
	const g = await googlePlace(placeId, "photos");
	await rememberPhotoNames(placeId, g);
	return g;
}

/** The short-lived `photoUri` for photo `idx` of a place. */
export async function googlePhotoUri(
	placeId: string,
	idx: number,
	width: number,
): Promise<string | null> {
	let names = await cacheGet<string[]>("gphotos", placeId);
	if (!names)
		names = await rememberPhotoNames(
			placeId,
			await googlePlace(placeId, "photos"),
		);
	const name = names[idx];
	if (!name || !GOOGLE_PHOTO_NAME_RE.test(name)) return null;
	const res = await getJson<{ photoUri?: string }>(
		googleUrl(`/v1/${name}/media`, {
			maxWidthPx: String(Math.max(64, Math.min(1600, Math.round(width)))),
			skipHttpRedirect: "true",
		}),
		{ headers: googleHeaders("photoUri") },
	);
	const uri = res.photoUri;
	return uri && /^https:\/\/[a-z0-9.-]+\.googleusercontent\.com\//i.test(uri)
		? uri
		: null;
}
