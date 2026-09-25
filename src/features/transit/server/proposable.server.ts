/**
 * WP-Transit's proposable defs (EXTENSIONS §3.3, §1.4). F wrote the inputs and
 * the typed defs in F-ext0; WP-Transit replaces each `core` body (DB-only:
 * provider calls happen before the gate, or through `out.job`). The redact
 * helpers strip booking refs, costs, points, fees and real seats from a
 * guest's input; cores merge with `ctx.inputRedacted`
 * (`mergeGuestDetails`), never with `access.isGuest`.
 */
import { z } from "zod";
import type { Tx } from "@/db/db.server";
import { mustRedact } from "@/lib/auth/roles";
import type { GraphLeg } from "@/lib/engine/types";
import {
	FixedTimes,
	FlightDetails,
	type LegDetails,
	readLegDetails,
	TransitBooking,
	TransitRoute,
} from "@/lib/schemas/legs";
import { LegTarget } from "@/lib/schemas/targets";
import { logActivity } from "@/server/activity.server";
import { fail } from "@/server/authz/session.server";
import { assertFreshIds } from "@/server/cores/ids.server";
import { redactLegDetails } from "@/server/graph.server";
import {
	findLeg,
	indexTx,
	reconcileLegs,
	writeLeg,
} from "@/server/legs.server";
import type { TxOutbox } from "@/server/live/outbox.server";
import { legTargetTrip } from "@/server/proposals/trip-of.server";
import { type CoreCtx, defineProposable } from "@/server/proposals/types";
import { displayFlightNumber } from "../lib/flight";
import {
	createFlightBlock,
	defaultAssigneesFromSeats,
	fitDayStartToFlight,
	normalizeFlight,
	rehomeFlightBlock,
} from "./flights.server";
import { toGraphLeg } from "./leg-dto.server";
import {
	chosenIdOf,
	fastestRide,
	legRoutes,
	setAlternatives,
	transitDetailsOf,
} from "./options.server";

export type LegResult = { leg: GraphLeg };

const Target = z.object({ target: LegTarget });

export const ResetLegEstimateInput = Target.strict();
export const SaveCustomRouteInput = Target.extend({
	route: TransitRoute,
}).strict();
export const UpdateCustomRouteInput = Target.extend({
	routeId: z.string().max(100),
	route: TransitRoute,
	expectedUpdatedAt: z.string().optional(),
}).strict();
export const DeleteCustomRouteInput = Target.extend({
	routeId: z.string().max(100),
}).strict();
export const SaveTransitDetailsInput = Target.extend({
	fixed: FixedTimes.nullable().optional(),
	booking: TransitBooking.nullable().optional(),
	expectedUpdatedAt: z.string().optional(),
}).strict();
export const SaveFlightInput = z
	.object({
		target: LegTarget,
		flight: FlightDetails,
		expectedUpdatedAt: z.string().optional(),
	})
	.strict();
export const CreateFlightWithAirportsInput = z
	.object({
		tripId: z.uuid(),
		afterItemId: z.uuid().optional(),
		dayId: z.uuid().optional(),
		segments: z.array(FlightDetails).min(1).max(4),
		bookingRef: z.string().max(40).optional(),
		/**
		 * EXTENSIONS §2.2: per segment [from airport, to airport, leg], in segment
		 * order. Unused ids are ignored; an existing id is CONFLICT.
		 */
		ids: z.array(z.uuid()).max(12).optional(),
	})
	.strict();

type LegRow = NonNullable<Awaited<ReturnType<typeof findLeg>>>;

const result = async (
	tx: Tx,
	row: LegRow,
	ctx: CoreCtx,
): Promise<LegResult> => ({
	leg: await toGraphLeg(tx, row, mustRedact(ctx.access)),
});

const writeMeta = (ctx: CoreCtx, expectedUpdatedAt?: string) => ({
	userId: ctx.user.id,
	// EXTENSIONS §3.4: merges key on the redacted input, not on the caller.
	isGuest: ctx.inputRedacted,
	expectedUpdatedAt,
});

async function logLeg(
	tx: Tx,
	out: TxOutbox,
	ctx: CoreCtx,
	legId: string,
	summary: string,
	verb: "leg.update" | "transit.route" | "flight.save" = "leg.update",
): Promise<void> {
	await logActivity(tx, out, {
		tripId: ctx.access.tripId,
		actor: ctx.actor,
		verb,
		summary,
		legId,
	});
}

/** A custom route as stored: `source: 'manual'`, bounded, integer minutes. */
function manualRoute(route: TransitRoute): TransitRoute {
	const segments = route.segments.map((s) => ({
		...s,
		durationMin: Math.round(s.durationMin),
	}));
	const sum = segments.reduce((t, s) => t + s.durationMin, 0);
	const out: TransitRoute = {
		...route,
		source: "manual",
		segments,
		durationMin: Math.round(route.durationMin || sum),
		transfers: Math.max(
			0,
			segments.filter((s) => s.mode !== "walk" && s.mode !== "other").length -
				1,
		),
		walkMin: segments
			.filter((s) => s.mode === "walk")
			.reduce((t, s) => t + s.durationMin, 0),
	};
	delete out.scheduleEstimate;
	delete out.typical;
	delete out.range;
	delete out.dataBuild;
	return out;
}

/** Guest strip for `transit.details`: the ref and real seats. */
function redactBooking(
	input: z.output<typeof SaveTransitDetailsInput>,
): z.output<typeof SaveTransitDetailsInput> {
	if (!input.booking) return input;
	const redacted = redactLegDetails({
		kind: "transit",
		booking: input.booking,
	});
	return {
		...input,
		booking: redacted.kind === "transit" ? (redacted.booking ?? null) : null,
	};
}

/** Guest strip for `flight.save`: ref, cost, points, fees, real seats. */
function redactFlight(
	input: z.output<typeof SaveFlightInput>,
): z.output<typeof SaveFlightInput> {
	const redacted = redactLegDetails({ kind: "flight", flight: input.flight });
	return redacted.kind === "flight"
		? { ...input, flight: redacted.flight }
		: input;
}

export const defs = {
	"leg.resetEstimate": defineProposable({
		input: ResetLegEstimateInput,
		tripIdOf: (i, exec) => legTargetTrip(exec, i.target),
		entityOf: () => ({ kind: "leg", id: null }),
		fields: () => ["durationMin", "source", "isEdited"],
		core: async (tx, out, data, ctx): Promise<LegResult> => {
			const tripId = ctx.access.tripId;
			const row = await findLeg(tx, tripId, data.target);
			if (!row) return fail("NOT_FOUND");
			const { row: next } = await writeLeg(
				tx,
				out,
				tripId,
				data.target,
				{
					durationMin: row.estimateMin,
					isEdited: false,
					...(row.estimateMin !== null && row.source === "manual"
						? { source: "estimate" as const }
						: {}),
				},
				writeMeta(ctx),
			);
			await logLeg(tx, out, ctx, next.id, "reset a leg to its estimate");
			return result(tx, next, ctx);
		},
	}),
	"transit.route.save": defineProposable({
		input: SaveCustomRouteInput,
		tripIdOf: (i, exec) => legTargetTrip(exec, i.target),
		entityOf: () => ({ kind: "leg", id: null }),
		fields: () => ["details.route"],
		core: async (tx, out, data, ctx): Promise<LegResult> => {
			const tripId = ctx.access.tripId;
			const before = await findLeg(tx, tripId, data.target);
			const route = manualRoute(data.route);
			const alternatives = [
				...legRoutes(before).filter((r) => r.id !== route.id),
				route,
			].slice(-10);
			const current = transitDetailsOf(before);
			const { row } = await writeLeg(
				tx,
				out,
				tripId,
				data.target,
				{
					mode: "transit",
					durationMin: route.durationMin,
					source: "manual",
					isEdited: true,
					// A walk's measured distance isn't the route's (QA MT-06 residual).
					distanceM: null,
					details: { ...current, route, chosenId: route.id },
				},
				writeMeta(ctx),
			);
			await setAlternatives(tx, tripId, row.id, alternatives);
			await logLeg(
				tx,
				out,
				ctx,
				row.id,
				`added a custom route${route.label ? ` (${route.label})` : ""}`,
				"transit.route",
			);
			return result(tx, row, ctx);
		},
	}),
	"transit.route.update": defineProposable({
		input: UpdateCustomRouteInput,
		tripIdOf: (i, exec) => legTargetTrip(exec, i.target),
		entityOf: () => ({ kind: "leg", id: null }),
		fields: () => ["details.route"],
		core: async (tx, out, data, ctx): Promise<LegResult> => {
			const tripId = ctx.access.tripId;
			const before = await findLeg(tx, tripId, data.target);
			const alts = legRoutes(before);
			const at = alts.findIndex(
				(r) => r.id === data.routeId && r.source === "manual",
			);
			if (!before || at < 0) return fail("NOT_FOUND", "route");
			const route = manualRoute({ ...data.route, id: data.routeId });
			const alternatives = alts.map((r, k) => (k === at ? route : r));
			const current = transitDetailsOf(before);
			const chosen = chosenIdOf(current) === data.routeId;
			const { row } = await writeLeg(
				tx,
				out,
				tripId,
				data.target,
				chosen
					? {
							mode: "transit",
							durationMin: route.durationMin,
							source: "manual",
							isEdited: true,
							distanceM: null,
							details: { ...current, route, chosenId: route.id },
						}
					: { details: current },
				writeMeta(ctx, data.expectedUpdatedAt),
			);
			await setAlternatives(tx, tripId, row.id, alternatives);
			await logLeg(
				tx,
				out,
				ctx,
				row.id,
				"edited a custom route",
				"transit.route",
			);
			return result(tx, row, ctx);
		},
	}),
	"transit.route.delete": defineProposable({
		input: DeleteCustomRouteInput,
		tripIdOf: (i, exec) => legTargetTrip(exec, i.target),
		entityOf: () => ({ kind: "leg", id: null }),
		fields: () => ["details.route"],
		core: async (tx, out, data, ctx): Promise<LegResult> => {
			const tripId = ctx.access.tripId;
			const before = await findLeg(tx, tripId, data.target);
			const alts = legRoutes(before);
			if (
				!before ||
				!alts.some((r) => r.id === data.routeId && r.source === "manual")
			)
				return fail("NOT_FOUND", "route");
			const alternatives = alts.filter((r) => r.id !== data.routeId);
			const current = transitDetailsOf(before);
			let patch: Parameters<typeof writeLeg>[4];
			if (chosenIdOf(current) !== data.routeId) patch = { details: current };
			else {
				const next = fastestRide(alternatives);
				const { route: _r, chosenId: _c, ...rest } = current;
				patch = next
					? {
							durationMin: next.durationMin,
							source: next.source,
							isEdited: next.source === "manual",
							details: { ...rest, route: next, chosenId: next.id },
						}
					: {
							durationMin: before.estimateMin,
							source: "estimate",
							isEdited: false,
							details: rest,
						};
			}
			const { row } = await writeLeg(
				tx,
				out,
				tripId,
				data.target,
				patch,
				writeMeta(ctx),
			);
			await setAlternatives(tx, tripId, row.id, alternatives);
			await logLeg(
				tx,
				out,
				ctx,
				row.id,
				"deleted a custom route",
				"transit.route",
			);
			return result(tx, row, ctx);
		},
	}),
	"transit.details": defineProposable({
		input: SaveTransitDetailsInput,
		tripIdOf: (i, exec) => legTargetTrip(exec, i.target),
		entityOf: () => ({ kind: "leg", id: null }),
		fields: (i) =>
			(["fixed", "booking"] as const)
				.filter((k) => i[k] !== undefined)
				.map((k) => `details.${k}`),
		redact: redactBooking,
		core: async (tx, out, data, ctx): Promise<LegResult> => {
			const tripId = ctx.access.tripId;
			const before = await findLeg(tx, tripId, data.target);
			const current = transitDetailsOf(before);
			const details: Extract<LegDetails, { kind: "transit" }> = {
				...current,
			};
			if (data.fixed === null) delete details.fixed;
			else if (data.fixed) details.fixed = data.fixed;
			if (data.booking === null) delete details.booking;
			else if (data.booking)
				details.booking = {
					...data.booking,
					ref: data.booking.ref?.trim().toUpperCase() || undefined,
				};
			if (details.booking && details.booking.ref === undefined)
				delete details.booking.ref;
			const { row } = await writeLeg(
				tx,
				out,
				tripId,
				data.target,
				{ mode: "transit", distanceM: null, details },
				writeMeta(ctx, data.expectedUpdatedAt),
			);
			let final = row;
			if (row.depAt && row.arrAt) {
				// A reserved departure's own minutes (the schedule anchors on dep/arr).
				const min = Math.round(
					(row.arrAt.getTime() - row.depAt.getTime()) / 60_000,
				);
				const { row: r2 } = await writeLeg(
					tx,
					out,
					tripId,
					data.target,
					{ durationMin: min },
					writeMeta(ctx),
				);
				final = r2;
			}
			await logLeg(
				tx,
				out,
				ctx,
				row.id,
				details.fixed
					? "reserved a departure"
					: data.booking !== undefined
						? "updated a booking"
						: "updated a route",
				"transit.route",
			);
			return result(tx, final, ctx);
		},
	}),
	"flight.save": defineProposable({
		input: SaveFlightInput,
		tripIdOf: (i, exec) => legTargetTrip(exec, i.target),
		entityOf: () => ({ kind: "leg", id: null }),
		fields: () => ["details.flight"],
		redact: redactFlight,
		core: async (tx, out, data, ctx): Promise<LegResult> => {
			const tripId = ctx.access.tripId;
			if (data.target.kind !== "pair")
				return fail("VALIDATION", "a flight joins two stops");
			const before = await indexTx(tx, tripId);
			const stored = await findLeg(tx, tripId, data.target);
			const prev = readLegDetails(stored?.details);
			const flight = normalizeFlight({
				...data.flight,
				// Connections are the server's (§7.9).
				connection: prev.kind === "flight" ? prev.flight.connection : undefined,
			});
			if (!flight.connection) delete flight.connection;
			const { row } = await writeLeg(
				tx,
				out,
				tripId,
				data.target,
				{
					mode: "flight",
					source: "manual",
					isEdited: true,
					distanceM: null,
					details: { kind: "flight", flight },
				},
				writeMeta(ctx, data.expectedUpdatedAt),
			);
			const after = await indexTx(tx, tripId);
			const moved = await rehomeFlightBlock(
				tx,
				tripId,
				after,
				data.target.fromItemId,
			);
			if (moved.length) {
				const { detachedLegIds } = await reconcileLegs(
					tx,
					out,
					tripId,
					before,
					{
						changed: moved,
					},
				);
				if (detachedLegIds.length)
					return fail(
						"CONFLICT",
						"those times would move the flight across other stops — move them first",
					);
				out.emit({ entity: "item", ids: moved });
			}
			if (await defaultAssigneesFromSeats(tx, tripId, row.id, flight.seats))
				out.emit({ entity: "leg", ids: [row.id] });
			// Times added to a flight (FB-18: a default flight gets its times
			// later) move an opening day's start like a new flight does (QA MT-08).
			if (flight.depLocal)
				await fitDayStartToFlight(
					tx,
					out,
					tripId,
					{ itemIds: [data.target.fromItemId, data.target.toItemId] },
					ctx,
				);
			const label = [
				displayFlightNumber(flight.flightNumber),
				`${flight.from.iata}→${flight.to.iata}`,
			]
				.filter(Boolean)
				.join(" ");
			await logLeg(
				tx,
				out,
				ctx,
				row.id,
				`saved flight ${label}`,
				"flight.save",
			);
			const fresh = (await findLeg(tx, tripId, data.target)) ?? row;
			return result(tx, fresh, ctx);
		},
	}),
	"flight.create": defineProposable({
		input: CreateFlightWithAirportsInput,
		tripIdOf: async (i) => i.tripId,
		entityOf: (i) => ({ kind: "leg", id: i.ids?.[2] ?? null }),
		fields: () => [],
		redact: (i) => {
			const { bookingRef: _ref, ...rest } = i;
			return {
				...rest,
				segments: i.segments.map((f) => {
					const r = redactLegDetails({ kind: "flight", flight: f });
					return r.kind === "flight" ? r.flight : f;
				}),
			};
		},
		core: async (
			tx,
			out,
			data,
			ctx,
		): Promise<{
			itemIds: string[];
			legIds: string[];
			detachedLegIds: string[];
		}> => {
			const tripId = ctx.access.tripId;
			if (data.tripId !== tripId) return fail("NOT_FOUND");
			if (data.ids?.length) {
				await assertFreshIds(
					tx,
					"items",
					data.ids.filter((_, k) => k % 3 !== 2),
				);
				await assertFreshIds(
					tx,
					"legs",
					data.ids.filter((_, k) => k % 3 === 2),
				);
			}
			if (data.afterItemId) {
				const ix0 = await indexTx(tx, tripId);
				if (!ix0.item(data.afterItemId)) return fail("NOT_FOUND", "item");
			}
			if (data.dayId) {
				const ix0 = await indexTx(tx, tripId);
				if (!ix0.day(data.dayId)) return fail("NOT_FOUND", "day");
			}
			const before = await indexTx(tx, tripId);
			const block = await createFlightBlock(
				tx,
				out,
				tripId,
				{
					segments: data.segments,
					bookingRef: data.bookingRef,
					afterItemId: data.afterItemId,
					dayId: data.dayId,
					ids: data.ids,
				},
				ctx,
			);
			for (const [k, flight] of block.flights.entries()) {
				const fromItemId = block.itemIds[k] as string;
				const toItemId = block.itemIds[k + 1] as string;
				const { row } = await writeLeg(
					tx,
					out,
					tripId,
					{ kind: "pair", fromItemId, toItemId },
					{
						mode: "flight",
						source: "manual",
						isEdited: true,
						details: { kind: "flight", flight },
					},
					writeMeta(ctx),
				);
				await defaultAssigneesFromSeats(tx, tripId, row.id, flight.seats);
			}
			const { detachedLegIds } = await reconcileLegs(tx, out, tripId, before, {
				changed: block.itemIds,
			});
			// An early flight on a day that starts later moves the day start (QA MT-08).
			await fitDayStartToFlight(tx, out, tripId, block, ctx);
			const first = block.flights[0];
			const last = block.flights.at(-1);
			const label = [
				block.flights
					.map((f) => displayFlightNumber(f.flightNumber))
					.filter(Boolean)
					.join(" + "),
				first && last ? `${first.from.iata}→${last.to.iata}` : "",
			]
				.filter(Boolean)
				.join(" ");
			await logActivity(tx, out, {
				tripId,
				actor: ctx.actor,
				verb: "flight.create",
				summary: `added flight ${label}`.trim(),
				itemId: block.itemIds[0] ?? null,
				legId: block.legIds[0] ?? null,
			});
			out.emit({ entity: "item", ids: block.itemIds });
			out.emit({ entity: "leg", ids: block.legIds });
			return {
				itemIds: block.itemIds,
				legIds: block.legIds,
				detachedLegIds,
			};
		},
	}),
};
