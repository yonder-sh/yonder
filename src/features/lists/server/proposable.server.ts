/**
 * WP-Lists' proposable defs (EXTENSIONS §3.3, §1.4, §7) and their DB-only
 * cores. Rules every core keeps:
 * - Private list items (ADDENDUM §7.2) never create mention rows, activity
 *   rows or anything another member can see; someone else's private row
 *   answers NOT_FOUND exactly like a missing one (`lockListItem`), so a
 *   proposal's dry run can never reveal it either.
 * - `list.status` applies directly for an assignee (`directIf`); the author's
 *   own private rows apply directly while they STAY private (`directIf` via
 *   `@/server/proposals/private.server`, F), so they never become proposals.
 *   Sharing one publishes it, so for whoever can't apply edits (a suggester,
 *   suggest mode) `isPrivate: false` is never direct (QA SEC-R3-01) and can't
 *   be a suggestion about the private row either: it answers FORBIDDEN, and
 *   the UI suggests the shared copy instead (`list.create` with
 *   `fromPrivateId`), which retires the private original when accepted.
 * - Activity: `list.create`, `list.done` and `list.delete` (never for private
 *   rows; `meta.listItemId` names the row). Making a shared item private drops
 *   its earlier lines (`dropListItemActivity`), as if it had always been private.
 * - Mentions: `syncMentions` after every write of `text`, `note` or `is_private`.
 * - Ids named by the input (members, nodes, days, the rule's item, neighbours)
 *   must belong to the row's trip.
 */
import { sql } from "drizzle-orm";
import { z } from "zod";
import type { Tx } from "@/db/db.server";
import { listItems } from "@/db/schema";
import { HHmm, HttpUrl, IsoDate, Tz } from "@/lib/schemas/common";
import { DUE_KIND_VALUES, LIST_KIND_VALUES } from "@/lib/schemas/enums";
import { DueRule } from "@/lib/schemas/lists";
import { CurrencyCode } from "@/lib/schemas/money";
import {
	BundleTarget,
	bundleTargetColumns,
	bundleTargetOf,
} from "@/lib/schemas/targets";
import { logActivity } from "@/server/activity.server";
import { fail } from "@/server/authz/session.server";
import { assertFreshIds } from "@/server/cores/ids.server";
import type { TxOutbox } from "@/server/live/outbox.server";
import { syncMentions } from "@/server/mentions.server";
import { assertBundleTarget } from "@/server/perms.server";
import { positionFor } from "@/server/position.server";
import {
	ownPrivateListItem,
	privateCreateDirect,
	retractListItemProposals,
} from "@/server/proposals/private.server";
import { rowTrip } from "@/server/proposals/trip-of.server";
import { type CoreCtx, defineProposable } from "@/server/proposals/types";
import type { ListItemDto } from "../lists.functions";
import {
	activityTarget,
	assertDay,
	assertMembers,
	assertNodes,
	assertRuleItem,
	dropListItemActivity,
	lockListItem,
	quoteOf,
	readListItems,
	tripTz,
	writeAssignees,
	writeTargets,
} from "./lists.server";

export const NewListItem = z.object({
	tripId: z.uuid(),
	/** EXTENSIONS §2.2: a chosen id; an existing one is CONFLICT. */
	id: z.uuid().optional(),
	target: BundleTarget,
	list: z.enum(LIST_KIND_VALUES),
	text: z.string().trim().min(1).max(500),
	note: z.string().max(10_000).optional(),
	url: HttpUrl.max(2000).optional(),
	dueDayId: z.uuid().optional(),
	dueDate: IsoDate.optional(),
	dueTime: HHmm.optional(),
	dueTz: Tz.optional(),
	/** E4: `due` (default), `opens` (a booking window), `on` (do it that day). */
	dueKind: z.enum(DUE_KIND_VALUES).optional(),
	/** ADDENDUM §10: a date relative to an item's day (replaces the absolute fields). */
	dueRule: DueRule.nullable().optional(),
	quantity: z.number().int().positive().max(9999).optional(),
	priceAmount: z.number().nonnegative().max(1e12).optional(),
	priceCurrency: CurrencyCode.optional(),
	/** ADDENDUM §7.2: visible only to the creator (gifts). */
	isPrivate: z.boolean().optional(),
	assigneeIds: z.array(z.uuid()).max(50).optional(),
	extraTargetNodeIds: z.array(z.uuid()).max(20).optional(),
	afterId: z.uuid().optional(),
	/**
	 * QA SEC-R3-01: this shared to-do is the author's private one, shared
	 * (a suggestion when they can't apply it). Applying it soft-deletes that
	 * private row, and only if the actor (on accept: the suggestion's author)
	 * created it.
	 */
	fromPrivateId: z.uuid().optional(),
});

export const CreateListItemInput = NewListItem.strict();

/** QA SEC-R3-01: what a suggester hears when sharing a private to-do directly. */
export const SHARE_NEEDS_REVIEW =
	"Sharing a private to-do needs review: suggest sharing it instead.";
/** …and when its share suggestion is still open. */
export const ALREADY_SUGGESTED =
	"You already suggested sharing this: it's waiting for review.";

/**
 * The fields `updateListItem` may change. Everything optional; the clearable
 * ones also take `null` (clear the note, the date, the quantity…).
 */
export const ListItemPatch = z
	.object({
		text: z.string().trim().min(1).max(500),
		note: z.string().max(10_000).nullable(),
		url: HttpUrl.max(2000).nullable(),
		dueDayId: z.uuid().nullable(),
		dueDate: IsoDate.nullable(),
		dueTime: HHmm.nullable(),
		dueTz: Tz.nullable(),
		dueKind: z.enum(DUE_KIND_VALUES),
		dueRule: DueRule.nullable(),
		quantity: z.number().int().positive().max(9999).nullable(),
		priceAmount: z.number().nonnegative().max(1e12).nullable(),
		priceCurrency: CurrencyCode.nullable(),
		isPrivate: z.boolean(),
		assigneeIds: z.array(z.uuid()).max(50),
		extraTargetNodeIds: z.array(z.uuid()).max(20),
	})
	.partial()
	.strict();
export type ListItemPatch = z.infer<typeof ListItemPatch>;

export const UpdateListItemInput = z
	.object({
		id: z.uuid(),
		patch: ListItemPatch,
		expectedUpdatedAt: z.string().optional(),
	})
	.strict();

export const SetListItemStatusInput = z
	.object({ id: z.uuid(), status: z.enum(["open", "done", "skipped"]) })
	.strict();

export const MoveListItemInput = z
	.object({
		id: z.uuid(),
		target: BundleTarget.optional(),
		afterId: z.uuid().optional(),
		beforeId: z.uuid().optional(),
	})
	.strict();

export const SetListItemTargetsInput = z
	.object({ id: z.uuid(), nodeIds: z.array(z.uuid()).max(20) })
	.strict();

export const SetListItemAssigneesInput = z
	.object({ id: z.uuid(), memberIds: z.array(z.uuid()).max(50) })
	.strict();

export const DeleteListItemInput = z.object({ id: z.uuid() }).strict();

export const RestoreListItemInput = z.object({ id: z.uuid() }).strict();

const listTrip = (i: { id: string }, exec: Parameters<typeof rowTrip>[0]) =>
	rowTrip(exec, "list_items", i.id);

type In<S extends z.ZodType> = z.output<S>;

/** The fields that make a date absolute (they switch a relative rule off). */
const ABSOLUTE_DUE = ["dueDayId", "dueDate", "dueTime", "dueTz"] as const;

async function mentionsOf(
	tx: Tx,
	out: TxOutbox,
	row: { id: string; tripId: string; text: string; note: string | null },
	target: ListItemDto["target"],
	userId: string,
): Promise<void> {
	await syncMentions(
		tx,
		out,
		row.tripId,
		{ listItemId: row.id },
		[row.text, row.note],
		{ createdBy: userId, target: bundleTargetColumns(target) },
	);
}

/** Announces a change: lists + counts for everyone (no hints; private rows carry no data). */
function announce(out: TxOutbox, id: string): void {
	out.emit({ entity: "listItem", ids: [id] });
}

async function readOne(
	tx: Tx,
	tripId: string,
	id: string,
	userId: string,
): Promise<ListItemDto> {
	const [dto] = await readListItems(tx, tripId, userId, [id]);
	if (!dto) return fail("NOT_FOUND");
	return dto;
}

/** `list.create`. Keys: lists, counts. */
export async function createListItemCore(
	tx: Tx,
	out: TxOutbox,
	data: In<typeof CreateListItemInput>,
	ctx: CoreCtx,
): Promise<ListItemDto> {
	const tripId = ctx.access.tripId;
	if (data.tripId !== tripId) return fail("NOT_FOUND");
	if (data.id) await assertFreshIds(tx, "list_items", [data.id]);
	if (data.isPrivate && ctx.access.isGuest)
		return fail("VALIDATION", "link guests can't keep private items");
	if (data.isPrivate && data.fromPrivateId)
		return fail("VALIDATION", "a shared copy can't be private");
	// Proposing (the dry run): one open suggestion per private to-do.
	if (data.fromPrivateId && ctx.dryRun && ctx.actor.userId) {
		const open = await tx.execute(sql`
			select 1 from proposals
			 where trip_id = ${tripId} and status = 'open' and op = 'list.create'
			   and author_user_id = ${ctx.actor.userId}
			   and payload->>'fromPrivateId' = ${data.fromPrivateId}
			 limit 1`);
		if (open.rows.length) return fail("CONFLICT", ALREADY_SUGGESTED);
	}
	await assertBundleTarget(tx, tripId, data.target);
	if (data.dueDayId) await assertDay(tx, tripId, data.dueDayId);
	await assertRuleItem(tx, tripId, data.dueRule);
	const assignees = data.assigneeIds?.length
		? await assertMembers(tx, tripId, data.assigneeIds)
		: [];
	const extra = data.extraTargetNodeIds?.length
		? await assertNodes(tx, tripId, data.extraTargetNodeIds)
		: [];
	const position = await positionFor(
		tx,
		{ table: "list_items", tripId, target: data.target, list: data.list },
		{ afterId: data.afterId },
	);
	const rule = data.dueRule ?? null;
	const cols = bundleTargetColumns(data.target);
	const [row] = await tx
		.insert(listItems)
		.values({
			...(data.id ? { id: data.id } : {}),
			tripId,
			...cols,
			list: data.list,
			text: data.text,
			note: data.note?.trim() ? data.note : null,
			url: data.url ?? null,
			dueKind: data.dueKind ?? "due",
			dueRule: rule,
			dueDayId: rule ? null : (data.dueDayId ?? null),
			dueDate: rule ? null : (data.dueDate ?? null),
			dueTime: rule ? null : (data.dueTime ?? null),
			dueTz:
				rule || !data.dueTime
					? null
					: (data.dueTz ?? (await tripTz(tx, tripId))),
			quantity: data.quantity ?? null,
			priceAmount: data.priceAmount ?? null,
			priceCurrency:
				data.priceAmount !== undefined ? (data.priceCurrency ?? null) : null,
			isPrivate: data.isPrivate ?? false,
			position,
			createdBy: ctx.user.id,
		})
		.returning();
	if (!row) throw new Error("createListItem: insert returned no row");
	if (assignees.length) await writeAssignees(tx, tripId, row.id, assignees);
	if (extra.length)
		await writeTargets(tx, tripId, row.id, extra, cols.nodeId ?? null);
	await mentionsOf(tx, out, row, data.target, ctx.user.id);
	if (!row.isPrivate)
		await logActivity(tx, out, {
			tripId,
			actor: ctx.actor,
			verb: "list.create",
			summary: `added ${quoteOf(row.text)} to ${row.list === "shopping" ? "shopping" : "to-dos"}`,
			...activityTarget(data.target),
			meta: { name: quoteOf(row.text).slice(1, -1), listItemId: row.id },
		});
	if (data.fromPrivateId)
		await retirePrivateOriginal(tx, out, tripId, data.fromPrivateId, ctx);
	announce(out, row.id);
	return readOne(tx, tripId, row.id, ctx.user.id);
}

/**
 * QA SEC-R3-01: the shared copy replaces the private to-do it was made from.
 * Only the actor's own private row goes (the suggestion's author on accept,
 * `ctx.actor`); anything else — shared by now, deleted, someone else's — is
 * left alone. Private rows write no activity.
 */
async function retirePrivateOriginal(
	tx: Tx,
	out: TxOutbox,
	tripId: string,
	id: string,
	ctx: CoreCtx,
): Promise<void> {
	const author = ctx.actor.userId;
	if (!author) return;
	const res = await tx.execute(sql`
		update list_items set deleted_at = date_trunc('milliseconds', now()), updated_at = now()
		 where id = ${id} and trip_id = ${tripId} and is_private
		   and created_by = ${author} and deleted_at is null
		returning id`);
	if (res.rows.length) announce(out, id);
}

/** `list.update`: re-diffs mentions; `expectedUpdatedAt` → CONFLICT when stale. */
export async function updateListItemCore(
	tx: Tx,
	out: TxOutbox,
	data: In<typeof UpdateListItemInput>,
	ctx: CoreCtx,
): Promise<{ updatedAt: string }> {
	const tripId = ctx.access.tripId;
	const row = await lockListItem(tx, tripId, data.id, ctx.user.id);
	if (
		data.expectedUpdatedAt &&
		new Date(data.expectedUpdatedAt).getTime() !== row.updatedAt.getTime()
	)
		return fail("CONFLICT", "someone changed this to-do — reload it");
	const p = data.patch;
	if (p.isPrivate !== undefined && p.isPrivate !== row.isPrivate) {
		// Only the author decides whether their item is private.
		if (row.createdBy !== ctx.user.id)
			return fail("FORBIDDEN", "only its author can change who sees it");
		if (p.isPrivate && ctx.access.isGuest)
			return fail("VALIDATION", "link guests can't keep private items");
	}
	if (p.dueDayId) await assertDay(tx, tripId, p.dueDayId);
	await assertRuleItem(tx, tripId, p.dueRule);
	const set: Partial<typeof listItems.$inferInsert> = { updatedAt: new Date() };
	if (p.text !== undefined) set.text = p.text;
	if (p.note !== undefined) set.note = p.note?.trim() ? p.note : null;
	if (p.url !== undefined) set.url = p.url;
	if (p.dueKind !== undefined) set.dueKind = p.dueKind;
	if (p.quantity !== undefined) set.quantity = p.quantity;
	if (p.priceAmount !== undefined) {
		set.priceAmount = p.priceAmount;
		if (p.priceAmount === null) set.priceCurrency = null;
	}
	if (p.priceCurrency !== undefined && p.priceAmount !== null)
		set.priceCurrency = p.priceCurrency;
	if (p.isPrivate !== undefined) set.isPrivate = p.isPrivate;
	// A relative rule replaces the absolute fields, and an absolute date turns
	// the rule off (EXTENSIONS §7).
	if (p.dueRule) {
		set.dueRule = p.dueRule;
		set.dueDayId = null;
		set.dueDate = null;
		set.dueTime = null;
		set.dueTz = null;
	} else {
		if (p.dueRule === null) set.dueRule = null;
		const touched = ABSOLUTE_DUE.some((k) => p[k] !== undefined);
		if (touched) set.dueRule = null;
		if (p.dueDayId !== undefined) set.dueDayId = p.dueDayId;
		if (p.dueDate !== undefined) set.dueDate = p.dueDate;
		if (p.dueTime !== undefined) set.dueTime = p.dueTime;
		if (p.dueTz !== undefined) set.dueTz = p.dueTz;
		const time = p.dueTime !== undefined ? p.dueTime : row.dueTime;
		const tz = p.dueTz !== undefined ? p.dueTz : row.dueTz;
		if (time && !tz) set.dueTz = await tripTz(tx, tripId);
		if (!time) set.dueTz = null;
		if (p.dueDate === null && p.dueTime === undefined) {
			set.dueTime = null;
			set.dueTz = null;
		}
	}
	const [updated] = await tx
		.update(listItems)
		.set(set)
		.where(sql`${listItems.id} = ${row.id} and ${listItems.tripId} = ${tripId}`)
		.returning();
	if (!updated) return fail("NOT_FOUND");
	const target = bundleTargetOf(updated);
	if (p.assigneeIds !== undefined)
		await writeAssignees(
			tx,
			tripId,
			row.id,
			await assertMembers(tx, tripId, p.assigneeIds),
		);
	if (p.extraTargetNodeIds !== undefined)
		await writeTargets(
			tx,
			tripId,
			row.id,
			await assertNodes(tx, tripId, p.extraTargetNodeIds),
			updated.nodeId,
		);
	if (p.text !== undefined || p.note !== undefined || p.isPrivate !== undefined)
		await mentionsOf(tx, out, updated, target, ctx.user.id);
	// "Make private": its earlier activity lines quote the text (ADDENDUM §7.2).
	if (updated.isPrivate && !row.isPrivate) {
		if (await dropListItemActivity(tx, tripId, row))
			out.emit({ entity: "activity" });
		// …and so do suggestions about it and their activity lines.
		await retractListItemProposals(tx, out, tripId, row.id);
	}
	announce(out, row.id);
	return { updatedAt: updated.updatedAt.toISOString() };
}

/** `list.status`: done/skipped stamp `doneAt`/`doneBy`; logs `list.done`. */
export async function setListItemStatusCore(
	tx: Tx,
	out: TxOutbox,
	data: In<typeof SetListItemStatusInput>,
	ctx: CoreCtx,
): Promise<{ ok: true }> {
	const tripId = ctx.access.tripId;
	const row = await lockListItem(tx, tripId, data.id, ctx.user.id);
	if (row.status === data.status) return { ok: true as const };
	const closing = data.status !== "open";
	await tx
		.update(listItems)
		.set({
			status: data.status,
			doneAt: closing ? new Date() : null,
			doneBy: closing ? ctx.user.id : null,
			updatedAt: new Date(),
		})
		.where(
			sql`${listItems.id} = ${row.id} and ${listItems.tripId} = ${tripId}`,
		);
	if (data.status === "done" && !row.isPrivate)
		await logActivity(tx, out, {
			tripId,
			actor: ctx.actor,
			verb: "list.done",
			summary: `ticked off ${quoteOf(row.text)}`,
			...activityTarget(bundleTargetOf(row)),
			meta: { name: quoteOf(row.text).slice(1, -1), listItemId: row.id },
		});
	announce(out, row.id);
	return { ok: true as const };
}

/** `list.move`: to another target and/or between neighbours. */
export async function moveListItemCore(
	tx: Tx,
	out: TxOutbox,
	data: In<typeof MoveListItemInput>,
	ctx: CoreCtx,
): Promise<{ ok: true }> {
	const tripId = ctx.access.tripId;
	const row = await lockListItem(tx, tripId, data.id, ctx.user.id);
	const target = data.target ?? bundleTargetOf(row);
	if (data.target) await assertBundleTarget(tx, tripId, data.target);
	const position = await positionFor(
		tx,
		{ table: "list_items", tripId, target, list: row.list },
		{ afterId: data.afterId, beforeId: data.beforeId, exclude: [row.id] },
	);
	const cols = bundleTargetColumns(target);
	await tx
		.update(listItems)
		.set({ ...cols, position, updatedAt: new Date() })
		.where(
			sql`${listItems.id} = ${row.id} and ${listItems.tripId} = ${tripId}`,
		);
	if (data.target) {
		// The mention rows' deep link follows the row.
		await tx.execute(sql`
			update mentions set node_id = ${cols.nodeId}, leg_id = ${cols.legId},
			       item_id = ${cols.itemId}, day_id = ${cols.dayId}
			 where list_item_id = ${row.id} and trip_id = ${tripId}`);
		// A candidate shop that became the primary target isn't an extra one any more.
		if (cols.nodeId)
			await tx.execute(sql`
				delete from list_item_targets where list_item_id = ${row.id} and node_id = ${cols.nodeId}`);
	}
	announce(out, row.id);
	return { ok: true as const };
}

/** `list.targets`: extra candidate shops ("Hands Shibuya or Shibuya Loft"). */
export async function setListItemTargetsCore(
	tx: Tx,
	out: TxOutbox,
	data: In<typeof SetListItemTargetsInput>,
	ctx: CoreCtx,
): Promise<{ ok: true }> {
	const tripId = ctx.access.tripId;
	const row = await lockListItem(tx, tripId, data.id, ctx.user.id);
	const nodes = await assertNodes(tx, tripId, data.nodeIds);
	await writeTargets(tx, tripId, row.id, nodes, row.nodeId);
	await tx
		.update(listItems)
		.set({ updatedAt: new Date() })
		.where(sql`${listItems.id} = ${row.id}`);
	announce(out, row.id);
	return { ok: true as const };
}

/** `list.assignees`: members of this trip only (never guests or removed members). */
export async function setListItemAssigneesCore(
	tx: Tx,
	out: TxOutbox,
	data: In<typeof SetListItemAssigneesInput>,
	ctx: CoreCtx,
): Promise<{ ok: true }> {
	const tripId = ctx.access.tripId;
	const row = await lockListItem(tx, tripId, data.id, ctx.user.id);
	await writeAssignees(
		tx,
		tripId,
		row.id,
		await assertMembers(tx, tripId, data.memberIds),
	);
	await tx
		.update(listItems)
		.set({ updatedAt: new Date() })
		.where(sql`${listItems.id} = ${row.id}`);
	announce(out, row.id);
	return { ok: true as const };
}

/** `list.delete`: soft delete (Undo → `restoreListItem`). */
export async function deleteListItemCore(
	tx: Tx,
	out: TxOutbox,
	data: In<typeof DeleteListItemInput>,
	ctx: CoreCtx,
): Promise<{ deletedAt: string }> {
	const tripId = ctx.access.tripId;
	const row = await lockListItem(tx, tripId, data.id, ctx.user.id);
	const res = await tx.execute(sql`
		update list_items set deleted_at = date_trunc('milliseconds', now())
		 where id = ${row.id} and trip_id = ${tripId} and deleted_at is null
		 returning deleted_at as "deletedAt"`);
	const deletedAt = (res.rows[0] as { deletedAt: Date } | undefined)?.deletedAt;
	if (!deletedAt) return fail("NOT_FOUND");
	if (!row.isPrivate)
		await logActivity(tx, out, {
			tripId,
			actor: ctx.actor,
			verb: "list.delete",
			summary: `deleted ${quoteOf(row.text)}`,
			...activityTarget(bundleTargetOf(row)),
			meta: { name: quoteOf(row.text).slice(1, -1), listItemId: row.id },
		});
	announce(out, row.id);
	return { deletedAt: new Date(deletedAt).toISOString() };
}

/** Undo of `list.delete` (edit-only, never a proposal). */
export async function restoreListItemCore(
	tx: Tx,
	out: TxOutbox,
	data: In<typeof RestoreListItemInput>,
	ctx: CoreCtx,
): Promise<{ ok: true }> {
	const tripId = ctx.access.tripId;
	const row = await lockListItem(tx, tripId, data.id, ctx.user.id, {
		deleted: true,
	});
	await tx
		.update(listItems)
		.set({ deletedAt: null, updatedAt: new Date() })
		.where(
			sql`${listItems.id} = ${row.id} and ${listItems.tripId} = ${tripId}`,
		);
	announce(out, row.id);
	return { ok: true as const };
}

export const defs = {
	"list.create": defineProposable({
		input: CreateListItemInput,
		tripIdOf: async (i) => i.tripId,
		entityOf: (i) => ({ kind: "list", id: i.id ?? null }),
		fields: () => [],
		directIf: async (i, access) => privateCreateDirect(i, access),
		core: createListItemCore,
	}),
	"list.update": defineProposable({
		input: UpdateListItemInput,
		tripIdOf: listTrip,
		entityOf: (i) => ({ kind: "list", id: i.id }),
		fields: (i) => Object.keys(i.patch),
		// Direct only while it stays private: `isPrivate: false` publishes it,
		// and a suggestion about the private row can't exist (SEC-R3-01).
		directIf: async (i, access, tx) => {
			if (!(await ownPrivateListItem(i.id, access, tx))) return false;
			if (i.patch.isPrivate === false)
				return fail("FORBIDDEN", SHARE_NEEDS_REVIEW);
			return true;
		},
		core: updateListItemCore,
	}),
	"list.move": defineProposable({
		input: MoveListItemInput,
		tripIdOf: listTrip,
		entityOf: (i) => ({ kind: "list", id: i.id }),
		fields: () => ["target", "position"],
		directIf: (i, access, tx) => ownPrivateListItem(i.id, access, tx),
		core: moveListItemCore,
	}),
	"list.status": defineProposable({
		input: SetListItemStatusInput,
		tripIdOf: listTrip,
		entityOf: (i) => ({ kind: "list", id: i.id }),
		fields: () => ["status"],
		// An assignee ticks their own to-do directly (EXTENSIONS §3.3 note ², QA DUE-07).
		directIf: async (i, access, tx) => {
			if (!access.memberId) return false;
			if (await ownPrivateListItem(i.id, access, tx)) return true;
			const res = await tx.execute(sql`
				select 1 from list_item_assignees
				 where list_item_id = ${i.id} and member_id = ${access.memberId}`);
			return res.rows.length > 0;
		},
		core: setListItemStatusCore,
	}),
	"list.targets": defineProposable({
		input: SetListItemTargetsInput,
		tripIdOf: listTrip,
		entityOf: (i) => ({ kind: "list", id: i.id }),
		fields: () => ["extraTargetNodeIds"],
		directIf: (i, access, tx) => ownPrivateListItem(i.id, access, tx),
		core: setListItemTargetsCore,
	}),
	"list.assignees": defineProposable({
		input: SetListItemAssigneesInput,
		tripIdOf: listTrip,
		entityOf: (i) => ({ kind: "list", id: i.id }),
		fields: () => ["assigneeIds"],
		directIf: (i, access, tx) => ownPrivateListItem(i.id, access, tx),
		core: setListItemAssigneesCore,
	}),
	"list.delete": defineProposable({
		input: DeleteListItemInput,
		tripIdOf: listTrip,
		entityOf: (i) => ({ kind: "list", id: i.id }),
		fields: () => ["deletedAt"],
		directIf: (i, access, tx) => ownPrivateListItem(i.id, access, tx),
		core: deleteListItemCore,
	}),
};
