/**
 * Google Routes (SPEC §14.1, §14.2.2): TRANSIT options outside Japan and WALK
 * durations. Plain `fetch` against `GOOGLE_ROUTES_URL` (QA's Routes stub
 * overrides it, TI-4), with a minimal field mask. Never called without a key,
 * and never for Japan (Google has no transit data there).
 *
 * - Proxy date: Routes accepts TRANSIT times from 7 days back to 100 days
 *   ahead. `transitQueryTime` shifts the departure by whole weeks into
 *   [now, now + 95 d], keeping the weekday and the local wall time; returned
 *   times are shifted back and flagged `scheduleEstimate`.
 * - Ranking: by computed arrival (last transit step's arrival + trailing walk).
 * - Cache: Redis 24 h per (mode, coordinates, 15-minute departure bucket).
 */
import { localDateOf, tzOffsetMin } from "@/lib/engine/time";
import type {
	LineString,
	SegmentMode,
	TransitRoute,
	TransitSegment,
} from "@/lib/schemas/legs";
import { cacheGet, cacheSet } from "@/server/cache.server";
import { getEnv } from "@/server/env.server";
import { capPoints } from "../jp/transit-route.server";
import {
	type Place,
	ProviderError,
	type ProviderResult,
	type TransitProvider,
} from "./types.server";

const DAY = 86_400_000;
const WEEK = 7 * DAY;
const TTL_SEC = 24 * 3600;
/**
 * A transit answer with no route is kept only briefly: a thin service or a
 * provider hiccup must not pin "No route found" for a day (QA MT-14).
 */
export const EMPTY_TTL_SEC = 10 * 60;

/**
 * §14.2.2: a departure Routes will accept. Inside [now − 7 d, now + 100 d] it
 * is used as is; otherwise it moves by whole weeks into [now, now + 95 d],
 * keeping the weekday and the wall time in `tz` (DST-corrected).
 */
export function transitQueryTime(
	departAt: Date,
	tz: string,
	now: Date = new Date(),
): { queryAt: Date; shiftMs: number } {
	const t = departAt.getTime();
	const lo = now.getTime() - 7 * DAY;
	const hi = now.getTime() + 100 * DAY;
	if (t >= lo && t <= hi) return { queryAt: departAt, shiftMs: 0 };
	const target = now.getTime();
	const weeks = Math.ceil((target - t) / WEEK);
	let q = t + weeks * WEEK;
	if (q > now.getTime() + 95 * DAY) q -= WEEK;
	// Same wall time: correct for a UTC-offset change (DST) between the dates.
	const drift = (tzOffsetMin(tz, t) - tzOffsetMin(tz, q)) * 60_000;
	q += drift;
	if (q < now.getTime()) q += WEEK;
	return { queryAt: new Date(q), shiftMs: q - t };
}

type GLatLng = { latitude: number; longitude: number };
type GStep = {
	travelMode?: string;
	staticDuration?: string;
	distanceMeters?: number;
	polyline?: { geoJsonLinestring?: { coordinates?: [number, number][] } };
	transitDetails?: {
		stopDetails?: {
			departureStop?: { name?: string; location?: { latLng?: GLatLng } };
			arrivalStop?: { name?: string; location?: { latLng?: GLatLng } };
			departureTime?: string;
			arrivalTime?: string;
		};
		headsign?: string;
		stopCount?: number;
		transitLine?: {
			name?: string;
			nameShort?: string;
			color?: string;
			textColor?: string;
			agencies?: { name?: string }[];
			vehicle?: { type?: string; name?: { text?: string } };
		};
	};
};
type GRoute = {
	duration?: string;
	distanceMeters?: number;
	polyline?: { geoJsonLinestring?: { coordinates?: [number, number][] } };
	travelAdvisory?: {
		transitFare?: { currencyCode?: string; units?: string; nanos?: number };
	};
	legs?: { steps?: GStep[] }[];
};

const TRANSIT_MASK = [
	"routes.duration",
	"routes.distanceMeters",
	"routes.polyline.geoJsonLinestring",
	"routes.travelAdvisory.transitFare",
	"routes.legs.steps.travelMode",
	"routes.legs.steps.staticDuration",
	"routes.legs.steps.distanceMeters",
	"routes.legs.steps.polyline.geoJsonLinestring",
	"routes.legs.steps.transitDetails.stopDetails",
	"routes.legs.steps.transitDetails.headsign",
	"routes.legs.steps.transitDetails.stopCount",
	"routes.legs.steps.transitDetails.transitLine.name",
	"routes.legs.steps.transitDetails.transitLine.nameShort",
	"routes.legs.steps.transitDetails.transitLine.color",
	"routes.legs.steps.transitDetails.transitLine.textColor",
	"routes.legs.steps.transitDetails.transitLine.agencies",
	"routes.legs.steps.transitDetails.transitLine.vehicle",
].join(",");

const WALK_MASK =
	"routes.duration,routes.distanceMeters,routes.polyline.geoJsonLinestring";

const seconds = (d: string | undefined): number =>
	d ? Number.parseFloat(d.replace(/s$/, "")) || 0 : 0;
const minutes = (d: string | undefined): number =>
	Math.max(0, Math.round(seconds(d) / 60));

const VEHICLE_MODE: Record<string, SegmentMode> = {
	BUS: "bus",
	INTERCITY_BUS: "bus",
	TROLLEYBUS: "bus",
	SHARE_TAXI: "bus",
	SUBWAY: "subway",
	METRO_RAIL: "subway",
	HEAVY_RAIL: "train",
	COMMUTER_TRAIN: "train",
	RAIL: "rail",
	HIGH_SPEED_TRAIN: "high_speed",
	LONG_DISTANCE_TRAIN: "train",
	TRAM: "tram",
	LIGHT_RAIL: "tram",
	MONORAIL: "rail",
	FERRY: "ferry",
	CABLE_CAR: "cable",
	GONDOLA_LIFT: "cable",
	FUNICULAR: "cable",
};

const hex = (c: string | undefined): string | undefined =>
	c && /^#[0-9a-fA-F]{6}$/.test(c) ? c.toUpperCase() : undefined;

const lineOf = (
	coords: [number, number][] | undefined,
	max?: number,
): LineString | undefined =>
	coords && coords.length >= 2
		? { type: "LineString", coordinates: capPoints(coords, max) }
		: undefined;

const shiftIso = (iso: string | undefined, shiftMs: number) =>
	iso ? new Date(Date.parse(iso) - shiftMs).toISOString() : undefined;

/** One Routes route → TransitRoute (times shifted back by `shiftMs`). */
export function normalizeGoogleRoute(
	r: GRoute,
	i: number,
	shiftMs: number,
): TransitRoute | null {
	const steps = r.legs?.flatMap((l) => l.steps ?? []) ?? [];
	if (!steps.some((s) => s.travelMode === "TRANSIT")) return null;
	const segments: TransitSegment[] = [];
	let walkMin = 0;
	for (const s of steps) {
		const min = minutes(s.staticDuration);
		if (s.travelMode !== "TRANSIT") {
			walkMin += min;
			const prev = segments[segments.length - 1];
			if (prev?.mode === "walk") prev.durationMin += min;
			else segments.push({ mode: "walk", durationMin: min });
			continue;
		}
		const t = s.transitDetails ?? {};
		const sd = t.stopDetails ?? {};
		const dep = sd.departureStop?.location?.latLng;
		const arr = sd.arrivalStop?.location?.latLng;
		const vehicle = t.transitLine?.vehicle?.type ?? "";
		const seg: TransitSegment = {
			mode: VEHICLE_MODE[vehicle] ?? "other",
			durationMin: min,
		};
		if (vehicle) seg.vehicleType = vehicle.slice(0, 60);
		if (t.transitLine?.name) seg.lineName = t.transitLine.name.slice(0, 200);
		if (t.transitLine?.nameShort)
			seg.lineShort = t.transitLine.nameShort.slice(0, 40);
		const color = hex(t.transitLine?.color);
		if (color) seg.color = color;
		const textColor = hex(t.transitLine?.textColor);
		if (textColor) seg.textColor = textColor;
		const agency = t.transitLine?.agencies?.[0]?.name;
		if (agency) seg.agency = agency.slice(0, 200);
		if (t.headsign) seg.headsign = t.headsign.slice(0, 200);
		if (typeof t.stopCount === "number") seg.stopCount = t.stopCount;
		if (sd.departureStop?.name)
			seg.from = {
				name: sd.departureStop.name.slice(0, 200),
				...(dep ? { lat: dep.latitude, lng: dep.longitude } : {}),
			};
		if (sd.arrivalStop?.name)
			seg.to = {
				name: sd.arrivalStop.name.slice(0, 200),
				...(arr ? { lat: arr.latitude, lng: arr.longitude } : {}),
			};
		const d = shiftIso(sd.departureTime, shiftMs);
		if (d) seg.departAt = d;
		const a = shiftIso(sd.arrivalTime, shiftMs);
		if (a) seg.arriveAt = a;
		const g = lineOf(s.polyline?.geoJsonLinestring?.coordinates, 80);
		if (g) seg.geometry = g;
		segments.push(seg);
	}
	const transit = segments.filter((s) => s.mode !== "walk");
	const first = transit[0];
	const last = transit[transit.length - 1];
	const trailingWalk =
		segments[segments.length - 1]?.mode === "walk"
			? (segments[segments.length - 1]?.durationMin ?? 0)
			: 0;
	const leadingWalk =
		segments[0]?.mode === "walk" ? (segments[0]?.durationMin ?? 0) : 0;
	const route: TransitRoute = {
		id: `g:${i}:${transit.map((s) => s.lineShort ?? s.lineName ?? s.mode).join(">")}`.slice(
			0,
			100,
		),
		source: "google",
		durationMin: minutes(r.duration),
		walkMin,
		transfers: Math.max(0, transit.length - 1),
		segments,
	};
	if (first?.departAt)
		route.departAt = new Date(
			Date.parse(first.departAt) - leadingWalk * 60_000,
		).toISOString();
	if (last?.arriveAt)
		route.arriveAt = new Date(
			Date.parse(last.arriveAt) + trailingWalk * 60_000,
		).toISOString();
	const geometry = lineOf(r.polyline?.geoJsonLinestring?.coordinates);
	if (geometry) route.geometry = geometry;
	const fare = r.travelAdvisory?.transitFare;
	if (fare?.currencyCode && /^[A-Z]{3}$/.test(fare.currencyCode))
		route.fare = {
			amount: Number(fare.units ?? 0) + (fare.nanos ?? 0) / 1e9,
			currency: fare.currencyCode,
		};
	if (shiftMs !== 0) route.scheduleEstimate = true;
	const label = transit
		.map((s) => s.lineShort ?? s.lineName)
		.filter(Boolean)
		.join(" → ");
	if (label) route.label = label.slice(0, 80);
	return route;
}

/** Fastest first, by computed arrival (else by duration). */
export function rankRoutes(routes: TransitRoute[]): TransitRoute[] {
	const arrival = (r: TransitRoute) =>
		r.arriveAt ? Date.parse(r.arriveAt) : Number.POSITIVE_INFINITY;
	return routes.sort(
		(a, b) =>
			arrival(a) - arrival(b) ||
			a.durationMin - b.durationMin ||
			a.transfers - b.transfers,
	);
}

async function post<T>(body: unknown, mask: string): Promise<T> {
	const env = getEnv();
	const key = env.GOOGLE_MAPS_API_KEY;
	if (!key) throw new ProviderError("unavailable", "no Google key");
	let res: Response;
	try {
		res = await fetch(
			`${env.GOOGLE_ROUTES_URL.replace(/\/$/, "")}/directions/v2:computeRoutes`,
			{
				method: "POST",
				headers: {
					"content-type": "application/json",
					"X-Goog-Api-Key": key,
					"X-Goog-FieldMask": mask,
				},
				body: JSON.stringify(body),
				signal: AbortSignal.timeout(10_000),
			},
		);
	} catch (e) {
		throw new ProviderError(
			"unavailable",
			`Routes request failed: ${e instanceof Error ? e.message : e}`,
		);
	}
	if (res.status === 429)
		throw new ProviderError("rate-limited", "Routes rate limit");
	if (!res.ok)
		throw new ProviderError("unavailable", `Routes HTTP ${res.status}`);
	return (await res.json()) as T;
}

const waypoint = (p: Place) => ({
	location: { latLng: { latitude: p.lat, longitude: p.lng } },
});
const c5 = (x: number) => x.toFixed(5);

/**
 * Google transit options (fastest first). Throws ProviderError. `fresh`
 * ("Refresh routes") asks Google again instead of reading the cache.
 */
export async function googleTransit(
	from: Place,
	to: Place,
	departAt: Date,
	tz: string,
	opts: { fresh?: boolean } = {},
): Promise<ProviderResult> {
	const { queryAt, shiftMs } = transitQueryTime(departAt, tz);
	const bucket = Math.floor(departAt.getTime() / (15 * 60_000));
	const parts = [
		"route",
		"google",
		"transit",
		c5(from.lat),
		c5(from.lng),
		c5(to.lat),
		c5(to.lng),
		bucket,
		localDateOf(queryAt, tz),
	];
	const cached = opts.fresh ? null : await cacheGet<ProviderResult>(...parts);
	if (cached) return cached;
	const data = await post<{ routes?: GRoute[] }>(
		{
			origin: waypoint(from),
			destination: waypoint(to),
			travelMode: "TRANSIT",
			departureTime: queryAt.toISOString(),
			computeAlternativeRoutes: true,
			polylineEncoding: "GEO_JSON_LINESTRING",
			languageCode: "en",
		},
		TRANSIT_MASK,
	);
	const routes = rankRoutes(
		(data.routes ?? [])
			.map((r, i) => normalizeGoogleRoute(r, i, shiftMs))
			.filter((r): r is TransitRoute => r !== null),
	).slice(0, 4);
	const result: ProviderResult = {
		routes,
		scheduleEstimate: shiftMs !== 0,
	};
	await cacheSet(parts, result, routes.length ? TTL_SEC : EMPTY_TTL_SEC);
	return result;
}

/** Google WALK: minutes, metres and the path. Throws ProviderError. */
export async function googleWalk(
	from: Place,
	to: Place,
): Promise<{
	minutes: number;
	distanceM: number;
	geometry?: LineString;
} | null> {
	const parts = [
		"route",
		"google",
		"walk",
		c5(from.lat),
		c5(from.lng),
		c5(to.lat),
		c5(to.lng),
	];
	const cached = await cacheGet<{
		minutes: number;
		distanceM: number;
		geometry?: LineString;
	}>(...parts);
	if (cached) return cached;
	const data = await post<{ routes?: GRoute[] }>(
		{
			origin: waypoint(from),
			destination: waypoint(to),
			travelMode: "WALK",
			polylineEncoding: "GEO_JSON_LINESTRING",
		},
		WALK_MASK,
	);
	const r = data.routes?.[0];
	if (!r) return null;
	const out: { minutes: number; distanceM: number; geometry?: LineString } = {
		minutes: Math.max(1, minutes(r.duration)),
		distanceM: Math.round(r.distanceMeters ?? 0),
	};
	const g = lineOf(r.polyline?.geoJsonLinestring?.coordinates);
	if (g) out.geometry = g;
	await cacheSet(parts, out, TTL_SEC);
	return out;
}

export const googleProvider: TransitProvider = {
	id: "google",
	supports: (ctx) =>
		Boolean(getEnv().GOOGLE_MAPS_API_KEY) && !ctx.countries.includes("JP"),
	fetch: (from, to, departAt, ctx) =>
		googleTransit(from, to, departAt, ctx.tz, { fresh: ctx.fresh }),
};
