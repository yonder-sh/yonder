/**
 * E3 sunrise and sunset (EXTENSIONS §6), WP-Insights: `suncalc@1.9.0`
 * (offline, BSD-2), in the place's local time.
 */
import * as SunCalcNs from "suncalc";
import { hhmm, zonedEpoch } from "./time";

// suncalc is CommonJS (`module.exports = SunCalc`): Node's ESM loader exposes it
// as `default`, bundlers as the namespace itself.
const SunCalc =
	(SunCalcNs as unknown as { default?: typeof SunCalcNs }).default ?? SunCalcNs;

export type SunTimes = {
	/** Local `HH:mm`. */
	sunrise: string;
	sunset: string;
	goldenStart: string;
	/** Midnight sun / polar night. */
	polar?: "day" | "night";
};

const cache = new Map<string, SunTimes | null>();

/**
 * Sunrise, the start of the evening golden hour and sunset on `date` at a
 * place, as local `HH:mm` in `tz`. Null for bad input. Polar days and nights
 * return empty times with `polar` set.
 */
export function sunTimes(
	date: string,
	lat: number,
	lng: number,
	tz: string,
): SunTimes | null {
	if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
	const k = `${date}|${lat.toFixed(3)}|${lng.toFixed(3)}|${tz}`;
	const hit = cache.get(k);
	if (hit !== undefined) return hit;
	let out: SunTimes | null = null;
	try {
		const noon = new Date(zonedEpoch(date, "12:00", tz));
		const t = SunCalc.getTimes(noon, lat, lng);
		if (Number.isNaN(t.sunrise.getTime()) || Number.isNaN(t.sunset.getTime())) {
			const up = SunCalc.getPosition(noon, lat, lng).altitude > 0;
			out = {
				sunrise: "",
				sunset: "",
				goldenStart: "",
				polar: up ? "day" : "night",
			};
		} else
			out = {
				sunrise: hhmm(t.sunrise, tz),
				sunset: hhmm(t.sunset, tz),
				goldenStart: Number.isNaN(t.goldenHour.getTime())
					? hhmm(t.sunset, tz)
					: hhmm(t.goldenHour, tz),
			};
	} catch {
		out = null;
	}
	if (cache.size > 4000) cache.clear();
	cache.set(k, out);
	return out;
}
