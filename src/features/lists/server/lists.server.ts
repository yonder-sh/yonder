/**
 * WP-Lists server helpers: DTO reads (with the ADDENDUM §7.2 privacy filter),
 * the locked row read every core starts with, and input checks that keep ids
 * inside the trip (SECURITY §13: members, nodes, days and items named by the
 * input must belong to `tripId`).
 */
import { and, asc, eq, inArray, isNull, or, sql } from "drizzle-orm";
import type { Tx } from "@/db/db.server";
import { listItemAssignees, listItems, listItemTargets } from "@/db/schema";
import type { DueRule } from "@/lib/schemas/lists";
import { type BundleTarget, bundleTargetOf } from "@/lib/schemas/targets";
import { fail } from "@/server/authz/session.server";
import type { SqlExec } from "@/server/graph.server";
import { mentionExcerpt } from "@/server/mentions.server";
import { tripMemberIds } from "@/server/perms.server";
import type { ListItemDto } from "../lists.functions";

type Exec = Pick<Tx, "select">;
type Row = typeof listItems.$inferSelect;

export function toDto(
	r: Row,
	meUserId: string,
	assigneeIds: string[],
	extraTargetNodeIds: string[],
): ListItemDto {
	return {
		id: r.id,
		target: bundleTargetOf(r),
		list: r.list,
		text: r.text,
		note: r.note,
		url: r.url,
		status: r.status,
		dueDayId: r.dueDayId,
		dueDate: r.dueDate,
		dueTime: r.dueTime,
		dueTz: r.dueTz,
		dueKind: r.dueKind,
		dueRule: (r.dueRule as DueRule | null) ?? null,
		quantity: r.quantity,
		priceAmount: r.priceAmount,
		priceCurrency: r.priceCurrency,
		position: r.position,
		isPrivate: r.isPrivate,
		assigneeIds,
		extraTargetNodeIds,
		createdAt: r.createdAt.toISOString(),
		updatedAt: r.updatedAt.toISOString(),
		doneAt: r.doneAt ? r.doneAt.toISOString() : null,
		mine: r.createdBy === meUserId,
	};
}

/**
 * Live list items of a trip that `meUserId` may see (private rows only for
 * their creator), ordered by `(position, id)`. `ids` narrows the read.
 */
export async function readListItems(
	exec: Exec,
	tripId: string,
	meUserId: string,
	ids?: readonly string[],
): Promise<ListItemDto[]> {
	const idFilter = ids ? inArray(listItems.id, [...ids]) : undefined;
	const rows = await exec
		.select()
		.from(listItems)
		.where(
			and(
				eq(listItems.tripId, tripId),
				isNull(listItems.deletedAt),
				or(eq(listItems.isPrivate, false), eq(listItems.createdBy, meUserId)),
				idFilter,
			),
		)
		.orderBy(asc(listItems.position), asc(listItems.id));
	if (rows.length === 0) return [];
	const rowIds = rows.map((r) => r.id);
	const [assignees, targets] = await Promise.all([
		exec
			.select()
			.from(listItemAssignees)
			.where(
				and(
					eq(listItemAssignees.tripId, tripId),
					ids ? inArray(listItemAssignees.listItemId, rowIds) : undefined,
				),
			),
		exec
			.select()
			.from(listItemTargets)
			.where(
				and(
					eq(listItemTargets.tripId, tripId),
					ids ? inArray(listItemTargets.listItemId, rowIds) : undefined,
				),
			),
	]);
	const byItem = <T extends { listItemId: string }>(xs: T[]) => {
		const m = new Map<string, T[]>();
		for (const x of xs) {
			const a = m.get(x.listItemId);
			if (a) a.push(x);
			else m.set(x.listItemId, [x]);
		}
		return m;
	};
	const as = byItem(assignees);
	const ts = byItem(targets);
	return rows.map((r) =>
		toDto(
			r,
			meUserId,
			(as.get(r.id) ?? []).map((a) => a.memberId),
			(ts.get(r.id) ?? []).map((t) => t.nodeId),
		),
	);
}

/**
 * The live row a core acts on, locked for the transaction. Someone else's
 * PRIVATE row answers NOT_FOUND exactly like a missing one (ADDENDUM §7.2).
 */
export async function lockListItem(
	tx: Tx,
	tripId: string,
	id: string,
	meUserId: string,
	opts: { deleted?: boolean } = {},
): Promise<Row> {
	const res = await tx.execute(sql`
		select id from list_items
		 where id = ${id} and trip_id = ${tripId}
		   and ${opts.deleted ? sql`deleted_at is not null` : sql`deleted_at is null`}
		 for update`);
	if (!res.rows.length) return fail("NOT_FOUND");
	const [row] = await tx.select().from(listItems).where(eq(listItems.id, id));
	if (!row) return fail("NOT_FOUND");
	if (row.isPrivate && row.createdBy !== meUserId) return fail("NOT_FOUND");
	return row;
}

/** Every id must be a trip member (active, invited or placeholder; never a guest). */
export async function assertMembers(
	exec: SqlExec,
	tripId: string,
	memberIds: readonly string[],
): Promise<string[]> {
	const ok = await tripMemberIds(exec, tripId, memberIds);
	if (ok.length !== new Set(memberIds).size)
		return fail("VALIDATION", "only members of this trip can be assigned");
	return ok;
}

/** Live nodes of this trip (candidate shops). Duplicates dropped, order kept. */
export async function assertNodes(
	exec: SqlExec,
	tripId: string,
	nodeIds: readonly string[],
): Promise<string[]> {
	const want = [...new Set(nodeIds)];
	if (!want.length) return [];
	const res = await exec.execute(sql`
		select id::text as id from nodes
		 where trip_id = ${tripId} and deleted_at is null
		   and id = any(${sql.param(want)}::uuid[])`);
	const ok = new Set((res.rows as { id: string }[]).map((r) => r.id));
	if (ok.size !== want.length) return fail("NOT_FOUND", "place");
	return want;
}

/** A day of this trip (the "by Day N" field). */
export async function assertDay(
	exec: SqlExec,
	tripId: string,
	dayId: string,
): Promise<void> {
	const res = await exec.execute(
		sql`select 1 from trip_days where id = ${dayId} and trip_id = ${tripId}`,
	);
	if (!res.rows.length) fail("NOT_FOUND", "day");
}

/** A relative rule's anchor item: a live item of this trip. */
export async function assertRuleItem(
	exec: SqlExec,
	tripId: string,
	rule: DueRule | null | undefined,
): Promise<void> {
	if (!rule) return;
	const res = await exec.execute(
		sql`select 1 from items where id = ${rule.itemId} and trip_id = ${tripId} and deleted_at is null`,
	);
	if (!res.rows.length) fail("NOT_FOUND", "item");
}

/** The trip's default zone (a `dueTime` without a zone gets it). */
export async function tripTz(exec: SqlExec, tripId: string): Promise<string> {
	const res = await exec.execute(
		sql`select default_tz as tz from trips where id = ${tripId}`,
	);
	return (res.rows[0] as { tz?: string } | undefined)?.tz ?? "UTC";
}

/** Replaces a row's assignees. */
export async function writeAssignees(
	tx: Tx,
	tripId: string,
	listItemId: string,
	memberIds: readonly string[],
): Promise<void> {
	await tx
		.delete(listItemAssignees)
		.where(eq(listItemAssignees.listItemId, listItemId));
	if (memberIds.length)
		await tx
			.insert(listItemAssignees)
			.values(memberIds.map((memberId) => ({ tripId, listItemId, memberId })));
}

/** Replaces a row's extra candidate shops (the primary target is never repeated). */
export async function writeTargets(
	tx: Tx,
	tripId: string,
	listItemId: string,
	nodeIds: readonly string[],
	primaryNodeId: string | null,
): Promise<void> {
	await tx
		.delete(listItemTargets)
		.where(eq(listItemTargets.listItemId, listItemId));
	const extra = nodeIds.filter((n) => n !== primaryNodeId);
	if (extra.length)
		await tx
			.insert(listItemTargets)
			.values(extra.map((nodeId) => ({ tripId, listItemId, nodeId })));
}

/** "“Book Shibuya Sky sunset slot”" for activity lines (tokens become @Name). */
export function quoteOf(text: string): string {
	const t = mentionExcerpt([text]);
	return `“${t.length > 60 ? `${t.slice(0, 59)}…` : t}”`;
}

/** Activity target columns of a bundle target (activity rows have no FKs). */
export function activityTarget(target: BundleTarget): {
	nodeId: string | null;
	legId: string | null;
	itemId: string | null;
	dayId: string | null;
} {
	return {
		nodeId: target.kind === "node" ? target.nodeId : null,
		legId: target.kind === "leg" ? target.legId : null,
		itemId: target.kind === "item" ? target.itemId : null,
		dayId: target.kind === "day" ? target.dayId : null,
	};
}

/**
 * "Make private (only me)" on an item that was shared (ADDENDUM §7.2, QA
 * DUE-10): its earlier `list.*` lines ("added “SURPRISE cake stand…”") are
 * removed, so the text can't reach anyone through `listActivity`, the digest
 * or `countChangesSince`, exactly as if the item had been private from the
 * start (private items never log). Rows carry `meta.listItemId`; older rows
 * without it are matched by the quoted name on the item's current target.
 * Returns how many rows went.
 */
export async function dropListItemActivity(
	tx: Tx,
	tripId: string,
	row: Pick<Row, "id" | "text" | "nodeId" | "legId" | "itemId" | "dayId">,
): Promise<number> {
	const name = quoteOf(row.text).slice(1, -1);
	const t = activityTarget(bundleTargetOf(row));
	const res = await tx.execute(sql`
		delete from activity_log
		 where trip_id = ${tripId}
		   and verb like 'list.%'
		   and (meta->>'listItemId' = ${row.id}
		        or (coalesce(meta->>'listItemId', '') = ''
		            and meta->>'name' = ${name}
		            and node_id is not distinct from ${t.nodeId}::uuid
		            and leg_id is not distinct from ${t.legId}::uuid
		            and item_id is not distinct from ${t.itemId}::uuid
		            and day_id is not distinct from ${t.dayId}::uuid))
		returning id`);
	return res.rows.length;
}
