/**
 * The place hierarchy (SPEC §7.1–§7.4, §13.1): inputs and DB-only cores for
 * the proposable node ops (EXTENSIONS §3.3). The server functions in
 * `src/functions/nodes.functions.ts` run them through `proposable.run(op)`.
 *
 * Every core checks the rank rules (a city can't go inside a place); the DB
 * cycle trigger is the backstop. Slugs are unique among live siblings; the
 * server writes `tz` whenever a node gets coordinates (`geo-tz/all`).
 */
import { sql } from "drizzle-orm";
import { v7 as uuidv7 } from "uuid";
import { z } from "zod";
import type { Tx } from "@/db/db.server";
import { nodePriorities, nodes } from "@/db/schema";
import { enqueueOsmHours } from "@/features/insights/server/osm-hours-queue.server";
import { lifecycleSet } from "@/lib/domain/places-lifecycle";
import type { GraphIndex } from "@/lib/engine/graph-index";
import { RANK } from "@/lib/engine/lens";
import {
	canNest,
	categoryForType,
	ROOT_RESERVED_SLUGS,
	slugify,
	uniqueSlug,
} from "@/lib/engine/tree";
import type { GraphNode } from "@/lib/engine/types";
import {
	IdeaStatus,
	NodeStatus,
	NodeType,
	PlaceCategory,
	Priority,
	ShortlistPin,
} from "@/lib/schemas/enums";
import {
	BBox,
	NodeDetails,
	NodeDetailsPatch,
	RatingComment,
} from "@/lib/schemas/nodes";
import { logActivity } from "@/server/activity.server";
import { fail } from "@/server/authz/session.server";
import { enqueueClimateCell } from "@/server/climate-prefetch.server";
import { indexTx, reconcileLegs } from "@/server/legs.server";
import type { TxOutbox } from "@/server/live/outbox.server";
import { syncMentions } from "@/server/mentions.server";
import { positionFor } from "@/server/position.server";
import type { CoreCtx } from "@/server/proposals/types";
import { tzAt } from "@/server/tz.server";
import { assertFreshIds } from "./ids.server";

export const NewNode = z.object({
	parentId: z.uuid().nullable(),
	type: NodeType,
	category: PlaceCategory.optional(),
	name: z.string().trim().min(1).max(200),
	localName: z.string().max(200).optional(),
	description: z.string().max(500).optional(),
	lat: z.number().min(-90).max(90).optional(),
	lng: z.number().min(-180).max(180).optional(),
	address: z.string().max(500).optional(),
	googlePlaceId: z.string().max(300).optional(),
	osmRef: z.string().max(40).optional(),
	countryCode: z
		.string()
		.regex(/^[A-Z]{2}$/)
		.optional(),
	bbox: BBox.optional(),
	timeNeededMin: z.number().int().min(0).max(4320).optional(),
	details: NodeDetails.optional(),
	afterId: z.uuid().optional(),
});
export type NewNode = z.infer<typeof NewNode>;

/** `id?` (EXTENSIONS §2.2): a client- or gate-chosen id; an existing one is CONFLICT. */
export const CreateNodeInput = NewNode.extend({
	tripId: z.uuid(),
	id: z.uuid().optional(),
}).strict();

export const CreateNodePathInput = z
	.object({
		tripId: z.uuid(),
		chain: z
			.array(
				z.union([z.object({ id: z.uuid() }), NewNode.omit({ parentId: true })]),
			)
			.min(1)
			.max(8),
		/** One id per NEW segment, root-most first; unused ids are ignored. */
		ids: z.array(z.uuid()).max(8).optional(),
	})
	.strict();

/** An IANA zone the runtime knows ("Asia/Tokyo", "UTC"). */
export const TimeZoneName = z
	.string()
	.max(64)
	.regex(/^[A-Za-z][A-Za-z0-9_+\-/]*$/)
	.refine((tz) => {
		try {
			new Intl.DateTimeFormat("en-US", { timeZone: tz });
			return true;
		} catch {
			return false;
		}
	}, "unknown time zone");

export const NodePatch = NewNode.omit({
	parentId: true,
	afterId: true,
	type: true,
})
	.extend({
		type: NodeType,
		status: NodeStatus,
		/**
		 * docs/PLACES.md §3: the lifecycle decision and the shortlist pin (pin,
		 * unpin and drop are ordinary proposable node edits). The core keeps
		 * `ideaStatus`, `shortlistPin` and `status` in step.
		 */
		ideaStatus: IdeaStatus,
		shortlistPin: ShortlistPin,
		/** docs/PLACES.md §1: null goes back to the category's default ("not set"). */
		timeNeededMin: z.number().int().min(0).max(4320).nullable(),
		/** Merged into the stored details; a null value deletes that key. */
		details: NodeDetailsPatch,
		/**
		 * QA TZ-08: an editor's override of the zone the server derived from
		 * the coordinates; null goes back to the coordinates' zone. A later
		 * relocation derives it again.
		 */
		tz: TimeZoneName.nullable(),
	})
	.partial();

export const UpdateNodeInput = z
	.object({
		nodeId: z.uuid(),
		patch: NodePatch,
		expectedUpdatedAt: z.string().optional(),
	})
	.strict();

export const MoveNodeInput = z
	.object({
		nodeId: z.uuid(),
		parentId: z.uuid().nullable(),
		afterId: z.uuid().optional(),
		beforeId: z.uuid().optional(),
	})
	.strict();

export const DeleteNodeInput = z.object({ nodeId: z.uuid() }).strict();

export const RestoreNodeInput = z
	.object({ nodeId: z.uuid(), deletedAt: z.string() })
	.strict();

export const SetNodePriorityInput = z
	.object({
		nodeId: z.uuid(),
		memberId: z.uuid(),
		priority: Priority.nullable(),
		/**
		 * ADDENDUM §10: the member's comment on their own rating (≤ 280 as read;
		 * mention tokens count as their "@Name", PLAN-R3-03). Omit to keep it;
		 * null clears it.
		 */
		comment: RatingComment.nullable().optional(),
	})
	.strict();

/** Live sibling slugs under `parentId` (excluding `exceptId`). */
async function takenSlugs(
	tx: Tx,
	tripId: string,
	parentId: string | null,
	exceptId?: string,
): Promise<string[]> {
	const res = await tx.execute(sql`
		select slug from nodes
		 where trip_id = ${tripId} and deleted_at is null
		   and parent_id is not distinct from ${parentId}
		   ${exceptId ? sql`and id <> ${exceptId}` : sql``}`);
	const slugs = (res.rows as { slug: string }[]).map((r) => r.slug);
	return parentId === null ? [...slugs, ...ROOT_RESERVED_SLUGS] : slugs;
}

async function freeSlug(
	tx: Tx,
	tripId: string,
	parentId: string | null,
	name: string,
	id: string,
	exceptId?: string,
): Promise<string> {
	return uniqueSlug(
		slugify(name, id),
		await takenSlugs(tx, tripId, parentId, exceptId),
	);
}

/** A parent must be a live node of this trip whose rank allows `type` below it. */
function assertParent(
	ix: GraphIndex,
	parentId: string | null,
	type: GraphNode["type"],
): void {
	if (parentId === null) return;
	const parent = ix.node(parentId);
	if (!parent) fail("NOT_FOUND", "parent");
	if (!canNest(parent.type, type))
		fail("VALIDATION", `a ${type} can't go inside a ${parent.type}`);
}

/**
 * Inserts one node (the body of `createNode` and each new link of
 * `createNodePath`). Writes `tz` from the coordinates, and makes the trip's
 * default zone the first country's.
 */
async function insertNode(
	tx: Tx,
	ix: GraphIndex,
	tripId: string,
	input: Omit<NewNode, "afterId"> & { afterId?: string; id?: string },
	userId: string,
): Promise<{ id: string; slug: string }> {
	assertParent(ix, input.parentId, input.type);
	const id = input.id ?? uuidv7();
	const tz =
		input.lat !== undefined && input.lng !== undefined
			? await tzAt(input.lat, input.lng)
			: null;
	const slug = await freeSlug(tx, tripId, input.parentId, input.name, id);
	const position = await positionFor(
		tx,
		{ table: "nodes", tripId, parentId: input.parentId },
		{ afterId: input.afterId },
	);
	const [row] = await tx
		.insert(nodes)
		.values({
			id,
			tripId,
			parentId: input.parentId,
			type: input.type,
			category: categoryForType(input.type, input.category ?? null),
			name: input.name,
			localName: input.localName?.trim() || null,
			slug,
			description: input.description?.trim() || null,
			position,
			lat: input.lat ?? null,
			lng: input.lng ?? null,
			tz,
			countryCode: input.countryCode ?? null,
			address: input.address?.trim() || null,
			googlePlaceId: input.googlePlaceId ?? null,
			osmRef: input.osmRef ?? null,
			bbox: input.bbox ?? null,
			timeNeededMin: input.timeNeededMin ?? null,
			details: input.details ?? {},
			createdBy: userId,
		})
		.returning({ id: nodes.id, slug: nodes.slug });
	if (!row) throw new Error("insertNode: insert returned no row");
	// §7.4: the trip's default zone is the first country's.
	if (input.type === "country" && tz && ix.trip.defaultTz === "UTC") {
		const firstCountry = !ix.graph.nodes.some((n) => n.type === "country");
		if (firstCountry)
			await tx.execute(
				sql`update trips set default_tz = ${tz} where id = ${tripId}`,
			);
	}
	return row;
}

type In<S extends z.ZodType> = z.output<S>;

/** `node.create`. Keys: graph. */
export async function createNodeCore(
	tx: Tx,
	out: TxOutbox,
	data: In<typeof CreateNodeInput>,
	ctx: CoreCtx,
): Promise<{ nodeId: string; slug: string }> {
	const { tripId, ...input } = data;
	if (input.id) await assertFreshIds(tx, "nodes", [input.id]);
	const ix = await indexTx(tx, tripId);
	const row = await insertNode(tx, ix, tripId, input, ctx.user.id);
	enqueueClimateCell(out, input);
	enqueueOsmHours(out, input);
	await logActivity(tx, out, {
		tripId,
		actor: ctx.actor,
		verb: "node.create",
		summary: `added ${input.name}`,
		nodeId: row.id,
		meta: { name: input.name, parentId: input.parentId },
	});
	out.emit({ entity: "node", ids: [row.id] });
	return { nodeId: row.id, slug: row.slug };
}

/** `node.createPath`: the missing ancestors, then the leaf, atomically (the places filing chip). Keys: graph. */
export async function createNodePathCore(
	tx: Tx,
	out: TxOutbox,
	data: In<typeof CreateNodePathInput>,
	ctx: CoreCtx,
): Promise<{ nodeIds: string[] }> {
	const freshIds = [...(data.ids ?? [])];
	const newCount = data.chain.filter((l) => !("id" in l)).length;
	if (freshIds.length)
		await assertFreshIds(tx, "nodes", freshIds.slice(0, newCount));
	let ix = await indexTx(tx, data.tripId);
	const ids: string[] = [];
	let parentId: string | null = null;
	for (const [i, link] of data.chain.entries()) {
		if ("id" in link) {
			const node = ix.node(link.id);
			if (!node) return fail("NOT_FOUND", "place");
			// §11.3: an existing link must hang under the previous one.
			if (i > 0 && node.parentId !== parentId)
				return fail("VALIDATION", "the chain is not a path in the tree");
			ids.push(node.id);
			parentId = node.id;
		} else {
			const row = await insertNode(
				tx,
				ix,
				data.tripId,
				{ ...link, parentId, id: freshIds.shift() },
				ctx.user.id,
			);
			enqueueClimateCell(out, link);
			enqueueOsmHours(out, link);
			ids.push(row.id);
			parentId = row.id;
			ix = await indexTx(tx, data.tripId);
		}
	}
	const created = ids.filter((_id, i) => !("id" in (data.chain[i] ?? {})));
	if (created.length) {
		const leaf = ix.node(ids.at(-1));
		await logActivity(tx, out, {
			tripId: data.tripId,
			actor: ctx.actor,
			verb: "node.create",
			summary: `added ${leaf?.name ?? "a place"}`,
			nodeId: ids.at(-1) ?? null,
			meta: { name: leaf?.name, parentId: leaf?.parentId ?? null },
		});
		out.emit({ entity: "node", ids: created });
	}
	return { nodeIds: ids };
}

/** `node.update`: re-slugs on rename; sets tz on relocate. Keys: graph. */
export async function updateNodeCore(
	tx: Tx,
	out: TxOutbox,
	data: In<typeof UpdateNodeInput>,
	ctx: CoreCtx,
): Promise<{ updatedAt: string; slug: string }> {
	const tripId = ctx.access.tripId;
	const ix = await indexTx(tx, tripId);
	const node = ix.node(data.nodeId);
	if (!node) return fail("NOT_FOUND");
	const p = data.patch;
	const set: Partial<typeof nodes.$inferInsert> = {
		updatedAt: new Date(),
	};

	const newType = p.type;
	if (newType !== undefined && newType !== node.type) {
		const parent = node.parentId ? ix.node(node.parentId) : undefined;
		const kids = ix.children(node.id);
		if (parent && RANK[newType] < RANK[parent.type])
			return fail(
				"VALIDATION",
				`a ${newType} can't go inside a ${parent.type}`,
			);
		if (kids.some((k) => RANK[k.type] < RANK[newType]))
			return fail(
				"VALIDATION",
				`a ${newType} can't contain what's inside it now`,
			);
		set.type = newType;
		set.category = categoryForType(newType, p.category ?? node.category);
	} else if (p.category !== undefined) {
		if (node.type !== "place")
			return fail("VALIDATION", "only places have a category");
		set.category = p.category;
	}
	if (p.name !== undefined && p.name !== node.name) {
		set.name = p.name;
		set.slug = await freeSlug(
			tx,
			tripId,
			node.parentId,
			p.name,
			node.id,
			node.id,
		);
	}
	if (p.localName !== undefined) set.localName = p.localName.trim() || null;
	if (p.description !== undefined)
		set.description = p.description.trim() || null;
	if (p.address !== undefined) set.address = p.address.trim() || null;
	if (p.googlePlaceId !== undefined)
		set.googlePlaceId = p.googlePlaceId || null;
	if (p.osmRef !== undefined) set.osmRef = p.osmRef || null;
	// A place newly linked to an OSM object: fetch its opening hours.
	const nextType = p.type ?? node.type;
	const nextRef = set.osmRef !== undefined ? set.osmRef : (node.osmRef ?? null);
	if (nextRef !== (node.osmRef ?? null) || nextType !== node.type)
		enqueueOsmHours(out, { type: nextType, osmRef: nextRef });
	if (p.countryCode !== undefined) set.countryCode = p.countryCode;
	if (p.bbox !== undefined) set.bbox = p.bbox;
	if (p.timeNeededMin !== undefined) set.timeNeededMin = p.timeNeededMin;
	if (p.details !== undefined) {
		const merged: Record<string, unknown> = { ...node.details, ...p.details };
		for (const [k, v] of Object.entries(merged))
			if (v === null) delete merged[k];
		// The merged object must still fit the per-node cap (SECURITY §3).
		const checked = NodeDetails.safeParse(merged);
		if (!checked.success)
			return fail("VALIDATION", "these details are too large");
		set.details = checked.data;
	}
	if (p.status !== undefined) set.status = p.status;
	Object.assign(set, lifecycleSet(node, p));
	if ((p.lat === undefined) !== (p.lng === undefined))
		return fail("VALIDATION", "send lat and lng together");
	if (p.lat !== undefined && p.lng !== undefined) {
		set.lat = p.lat;
		set.lng = p.lng;
		set.tz = await tzAt(p.lat, p.lng);
		enqueueClimateCell(out, {
			type: p.type ?? node.type,
			lat: p.lat,
			lng: p.lng,
		});
	}
	if (p.tz !== undefined) {
		const lat = p.lat ?? node.lat;
		const lng = p.lng ?? node.lng;
		set.tz =
			p.tz ?? (lat !== null && lng !== null ? await tzAt(lat, lng) : null);
	}
	const [row] = await tx
		.update(nodes)
		.set(set)
		.where(sql`${nodes.id} = ${node.id} and ${nodes.tripId} = ${tripId}`)
		.returning({ updatedAt: nodes.updatedAt, slug: nodes.slug });
	if (!row) return fail("NOT_FOUND");
	const nextStatus = set.status ?? node.status;
	if (nextStatus !== node.status) {
		await logActivity(tx, out, {
			tripId,
			actor: ctx.actor,
			verb: "node.update",
			summary: `${nextStatus === "dropped" ? "dropped" : "restored"} ${node.name}`,
			nodeId: node.id,
			meta: { name: node.name },
		});
	} else if (
		set.shortlistPin !== undefined &&
		set.shortlistPin !== (node.shortlistPin ?? "auto")
	) {
		await logActivity(tx, out, {
			tripId,
			actor: ctx.actor,
			verb: "node.update",
			summary:
				set.shortlistPin === "pinned"
					? `pinned ${node.name} to the shortlist`
					: set.shortlistPin === "unpinned"
						? `took ${node.name} off the shortlist`
						: `let the ratings decide on ${node.name}`,
			nodeId: node.id,
			meta: { name: node.name },
		});
	}
	out.emit({ entity: "node", ids: [node.id] });
	return { updatedAt: row.updatedAt.toISOString(), slug: row.slug };
}

/** `node.move`: re-parent and/or reorder. Keys: graph. */
export async function moveNodeCore(
	tx: Tx,
	out: TxOutbox,
	data: In<typeof MoveNodeInput>,
	ctx: CoreCtx,
): Promise<{ slug: string }> {
	const tripId = ctx.access.tripId;
	const ix = await indexTx(tx, tripId);
	const node = ix.node(data.nodeId);
	if (!node) return fail("NOT_FOUND");
	if (data.parentId !== null) {
		if (
			data.parentId === node.id ||
			ix.hierarchy.isInSubtree(data.parentId, node.id)
		)
			return fail("VALIDATION", "a place can't go inside itself");
		assertParent(ix, data.parentId, node.type);
	}
	const slug =
		data.parentId === node.parentId
			? node.slug
			: uniqueSlug(
					slugify(node.name, node.id),
					await takenSlugs(tx, tripId, data.parentId, node.id),
				);
	const position = await positionFor(
		tx,
		{ table: "nodes", tripId, parentId: data.parentId },
		{
			afterId: data.afterId,
			beforeId: data.beforeId,
			exclude: [node.id],
		},
	);
	try {
		await tx.execute(sql`
			update nodes set parent_id = ${data.parentId}, slug = ${slug}, position = ${position}, updated_at = now()
			 where id = ${node.id} and trip_id = ${tripId}`);
	} catch (e) {
		// The cycle trigger (23514 'cycle') is the backstop for the check above.
		const code =
			(e as { cause?: { code?: string }; code?: string }).cause?.code ??
			(e as { code?: string }).code;
		if (code === "23514")
			return fail("VALIDATION", "a place can't go inside itself");
		throw e;
	}
	if (data.parentId !== node.parentId) {
		const to = data.parentId ? ix.node(data.parentId)?.name : "the top level";
		await logActivity(tx, out, {
			tripId,
			actor: ctx.actor,
			verb: "node.move",
			summary: `moved ${node.name} to ${to ?? "another place"}`,
			nodeId: node.id,
			meta: { name: node.name, parentId: data.parentId },
		});
	}
	out.emit({ entity: "node", ids: [node.id] });
	return { slug };
}

/** `node.delete`: soft-deletes the subtree and its items (undo with restoreNode). Keys: graph, counts. */
export async function deleteNodeCore(
	tx: Tx,
	out: TxOutbox,
	data: In<typeof DeleteNodeInput>,
	ctx: CoreCtx,
): Promise<{ deletedAt: string; detachedLegIds: string[] }> {
	const tripId = ctx.access.tripId;
	const ix = await indexTx(tx, tripId);
	const node = ix.node(data.nodeId);
	if (!node) return fail("NOT_FOUND");
	const subtree = ix.outline
		.filter((n) => ix.isWithin(n.id, node.id))
		.map((n) => n.id);
	// Items on those nodes, plus the rest of any flight block they belong to (§7.9 rule 4).
	const itemIds = new Set<string>();
	for (const it of ix.graph.items) {
		if (it.nodeId && subtree.includes(it.nodeId)) {
			for (const id of ix.blockOf(it.id) ?? [it.id]) itemIds.add(id);
		}
	}
	// One timestamp for everything (ms precision, so restoreNode can match it).
	const res = await tx.execute(
		sql`select date_trunc('milliseconds', now()) as at`,
	);
	const at = (res.rows[0] as { at: Date }).at;
	await tx.execute(sql`
		update nodes set deleted_at = ${at}
		 where trip_id = ${tripId} and deleted_at is null and id = any(${sql.param(subtree)}::uuid[])`);
	if (itemIds.size)
		await tx.execute(sql`
			update items set deleted_at = ${at}
			 where trip_id = ${tripId} and deleted_at is null and id = any(${sql.param([...itemIds])}::uuid[])`);
	const { detachedLegIds } = await reconcileLegs(tx, out, tripId, ix, {
		changed: [...itemIds],
	});
	await logActivity(tx, out, {
		tripId,
		actor: ctx.actor,
		verb: "node.delete",
		summary: `deleted ${node.name}${subtree.length > 1 ? ` and ${subtree.length - 1} places inside` : ""}`,
		nodeId: node.id,
		meta: { name: node.name, count: subtree.length },
	});
	out.emit({ entity: "node", ids: [node.id], keys: ["counts"] });
	return { deletedAt: new Date(at).toISOString(), detachedLegIds };
}

/** restoreNode (edit-only, not proposable). Keys: graph, counts. */
export async function restoreNodeCore(
	tx: Tx,
	out: TxOutbox,
	data: In<typeof RestoreNodeInput>,
	ctx: CoreCtx,
): Promise<{ slug: string }> {
	const tripId = ctx.access.tripId;
	const ix = await indexTx(tx, tripId);
	const at = new Date(data.deletedAt);
	const res = await tx.execute(sql`
		with recursive sub(id) as (
		  select id from nodes where id = ${data.nodeId} and trip_id = ${tripId} and deleted_at = ${at}
		  union
		  select n.id from nodes n join sub on n.parent_id = sub.id where n.deleted_at = ${at}
		)
		select n.id::text as id, n.parent_id::text as "parentId", n.name, n.slug,
		       (p.id is not null and p.deleted_at is not null) as "parentGone"
		  from nodes n join sub on sub.id = n.id left join nodes p on p.id = n.parent_id`);
	const rows = res.rows as {
		id: string;
		parentId: string | null;
		name: string;
		slug: string;
		parentGone: boolean;
	}[];
	const root = rows.find((r) => r.id === data.nodeId);
	if (!root) return fail("NOT_FOUND");
	if (root.parentGone)
		return fail("CONFLICT", "its parent was deleted — restore that first");
	// The root may clash with a sibling created since; re-slug with a suffix (§7.1).
	const taken = await takenSlugs(tx, tripId, root.parentId, root.id);
	const slug = taken.includes(root.slug)
		? uniqueSlug(root.slug, taken)
		: root.slug;
	const ids = rows.map((r) => r.id);
	await tx.execute(sql`
		update nodes set deleted_at = null, updated_at = now()
		 where trip_id = ${tripId} and id = any(${sql.param(ids)}::uuid[])`);
	if (slug !== root.slug)
		await tx.execute(
			sql`update nodes set slug = ${slug} where id = ${root.id}`,
		);
	const items = await tx.execute(sql`
		update items set deleted_at = null, updated_at = now()
		 where trip_id = ${tripId} and deleted_at = ${at}
		 returning id::text as id`);
	await reconcileLegs(tx, out, tripId, ix, {
		changed: (items.rows as { id: string }[]).map((r) => r.id),
	});
	await logActivity(tx, out, {
		tripId,
		actor: ctx.actor,
		verb: "node.restore",
		summary: `restored ${root.name}`,
		nodeId: root.id,
		meta: { name: root.name },
	});
	out.emit({ entity: "node", ids: [root.id], keys: ["counts"] });
	return { slug };
}

/** `node.priority`: a member's priority for a node (null clears it). Keys: graph. */
export async function setNodePriorityCore(
	tx: Tx,
	out: TxOutbox,
	data: In<typeof SetNodePriorityInput>,
	ctx: CoreCtx,
): Promise<{ ok: true }> {
	const tripId = ctx.access.tripId;
	// The member must be a live (not removed) member of THIS trip, and the node live here.
	const check = await tx.execute(sql`
		select (select count(*) from trip_members
		         where id = ${data.memberId} and trip_id = ${tripId} and status::text <> 'removed')::int as m,
		       (select status::text from trip_members
		         where id = ${data.memberId} and trip_id = ${tripId}) as "memberStatus",
		       (select user_id from trip_members
		         where id = ${data.memberId} and trip_id = ${tripId}) as "memberUserId",
		       (select count(*) from nodes
		         where id = ${data.nodeId} and trip_id = ${tripId} and deleted_at is null)::int as n,
		       (select priority::text from node_priorities
		         where node_id = ${data.nodeId} and member_id = ${data.memberId}) as prev`);
	const c = check.rows[0] as
		| {
				m: number;
				n: number;
				memberStatus: string | null;
				memberUserId: string | null;
				prev: string | null;
		  }
		| undefined;
	if (!c?.n) return fail("NOT_FOUND");
	if (!c.m) return fail("NOT_FOUND", "member");
	// ADDENDUM §10: a rating comment is editable only by its author. People
	// without an account (placeholders, invites) can't author one, so editors
	// write theirs (the imported Audrey). The actor is the proposal's author
	// when a suggestion is accepted.
	if (
		data.comment !== undefined &&
		c.memberStatus !== "placeholder" &&
		c.memberStatus !== "invited" &&
		(!c.memberUserId || c.memberUserId !== ctx.actor.userId)
	)
		return fail("FORBIDDEN", "Only its author can change a rating comment.");
	if (data.priority === null) {
		await tx
			.delete(nodePriorities)
			.where(
				sql`${nodePriorities.nodeId} = ${data.nodeId} and ${nodePriorities.memberId} = ${data.memberId}`,
			);
	} else {
		const comment =
			data.comment === undefined ? undefined : data.comment?.trim() || null;
		await tx
			.insert(nodePriorities)
			.values({
				tripId,
				nodeId: data.nodeId,
				memberId: data.memberId,
				priority: data.priority,
				ratingComment: comment ?? null,
			})
			.onConflictDoUpdate({
				target: [nodePriorities.nodeId, nodePriorities.memberId],
				set: {
					priority: data.priority,
					...(comment !== undefined ? { ratingComment: comment } : {}),
					updatedAt: new Date(),
				},
			});
	}
	// docs/PLACES.md §3: an unpinned place stays off the shortlist "until the
	// ratings change" — this is that change (a comment alone is not).
	if ((c.prev ?? null) !== data.priority)
		await tx.execute(sql`
			update nodes set shortlist_pin = 'auto'
			 where id = ${data.nodeId} and trip_id = ${tripId} and shortlist_pin = 'unpinned'`);
	// ADDENDUM §10: mentions in a rating comment reach the mentioned member's
	// inbox like any other text's (cleared with the comment or the rating).
	if (data.priority === null || data.comment !== undefined)
		await syncMentions(
			tx,
			out,
			tripId,
			{ ratingComment: { nodeId: data.nodeId, raterMemberId: data.memberId } },
			data.priority === null ? [] : [data.comment?.trim() || null],
			{ createdBy: ctx.actor.userId ?? null, target: { nodeId: data.nodeId } },
		);
	out.emit({ entity: "node", ids: [data.nodeId] });
	return { ok: true as const };
}
