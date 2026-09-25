/**
 * Legs (SPEC §7.6, §7.8, §9.2, §11.3, §13.1): inputs and DB-only cores for
 * the proposable leg ops (EXTENSIONS §3.3). A leg is addressed by its
 * `LegTarget` (pair or stay) before its row exists; `ensureLeg` creates the
 * row when a bundle (note, photo, list item, expense) needs one. The rules
 * live in `src/server/legs.server.ts`, which WP-Transit's server code uses too.
 */
import { sql } from "drizzle-orm";
import { z } from "zod";
import type { Tx } from "@/db/db.server";
import { legAssignees, legs } from "@/db/schema";
import { pairKey } from "@/lib/engine/graph-index";
import { LegMode, LegSource } from "@/lib/schemas/enums";
import { LegDetails } from "@/lib/schemas/legs";
import { LegTarget } from "@/lib/schemas/targets";
import { logActivity } from "@/server/activity.server";
import { fail } from "@/server/authz/session.server";
import { redactLegDetails } from "@/server/graph.server";
import { ensureLegRow, indexTx, writeLeg } from "@/server/legs.server";
import type { TxOutbox } from "@/server/live/outbox.server";
import { tripMemberIds } from "@/server/perms.server";
import type { CoreCtx } from "@/server/proposals/types";

export const EnsureLegInput = z.object({ target: LegTarget }).strict();

export const LegPatch = z
	.object({
		mode: LegMode.nullable(),
		durationMin: z.number().int().min(0).max(4320).nullable(),
		distanceM: z.number().int().min(0).max(40_075_000).nullable(),
		source: LegSource,
		estimateMin: z.number().int().min(0).max(4320).nullable(),
		isEdited: z.boolean(),
		details: LegDetails,
	})
	.partial();
export type LegPatch = z.infer<typeof LegPatch>;

export const SetLegInput = z
	.object({
		target: LegTarget,
		patch: LegPatch,
		expectedUpdatedAt: z.string().optional(),
	})
	.strict();

export const RelinkLegInput = z
	.object({ legId: z.uuid(), fromItemId: z.uuid(), toItemId: z.uuid() })
	.strict();

export const DeleteLegInput = z.object({ legId: z.uuid() }).strict();

export const SetLegAssigneesInput = z
	.object({ legId: z.uuid(), memberIds: z.array(z.uuid()).max(50) })
	.strict();

type In<S extends z.ZodType> = z.output<S>;

/**
 * Guest strip for `leg.set` (EXTENSIONS §3.4 step 2): booking refs, costs,
 * points, fees and real seats never enter a guest's payload. The core then
 * merges with `inputRedacted`, so the stored values are kept.
 */
export function redactSetLeg(input: In<typeof SetLegInput>) {
	return input.patch.details
		? {
				...input,
				patch: {
					...input.patch,
					details: redactLegDetails(input.patch.details),
				},
			}
		: input;
}

/** `ensureLeg` ({ direct: 'propose' }): a `mode: null` row if there isn't one. Keys: graph. */
export async function ensureLegCore(
	tx: Tx,
	out: TxOutbox,
	data: In<typeof EnsureLegInput>,
	ctx: CoreCtx,
): Promise<{ legId: string }> {
	const { row, created } = await ensureLegRow(
		tx,
		ctx.access.tripId,
		data.target,
		ctx.user.id,
	);
	if (created) out.emit({ entity: "leg", ids: [row.id] });
	return { legId: row.id };
}

/** `leg.set`: details checked against the mode; timed instants (§9.2); guest merge (§11.3). Keys: graph. */
export async function setLegCore(
	tx: Tx,
	out: TxOutbox,
	data: In<typeof SetLegInput>,
	ctx: CoreCtx,
): Promise<{ legId: string; updatedAt: string }> {
	const tripId = ctx.access.tripId;
	const { row, modeChanged } = await writeLeg(
		tx,
		out,
		tripId,
		data.target,
		data.patch,
		{
			userId: ctx.user.id,
			// EXTENSIONS §3.4: merges key on the redacted input, not on the caller.
			isGuest: ctx.inputRedacted,
			expectedUpdatedAt: data.expectedUpdatedAt,
		},
	);
	if (modeChanged) {
		await logActivity(tx, out, {
			tripId,
			actor: ctx.actor,
			verb: "leg.update",
			summary: row.mode ? `set a leg to ${row.mode}` : "cleared a leg's mode",
			legId: row.id,
		});
	}
	return { legId: row.id, updatedAt: row.updatedAt.toISOString() };
}

/** `leg.relink`: re-attaches a detached leg to a new pair (§7.8). Keys: graph. */
export async function relinkLegCore(
	tx: Tx,
	out: TxOutbox,
	data: In<typeof RelinkLegInput>,
	ctx: CoreCtx,
): Promise<{ ok: true }> {
	const tripId = ctx.access.tripId;
	const ix = await indexTx(tx, tripId);
	const leg = ix.leg(data.legId);
	if (!leg) return fail("NOT_FOUND");
	if (leg.kind !== "pair")
		return fail("VALIDATION", "only a pair leg can be relinked");
	// Both items must be live items of THIS trip (ix only holds this trip).
	if (!ix.item(data.fromItemId) || !ix.item(data.toItemId))
		return fail("NOT_FOUND", "item");
	if (!ix.isPair(data.fromItemId, data.toItemId))
		return fail("CONFLICT", "those stops are not next to each other");
	const there = ix.legByPair.get(pairKey(data.fromItemId, data.toItemId));
	if (there && there.id !== leg.id) {
		if (ix.isSignificant(there))
			return fail("CONFLICT", "that stretch already has its own route");
		await tx.delete(legs).where(sql`${legs.id} = ${there.id}`);
	}
	await tx.execute(sql`
		update legs set from_item_id = ${data.fromItemId}, to_item_id = ${data.toItemId}, updated_at = now()
		 where id = ${leg.id} and trip_id = ${tripId}`);
	await logActivity(tx, out, {
		tripId,
		actor: ctx.actor,
		verb: "leg.relink",
		summary: "relinked a route",
		legId: leg.id,
	});
	out.emit({ entity: "leg", ids: [leg.id] });
	return { ok: true as const };
}

/** `leg.delete`. Keys: graph, counts, media, lists, notes. */
export async function deleteLegCore(
	tx: Tx,
	out: TxOutbox,
	data: In<typeof DeleteLegInput>,
	ctx: CoreCtx,
): Promise<{ ok: true }> {
	const tripId = ctx.access.tripId;
	const [row] = await tx
		.delete(legs)
		.where(sql`${legs.id} = ${data.legId} and ${legs.tripId} = ${tripId}`)
		.returning({ id: legs.id });
	if (!row) return fail("NOT_FOUND");
	await logActivity(tx, out, {
		tripId,
		actor: ctx.actor,
		verb: "leg.delete",
		summary: "discarded a route",
		legId: data.legId,
	});
	out.emit({
		entity: "leg",
		ids: [data.legId],
		keys: ["counts", "media", "lists", "notes", "money"],
	});
	return { ok: true as const };
}

/** `leg.assignees`: travellers (members of this trip only). Keys: graph. */
export async function setLegAssigneesCore(
	tx: Tx,
	out: TxOutbox,
	data: In<typeof SetLegAssigneesInput>,
	ctx: CoreCtx,
): Promise<{ ok: true }> {
	const tripId = ctx.access.tripId;
	const live = await tx.execute(
		sql`select 1 from legs where id = ${data.legId} and trip_id = ${tripId}`,
	);
	if (!live.rows.length) return fail("NOT_FOUND");
	const memberIds = await tripMemberIds(tx, tripId, data.memberIds);
	if (memberIds.length !== new Set(data.memberIds).size)
		return fail("VALIDATION", "only members of this trip can travel on a leg");
	await tx
		.delete(legAssignees)
		.where(sql`${legAssignees.legId} = ${data.legId}`);
	if (memberIds.length)
		await tx.insert(legAssignees).values(
			memberIds.map((memberId) => ({
				tripId,
				legId: data.legId,
				memberId,
			})),
		);
	await tx.execute(
		sql`update legs set updated_at = now() where id = ${data.legId}`,
	);
	out.emit({ entity: "leg", ids: [data.legId] });
	return { ok: true as const };
}
