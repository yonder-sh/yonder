/**
 * Timeline items (SPEC §7.7–§7.10, §13.1): inputs and DB-only cores for the
 * proposable item ops (EXTENSIONS §3.3). Everything that changes the located
 * sequence runs `reconcileLegs` inside the same transaction and returns
 * `detachedLegIds` (§7.8); flight blocks move and delete as one (§7.9); item
 * notes keep their mention rows in sync (§7.10).
 */
import { sql } from "drizzle-orm";
import { z } from "zod";
import type { Tx } from "@/db/db.server";
import { itemAssignees, items } from "@/db/schema";
import { defaultItemDuration } from "@/lib/domain/taxonomy";
import type { GraphIndex } from "@/lib/engine/graph-index";
import { HHmm } from "@/lib/schemas/common";
import { logActivity } from "@/server/activity.server";
import { fail } from "@/server/authz/session.server";
import { indexTx, reconcileLegs } from "@/server/legs.server";
import type { TxOutbox } from "@/server/live/outbox.server";
import { syncMentions } from "@/server/mentions.server";
import { tripMemberIds } from "@/server/perms.server";
import { positionFor, positionsFor } from "@/server/position.server";
import type { CoreCtx } from "@/server/proposals/types";
import { assertFreshIds } from "./ids.server";

export type SequenceResult = { detachedLegIds: string[] };

export const CreateItemInput = z
	.object({
		tripId: z.uuid(),
		/** EXTENSIONS §2.2: a chosen id (proposals pin it); an existing one is CONFLICT. */
		id: z.uuid().optional(),
		dayId: z.uuid().nullable(),
		nodeId: z.uuid().optional(),
		title: z.string().trim().min(1).max(200).optional(),
		note: z.string().max(10_000).optional(),
		durationMin: z.number().int().min(0).max(4320).optional(),
		pinnedStart: HHmm.optional(),
		afterItemId: z.uuid().optional(),
		beforeItemId: z.uuid().optional(),
	})
	.strict()
	.refine((v) => v.nodeId || v.title, {
		message: "A place or a title is required",
	});

export const UpdateItemInput = z
	.object({
		itemId: z.uuid(),
		patch: z
			.object({
				durationMin: z.number().int().min(0).max(4320),
				pinnedStart: HHmm.nullable(),
				title: z.string().max(200).nullable(),
				note: z.string().max(10_000).nullable(),
				nodeId: z.uuid().nullable(),
				/** E2 "Booked for this date". */
				fixedDate: z.boolean(),
			})
			.partial(),
		expectedUpdatedAt: z.string().optional(),
	})
	.strict();

export const MoveItemInput = z
	.object({
		itemId: z.uuid(),
		dayId: z.uuid().nullable(),
		afterItemId: z.uuid().optional(),
		beforeItemId: z.uuid().optional(),
	})
	.strict();

export const DeleteItemInput = z.object({ itemId: z.uuid() }).strict();

export const RestoreItemInput = z
	.object({ itemId: z.uuid(), deletedAt: z.string() })
	.strict();

export const SetItemAssigneesInput = z
	.object({ itemId: z.uuid(), memberIds: z.array(z.uuid()).max(50) })
	.strict();

type In<S extends z.ZodType> = z.output<S>;

/** "Itoya Ginza", "Lunch", … for activity lines. */
function itemLabel(ix: GraphIndex, itemId: string): string {
	const it = ix.item(itemId);
	return it?.title ?? ix.node(it?.nodeId)?.name ?? "an item";
}

function dayLabel(ix: GraphIndex, dayId: string | null): string {
	return dayId ? `Day ${ix.dayNumber(dayId)}` : "Unscheduled";
}

/** A node that items may point at: live, in this trip, not dropped when scheduling. */
function assertItemNode(
	ix: GraphIndex,
	nodeId: string,
	scheduled: boolean,
): void {
	if (!ix.node(nodeId)) fail("NOT_FOUND", "place");
	if (scheduled && ix.isDropped(nodeId))
		fail("CONFLICT", "that place is dropped — restore it first");
}

async function noteMentions(
	tx: Tx,
	out: TxOutbox,
	tripId: string,
	itemId: string,
	note: string | null,
	userId: string,
): Promise<void> {
	await syncMentions(tx, out, tripId, { noteItemId: itemId }, [note], {
		createdBy: userId,
		target: { itemId },
	});
}

/** `item.create`. Keys: graph. */
export async function createItemCore(
	tx: Tx,
	out: TxOutbox,
	data: In<typeof CreateItemInput>,
	ctx: CoreCtx,
): Promise<SequenceResult & { itemId: string }> {
	if (data.id) await assertFreshIds(tx, "items", [data.id]);
	const ix = await indexTx(tx, data.tripId);
	if (data.dayId && !ix.day(data.dayId)) return fail("NOT_FOUND", "day");
	const node = data.nodeId ? ix.node(data.nodeId) : undefined;
	if (data.nodeId) assertItemNode(ix, data.nodeId, data.dayId !== null);
	const position = await positionFor(
		tx,
		{ table: "items", tripId: data.tripId, dayId: data.dayId },
		{ afterId: data.afterItemId, beforeId: data.beforeItemId },
	);
	const [row] = await tx
		.insert(items)
		.values({
			...(data.id ? { id: data.id } : {}),
			tripId: data.tripId,
			dayId: data.dayId,
			nodeId: data.nodeId ?? null,
			title: data.title ?? null,
			note: data.note ?? null,
			position,
			durationMin: data.durationMin ?? (node ? defaultItemDuration(node) : 60),
			pinnedStart: data.pinnedStart ?? null,
			createdBy: ctx.user.id,
		})
		.returning({ id: items.id });
	if (!row) throw new Error("createItem: insert returned no row");
	if (data.note)
		await noteMentions(tx, out, data.tripId, row.id, data.note, ctx.user.id);
	const { detachedLegIds } = await reconcileLegs(tx, out, data.tripId, ix, {
		changed: [row.id],
	});
	const label = data.title ?? node?.name ?? "an item";
	await logActivity(tx, out, {
		tripId: data.tripId,
		actor: ctx.actor,
		verb: data.dayId ? "item.schedule" : "item.create",
		summary: `added ${label} to ${dayLabel(ix, data.dayId)}`,
		itemId: row.id,
		nodeId: data.nodeId ?? null,
		dayId: data.dayId,
		meta: { name: label, toDayId: data.dayId },
	});
	out.emit({ entity: "item", ids: [row.id] });
	return { itemId: row.id, detachedLegIds };
}

/** `item.update`. Keys: graph (+ mention). */
export async function updateItemCore(
	tx: Tx,
	out: TxOutbox,
	data: In<typeof UpdateItemInput>,
	ctx: CoreCtx,
): Promise<SequenceResult & { updatedAt: string }> {
	const tripId = ctx.access.tripId;
	const ix = await indexTx(tx, tripId);
	const item = ix.item(data.itemId);
	if (!item) return fail("NOT_FOUND");
	const p = data.patch;
	const title = p.title === undefined ? item.title : p.title?.trim() || null;
	const nodeId = p.nodeId === undefined ? item.nodeId : p.nodeId;
	if (!nodeId && !title)
		return fail("VALIDATION", "A place or a title is required");
	if (p.nodeId && p.nodeId !== item.nodeId) {
		assertItemNode(ix, p.nodeId, item.dayId !== null);
		if (ix.blockOf(item.id))
			return fail(
				"CONFLICT",
				"flight stops follow the flight — edit the flight",
			);
	}
	const set: Partial<typeof items.$inferInsert> = {
		updatedAt: new Date(),
		title,
		nodeId,
	};
	if (p.durationMin !== undefined) set.durationMin = p.durationMin;
	if (p.pinnedStart !== undefined) set.pinnedStart = p.pinnedStart;
	if (p.note !== undefined) set.note = p.note?.trim() ? p.note : null;
	if (p.fixedDate !== undefined) set.fixedDate = p.fixedDate;
	const [row] = await tx
		.update(items)
		.set(set)
		.where(sql`${items.id} = ${item.id} and ${items.tripId} = ${tripId}`)
		.returning({ updatedAt: items.updatedAt });
	if (!row) return fail("NOT_FOUND");
	if (p.note !== undefined)
		await noteMentions(tx, out, tripId, item.id, set.note ?? null, ctx.user.id);
	let detachedLegIds: string[] = [];
	if (nodeId !== item.nodeId) {
		({ detachedLegIds } = await reconcileLegs(tx, out, tripId, ix, {
			changed: [item.id],
		}));
	}
	out.emit({ entity: "item", ids: [item.id] });
	return { updatedAt: row.updatedAt.toISOString(), detachedLegIds };
}

/** `item.move`: `dayId: null` unschedules it. Flight blocks move as one (§7.9). Keys: graph. */
export async function moveItemCore(
	tx: Tx,
	out: TxOutbox,
	data: In<typeof MoveItemInput>,
	ctx: CoreCtx,
): Promise<SequenceResult> {
	const tripId = ctx.access.tripId;
	const ix = await indexTx(tx, tripId);
	const item = ix.item(data.itemId);
	if (!item) return fail("NOT_FOUND");
	if (data.dayId && !ix.day(data.dayId)) return fail("NOT_FOUND", "day");
	if (item.nodeId && data.dayId) assertItemNode(ix, item.nodeId, true);
	const block = ix.blockOf(item.id);
	const moving = block && block.length > 1 ? [...block] : [item.id];
	if (moving.length > 1) {
		const days = new Set(moving.map((id) => ix.item(id)?.dayId ?? null));
		if (days.size > 1 || data.dayId !== item.dayId)
			return fail(
				"CONFLICT",
				"flights move with their times — edit the flight",
			);
	}
	const keys = await positionsFor(
		tx,
		{ table: "items", tripId, dayId: data.dayId },
		moving.length,
		{
			afterId: data.afterItemId,
			beforeId: data.beforeItemId,
			exclude: moving,
		},
	);
	for (const [i, id] of moving.entries()) {
		await tx.execute(sql`
			update items set day_id = ${data.dayId}, position = ${keys[i] as string}, updated_at = now()
			 where id = ${id} and trip_id = ${tripId}`);
	}
	const { detachedLegIds } = await reconcileLegs(tx, out, tripId, ix, {
		changed: moving,
	});
	const dayChanged = data.dayId !== item.dayId;
	await logActivity(tx, out, {
		tripId,
		actor: ctx.actor,
		verb:
			data.dayId === null
				? "item.unschedule"
				: dayChanged
					? "item.schedule"
					: "item.move",
		summary:
			data.dayId === null
				? `moved ${itemLabel(ix, item.id)} to Unscheduled`
				: `moved ${itemLabel(ix, item.id)} to ${dayLabel(ix, data.dayId)}`,
		itemId: item.id,
		nodeId: item.nodeId,
		dayId: data.dayId,
		meta: {
			name: itemLabel(ix, item.id),
			fromDayId: item.dayId,
			toDayId: data.dayId,
		},
	});
	out.emit({ entity: "item", ids: moving });
	return { detachedLegIds };
}

/** `item.delete`: the whole block for flight items. Keys: graph, counts. */
export async function deleteItemCore(
	tx: Tx,
	out: TxOutbox,
	data: In<typeof DeleteItemInput>,
	ctx: CoreCtx,
): Promise<SequenceResult & { deletedAt: string }> {
	// `deleted_at` is truncated to milliseconds so the ISO string restoreItem
	// gets back matches it exactly.
	const tripId = ctx.access.tripId;
	const ix = await indexTx(tx, tripId);
	const item = ix.item(data.itemId);
	if (!item) return fail("NOT_FOUND");
	const ids = [...(ix.blockOf(item.id) ?? [item.id])];
	const res = await tx.execute(sql`
		update items set deleted_at = date_trunc('milliseconds', now())
		 where trip_id = ${tripId} and id = any(${sql.param(ids)}::uuid[]) and deleted_at is null
		 returning deleted_at as "deletedAt"`);
	const deletedAt = (res.rows[0] as { deletedAt: Date } | undefined)?.deletedAt;
	if (!deletedAt) return fail("NOT_FOUND");
	const { detachedLegIds } = await reconcileLegs(tx, out, tripId, ix, {
		changed: ids,
	});
	await logActivity(tx, out, {
		tripId,
		actor: ctx.actor,
		verb: "item.delete",
		summary: `deleted ${itemLabel(ix, item.id)}${ids.length > 1 ? ` (${ids.length} flight stops)` : ""}`,
		itemId: item.id,
		nodeId: item.nodeId,
		dayId: item.dayId,
		meta: { name: itemLabel(ix, item.id), fromDayId: item.dayId },
	});
	out.emit({ entity: "item", ids, keys: ["counts"] });
	return {
		deletedAt: new Date(deletedAt).toISOString(),
		detachedLegIds,
	};
}

/** restoreItem (edit-only, not proposable). Keys: graph, counts. */
export async function restoreItemCore(
	tx: Tx,
	out: TxOutbox,
	data: In<typeof RestoreItemInput>,
	ctx: CoreCtx,
): Promise<SequenceResult> {
	const tripId = ctx.access.tripId;
	const ix = await indexTx(tx, tripId);
	// The item plus the flight-block partners deleted with it (same timestamp).
	const res = await tx.execute(sql`
		with recursive block(id) as (
		  select ${data.itemId}::uuid
		  union
		  select case when l.from_item_id = b.id then l.to_item_id else l.from_item_id end
		    from legs l join block b on b.id in (l.from_item_id, l.to_item_id)
		   where l.trip_id = ${tripId} and l.mode = 'flight'
		)
		select i.id::text as id, i.node_id::text as "nodeId",
		       (n.id is not null and n.deleted_at is not null) as "nodeGone"
		  from items i join block b on b.id = i.id
		  left join nodes n on n.id = i.node_id
		 where i.trip_id = ${tripId} and i.deleted_at = ${new Date(data.deletedAt)}`);
	const rows = res.rows as {
		id: string;
		nodeId: string | null;
		nodeGone: boolean;
	}[];
	if (!rows.some((r) => r.id === data.itemId)) return fail("NOT_FOUND");
	if (rows.some((r) => r.nodeGone))
		return fail("CONFLICT", "its place was deleted — restore the place first");
	const ids = rows.map((r) => r.id);
	await tx.execute(sql`
		update items set deleted_at = null, updated_at = now()
		 where trip_id = ${tripId} and id = any(${sql.param(ids)}::uuid[])`);
	const { detachedLegIds } = await reconcileLegs(tx, out, tripId, ix, {
		changed: ids,
	});
	await logActivity(tx, out, {
		tripId,
		actor: ctx.actor,
		verb: "item.restore",
		summary: "restored an item",
		itemId: data.itemId,
	});
	out.emit({ entity: "item", ids, keys: ["counts"] });
	return { detachedLegIds };
}

/** `item.assignees`: members of this trip only (never guests or removed members). Keys: graph. */
export async function setItemAssigneesCore(
	tx: Tx,
	out: TxOutbox,
	data: In<typeof SetItemAssigneesInput>,
	ctx: CoreCtx,
): Promise<{ ok: true }> {
	const tripId = ctx.access.tripId;
	const live = await tx.execute(
		sql`select 1 from items where id = ${data.itemId} and trip_id = ${tripId} and deleted_at is null`,
	);
	if (!live.rows.length) return fail("NOT_FOUND");
	const memberIds = await tripMemberIds(tx, tripId, data.memberIds);
	if (memberIds.length !== new Set(data.memberIds).size)
		return fail("VALIDATION", "only members of this trip can be assigned");
	await tx
		.delete(itemAssignees)
		.where(sql`${itemAssignees.itemId} = ${data.itemId}`);
	if (memberIds.length)
		await tx.insert(itemAssignees).values(
			memberIds.map((memberId) => ({
				tripId,
				itemId: data.itemId,
				memberId,
			})),
		);
	await tx.execute(
		sql`update items set updated_at = now() where id = ${data.itemId}`,
	);
	out.emit({ entity: "item", ids: [data.itemId] });
	return { ok: true as const };
}
