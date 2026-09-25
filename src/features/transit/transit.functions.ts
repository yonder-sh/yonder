/**
 * WP-Transit server functions (SPEC §13.2; EXTENSIONS §1.4; ADDENDUM §5).
 * Signatures are final. The proposable ones run through the gate (their cores
 * are in `server/proposable.server.ts`); `estimateWalk`, `getTransitOptions`
 * and `lockTransitTimes` are edit-only (`requireEditOnly`),
 * `chooseTransitOption` is `{ direct: 'edit' }`. The rail look-ups (GET) back
 * the custom-route builder's N02 station/line autocomplete.
 * Keys: graph and counts. Every provider call is rate-limited per user
 * (§12.3) and never runs for viewers or suggesters.
 */
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { db } from "@/db/db.server";
import { mustRedact } from "@/lib/auth/roles";
import { hhmm, localDateOf } from "@/lib/engine/time";
import type { TransitRoute } from "@/lib/schemas/legs";
import { LegTarget } from "@/lib/schemas/targets";
import { requireTripRole } from "@/server/authz/access.server";
import { withNamedUser, withUser } from "@/server/authz/middleware";
import { fail } from "@/server/authz/session.server";
import { rateLimit } from "@/server/cache.server";
import { findLeg, writeLeg } from "@/server/legs.server";
import {
	proposable,
	requireDirect,
	requireEditOnly,
} from "@/server/proposals/proposable.server";
import { legTargetTrip } from "@/server/proposals/trip-of.server";
import { mutationMeta, withTripTx } from "@/server/tx.server";
import { legEnds } from "./lib/endpoints";
import { jpRail } from "./server/jp/load.server";
import { toGraphLeg } from "./server/leg-dto.server";
import {
	applyOptions,
	isWalkOnly,
	legRoutes,
	loadIndex,
	providerContext,
	runChain,
	transitDetailsOf,
} from "./server/options.server";
import {
	CreateFlightWithAirportsInput,
	DeleteCustomRouteInput,
	type LegResult,
	ResetLegEstimateInput,
	SaveCustomRouteInput,
	SaveFlightInput,
	SaveTransitDetailsInput,
	UpdateCustomRouteInput,
} from "./server/proposable.server";
import {
	type RailLine,
	type RailSegmentResult,
	type RailStation,
	railSegment,
	searchLines,
	searchStations,
} from "./server/rail.server";
import { type WalkResult, walkChain } from "./server/walk.server";
import { dropContradictedWalks } from "./server/walk-only.server";

const Target = z.object({ target: LegTarget });

export type { LegResult } from "./server/proposable.server";

export type TransitOptionsResult = {
	provider: "google" | "navitime" | "manual" | "estimate";
	unsupportedReason?: "japan" | "no-key" | "out-of-range" | "no-location";
	options: TransitRoute[];
	/** ADDENDUM §5: always offered next to options (and instead of them). */
	googleMapsUrl?: string;
	/** Google proxy date (§14.2.2): "typical schedule". */
	scheduleEstimate?: boolean;
	/** Caveats for the whole result ("a bus is probably faster"). */
	notes?: string[];
	/** N02 attribution for estimate routes (JAPAN_TRANSIT §5). */
	attribution?: string;
	/** The provider failed: "Routing unavailable right now" (QA TR-06). */
	error?: "rate-limited" | "unavailable";
	/** The leg after the write (chosen fastest when nothing was chosen). */
	leg?: LegResult["leg"];
};

/** Per-user provider limit (§12.3): 30 calls a minute. */
const providerLimit = (userId: string) => rateLimit(`provider:${userId}`, 30);

export const estimateWalk = createServerFn({ method: "POST" })
	.middleware([withNamedUser])
	.validator(Target.extend({ apply: z.boolean().optional() }).strict())
	.handler(
		async ({
			data,
			context,
		}): Promise<{
			minutes: number;
			distanceM: number;
			source: string;
		}> => {
			const tripId = await legTargetTrip(db, data.target);
			const access = await requireEditOnly(
				"estimateWalk",
				tripId,
				context.user,
			);
			await providerLimit(context.user.id);
			const ix = await loadIndex(db, tripId);
			const ctx = providerContext(legEnds(ix, data.target));
			if (!ctx) return fail("VALIDATION", "both stops need a location");
			const walk = await walkChain(ctx.from, ctx.to, {
				walkSpeedKmh: ix.settings.walkSpeedKmh,
				countries: ctx.countries,
			});
			if (data.apply)
				await withTripTx(
					tripId,
					(tx, out) =>
						writeLeg(
							tx,
							out,
							tripId,
							data.target,
							{
								mode: "walk",
								durationMin: walk.minutes,
								distanceM: walk.distanceM,
								estimateMin: walk.minutes,
								source: walk.source,
								isEdited: false,
								details: walk.geometry
									? { kind: "walk", geometry: walk.geometry }
									: { kind: "none" },
							},
							{ userId: context.user.id, isGuest: false },
						),
					mutationMeta(access, context.user),
				);
			return {
				minutes: walk.minutes,
				distanceM: walk.distanceM,
				source: walk.source,
			};
		},
	);

export const getTransitOptions = createServerFn({ method: "POST" })
	.middleware([withNamedUser])
	.validator(
		Target.extend({
			departAt: z.iso.datetime({ offset: true }),
			/** "Refresh routes" / "Find routes": ask the provider again, not its cache. */
			refresh: z.boolean().optional(),
		}).strict(),
	)
	.handler(async ({ data, context }): Promise<TransitOptionsResult> => {
		const tripId = await legTargetTrip(db, data.target);
		const access = await requireEditOnly(
			"getTransitOptions",
			tripId,
			context.user,
		);
		await providerLimit(context.user.id);
		const ix = await loadIndex(db, tripId);
		const departAt = new Date(data.departAt);
		const answer = await runChain(ix, data.target, departAt, {
			fresh: data.refresh === true,
		});
		const ctx = providerContext(legEnds(ix, data.target));
		// "Walk the whole way" by the straight line, against the real walk (QA MT-06c).
		const routes = ctx
			? await dropContradictedWalks(answer.result.routes, ctx, () =>
					walkChain(ctx.from, ctx.to, {
						walkSpeedKmh: ix.settings.walkSpeedKmh,
						countries: ctx.countries,
					}),
				)
			: answer.result.routes;
		const base: TransitOptionsResult = {
			provider: answer.provider,
			options: routes,
			...(answer.unsupportedReason
				? { unsupportedReason: answer.unsupportedReason }
				: {}),
			...(answer.googleMapsUrl ? { googleMapsUrl: answer.googleMapsUrl } : {}),
			...(answer.result.scheduleEstimate ? { scheduleEstimate: true } : {}),
			...(answer.result.notes?.length ? { notes: answer.result.notes } : {}),
			...(answer.result.attribution
				? { attribution: answer.result.attribution }
				: {}),
			...(answer.error ? { error: answer.error } : {}),
		};
		// No answer: the stored options stay. An answer whose only option was
		// dropped above still replaces them (the stale walk goes too).
		if (!answer.result.routes.length) {
			const row = await findLeg(db, tripId, data.target);
			return {
				...base,
				options: legRoutes(row),
			};
		}
		const { row } = await withTripTx(
			tripId,
			(tx, out) =>
				applyOptions(tx, out, tripId, data.target, routes, {
					userId: context.user.id,
					queriedFor: departAt,
				}),
			mutationMeta(access, context.user),
		);
		return {
			...base,
			options: legRoutes(row),
			leg: await toGraphLeg(db, row, mustRedact(access)),
		};
	});

/**
 * Chooses a listed option. A walk-only option ("walk the whole way") makes
 * the leg a walk with the real walk's minutes and distance (the walk chain),
 * never a transit leg with one walk step (QA MT-06c).
 */
export const chooseTransitOption = createServerFn({ method: "POST" })
	.middleware([withNamedUser])
	.validator(Target.extend({ optionId: z.string().min(1).max(100) }).strict())
	.handler(async ({ data, context }): Promise<LegResult> => {
		const tripId = await legTargetTrip(db, data.target);
		const access = await requireDirect(
			"chooseTransitOption",
			tripId,
			context.user,
		);
		// The real walk is measured before the transaction (a provider call).
		const listed = legRoutes(await findLeg(db, tripId, data.target)).find(
			(r) => r.id === data.optionId,
		);
		let walk: WalkResult | null = null;
		if (listed && isWalkOnly(listed)) {
			await providerLimit(context.user.id);
			const ix = await loadIndex(db, tripId);
			const ctx = providerContext(legEnds(ix, data.target));
			if (ctx)
				walk = await walkChain(ctx.from, ctx.to, {
					walkSpeedKmh: ix.settings.walkSpeedKmh,
					countries: ctx.countries,
				});
		}
		return withTripTx(
			tripId,
			async (tx, out) => {
				const before = await findLeg(tx, tripId, data.target);
				const option = legRoutes(before).find((r) => r.id === data.optionId);
				if (!before || !option) return fail("NOT_FOUND", "route option");
				const meta = { userId: context.user.id, isGuest: access.isGuest };
				if (isWalkOnly(option)) {
					const w = walk ?? {
						minutes: option.durationMin,
						distanceM: null,
						source: "estimate" as const,
					};
					const { row } = await writeLeg(
						tx,
						out,
						tripId,
						data.target,
						{
							mode: "walk",
							durationMin: w.minutes,
							estimateMin: w.minutes,
							distanceM: w.distanceM,
							source: w.source,
							isEdited: false,
							details: walk?.geometry
								? { kind: "walk", geometry: walk.geometry }
								: { kind: "none" },
						},
						meta,
					);
					return { leg: await toGraphLeg(tx, row, mustRedact(access)) };
				}
				const current = transitDetailsOf(before);
				const { row } = await writeLeg(
					tx,
					out,
					tripId,
					data.target,
					{
						mode: "transit",
						durationMin: option.durationMin,
						source: option.source,
						isEdited: option.source === "manual",
						// A walk's measured distance isn't the ride's (QA MT-06 residual).
						distanceM: null,
						details: { ...current, route: option, chosenId: option.id },
					},
					meta,
				);
				return { leg: await toGraphLeg(tx, row, mustRedact(access)) };
			},
			mutationMeta(access, context.user),
		);
	});

/** `transit.route.save`: suggesters save a full route (never `chooseTransitOption`). */
export const saveCustomRoute = createServerFn({ method: "POST" })
	.middleware([withNamedUser])
	.validator(proposable.input(SaveCustomRouteInput))
	.handler(proposable.run("transit.route.save"));

/** `transit.route.update`. */
export const updateCustomRoute = createServerFn({ method: "POST" })
	.middleware([withNamedUser])
	.validator(proposable.input(UpdateCustomRouteInput))
	.handler(proposable.run("transit.route.update"));

/** `transit.route.delete`. */
export const deleteCustomRoute = createServerFn({ method: "POST" })
	.middleware([withNamedUser])
	.validator(proposable.input(DeleteCustomRouteInput))
	.handler(proposable.run("transit.route.delete"));

/** `transit.details`: reserved times and booking (guests' refs/seats are merged, never overwritten). */
export const saveTransitDetails = createServerFn({ method: "POST" })
	.middleware([withNamedUser])
	.validator(proposable.input(SaveTransitDetailsInput))
	.handler(proposable.run("transit.details"));

/**
 * A Google option's times → `details.fixed` in the endpoints' zones (SPEC
 * §13.2). Not offered for estimates or NAVITIME (typical times only).
 */
export const lockTransitTimes = createServerFn({ method: "POST" })
	.middleware([withNamedUser])
	.validator(Target.extend({ optionId: z.string() }).strict())
	.handler(async ({ data, context }): Promise<LegResult> => {
		const tripId = await legTargetTrip(db, data.target);
		const access = await requireEditOnly(
			"lockTransitTimes",
			tripId,
			context.user,
		);
		const ix = await loadIndex(db, tripId);
		const ends = legEnds(ix, data.target);
		if (!ends.from || !ends.to)
			return fail("VALIDATION", "both stops need a location");
		const fromTz = ends.from.tz;
		const toTz = ends.to.tz;
		return withTripTx(
			tripId,
			async (tx, out) => {
				const before = await findLeg(tx, tripId, data.target);
				const option = legRoutes(before).find((r) => r.id === data.optionId);
				if (!before || !option) return fail("NOT_FOUND", "route option");
				if (option.source !== "google" || !option.departAt || !option.arriveAt)
					return fail("VALIDATION", "only timetabled options can be locked");
				const dep = new Date(option.departAt);
				const arr = new Date(option.arriveAt);
				const local = (d: Date, tz: string) =>
					`${localDateOf(d, tz)}T${hhmm(d, tz)}`;
				const current = transitDetailsOf(before);
				const { row } = await writeLeg(
					tx,
					out,
					tripId,
					data.target,
					{
						mode: "transit",
						durationMin: option.durationMin,
						source: "google",
						isEdited: true,
						distanceM: null,
						details: {
							...current,
							route: option,
							chosenId: option.id,
							fixed: {
								departLocal: local(dep, fromTz),
								arriveLocal: local(arr, toTz),
								fromTz,
								toTz,
								accessMin: current.fixed?.accessMin ?? 10,
								egressMin: current.fixed?.egressMin ?? 0,
							},
						},
					},
					{ userId: context.user.id, isGuest: access.isGuest },
				);
				return { leg: await toGraphLeg(tx, row, mustRedact(access)) };
			},
			mutationMeta(access, context.user),
		);
	});

/** `flight.save`. */
export const saveFlight = createServerFn({ method: "POST" })
	.middleware([withNamedUser])
	.validator(proposable.input(SaveFlightInput))
	.handler(proposable.run("flight.save"));

/** `flight.create`: airports + items + legs in one go (`ids?`: [from, to, leg] per segment). */
export const createFlightWithAirports = createServerFn({ method: "POST" })
	.middleware([withNamedUser])
	.validator(proposable.input(CreateFlightWithAirportsInput))
	.handler(proposable.run("flight.create"));

/** `leg.resetEstimate`. */
export const resetLegEstimate = createServerFn({ method: "POST" })
	.middleware([withNamedUser])
	.validator(proposable.input(ResetLegEstimateInput))
	.handler(proposable.run("leg.resetEstimate"));

// ---------------------------------------------------------------------------
// N02 look-ups for the custom-route builder (GET; any trip member or guest)
// ---------------------------------------------------------------------------

export type RailInfo = {
	available: boolean;
	build?: string;
	dataDate?: string;
	attributionEn?: string;
	attributionJa?: string;
	datasetPage?: string;
	namesSource?: string;
};

/** Whether the rail data is installed, and its attribution (JAPAN_TRANSIT §5). */
export const getRailInfo = createServerFn({ method: "GET" })
	.middleware([withUser])
	.handler(async (): Promise<RailInfo> => {
		const rail = await jpRail();
		if (!rail) return { available: false };
		const m = rail.manifest;
		return {
			available: true,
			build: m.build,
			dataDate: m.dataDate,
			attributionEn: m.attributionEn,
			attributionJa: m.attributionJa,
			datasetPage: m.datasetPage,
			namesSource: m.namesSource,
		};
	});

const Point = z.object({
	lat: z.number().min(-90).max(90),
	lng: z.number().min(-180).max(180),
});

/** Stations (and lines) matching `q`, nearest to `near` first. */
export const searchRail = createServerFn({ method: "GET" })
	.middleware([withUser])
	.validator(
		z
			.object({
				tripId: z.uuid(),
				q: z.string().max(80),
				near: Point.optional(),
				line: z.string().max(200).optional(),
			})
			.strict(),
	)
	.handler(
		async ({
			data,
			context,
		}): Promise<{ stations: RailStation[]; lines: RailLine[] }> => {
			await requireTripRole(data.tripId, "viewer", context.user);
			const rail = await jpRail();
			if (!rail) return { stations: [], lines: [] };
			return {
				stations: searchStations(rail.graph, data.q, {
					near: data.near,
					line: data.line,
				}),
				lines: data.line ? [] : searchLines(rail.graph, data.q, 5),
			};
		},
	);

const StationRef = Point.extend({ name: z.string().min(1).max(200) });

/** The ride between two stations: minutes, stops, track shape, line chip. */
export const railRide = createServerFn({ method: "GET" })
	.middleware([withUser])
	.validator(
		z
			.object({
				tripId: z.uuid(),
				from: StationRef,
				to: StationRef,
				line: z.string().max(200).optional(),
			})
			.strict(),
	)
	.handler(async ({ data, context }): Promise<RailSegmentResult | null> => {
		await requireTripRole(data.tripId, "viewer", context.user);
		const rail = await jpRail();
		if (!rail) return null;
		return (
			railSegment(rail.graph, data.from, data.to, data.line) ??
			(data.line ? railSegment(rail.graph, data.from, data.to) : null)
		);
	});
