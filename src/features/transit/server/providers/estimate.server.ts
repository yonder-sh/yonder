/**
 * The `estimate` provider (ADDENDUM §5, JAPAN_TRANSIT §3): Japan rail routes
 * modelled on the MLIT N02 network — 2–3 alternatives on different lines,
 * fastest first, each with a likely range and the real track shape. No
 * timetables, no external call, no key. Applies when both ends are in Japan
 * and each snaps to a station (1.2 km, widening to 6 km).
 *
 * Results are cached in Redis for 7 days per coordinate pair and data build
 * (the estimate doesn't depend on the time of day).
 */

import { cacheGet, cacheSet } from "@/server/cache.server";
import { type EstimateNote, estimateRoutes } from "../jp/estimate.server";
import { jpRail } from "../jp/load.server";
import { snap } from "../jp/snap.server";
import { toTransitRoute } from "../jp/transit-route.server";
import type {
	Place,
	ProviderContext,
	ProviderResult,
	TransitProvider,
} from "./types.server";

const TTL_SEC = 7 * 24 * 3600;

/** Human copy for the engine's notes (shown as warnings on the routes). */
export const NOTE_TEXT: Partial<Record<EstimateNote, string>> = {
	"rail-detour-bus-likely":
		"Rail is a long detour here — a bus or car is probably faster",
	"long-access-walk": "Long walk to the station — a bus or taxi may be quicker",
};

const c5 = (x: number) => x.toFixed(5);

function inJapan(ctx: ProviderContext): boolean {
	return ctx.countries.length === 2 && ctx.countries.every((c) => c === "JP");
}

export const estimateProvider: TransitProvider = {
	id: "estimate",
	async supports(ctx) {
		if (!inJapan(ctx)) return false;
		const rail = await jpRail();
		if (!rail) return false;
		return (
			snap(rail.graph, ctx.from).length > 0 &&
			snap(rail.graph, ctx.to).length > 0
		);
	},
	async fetch(from: Place, to: Place): Promise<ProviderResult> {
		const rail = await jpRail();
		if (!rail) return { routes: [] };
		const build = rail.manifest.build;
		const parts = [
			"route",
			"estimate",
			c5(from.lat),
			c5(from.lng),
			c5(to.lat),
			c5(to.lng),
			build,
		];
		const cached = await cacheGet<ProviderResult>(...parts);
		if (cached) return cached;
		const r = estimateRoutes(
			rail.graph,
			{ lat: from.lat, lng: from.lng, name: from.name },
			{ lat: to.lat, lng: to.lng, name: to.name },
			{ geometry: true },
		);
		const notes = r.notes.flatMap((n) => NOTE_TEXT[n] ?? []);
		const result: ProviderResult = {
			routes: r.routes.map((x) =>
				toTransitRoute(x, { dataBuild: build, warnings: notes }),
			),
			notes,
			attribution: rail.manifest.attributionEn,
		};
		await cacheSet(parts, result, TTL_SEC);
		return result;
	},
};
