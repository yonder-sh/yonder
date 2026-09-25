/**
 * How a TransitRoute reads in the inspector (DESIGN §8.2): times, the likely
 * range of an estimate, the proportional segment strip, line chips, the
 * booking line. Pure and isomorphic.
 */

import { localDateOf } from "@/lib/engine/time";
import {
	formatDuration,
	formatTime,
	getDisplayPrefs,
	to12h,
} from "@/lib/format";
import type {
	SegmentMode,
	TransitBooking,
	TransitRoute,
	TransitSegment,
} from "@/lib/schemas/legs";

/** "11:34 → 11:51" in the endpoints' zones, when the route has times. */
export function routeTimes(
	r: Pick<TransitRoute, "departAt" | "arriveAt">,
	fromTz: string,
	toTz: string,
): string | null {
	if (!r.departAt || !r.arriveAt) return null;
	return `${formatTime(Date.parse(r.departAt), fromTz)} → ${formatTime(Date.parse(r.arriveAt), toTz)}`;
}

/** A stored local "HH:mm" in the viewer's 12/24 h setting (ADDENDUM §7.2). */
export function clockText(hhmmText: string): string {
	return getDisplayPrefs().clock === "12h" ? to12h(hhmmText) : hhmmText;
}

/** "1h 36m–2h 03m" for an estimate's likely range. */
export function rangeText(r: Pick<TransitRoute, "range">): string | null {
	if (!r.range) return null;
	return `${formatDuration(r.range.lo, { compact: true })}–${formatDuration(r.range.hi, { compact: true })}`;
}

const VEHICLE: Record<SegmentMode, string> = {
	walk: "walk",
	bus: "bus",
	subway: "subway",
	train: "train",
	rail: "rail",
	high_speed: "high-speed",
	tram: "tram",
	ferry: "ferry",
	cable: "cable car",
	other: "ride",
};

export const isTransfer = (s: TransitSegment) =>
	s.mode === "walk" && s.vehicleType === "TRANSFER";

/** A segment's short name for chips: line short name, else line, else mode. */
export function segmentName(s: TransitSegment): string {
	if (s.mode === "walk") return isTransfer(s) ? "Transfer" : "Walk";
	if (s.mode === "other" && s.vehicleType === "TAXI") return "Taxi";
	return s.lineShort ?? s.lineName ?? VEHICLE[s.mode];
}

export type StripPart = {
	key: string;
	/** Share of the width, 0–1. */
	share: number;
	color: string | null;
	walk: boolean;
	label: string;
};

/** The 8px strip: segments proportional to time, walking muted (DESIGN §8.2). */
export function segmentStrip(r: TransitRoute): StripPart[] {
	const segs = r.segments.filter((s) => s.durationMin > 0);
	const total = segs.reduce((t, s) => t + s.durationMin, 0);
	if (!total) return [];
	return segs.map((s, i) => ({
		key: `${i}:${s.mode}:${s.lineName ?? ""}`,
		share: s.durationMin / total,
		color: s.mode === "walk" ? null : (s.color ?? null),
		walk: s.mode === "walk",
		label: `${segmentName(s)} · ${formatDuration(s.durationMin)}`,
	}));
}

/** The rides of a route (no walks or transfers). */
/** Every step is on foot: "walk the whole way", listed with the rides (QA MT-06). */
export const isWalkOnlyRoute = (r: TransitRoute): boolean =>
	r.segments.length > 0 && r.segments.every((s) => s.mode === "walk");

export const rides = (r: TransitRoute) =>
	r.segments.filter((s) => s.mode !== "walk");

/** "Walk · Fuji Excursion 7 · Taxi" (QA TR-07). */
export function routeSummary(r: TransitRoute): string {
	const names: string[] = [];
	for (const s of r.segments) {
		const n = s.mode === "walk" && !isTransfer(s) ? "Walk" : segmentName(s);
		if (isTransfer(s)) continue;
		if (names[names.length - 1] !== n) names.push(n);
	}
	return names.join(" · ") || r.label || "Route";
}

/** "Fuji Excursion 7 · Car 3 · 5A 5B · ref E7K2Q9" (refs/seats masked for guests upstream). */
export function bookingLine(
	b: TransitBooking | undefined | null,
): string | null {
	if (!b) return null;
	const parts = [
		b.trainNumber,
		b.class,
		b.car ? `Car ${b.car}` : null,
		b.seats.length
			? `${b.seats.length > 1 ? "Seats" : "Seat"} ${b.seats.map((s) => s.seat).join(", ")}`
			: null,
		b.ref ? `ref ${b.ref}` : null,
	].filter((x): x is string => !!x);
	return parts.length ? parts.join(" · ") : null;
}

/** The fastest of the options (by arrival when timed, else minutes). */
export function fastestId(routes: readonly TransitRoute[]): string | null {
	let best: TransitRoute | null = null;
	for (const r of routes) {
		if (!best) best = r;
		else if (r.arriveAt && best.arriveAt) {
			if (Date.parse(r.arriveAt) < Date.parse(best.arriveAt)) best = r;
		} else if (r.durationMin < best.durationMin) best = r;
	}
	return best?.id ?? null;
}

/** The fastest option that rides something (a walk-only one is never picked, QA MT-06). */
export function fastestRideOf(
	routes: readonly TransitRoute[],
): TransitRoute | null {
	const rides = routes.filter((r) => !isWalkOnlyRoute(r));
	const id = fastestId(rides);
	return rides.find((r) => r.id === id) ?? null;
}

/** Options fastest first; manual routes keep their place after fetched ones. */
export function sortOptions(routes: readonly TransitRoute[]): TransitRoute[] {
	return [...routes].sort((a, b) => a.durationMin - b.durationMin);
}

/**
 * The cards a leg lists (DESIGN §8.2): the stored options, plus the chosen
 * route when it isn't among them — always when nothing is stored, and for a
 * manual route (imported legs keep theirs in `details.route` only) next to
 * fetched options, so it keeps its Edit and Delete (QA MT-01).
 */
export function listedRoutes(
	stored: readonly TransitRoute[],
	chosen: TransitRoute | null | undefined,
): TransitRoute[] {
	if (!chosen || stored.some((r) => r.id === chosen.id)) return [...stored];
	if (stored.length && chosen.source !== "manual") return [...stored];
	return [chosen, ...stored];
}

/**
 * A reserved (timed) leg door to door (QA TR-07): from the end of the stop
 * before it (`prevEnd`) to the next stop's door (`legEnd`), including the idle
 * wait until the leg's `legStart` (departure − "be at the platform"). The
 * platform minutes are part of the trip, never counted as waiting. Without a
 * stop before it, or when that stop ended on an earlier local date (a morning
 * train after last night's stop), the leg's own span.
 */
export function doorToDoor(
	legStart: Date,
	legEnd: Date,
	prevEnd: Date | null | undefined,
	tz: string,
): { minutes: number; waitMin: number } {
	const own = Math.round((legEnd.getTime() - legStart.getTime()) / 60_000);
	if (!prevEnd || localDateOf(prevEnd, tz) !== localDateOf(legStart, tz))
		return { minutes: own, waitMin: 0 };
	const waitMin = Math.round((legStart.getTime() - prevEnd.getTime()) / 60_000);
	if (waitMin <= 0) return { minutes: own, waitMin: 0 };
	return { minutes: own + waitMin, waitMin };
}

/** Decimal places of a currency (JPY 0, USD 2) for minor units. */
export function currencyDecimals(currency: string): number {
	try {
		return (
			new Intl.NumberFormat("en", {
				style: "currency",
				currency,
			}).resolvedOptions().maximumFractionDigits ?? 2
		);
	} catch {
		return 2;
	}
}

/** "¥210", "$12.50". */
export function formatMoney(amount: number, currency: string): string {
	try {
		return new Intl.NumberFormat("en", {
			style: "currency",
			currency,
			maximumFractionDigits: currencyDecimals(currency),
		}).format(amount);
	} catch {
		return `${amount} ${currency}`;
	}
}
