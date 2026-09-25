/**
 * The transit provider chain (SPEC §14.2; ADDENDUM §5), without any
 * request-scoped import, so the worker's autofill job can use it:
 *
 * 1. google — a key is set and neither end is in Japan;
 * 2. estimate — both ends in Japan, the N02 data installed, both ends snap;
 * 3. navitime — never (Q1 = no, an empty stub);
 * 4. none — `unsupportedReason` ("japan" | "no-key" | "no-location").
 */
import type { DbOrTx } from "@/db/db.server";
import type { legs } from "@/db/schema";
import { type GraphIndex, indexGraph } from "@/lib/engine/graph-index";
import { computeSchedule } from "@/lib/engine/schedule";
import type { LegSource } from "@/lib/schemas/enums";
import {
	LEG_LIMITS,
	type LegDetails,
	readLegDetails,
	type TransitRoute,
} from "@/lib/schemas/legs";
import type { LegTarget } from "@/lib/schemas/targets";
import { loadGraphForServer } from "@/server/graph.server";
import {
	googleMapsDirectionsUrl,
	type LegEnds,
	legEnds,
	touchesJapan,
} from "../lib/endpoints";
import { estimateProvider } from "./providers/estimate.server";
import { googleProvider } from "./providers/google.server";
import { navitimeProvider } from "./providers/navitime.server";
import {
	type ProviderContext,
	ProviderError,
	type ProviderId,
	type ProviderResult,
	type TransitProvider,
} from "./providers/types.server";

export type UnsupportedReason =
	| "japan"
	| "no-key"
	| "out-of-range"
	| "no-location";

export type ChainAnswer = {
	provider: ProviderId | "manual";
	unsupportedReason?: UnsupportedReason;
	result: ProviderResult;
	/** Always offered (ADDENDUM §5, SPEC §14.2.1). */
	googleMapsUrl?: string;
	/** A provider answered with an error ("Routing unavailable right now"). */
	error?: "rate-limited" | "unavailable";
};

const CHAIN: TransitProvider[] = [
	googleProvider,
	estimateProvider,
	navitimeProvider,
];

/** The trip graph, indexed (committed state); null when the trip is gone. */
export async function loadIndexOrNull(
	exec: DbOrTx,
	tripId: string,
): Promise<GraphIndex | null> {
	const g = await loadGraphForServer(exec, tripId);
	return g ? indexGraph(g) : null;
}

export function providerContext(ends: LegEnds): ProviderContext | null {
	if (!ends.from || !ends.to) return null;
	return {
		countries: [ends.from.country, ends.to.country].filter(
			(c): c is string => !!c,
		),
		from: {
			lat: ends.from.lat,
			lng: ends.from.lng,
			name: ends.from.name,
			country: ends.from.country,
		},
		to: {
			lat: ends.to.lat,
			lng: ends.to.lng,
			name: ends.to.name,
			country: ends.to.country,
		},
		tz: ends.from.tz,
	};
}

/** When the leg departs, by the current schedule (else noon on its day). */
export function departureFor(ix: GraphIndex, target: LegTarget): Date {
	const ends = legEnds(ix, target);
	const s = computeSchedule(ix).legs[ends.key];
	if (s) return s.start;
	return new Date();
}

/**
 * Runs the chain for a leg. Never throws for provider errors. `fresh`
 * ("Refresh routes") bypasses provider caches.
 */
export async function runChain(
	ix: GraphIndex,
	target: LegTarget,
	departAt: Date,
	opts: { fresh?: boolean } = {},
): Promise<ChainAnswer> {
	const ends = legEnds(ix, target);
	const base = providerContext(ends);
	const ctx = base && opts.fresh ? { ...base, fresh: true } : base;
	if (!ctx)
		return {
			provider: "manual",
			unsupportedReason: "no-location",
			result: { routes: [] },
		};
	const googleMapsUrl = googleMapsDirectionsUrl(ctx.from, ctx.to);
	for (const p of CHAIN) {
		if (!(await p.supports(ctx))) continue;
		try {
			const result = await p.fetch(ctx.from, ctx.to, departAt, ctx);
			return { provider: p.id, result, googleMapsUrl };
		} catch (e) {
			if (e instanceof ProviderError)
				return {
					provider: p.id,
					result: { routes: [] },
					googleMapsUrl,
					error: e.kind === "rate-limited" ? "rate-limited" : "unavailable",
				};
			throw e;
		}
	}
	return {
		provider: "manual",
		unsupportedReason: touchesJapan(ends) ? "japan" : "no-key",
		result: { routes: [] },
		googleMapsUrl,
	};
}

export type LegRow = typeof legs.$inferSelect;

export const storedAlternatives = (row: LegRow | undefined): TransitRoute[] =>
	(row?.alternatives ?? []) as TransitRoute[];

/**
 * The routes a leg lists: the stored options plus the chosen manual route
 * when it isn't among them. The sheet importer and the QA seed write
 * `details.route` only (no `alternatives`), and a manual card must survive
 * Refresh (DESIGN §8.2), be choosable, editable and deletable. Every read
 * that looks a route up by id goes through this.
 */
export function legRoutes(row: LegRow | undefined): TransitRoute[] {
	const stored = storedAlternatives(row);
	const route = transitDetailsOf(row).route;
	if (route?.source !== "manual" || stored.some((r) => r.id === route.id))
		return stored;
	return [route, ...stored];
}

/** The id of the chosen route (`chosenId`, else the route's own id). */
export const chosenIdOf = (
	d: Extract<LegDetails, { kind: "transit" }>,
): string | undefined => d.chosenId ?? d.route?.id;

/** The fastest option (by arrival when timed, else by minutes). */
export function fastest(routes: readonly TransitRoute[]): TransitRoute | null {
	let best: TransitRoute | null = null;
	for (const r of routes) {
		if (!best) best = r;
		else if (r.arriveAt && best.arriveAt) {
			if (Date.parse(r.arriveAt) < Date.parse(best.arriveAt)) best = r;
		} else if (r.durationMin < best.durationMin) best = r;
	}
	return best;
}

/** Every step is on foot: the provider found nothing better than walking. */
export const isWalkOnly = (r: TransitRoute): boolean =>
	r.segments.length > 0 && r.segments.every((s) => s.mode === "walk");

/**
 * The fastest route that actually rides something. A walk-only "transit"
 * option is listed but never picked for a person: when walking wins, the
 * leg is a walk, not a train (QA MT-06).
 */
export const fastestRide = (
	routes: readonly TransitRoute[],
): TransitRoute | null => fastest(routes.filter((r) => !isWalkOnly(r)));

export const legSourceOf = (r: TransitRoute): LegSource => r.source;

/** Keeps alternatives within LEG_LIMITS (manual routes first, then fetched). */
export function mergeAlternatives(
	existing: readonly TransitRoute[],
	fetched: readonly TransitRoute[],
): TransitRoute[] {
	const manual = existing.filter((r) => r.source === "manual");
	const seen = new Set(manual.map((r) => r.id));
	const rest = fetched.filter((r) => !seen.has(r.id));
	return [...manual, ...rest].slice(0, LEG_LIMITS.alternatives);
}

/** The transit details of a stored leg, or a fresh transit object. */
export function transitDetailsOf(
	row: LegRow | undefined,
): Extract<LegDetails, { kind: "transit" }> {
	const d = readLegDetails(row?.details);
	return d.kind === "transit" ? d : { kind: "transit" };
}
