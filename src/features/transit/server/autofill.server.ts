/**
 * The `autofill` BullMQ job (SPEC §10.9; ADDENDUM §5, JAPAN_TRANSIT §3):
 * fills an unset leg's mode and minutes after COMMIT.
 *
 * - Stops when the target is no longer a pair/stay leg, or the leg has a mode
 *   or `isEdited` — it never touches a person's choice. Exception: an
 *   unedited `estimate` transit leg is refreshed when the rail data build
 *   changed.
 * - walk suggestion → the walk chain (Google, OSRM, else the estimate).
 * - transit suggestion → the provider chain: Google outside Japan, the N02
 *   `estimate` provider in Japan (fastest route written, every option kept in
 *   `alternatives`). An estimate that carries a warning ("a bus is probably
 *   faster") writes nothing: the leg stays unset and asks for a custom route.
 *   When the fastest option is walk-only, the leg is filled as a walk.
 * - A walk (either way) is written only when the walk the provider found fits
 *   the straight-line estimate that chose walking. A walk far past it (a lake
 *   in the way: QA MT-R2-03) writes nothing, like a "long walk" warning.
 * - Paid/remote provider calls per trip per day are capped
 *   (`AUTOFILL_MAX_PROVIDER_CALLS_PER_TRIP_PER_DAY`); the estimate engine runs
 *   in-process and isn't counted.
 *
 * Writes go through `withTripTx` and `writeLeg(…, { emit: false })` (the
 * worker sends one gated refetch after the job), so a filled leg passes the
 * same details checks as a person's edit.
 */
import { sql } from "drizzle-orm";
import { db, type Tx } from "@/db/db.server";
import { legs } from "@/db/schema";
import { suggestBetween, suggestPair } from "@/lib/engine/suggest";
import { LegDetails, readLegDetails } from "@/lib/schemas/legs";
import type { LegTarget } from "@/lib/schemas/targets";
import { getEnv } from "@/server/env.server";
import { ensureLegRow, writeLeg } from "@/server/legs.server";
import type { JobResult } from "@/server/live/job-handlers.server";
import type { TxOutbox } from "@/server/live/outbox.server";
import { key, redis } from "@/server/live/redis.server";
import { withTripTx } from "@/server/tx.server";
import { legEnds } from "../lib/endpoints";
import { autoFlightFor } from "./auto-flight.server";
import {
	departureFor,
	fastest,
	isWalkOnly,
	legRoutes,
	loadIndexOrNull,
	mergeAlternatives,
	providerContext,
	runChain,
} from "./chain.server";
import { jpRail } from "./jp/load.server";
import { straightLineM, walkChain, walkFarPastEstimate } from "./walk.server";
import { dropContradictedWalks } from "./walk-only.server";

/** A job write: no user, never a guest, no live event (the worker sends one). */
const JOB = { userId: null, isGuest: false, emit: false } as const;

/** INCR the trip's provider-call counter for today; false once over the cap. */
async function takeQuota(tripId: string): Promise<boolean> {
	try {
		const k = key("quota", tripId, new Date().toISOString().slice(0, 10));
		const n = await redis().incr(k);
		if (n === 1) await redis().expire(k, 2 * 86_400);
		return n <= getEnv().AUTOFILL_MAX_PROVIDER_CALLS_PER_TRIP_PER_DAY;
	} catch {
		return true; // Redis down: the job itself needs Redis, so this is rare
	}
}

type Row = typeof legs.$inferSelect;

/** The row is still ours to fill (no mode, not edited) — or a stale estimate. */
function fillable(row: Row, build: string | null): boolean {
	if (row.isEdited) return false;
	if (!row.mode) return true;
	if (row.mode !== "transit" || row.source !== "estimate" || !build)
		return false;
	const d = readLegDetails(row.details);
	return (
		d.kind === "transit" && !!d.route?.dataBuild && d.route.dataBuild !== build
	);
}

/**
 * Runs `write` in the trip's transaction when the row (created if missing)
 * is still fillable. The trip lock serialises it against people's edits.
 * A pair that stopped being a pair (CONFLICT) or a vanished item writes
 * nothing.
 */
async function fill(
	tripId: string,
	target: LegTarget,
	build: string | null,
	write: (tx: Tx, out: TxOutbox, row: Row) => Promise<void>,
): Promise<boolean> {
	try {
		return await withTripTx(tripId, async (tx, out) => {
			const { row } = await ensureLegRow(tx, tripId, target, null);
			if (!fillable(row, build)) return false;
			await write(tx, out, row);
			return true;
		});
	} catch (e) {
		const code = (e as { code?: string } | null)?.code;
		if (code === "CONFLICT" || code === "NOT_FOUND") return false;
		throw e;
	}
}

export async function autofillLeg(
	tripId: string,
	target: LegTarget,
): Promise<JobResult> {
	const ix = await loadIndexOrNull(db, tripId).catch(() => null);
	if (!ix) return { keys: [] };
	// Still a pair / stay leg?
	if (target.kind === "pair") {
		if (!ix.isPair(target.fromItemId, target.toItemId)) return { keys: [] };
		// FB-19: two adjacent airports default to a flight, across a night too
		// (heals trips planned before the default existed; `reconcileLegs`
		// writes it for new pairs).
		const flight = autoFlightFor(ix, target.fromItemId, target.toItemId);
		if (flight) {
			const wrote = await fill(tripId, target, null, async (tx, out) => {
				await writeLeg(
					tx,
					out,
					tripId,
					target,
					{
						mode: "flight",
						source: "estimate",
						isEdited: false,
						distanceM: null,
						details: { kind: "flight", flight },
					},
					JOB,
				);
			});
			return { keys: wrote ? ["graph"] : [] };
		}
		// Across a night with no leg yet: an overnight connector, or the stay
		// legs carry the travel (SPEC §9.2). Nothing to fill: a direct route
		// from last night's stop would replace the connector (found at
		// integration: MAP-09's overnight edge became a transit edge).
		const kind = ix.boundaryKind(target.fromItemId, target.toItemId);
		if (kind === "stay" || kind === "overnight") return { keys: [] };
	} else {
		const plan =
			target.end === "start"
				? ix.morningStay(target.dayId)
				: ix.eveningStay(target.dayId);
		if (!plan) return { keys: [] };
	}
	const rail = await jpRail();
	const build = rail?.manifest.build ?? null;
	const existing =
		target.kind === "pair"
			? ix.legByPair.get(`${target.fromItemId}>${target.toItemId}`)
			: ix.legByStay.get(`${target.dayId}:${target.end}`);
	if (existing?.isEdited) return { keys: [] };
	if (existing?.mode) {
		const d = ix.legDetails(existing);
		const stale =
			existing.mode === "transit" &&
			existing.source === "estimate" &&
			d.kind === "transit" &&
			!!d.route?.dataBuild &&
			!!build &&
			d.route.dataBuild !== build;
		if (!stale) return { keys: [] };
	}

	const ends = legEnds(ix, target);
	const ctx = providerContext(ends);
	if (!ctx) return { keys: [] };
	let suggestion =
		target.kind === "pair"
			? suggestPair(ix, target.fromItemId, target.toItemId)
			: suggestBetween(ix, ends.from?.nodeId ?? "", ends.to?.nodeId ?? "");
	if (existing?.mode === "transit")
		suggestion = { ...suggestion, mode: "transit" };

	/**
	 * Fills the leg as a walk. `estimate` is the straight-line guess that chose
	 * walking (`hiMin`: its likely range, when the route carries one); a
	 * provider walk far past it writes nothing (`walkFarPastEstimate`).
	 */
	const fillWalk = async (estimate: {
		minutes: number;
		hiMin?: number;
	}): Promise<JobResult> => {
		// OSRM/Google are remote calls: counted.
		const remote = await takeQuota(tripId);
		const walk = remote
			? await walkChain(ctx.from, ctx.to, {
					walkSpeedKmh: ix.settings.walkSpeedKmh,
					countries: ctx.countries,
				})
			: null;
		if (!walk) return { keys: [] };
		const straightM = straightLineM(ctx.from, ctx.to);
		if (walkFarPastEstimate(walk, { ...estimate, straightM }))
			return { keys: [] };
		const wrote = await fill(tripId, target, build, async (tx, out) => {
			await writeLeg(
				tx,
				out,
				tripId,
				target,
				{
					mode: "walk",
					durationMin: walk.minutes,
					distanceM: walk.distanceM,
					estimateMin: walk.minutes,
					source: walk.source,
					isEdited: false,
					details: walk.geometry
						? LegDetails.parse({ kind: "walk", geometry: walk.geometry })
						: { kind: "none" },
				},
				JOB,
			);
		});
		return { keys: wrote ? ["graph"] : [] };
	};

	if (suggestion.mode === "walk")
		return fillWalk({ minutes: suggestion.estimateMin ?? 0 });

	if (suggestion.mode !== "transit") return { keys: [] };
	const departAt = departureFor(ix, target);
	const japan = ctx.countries.includes("JP");
	if (!japan && !(await takeQuota(tripId))) return { keys: [] };
	const answer = await runChain(ix, target, departAt);
	const routes = answer.result.routes;
	if (!routes.length || answer.error) return { keys: [] };
	// JAPAN_TRANSIT §3: a warning ("bus likely faster", "long walk") → write nothing.
	if (routes.some((r) => r.warnings?.length)) return { keys: [] };
	const best = fastest(routes);
	if (!best) return { keys: [] };
	// Walking beats every ride (Oishi Park → Lake Kawaguchiko, QA MT-06): the
	// leg is a walk, never a "transit" leg with one walk step. A leg that
	// already has transit (a stale estimate) keeps its mode: nothing to do.
	// The real walk must fit the estimate's likely range (QA MT-R2-03).
	if (isWalkOnly(best))
		return existing?.mode
			? { keys: [] }
			: fillWalk({ minutes: best.durationMin, hiMin: best.range?.hi });
	// The picker never lists a walk-only option the real walk contradicts
	// (QA MT-06c); the walk chain is a remote call, so it is counted.
	const listed = await dropContradictedWalks(routes, ctx, async () =>
		(await takeQuota(tripId))
			? walkChain(ctx.from, ctx.to, {
					walkSpeedKmh: ix.settings.walkSpeedKmh,
					countries: ctx.countries,
				})
			: null,
	);
	const wrote = await fill(tripId, target, build, async (tx, out, row) => {
		const current = readLegDetails(row.details);
		const base =
			current.kind === "transit" ? current : { kind: "transit" as const };
		const { row: written } = await writeLeg(
			tx,
			out,
			tripId,
			target,
			{
				mode: "transit",
				durationMin: best.durationMin,
				estimateMin: best.durationMin,
				source: best.source,
				isEdited: false,
				distanceM: null,
				details: LegDetails.parse({ ...base, route: best, chosenId: best.id }),
			},
			JOB,
		);
		// The options the picker shows (writeLeg keeps the leg's own columns).
		await tx
			.update(legs)
			.set({
				alternatives: mergeAlternatives(legRoutes(row), listed),
				queriedFor: departAt,
				queriedAt: new Date(),
			})
			.where(sql`${legs.id} = ${written.id} and ${legs.tripId} = ${tripId}`);
	});
	return { keys: wrote ? ["graph"] : [] };
}
