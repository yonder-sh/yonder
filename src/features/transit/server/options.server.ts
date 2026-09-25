/**
 * Leg writes shared by `getTransitOptions`, `chooseTransitOption` and the
 * route cores (SPEC §13.2): the provider chain lives in `chain.server.ts`
 * (worker-safe); this file adds the request-side writes through `writeLeg`
 * (details checked, guest merge, emit).
 */
import { sql } from "drizzle-orm";
import type { DbOrTx, Tx } from "@/db/db.server";
import { legs } from "@/db/schema";
import type { GraphIndex } from "@/lib/engine/graph-index";
import type { TransitRoute } from "@/lib/schemas/legs";
import type { LegTarget } from "@/lib/schemas/targets";
import { fail } from "@/server/authz/session.server";
import { findLeg, writeLeg } from "@/server/legs.server";
import type { TxOutbox } from "@/server/live/outbox.server";
import {
	chosenIdOf,
	fastestRide,
	type LegRow,
	legRoutes,
	legSourceOf,
	loadIndexOrNull,
	mergeAlternatives,
	transitDetailsOf,
} from "./chain.server";

export * from "./chain.server";

/** The trip graph, indexed (committed state); NOT_FOUND when the trip is gone. */
export async function loadIndex(
	exec: DbOrTx,
	tripId: string,
): Promise<GraphIndex> {
	const ix = await loadIndexOrNull(exec, tripId);
	return ix ?? fail("NOT_FOUND");
}

export async function setAlternatives(
	tx: Tx,
	tripId: string,
	legId: string,
	alternatives: TransitRoute[],
	queriedFor?: Date | null,
): Promise<void> {
	await tx
		.update(legs)
		.set({
			alternatives,
			...(queriedFor !== undefined
				? { queriedFor, queriedAt: queriedFor ? new Date() : null }
				: {}),
		})
		.where(sql`${legs.id} = ${legId} and ${legs.tripId} = ${tripId}`);
}

/**
 * Stores fetched options (manual routes survive) and, when no route is chosen
 * (or `choose`), picks the fastest: `details.route`, `durationMin`, `source`.
 */
export async function applyOptions(
	tx: Tx,
	out: TxOutbox,
	tripId: string,
	target: LegTarget,
	fetched: TransitRoute[],
	meta: {
		userId: string | null;
		queriedFor: Date;
		/** Overwrite the current choice (autofill of an unedited leg). */
		choose?: boolean;
		/** Write the mode too (autofill); otherwise only when the leg has none. */
		setMode?: boolean;
	},
): Promise<{ row: LegRow; chosen: TransitRoute | null }> {
	const before = await findLeg(tx, tripId, target);
	// The chosen manual route stays listed even when only `details.route`
	// holds it (imported legs): fetching must never drop it (QA MT-01).
	const alternatives = mergeAlternatives(legRoutes(before), fetched);
	const current = transitDetailsOf(before);
	const chosenId = chosenIdOf(current);
	const hasChoice =
		!!current.route && alternatives.some((r) => r.id === chosenId);
	// A person's own minutes (isEdited, no route chosen) are never replaced (QA TR-08).
	const pick =
		meta.choose || (!hasChoice && !before?.isEdited)
			? fastestRide(fetched)
			: null;
	let row: LegRow;
	if (pick && (before?.mode === "transit" || !before?.mode || meta.setMode)) {
		const { row: r } = await writeLeg(
			tx,
			out,
			tripId,
			target,
			{
				mode: "transit",
				durationMin: pick.durationMin,
				estimateMin: pick.durationMin,
				source: legSourceOf(pick),
				isEdited: false,
				// A walk's measured distance isn't the ride's (QA MT-06 residual).
				distanceM: null,
				details: { ...current, route: pick, chosenId: pick.id },
			},
			{ userId: meta.userId, isGuest: false },
		);
		row = r;
	} else {
		const { row: r } = await writeLeg(
			tx,
			out,
			tripId,
			target,
			{},
			{ userId: meta.userId, isGuest: false },
		);
		row = r;
	}
	await setAlternatives(tx, tripId, row.id, alternatives, meta.queriedFor);
	return { row: { ...row, alternatives }, chosen: pick };
}
