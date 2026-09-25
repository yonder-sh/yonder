/**
 * A leg row as the client sees it (`GraphLeg`), with guest redaction
 * (SPEC §6.6: refs, costs, points and fees dropped, seats "••").
 */
import { sql } from "drizzle-orm";
import type { DbOrTx } from "@/db/db.server";
import type { legs } from "@/db/schema";
import type { GraphLeg } from "@/lib/engine/types";
import { readLegDetails, type StoredLegDetails } from "@/lib/schemas/legs";
import { redactLegDetails } from "@/server/graph.server";

type LegRow = typeof legs.$inferSelect;

export async function toGraphLeg(
	exec: DbOrTx,
	row: LegRow,
	redact: boolean,
): Promise<GraphLeg> {
	const extra = await exec.execute(sql`
		select coalesce((select array_agg(member_id::text order by member_id) from leg_assignees where leg_id = ${row.id}), '{}') as "assigneeIds",
		       (exists (select 1 from attachments x where x.leg_id = ${row.id} and x.deleted_at is null)
		        or exists (select 1 from list_items x where x.leg_id = ${row.id} and x.deleted_at is null)
		        or exists (select 1 from yjs_documents x where x.leg_id = ${row.id} and coalesce(x.plain_text, '') <> '')
		        or exists (select 1 from leg_assignees x where x.leg_id = ${row.id})) as "hasContent"`);
	const e = extra.rows[0] as
		| { assigneeIds: string[] | null; hasContent: boolean }
		| undefined;
	const details = readLegDetails(row.details);
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
		details: (redact
			? redactLegDetails(details)
			: details.kind === "none"
				? {}
				: details) as StoredLegDetails,
		queriedFor: row.queriedFor?.toISOString() ?? null,
		assigneeIds: e?.assigneeIds ?? [],
		hasContent: Boolean(e?.hasContent),
		updatedAt: row.updatedAt.toISOString(),
	};
}
