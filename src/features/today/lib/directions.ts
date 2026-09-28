/**
 * Directions open the phone's own maps app (One Yonder flow 10): a plain
 * link, never a Maps API. Apple Maps on Apple devices, else Google Maps.
 */
import type { LngLat } from "@/lib/engine/geo";
import type { LegMode } from "@/lib/engine/types";

export type TravelBy = "walking" | "transit" | "driving";

/** How to get there, from the travel into the stop (on foot when unknown). */
export function travelBy(mode: LegMode | null): TravelBy {
	if (mode === "transit" || mode === "flight") return "transit";
	if (mode === "other") return "driving";
	return "walking";
}

const APPLE_FLAG: Record<TravelBy, string> = {
	walking: "w",
	transit: "r",
	driving: "d",
};

/** An iPhone, iPad or Mac, where maps.apple.com opens Apple Maps. */
export function isAppleDevice(
	ua = typeof navigator === "undefined" ? "" : navigator.userAgent,
): boolean {
	return /iPhone|iPad|iPod|Macintosh/.test(ua);
}

/** Directions from here to `to` (`[lng, lat]`), at 5 decimals (~1 m). */
export function directionsUrl(
	to: LngLat,
	by: TravelBy,
	apple = isAppleDevice(),
): string {
	const [lng, lat] = to;
	const ll = `${Number(lat.toFixed(5))},${Number(lng.toFixed(5))}`;
	return apple
		? `https://maps.apple.com/?daddr=${ll}&dirflg=${APPLE_FLAG[by]}`
		: `https://www.google.com/maps/dir/?api=1&destination=${ll}&travelmode=${by}`;
}
