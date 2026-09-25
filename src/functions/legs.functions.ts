/**
 * Legs (SPEC §7.6, §7.8, §9.2, §11.3, §13.1). A leg is addressed by its
 * `LegTarget` (pair or stay) before its row exists; `ensureLeg` creates the
 * row when a bundle (note, photo, list item, expense) needs one. Proposable
 * functions are literal `createServerFn`s whose handler is the gate
 * (EXTENSIONS §3.4); the inputs and cores live in `src/server/cores/legs.server.ts`.
 */
import { createServerFn } from "@tanstack/react-start";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db/db.server";
import type { GraphLeg } from "@/lib/engine/types";
import {
	readLegDetails,
	type StoredLegDetails,
	type TransitRoute,
} from "@/lib/schemas/legs";
import { LegTarget } from "@/lib/schemas/targets";
import { withNamedUser, withUser } from "@/server/authz/middleware";
import {
	DeleteLegInput,
	EnsureLegInput,
	ensureLegCore,
	RelinkLegInput,
	SetLegAssigneesInput,
	SetLegInput,
} from "@/server/cores/legs.server";
import { guestLegDetails } from "@/server/graph.server";
import { findLeg } from "@/server/legs.server";
import { requireLegTarget } from "@/server/perms.server";
import {
	proposable,
	requireDirect,
} from "@/server/proposals/proposable.server";
import { legTargetTrip } from "@/server/proposals/trip-of.server";
import { actorOf } from "@/server/proposals/types";
import { mutationMeta, withTripTx } from "@/server/tx.server";

/**
 * `{ direct: 'propose' }`: creates a `mode: null` row if there isn't one
 * (bundles and expenses need a leg row; suggesters too). Keys: graph.
 */
export const ensureLeg = createServerFn({ method: "POST" })
	.middleware([withNamedUser])
	.validator(EnsureLegInput)
	.handler(async ({ data, context }): Promise<{ legId: string }> => {
		const tripId = await legTargetTrip(db, data.target);
		const access = await requireDirect("ensureLeg", tripId, context.user);
		return withTripTx(
			tripId,
			(tx, out) =>
				ensureLegCore(tx, out, data, {
					access,
					user: context.user,
					actor: actorOf(context.user),
					inputRedacted: false,
					dryRun: false,
				}),
			mutationMeta(access, context.user),
		);
	});

/** `leg.set`: details checked against the mode; timed instants (§9.2); guest merge (§11.3). Keys: graph. */
export const setLeg = createServerFn({ method: "POST" })
	.middleware([withNamedUser])
	.validator(proposable.input(SetLegInput))
	.handler(proposable.run("leg.set"));

/** `leg.relink`: re-attaches a detached leg to a new pair (§7.8). Keys: graph. */
export const relinkLeg = createServerFn({ method: "POST" })
	.middleware([withNamedUser])
	.validator(proposable.input(RelinkLegInput))
	.handler(proposable.run("leg.relink"));

/** `leg.delete`. Keys: graph, counts, media, lists, notes, money. */
export const deleteLeg = createServerFn({ method: "POST" })
	.middleware([withNamedUser])
	.validator(proposable.input(DeleteLegInput))
	.handler(proposable.run("leg.delete"));

/** `leg.assignees`: travellers (members of this trip only). Keys: graph. */
export const setLegAssignees = createServerFn({ method: "POST" })
	.middleware([withNamedUser])
	.validator(proposable.input(SetLegAssigneesInput))
	.handler(proposable.run("leg.assignees"));

export type LegWithAlternatives = GraphLeg & { alternatives: TransitRoute[] };

/** The leg row including `alternatives`, redacted for guests; null when no row exists. */
export const getLeg = createServerFn({ method: "GET" })
	.middleware([withUser])
	.validator(z.object({ target: LegTarget }).strict())
	.handler(async ({ data, context }): Promise<LegWithAlternatives | null> => {
		const { tripId, access } = await requireLegTarget(
			data.target,
			"viewer",
			context.user,
		);
		const row = await findLeg(db, tripId, data.target);
		if (!row) return null;
		const extra = await db.execute(sql`
			select coalesce((select array_agg(member_id::text order by member_id) from leg_assignees where leg_id = ${row.id}), '{}') as "assigneeIds",
			       (exists (select 1 from attachments x where x.leg_id = ${row.id} and x.deleted_at is null)
			        or exists (select 1 from list_items x where x.leg_id = ${row.id} and x.deleted_at is null)
			        -- Private notes and list items count (the leg must not be dropped); one bit, never content.
			        or exists (select 1 from yjs_documents x where x.leg_id = ${row.id} and coalesce(x.plain_text, '') <> '')
			        or exists (select 1 from leg_assignees x where x.leg_id = ${row.id})) as "hasContent"`);
		const e = extra.rows[0] as { assigneeIds: string[]; hasContent: boolean };
		const details = readLegDetails(row.details);
		const alternatives = (row.alternatives ?? []) as TransitRoute[];
		return {
			id: row.id,
			kind: row.kind,
			fromItemId: row.fromItemId,
			toItemId: row.toItemId,
			stayDayId: row.stayDayId,
			anchorItemId: row.anchorItemId,
			mode: row.mode,
			durationMin: row.durationMin,
			distanceM: row.distanceM,
			source: row.source,
			estimateMin: row.estimateMin,
			isEdited: row.isEdited,
			depAt: row.depAt?.toISOString() ?? null,
			arrAt: row.arrAt?.toISOString() ?? null,
			details: (access.isGuest
				? guestLegDetails(details)
				: row.details) as StoredLegDetails,
			queriedFor: row.queriedFor?.toISOString() ?? null,
			assigneeIds: e.assigneeIds ?? [],
			hasContent: Boolean(e.hasContent),
			updatedAt: row.updatedAt.toISOString(),
			alternatives,
		};
	});
