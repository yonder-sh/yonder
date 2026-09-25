/**
 * `media.add` is logged once per batch (EXTENSIONS §1.4): the same person
 * adding to the same target within two minutes updates one activity row
 * ("added 4 photos to Shibuya Sky") instead of writing four.
 *
 * A proposal's dry run never joins a batch (COLLAB-R3-04): the first activity
 * line it writes becomes the suggestion's summary, which must describe that
 * one suggestion ("added a link to Golden Gai"), not the author's recent adds.
 *
 * Receipts and `members`-only attachments are never logged: guests read the
 * activity feed, and those must not leak even as a line (CONTRACTS rule 11).
 */
import { sql } from "drizzle-orm";
import type { Tx } from "@/db/db.server";
import type { AttachmentKind } from "@/lib/schemas/enums";
import {
	type AttachmentTarget,
	attachmentTargetColumns,
} from "@/lib/schemas/targets";
import { logActivity } from "@/server/activity.server";
import type { TxOutbox } from "@/server/live/outbox.server";

const NOUN: Record<AttachmentKind, [string, string]> = {
	photo: ["a photo", "photos"],
	video: ["a video", "videos"],
	embed: ["a video link", "video links"],
	link: ["a link", "links"],
	pdf: ["a PDF", "PDFs"],
};

/** "Shibuya Sky", "Day 4", "the trip" … for activity summaries (plain text). */
export async function targetLabel(
	tx: Tx,
	tripId: string,
	target: AttachmentTarget,
): Promise<string> {
	const one = async (q: ReturnType<typeof sql>) =>
		((await tx.execute(q)).rows[0] as { label?: string } | undefined)?.label ??
		null;
	switch (target.kind) {
		case "trip":
			return "the trip";
		case "node":
			return (
				(await one(
					sql`select name as label from nodes where id = ${target.nodeId} and trip_id = ${tripId}`,
				)) ?? "a place"
			);
		case "item":
			return (
				(await one(sql`
					select coalesce(i.title, n.name) as label from items i
					  left join nodes n on n.id = i.node_id
					 where i.id = ${target.itemId} and i.trip_id = ${tripId}`)) ??
				"a stop"
			);
		case "day":
			return (
				(await one(sql`
					select 'Day ' || (select count(*) from trip_days d2
					                   where d2.trip_id = d.trip_id and d2.date <= d.date)::text as label
					  from trip_days d where d.id = ${target.dayId} and d.trip_id = ${tripId}`)) ??
				"a day"
			);
		case "leg":
			return "a leg";
		case "expense":
			return "an expense";
	}
}

export async function logMediaAdd(
	tx: Tx,
	out: Pick<TxOutbox, "version">,
	a: {
		tripId: string;
		actor: { userId: string | null; name: string };
		target: AttachmentTarget;
		kind: AttachmentKind;
		visibility: "everyone" | "members";
		/**
		 * A proposal's validation run (`CoreCtx.dryRun`): always a fresh row, so
		 * the captured summary is this add alone (the run is rolled back anyway).
		 */
		dryRun?: boolean;
	},
): Promise<void> {
	if (a.target.kind === "expense" || a.visibility !== "everyone") return;
	const c = attachmentTargetColumns(a.target);
	const label = await targetLabel(tx, a.tripId, a.target);
	const [single, plural] = NOUN[a.kind];
	// A batch is one person adding one way: an accepted suggestion
	// ("Maya (accepted by Dennis)") never folds into their direct adds.
	const recent =
		a.actor.userId && !a.dryRun
			? ((
					await tx.execute(sql`
					select id::text as id, meta from activity_log
					 where trip_id = ${a.tripId} and verb = 'media.add'
					   and actor_user_id = ${a.actor.userId}
					   and actor_name = ${a.actor.name.slice(0, 120) || "Someone"}
					   and created_at > now() - interval '2 minutes'
					   and node_id is not distinct from ${c.nodeId}::uuid
					   and leg_id is not distinct from ${c.legId}::uuid
					   and item_id is not distinct from ${c.itemId}::uuid
					   and day_id is not distinct from ${c.dayId}::uuid
					 order by created_at desc limit 1
					 for update`)
				).rows[0] as
					| { id: string; meta: { count?: number; name?: string } | null }
					| undefined)
			: undefined;
	if (recent) {
		const count = (recent.meta?.count ?? 1) + 1;
		const noun = recent.meta?.name === plural ? plural : "files";
		await tx.execute(sql`
			update activity_log
			   set summary = ${`added ${count} ${noun} to ${label}`.slice(0, 300)},
			       meta = ${JSON.stringify({ ...(recent.meta ?? {}), count, name: noun })}::jsonb,
			       version = ${out.version}
			 where id = ${recent.id}`);
		return;
	}
	await logActivity(tx, out, {
		tripId: a.tripId,
		actor: a.actor,
		verb: "media.add",
		summary: `added ${single} to ${label}`,
		nodeId: c.nodeId,
		itemId: c.itemId,
		legId: c.legId,
		dayId: c.dayId,
		meta: { count: 1, name: plural },
	});
}

/**
 * A caption edit, a move or a delete of one attachment ("deleted a link from
 * Shibuya Sky", "edited the caption of a photo on Day 4"). Same privacy rule as
 * `logMediaAdd`: receipts and `members`-only rows are never logged. It also
 * gives a suggested edit or delete its readable summary (the dry run's first
 * activity line becomes the proposal's summary).
 */
export async function logMediaChange(
	tx: Tx,
	out: Pick<TxOutbox, "version">,
	a: {
		tripId: string;
		actor: { userId: string | null; name: string };
		target: AttachmentTarget;
		kind: AttachmentKind;
		visibility: "everyone" | "members";
		change: "caption" | "move" | "delete";
		/** For a move: where it went. */
		to?: AttachmentTarget;
	},
): Promise<void> {
	if (a.target.kind === "expense" || a.visibility !== "everyone") return;
	if (a.to?.kind === "expense") return;
	const c = attachmentTargetColumns(a.to ?? a.target);
	const [single] = NOUN[a.kind];
	const label = await targetLabel(tx, a.tripId, a.target);
	const summary =
		a.change === "delete"
			? `deleted ${single} from ${label}`
			: a.change === "caption"
				? `edited the caption of ${single} on ${label}`
				: `moved ${single} to ${a.to ? await targetLabel(tx, a.tripId, a.to) : label}`;
	await logActivity(tx, out, {
		tripId: a.tripId,
		actor: a.actor,
		verb: a.change === "delete" ? "media.delete" : "media.update",
		summary: summary.slice(0, 300),
		nodeId: c.nodeId,
		itemId: c.itemId,
		legId: c.legId,
		dayId: c.dayId,
	});
}
