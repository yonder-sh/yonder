/**
 * The Photon fallback (SPEC §17.3 step 2): ONLY for nodes with no hint and no
 * override, at most 1 request per second, with the OSM User-Agent. With
 * `--no-geocode-fallback` misses stay unlocated and are listed in the report.
 */
import { getEnv, osmUserAgent } from "@/server/env.server";

export type GeoHit = { lat: number; lng: number; label: string };

let last = 0;
async function throttle(): Promise<void> {
	const wait = last + 1000 - Date.now();
	if (wait > 0) await new Promise((r) => setTimeout(r, wait));
	last = Date.now();
}

/** One Photon search; null on no result or any error (never throws). */
export async function photonSearch(query: string): Promise<GeoHit | null> {
	try {
		await throttle();
		const env = getEnv();
		const url = new URL("/api/", env.PHOTON_URL);
		url.searchParams.set("q", query);
		url.searchParams.set("limit", "1");
		url.searchParams.set("lang", "en");
		const res = await fetch(url, {
			headers: { "user-agent": osmUserAgent(env), accept: "application/json" },
			signal: AbortSignal.timeout(8000),
		});
		if (!res.ok) return null;
		const body = (await res.json()) as {
			features?: {
				geometry?: { coordinates?: [number, number] };
				properties?: { name?: string };
			}[];
		};
		const f = body.features?.[0];
		const c = f?.geometry?.coordinates;
		if (!c || !Number.isFinite(c[0]) || !Number.isFinite(c[1])) return null;
		return { lng: c[0], lat: c[1], label: f?.properties?.name ?? query };
	} catch {
		return null;
	}
}
