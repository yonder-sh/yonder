/**
 * Coordinates → IANA zone on the server (SPEC §7.4, spikes/geo): `geo-tz/all`,
 * whose names are exact (the default and `/now` datasets return merged names
 * such as Hanoi → `Asia/Jakarta`). Loaded lazily: ~30 MB of data that only
 * node writes need. The client never looks zones up itself.
 */
import { isValidTimeZone } from "@/lib/engine/time";

type Find = (lat: number, lng: number) => string[];
let finder: Promise<Find> | undefined;

/** The zone at a point, or null (open ocean, bad input, missing data). Never throws. */
export async function tzAt(lat: number, lng: number): Promise<string | null> {
	if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
	try {
		finder ??= import("geo-tz/all").then((m) => m.find as Find);
		const zone = (await finder)(lat, lng)[0];
		if (!zone || zone.startsWith("Etc/")) return null;
		return isValidTimeZone(zone) ? zone : null;
	} catch (e) {
		console.error("[tz] lookup failed:", e instanceof Error ? e.message : e);
		return null;
	}
}
