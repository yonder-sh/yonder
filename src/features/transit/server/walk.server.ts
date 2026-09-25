/**
 * The walk chain (SPEC §14.3):
 * 1. Google WALK — a key is set and no endpoint is in Korea.
 * 2. FOSSGIS OSRM foot — through one shared 1 request/s queue (app and
 *    worker), with the OSM User-Agent, cached 30 days.
 * 3. Haversine × 1.3 at the trip's walk speed (`source: 'estimate'`).
 * A provider failure falls through to the next step; the chain always answers.
 */
import { RateLimiterQueue, RateLimiterRedis } from "rate-limiter-flexible";
import { WALK_DETOUR_FACTOR, walkEstimateMin } from "@/lib/engine/suggest";
import type { LineString } from "@/lib/schemas/legs";
import { cacheGet, cacheSet } from "@/server/cache.server";
import { getEnv, osmUserAgent } from "@/server/env.server";
import { key, redis } from "@/server/live/redis.server";
import { ERROR_BAND } from "./jp/router.server";
import { capPoints } from "./jp/transit-route.server";
import { googleWalk } from "./providers/google.server";
import type { Place } from "./providers/types.server";

export type WalkResult = {
	minutes: number;
	distanceM: number;
	source: "google" | "osrm" | "estimate";
	geometry?: LineString;
};

const OSRM_TTL = 30 * 24 * 3600;
/** Longer than any sane walk: skip the providers, keep the estimate. */
const MAX_WALK_M = 25_000;

let osrmQueue: RateLimiterQueue | undefined;
function osrmSlot(): Promise<unknown> {
	osrmQueue ??= new RateLimiterQueue(
		new RateLimiterRedis({
			storeClient: redis(),
			keyPrefix: key("rl", "osrm"),
			points: 1,
			duration: 1,
		}),
		{ maxQueueSize: 50 },
	);
	return osrmQueue.removeTokens(1);
}

function haversineM(a: Place, b: Place): number {
	const R = 6_371_008.8;
	const rad = Math.PI / 180;
	const dLat = (b.lat - a.lat) * rad;
	const dLng = (b.lng - a.lng) * rad;
	const s =
		Math.sin(dLat / 2) ** 2 +
		Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLng / 2) ** 2;
	return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
}

const c5 = (x: number) => x.toFixed(5);

async function osrmWalk(from: Place, to: Place): Promise<WalkResult | null> {
	const env = getEnv();
	const parts = [
		"route",
		"osrm",
		"foot",
		c5(from.lat),
		c5(from.lng),
		c5(to.lat),
		c5(to.lng),
	];
	const cached = await cacheGet<WalkResult>(...parts);
	if (cached) return cached;
	await osrmSlot();
	const url = `${env.OSRM_FOOT_URL.replace(/\/$/, "")}/route/v1/foot/${from.lng},${from.lat};${to.lng},${to.lat}?overview=full&geometries=geojson`;
	const res = await fetch(url, {
		headers: { "User-Agent": osmUserAgent(env) },
		signal: AbortSignal.timeout(8_000),
	});
	if (!res.ok) return null;
	const data = (await res.json()) as {
		code?: string;
		routes?: {
			duration?: number;
			distance?: number;
			geometry?: { coordinates?: [number, number][] };
		}[];
	};
	const r = data.code === "Ok" ? data.routes?.[0] : undefined;
	if (!r || typeof r.distance !== "number") return null;
	// FOSSGIS foot durations assume ~5 km/h; keep the distance, re-time at 4.5 km/h × detour-free.
	const out: WalkResult = {
		minutes: Math.max(1, Math.round((r.duration ?? r.distance / 1.25) / 60)),
		distanceM: Math.round(r.distance),
		source: "osrm",
	};
	const coords = r.geometry?.coordinates;
	if (coords && coords.length >= 2)
		out.geometry = { type: "LineString", coordinates: capPoints(coords) };
	await cacheSet(parts, out, OSRM_TTL);
	return out;
}

/** Three minutes on foot: the distance slack of the estimate's likely range. */
const RANGE_SLACK_M = 250;

/**
 * The walk a provider found is far past the straight-line estimate that
 * chose walking: longer than the estimate's likely range (ERROR_BAND,
 * or the route's own `range.hi`) in minutes **and** in metres. Something is
 * in the way — a lake, a river, a node set in the water (QA MT-R2-03:
 * Oishi Park → Lake Kawaguchiko is 28 min by the straight line, 78 min and
 * 5.9 km by OSRM). Autofill writes nothing then (JAPAN_TRANSIT §3 "long
 * walk"): the leg stays unset and asks for a route. Both limits must be
 * crossed, so a walk that is only slower (the trip's own walk speed against
 * the provider's pace) is still written. The chain's own estimate always fits.
 */
export function walkFarPastEstimate(
	walk: WalkResult,
	estimate: { minutes: number; hiMin?: number; straightM: number },
): boolean {
	if (walk.source === "estimate") return false;
	const hiMin =
		estimate.hiMin ??
		Math.round(
			estimate.minutes * ERROR_BAND.highFactor + ERROR_BAND.highPlusMin,
		);
	const hiM =
		estimate.straightM * WALK_DETOUR_FACTOR * ERROR_BAND.highFactor +
		RANGE_SLACK_M;
	return walk.minutes > hiMin && walk.distanceM > hiM;
}

/** Straight-line metres between two places. */
export const straightLineM = (a: Place, b: Place): number => haversineM(a, b);

/** The chain. `walkSpeedKmh` is the trip's (for the estimate). */
export async function walkChain(
	from: Place,
	to: Place,
	opts: { walkSpeedKmh: number; countries: string[] },
): Promise<WalkResult> {
	const straightM = haversineM(from, to);
	const estimate: WalkResult = {
		minutes: Math.max(1, walkEstimateMin(straightM / 1000, opts.walkSpeedKmh)),
		distanceM: Math.round(straightM * 1.3),
		source: "estimate",
	};
	if (straightM > MAX_WALK_M) return estimate;
	const env = getEnv();
	if (env.GOOGLE_MAPS_API_KEY && !opts.countries.includes("KR")) {
		try {
			const g = await googleWalk(from, to);
			if (g) return { ...g, source: "google" };
		} catch (e) {
			console.warn("[walk] google:", e instanceof Error ? e.message : e);
		}
	}
	try {
		const o = await osrmWalk(from, to);
		if (o) return o;
	} catch (e) {
		console.warn("[walk] osrm:", e instanceof Error ? e.message : e);
	}
	return estimate;
}
