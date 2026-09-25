/**
 * WP-Suggest's proposable def (EXTENSIONS §3.7 NoteSuggestions): `note.append`
 * is propose-only. Its core only checks that the target is live and in this
 * trip (so the gate's limits and author snapshot apply); the reviewer's
 * editor inserts the Markdown and accepts with `appliedClientSide`.
 *
 * - The trip comes from the target ROW (never from the input alone): a node,
 *   item, day or leg of another trip is NOT_FOUND, like a missing one.
 * - The entity is the note's target (`kind: 'note'`, id = the target's id,
 *   null for the trip root), so the gate's ghost lookup and access loss work
 *   per note.
 * - The Markdown is never rendered as HTML (`MarkdownText` skips raw HTML).
 * - No `fields`: additions never compete. Two additions to one note are two
 *   proposals (propose-only ops never amend), and accepting one must not put
 *   the other under Conflicts (the accept marks open proposals on the same
 *   entity that share a field).
 * - Activity: "added to the notes of Shibuya Sky". The dry run turns it into
 *   the proposal's summary; the accept logs it as "Maya (accepted by Dennis)".
 */
import { sql } from "drizzle-orm";
import { z } from "zod";
import { BundleTarget } from "@/lib/schemas/targets";
import { logActivity } from "@/server/activity.server";
import { fail } from "@/server/authz/session.server";
import type { SqlExec } from "@/server/graph.server";
import { assertBundleTarget, tripOf } from "@/server/perms.server";
import { entityLabel } from "@/server/proposals/base.server";
import { defineProposable } from "@/server/proposals/types";

export const ProposeNoteAppendInput = z
	.object({
		tripId: z.uuid(),
		target: BundleTarget,
		/** Markdown, rendered to reviewers with `MarkdownText` only (never raw HTML). */
		markdown: z.string().trim().min(1).max(4000),
	})
	.strict();

type Input = z.output<typeof ProposeNoteAppendInput>;

/** The target's own id (null for the trip root). */
export function noteTargetId(target: BundleTarget): string | null {
	switch (target.kind) {
		case "trip":
			return null;
		case "node":
			return target.nodeId;
		case "item":
			return target.itemId;
		case "day":
			return target.dayId;
		case "leg":
			return target.legId;
	}
}

/** The trip of a note target: the row's trip, which must be the input's trip. */
export async function noteTripOf(i: Input, exec: SqlExec): Promise<string> {
	const t = i.target;
	if (t.kind === "trip") return i.tripId; // the gate's access check 404s an unknown trip
	const found =
		t.kind === "node"
			? await tripOf("nodes", t.nodeId, { exec })
			: t.kind === "item"
				? await tripOf("items", t.itemId, { exec })
				: t.kind === "day"
					? await tripOf("trip_days", t.dayId, { exec })
					: await tripOf("legs", t.legId, { exec });
	if (!found || found !== i.tripId) return fail("NOT_FOUND");
	return found;
}

/** "the notes of Shibuya Sky", "the notes of Day 3", "the trip notes". */
export async function noteWhere(
	exec: SqlExec,
	tripId: string,
	target: BundleTarget,
): Promise<string> {
	switch (target.kind) {
		case "trip":
			return "the trip notes";
		case "node":
			return `the notes of ${await entityLabel(exec, tripId, "node", target.nodeId)}`;
		case "item":
			return `the notes of ${await entityLabel(exec, tripId, "item", target.itemId)}`;
		case "day":
			return `the notes of ${await entityLabel(exec, tripId, "day", target.dayId)}`;
		case "leg": {
			const res = await exec.execute(sql`
				select coalesce(fi.title, fn.name) as "from", coalesce(ti.title, tn.name) as "to"
				  from legs l
				  left join items fi on fi.id = l.from_item_id
				  left join nodes fn on fn.id = fi.node_id
				  left join items ti on ti.id = l.to_item_id
				  left join nodes tn on tn.id = ti.node_id
				 where l.id = ${target.legId} and l.trip_id = ${tripId}`);
			const r = res.rows[0] as
				| { from: string | null; to: string | null }
				| undefined;
			return r?.from && r.to
				? `the notes of ${r.from} → ${r.to}`.slice(0, 200)
				: "the notes of a leg";
		}
	}
}

/** The activity row's entity columns for a note target. */
function targetCols(target: BundleTarget) {
	return {
		nodeId: target.kind === "node" ? target.nodeId : null,
		itemId: target.kind === "item" ? target.itemId : null,
		dayId: target.kind === "day" ? target.dayId : null,
		legId: target.kind === "leg" ? target.legId : null,
	};
}

export const defs = {
	"note.append": defineProposable({
		input: ProposeNoteAppendInput,
		tripIdOf: noteTripOf,
		entityOf: (i) => ({ kind: "note", id: noteTargetId(i.target) }),
		fields: () => [],
		proposeOnly: true,
		core: async (tx, out, input, ctx): Promise<{ ok: true }> => {
			const tripId = ctx.access.tripId;
			// Live and in this trip (a soft-deleted node or item is NOT_FOUND).
			await assertBundleTarget(tx, tripId, input.target);
			await logActivity(tx, out, {
				tripId,
				actor: ctx.actor,
				verb: "note.append",
				summary: `added to ${await noteWhere(tx, tripId, input.target)}`,
				...targetCols(input.target),
			});
			return { ok: true };
		},
	}),
};
