/**
 * Bundles: media and links, todo and shopping lists, Yjs notes, and mentions
 * (SPEC §6.3 bundle.ts, §7.10, §10.2).
 *
 * A bundle row hangs on exactly one target: the trip root (all target columns
 * null), a node, a leg, an item or a day. `targetCols`/`targetFks` are identical
 * on attachments, list_items and yjs_documents.
 */
import { sql } from "drizzle-orm";
import {
	type AnyPgColumn,
	bigint,
	boolean,
	check,
	date,
	foreignKey,
	index,
	integer,
	jsonb,
	numeric,
	pgTable,
	primaryKey,
	real,
	text,
	timestamp,
	unique,
	uniqueIndex,
	uuid,
} from "drizzle-orm/pg-core";
import type { AttachmentMeta } from "../../lib/schemas/attachments";
import type { DueRule } from "../../lib/schemas/lists";
import {
	bytea,
	createdAt,
	deletedAt,
	HHMM_PATTERN,
	HTTP_URL_PATTERN,
	pk,
	sortKey,
	updatedAt,
} from "./_columns";
import { user } from "./auth";
import {
	attachmentKind,
	attachmentStatus,
	attachmentVisibility,
	dueKind,
	listItemStatus,
	listKind,
} from "./enums";
import { nodes } from "./nodes";
import { items, legs, tripDays } from "./timeline";
import { tripMembers, tripRef } from "./trips";

/** The four nullable target columns (all null = the trip root). */
const targetCols = () => ({
	nodeId: uuid(),
	legId: uuid(),
	itemId: uuid(),
	dayId: uuid(),
});

type TargetColumns = {
	tripId: AnyPgColumn;
	nodeId: AnyPgColumn;
	legId: AnyPgColumn;
	itemId: AnyPgColumn;
	dayId: AnyPgColumn;
};

/**
 * Composite (trip-isolating) FKs, lookup indexes and the at-most-one-target
 * CHECK. `extraTargets` joins the CHECK (attachments: `expense_id`, whose FK
 * is hand-written in 0003_money_fks.sql).
 */
const targetFks = (
	t: TargetColumns,
	name: string,
	extraTargets: AnyPgColumn[] = [],
) => [
	foreignKey({
		name: `${name}_node_fk`,
		columns: [t.tripId, t.nodeId],
		foreignColumns: [nodes.tripId, nodes.id],
	}).onDelete("cascade"),
	foreignKey({
		name: `${name}_leg_fk`,
		columns: [t.tripId, t.legId],
		foreignColumns: [legs.tripId, legs.id],
	}).onDelete("cascade"),
	foreignKey({
		name: `${name}_item_fk`,
		columns: [t.tripId, t.itemId],
		foreignColumns: [items.tripId, items.id],
	}).onDelete("cascade"),
	foreignKey({
		name: `${name}_day_fk`,
		columns: [t.tripId, t.dayId],
		foreignColumns: [tripDays.tripId, tripDays.id],
	}).onDelete("cascade"),
	index(`${name}_node_idx`).on(t.nodeId),
	index(`${name}_leg_idx`).on(t.legId),
	index(`${name}_item_idx`).on(t.itemId),
	index(`${name}_day_idx`).on(t.dayId),
	check(
		`${name}_target_ck`,
		extraTargets.length
			? sql`num_nonnulls(${t.nodeId}, ${t.legId}, ${t.itemId}, ${t.dayId}, ${sql.join(extraTargets, sql`, `)}) <= 1`
			: sql`num_nonnulls(${t.nodeId}, ${t.legId}, ${t.itemId}, ${t.dayId}) <= 1`,
	),
];

export const attachments = pgTable(
	"attachments",
	{
		id: pk(),
		tripId: tripRef(),
		...targetCols(),
		/**
		 * E5 receipts: a photo attached to an expense (ADDENDUM §6). Its composite
		 * FK (ON DELETE CASCADE) is in 0003_money_fks.sql. `BundleTarget` kind `expense`.
		 */
		expenseId: uuid(),
		/**
		 * ADDENDUM §7.3/§9: the receipt of ONE payment of that expense (a deposit,
		 * the final bill). A qualifier, not a target: `expense_id` stays set. FK
		 * `(trip_id, expense_id, payment_id)` → expense_payments with column-list
		 * SET NULL (payment_id) in 0006, so a replaced payment's receipt stays on
		 * the expense.
		 */
		paymentId: uuid(),
		kind: attachmentKind().notNull(),
		status: attachmentStatus().notNull().default("ready"),
		/**
		 * ADDENDUM §9: `members` hides it from link guests ("Hide from guests").
		 * PDFs on flights, stays, reserved transit and expenses default to it.
		 */
		visibility: attachmentVisibility().notNull().default("everyone"),
		/** `trips/<tripId>/<id>/` → original, thumb.webp, display.webp, poster.jpg, image.webp, favicon.webp (§15.1). */
		storageKey: text(),
		mime: text(),
		sizeBytes: bigint({ mode: "number" }),
		width: integer(),
		height: integer(),
		durationSec: real(),
		thumbhash: text(),
		takenAt: timestamp({ withTimezone: true }),
		/** http(s) only. */
		url: text(),
		/** `youtube` | `tiktok` | `instagram` | `web` … */
		provider: text(),
		embedId: text(),
		title: text(),
		description: text(),
		siteName: text(),
		author: text(),
		/** Provenance only; NEVER rendered (the page loads `/media/<id>/favicon`). */
		faviconUrl: text(),
		/** Re-hosted favicon.webp. */
		faviconKey: text(),
		/** Re-hosted preview (image.webp). */
		imageKey: text(),
		meta: jsonb().$type<AttachmentMeta>().notNull().default({}),
		/** Markdown (inline); no mentions. */
		caption: text(),
		position: sortKey().notNull(),
		createdBy: text().references(() => user.id, { onDelete: "set null" }),
		createdAt: createdAt(),
		updatedAt: updatedAt(),
		deletedAt: deletedAt(),
	},
	(t) => [
		unique("attachments_trip_id_id_uq").on(t.tripId, t.id),
		...targetFks(t, "attachments", [t.expenseId]),
		index("attachments_expense_idx").on(t.expenseId),
		index("attachments_payment_idx").on(t.paymentId),
		check(
			"attachments_payment_ck",
			sql`${t.paymentId} is null or ${t.expenseId} is not null`,
		),
		index("attachments_trip_live_idx")
			.on(t.tripId)
			.where(sql`${t.deletedAt} is null`),
		// ADDENDUM §12: storage used per uploader (the quota check at every upload).
		index("attachments_created_by_live_idx")
			.on(t.createdBy)
			.where(sql`${t.deletedAt} is null`),
		check(
			"attachments_url_ck",
			sql`${t.url} is null or ${t.url} ~* ${HTTP_URL_PATTERN}`,
		),
		check(
			"attachments_size_ck",
			sql`(${t.sizeBytes} is null or ${t.sizeBytes} >= 0)
			and (${t.width} is null or ${t.width} > 0)
			and (${t.height} is null or ${t.height} > 0)
			and (${t.durationSec} is null or ${t.durationSec} >= 0)`,
		),
	],
);

/** Todo and shopping items (the `list` column says which). */
export const listItems = pgTable(
	"list_items",
	{
		id: pk(),
		tripId: tripRef(),
		/** Primary target. Extra candidate shops go in `list_item_targets`. */
		...targetCols(),
		list: listKind().notNull(),
		/** One line of inline Markdown; may contain mention tokens `[@Label](mention:<memberId>)`. */
		text: text().notNull(),
		/** Markdown with mention tokens. */
		note: text(),
		/** http(s) only. */
		url: text(),
		status: listItemStatus().notNull().default("open"),
		/** E4: `due` deadline, `opens` booking window, `on` do it that day. */
		dueKind: dueKind().notNull().default("due"),
		/**
		 * ADDENDUM §10 "booking windows that move": a date RELATIVE to an item's
		 * day (`DueRule`); the due date recomputes when the item or trip moves.
		 * Null = the absolute `due_date`/`due_time`/`due_day_id` fields apply.
		 */
		dueRule: jsonb().$type<DueRule>(),
		/**
		 * ADDENDUM §7.2: visible only to `created_by` (gifts). Every F read filters
		 * `not is_private or created_by = me`; never in counts, rollups, activity,
		 * digest, mentions, search or proposals of anyone else.
		 */
		isPrivate: boolean().notNull().default(false),
		/** When status left 'open' (done or skipped). */
		doneAt: timestamp({ withTimezone: true }),
		doneBy: text().references(() => user.id, { onDelete: "set null" }),
		/** "by Day 4". FK in the custom migration (SET NULL). */
		dueDayId: uuid(),
		/** "opens Wed 30 Sep 2026 · 20:00 ET": date + local time + zone. */
		dueDate: date({ mode: "string" }),
		dueTime: text(),
		dueTz: text(),
		quantity: integer(),
		priceAmount: numeric({ precision: 14, scale: 2, mode: "number" }),
		priceCurrency: text(),
		priceText: text(),
		position: sortKey().notNull(),
		createdBy: text().references(() => user.id, { onDelete: "set null" }),
		createdAt: createdAt(),
		updatedAt: updatedAt(),
		deletedAt: deletedAt(),
	},
	(t) => [
		unique("list_items_trip_id_id_uq").on(t.tripId, t.id),
		...targetFks(t, "list_items"),
		index("list_items_trip_live_idx")
			.on(t.tripId, t.list)
			.where(sql`${t.deletedAt} is null`),
		index("list_items_due_idx")
			.on(t.tripId, t.dueDate)
			.where(sql`${t.status} = 'open' and ${t.dueDate} is not null`),
		index("list_items_due_day_idx").on(t.dueDayId),
		check(
			"list_items_due_time_ck",
			sql`${t.dueTime} is null or ${t.dueTime} ~ ${HHMM_PATTERN}`,
		),
		check(
			"list_items_due_tz_ck",
			sql`(${t.dueTime} is null) or (${t.dueTz} is not null)`,
		),
		check(
			"list_items_url_ck",
			sql`${t.url} is null or ${t.url} ~* ${HTTP_URL_PATTERN}`,
		),
		check(
			"list_items_quantity_ck",
			sql`${t.quantity} is null or ${t.quantity} > 0`,
		),
		check(
			"list_items_currency_ck",
			sql`${t.priceCurrency} is null or char_length(${t.priceCurrency}) = 3`,
		),
	],
);

/** Extra candidate shops for a list item ("Hands Shibuya or Shibuya Loft"). */
export const listItemTargets = pgTable(
	"list_item_targets",
	{
		tripId: uuid().notNull(),
		listItemId: uuid().notNull(),
		nodeId: uuid().notNull(),
	},
	(t) => [
		primaryKey({ columns: [t.listItemId, t.nodeId] }),
		foreignKey({
			name: "list_item_targets_item_fk",
			columns: [t.tripId, t.listItemId],
			foreignColumns: [listItems.tripId, listItems.id],
		}).onDelete("cascade"),
		foreignKey({
			name: "list_item_targets_node_fk",
			columns: [t.tripId, t.nodeId],
			foreignColumns: [nodes.tripId, nodes.id],
		}).onDelete("cascade"),
		index("list_item_targets_node_idx").on(t.nodeId),
		index("list_item_targets_trip_idx").on(t.tripId),
	],
);

export const listItemAssignees = pgTable(
	"list_item_assignees",
	{
		tripId: uuid().notNull(),
		listItemId: uuid().notNull(),
		memberId: uuid().notNull(),
	},
	(t) => [
		primaryKey({ columns: [t.listItemId, t.memberId] }),
		foreignKey({
			name: "list_item_assignees_item_fk",
			columns: [t.tripId, t.listItemId],
			foreignColumns: [listItems.tripId, listItems.id],
		}).onDelete("cascade"),
		foreignKey({
			name: "list_item_assignees_member_fk",
			columns: [t.tripId, t.memberId],
			foreignColumns: [tripMembers.tripId, tripMembers.id],
		}).onDelete("cascade"),
		index("list_item_assignees_member_idx").on(t.memberId),
		index("list_item_assignees_trip_idx").on(t.tripId),
	],
);

/**
 * Persisted Yjs note documents (Hocuspocus, §10.2, §10.6). `name` is the
 * document name and must agree with the target columns (CHECK below):
 * `trip/<tripId>/root` | `trip/<tripId>/{node|leg|item|day}/<id>`, plus
 * `/u/<userId>` for a member's PRIVATE note on that target (ADDENDUM §7.2;
 * `owner_user_id`, readable and writable by that user only, never in anyone
 * else's counts, search, digest, activity or mentions).
 * The channel document `trip/<tripId>` is never persisted.
 */
export const yjsDocuments = pgTable(
	"yjs_documents",
	{
		name: text().primaryKey(),
		tripId: tripRef(),
		...targetCols(),
		/** `Y.encodeStateAsUpdate(doc)`. */
		state: bytea().notNull(),
		/** ProseMirror JSON (derived) → static render. */
		json: jsonb(),
		/** Derived, for export, search and previews. */
		markdown: text(),
		plainText: text(),
		updatedBy: text().references(() => user.id, { onDelete: "set null" }),
		updatedAt: updatedAt(),
		/** Null = the shared note; else a private note of this user (ADDENDUM §7.2). */
		ownerUserId: text().references(() => user.id, { onDelete: "cascade" }),
	},
	(t) => [
		...targetFks(t, "yjs_documents"),
		index("yjs_documents_trip_idx").on(t.tripId),
		index("yjs_documents_owner_idx")
			.on(t.ownerUserId)
			.where(sql`${t.ownerUserId} is not null`),
		check(
			"yjs_documents_name_ck",
			sql`${t.name} = 'trip/' || ${t.tripId}::text || case
				when ${t.nodeId} is not null then '/node/' || ${t.nodeId}::text
				when ${t.legId} is not null then '/leg/' || ${t.legId}::text
				when ${t.itemId} is not null then '/item/' || ${t.itemId}::text
				when ${t.dayId} is not null then '/day/' || ${t.dayId}::text
				else '/root' end || case
				when ${t.ownerUserId} is not null then '/u/' || ${t.ownerUserId}
				else '' end`,
		),
	],
);

/**
 * Who was @mentioned where. Source: exactly one of a Yjs note (`doc_name`), a
 * list item's text/note, or an item's note. The target columns are a
 * denormalised deep link (no FK: they may outlive their target).
 */
export const mentions = pgTable(
	"mentions",
	{
		id: pk(),
		tripId: tripRef(),
		/** Who is mentioned (`trip_members.id`). */
		memberId: uuid().notNull(),
		docName: text().references(() => yjsDocuments.name, {
			onDelete: "cascade",
		}),
		listItemId: uuid(),
		noteItemId: uuid(),
		/**
		 * ADDENDUM §10 rating comments: the member whose rating comment on
		 * `nodeId` holds the mention (the source is that rating).
		 */
		raterMemberId: uuid(),
		nodeId: uuid(),
		legId: uuid(),
		itemId: uuid(),
		dayId: uuid(),
		excerpt: text(),
		createdBy: text().references(() => user.id, { onDelete: "set null" }),
		createdAt: createdAt(),
		readAt: timestamp({ withTimezone: true }),
	},
	(t) => [
		foreignKey({
			name: "mentions_member_fk",
			columns: [t.tripId, t.memberId],
			foreignColumns: [tripMembers.tripId, tripMembers.id],
		}).onDelete("cascade"),
		foreignKey({
			name: "mentions_list_item_fk",
			columns: [t.tripId, t.listItemId],
			foreignColumns: [listItems.tripId, listItems.id],
		}).onDelete("cascade"),
		foreignKey({
			name: "mentions_note_item_fk",
			columns: [t.tripId, t.noteItemId],
			foreignColumns: [items.tripId, items.id],
		}).onDelete("cascade"),
		uniqueIndex("mentions_doc_member_uq")
			.on(t.docName, t.memberId)
			.where(sql`${t.docName} is not null`),
		uniqueIndex("mentions_list_member_uq")
			.on(t.listItemId, t.memberId)
			.where(sql`${t.listItemId} is not null`),
		uniqueIndex("mentions_note_member_uq")
			.on(t.noteItemId, t.memberId)
			.where(sql`${t.noteItemId} is not null`),
		uniqueIndex("mentions_rating_member_uq")
			.on(t.nodeId, t.raterMemberId, t.memberId)
			.where(sql`${t.raterMemberId} is not null`),
		foreignKey({
			name: "mentions_rater_fk",
			columns: [t.tripId, t.raterMemberId],
			foreignColumns: [tripMembers.tripId, tripMembers.id],
		}).onDelete("cascade"),
		index("mentions_member_unread_idx")
			.on(t.memberId)
			.where(sql`${t.readAt} is null`),
		index("mentions_trip_idx").on(t.tripId, t.createdAt),
		check(
			"mentions_source_ck",
			sql`num_nonnulls(${t.docName}, ${t.listItemId}, ${t.noteItemId}, ${t.raterMemberId}) = 1`,
		),
		// A Yjs source must belong to the same trip (its name embeds the trip id).
		check(
			"mentions_doc_trip_ck",
			sql`${t.docName} is null or ${t.docName} like 'trip/' || ${t.tripId}::text || '/%'`,
		),
	],
);
