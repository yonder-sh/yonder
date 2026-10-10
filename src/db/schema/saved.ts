/**
 * Saved (owner, 2026-10-09): the links someone shared into Yonder (the iPhone
 * Shortcut, the share sheet, a paste), kept on their account until they add
 * them to a trip or delete them (`src/features/saved`). No expiry; every
 * device sees them.
 *
 * - The preview (title, caption, author, picture) is fetched after saving by
 *   the `saved.preview` job; pictures are re-hosted under
 *   `saved/<userId>/<id>/` in the bucket and served by `/api/saved/<id>/…`.
 * - Added to a trip: `added_*` say where; it leaves the grid.
 * - `link_key`: the canonical link (`canonicalLink`); one waiting row per
 *   link and account, so a link shared again opens the one already there.
 * - `saved_files`: photos and videos shared into Saved, stored under
 *   `saved/<userId>/<fileId>/` like an attachment's objects (`original`,
 *   `thumb.webp`, `display.webp`, `poster.jpg`). They count against their
 *   owner's storage quota; added to a trip, the attachment re-references
 *   the same objects (`storage_key`), so they count once.
 */
import { sql } from "drizzle-orm";
import {
	bigint,
	check,
	doublePrecision,
	index,
	integer,
	jsonb,
	pgTable,
	text,
	timestamp,
	uniqueIndex,
	uuid,
} from "drizzle-orm/pg-core";
import { createdAt, deletedAt, pk, updatedAt } from "./_columns";
import { user } from "./auth";
import { trips } from "./trips";

/** What a Maps link named (the job's resolve), for the tile and the trip default. */
export type SavedPlace = {
	name: string;
	address?: string;
	lat: number;
	lng: number;
	countryCode?: string;
};

export const savedLinks = pgTable(
	"saved_links",
	{
		id: pk(),
		userId: text()
			.notNull()
			.references(() => user.id, { onDelete: "cascade" }),
		/** The device's own id for it (a share-sheet entry), so an upload retried never saves twice. */
		clientId: text(),
		url: text(),
		/** The canonical link: one waiting row per link (see the file comment). */
		linkKey: text(),
		text: text(),
		/** The title the share sheet sent, if any. */
		title: text(),
		/** `youtube` | `tiktok` | `instagram` (an embed), else null. */
		provider: text(),
		embedId: text(),
		igType: text(),
		/** `pending` until the preview job ran, then `ready` or `failed`. */
		previewStatus: text().notNull().default("pending"),
		previewTitle: text(),
		description: text(),
		author: text(),
		siteName: text(),
		imageKey: text(),
		imageW: integer(),
		imageH: integer(),
		thumbhash: text(),
		faviconKey: text(),
		place: jsonb().$type<SavedPlace>(),
		addedTripId: uuid().references(() => trips.id, { onDelete: "set null" }),
		addedNodeId: uuid(),
		addedAt: timestamp({ withTimezone: true }),
		deletedAt: deletedAt(),
		createdAt: createdAt(),
		updatedAt: updatedAt(),
	},
	(t) => [
		index("saved_links_user_idx").on(t.userId, t.createdAt),
		uniqueIndex("saved_links_client_uq").on(t.userId, t.clientId),
		uniqueIndex("saved_links_waiting_link_uq")
			.on(t.userId, t.linkKey)
			.where(sql`${t.deletedAt} is null and ${t.addedAt} is null`),
		check(
			"saved_links_size_ck",
			sql`char_length(coalesce(${t.url}, '')) <= 2000 and char_length(coalesce(${t.text}, '')) <= 2000 and char_length(coalesce(${t.title}, '')) <= 300`,
		),
		check(
			"saved_links_status_ck",
			sql`${t.previewStatus} in ('pending', 'ready', 'failed')`,
		),
	],
);

export const savedFiles = pgTable(
	"saved_files",
	{
		id: pk(),
		savedId: uuid()
			.notNull()
			.references(() => savedLinks.id, { onDelete: "cascade" }),
		userId: text()
			.notNull()
			.references(() => user.id, { onDelete: "cascade" }),
		/** Its order in the share (0 first). */
		position: integer().notNull(),
		/** `photo` | `video`. */
		kind: text().notNull(),
		mime: text().notNull(),
		sizeBytes: bigint({ mode: "number" }).notNull(),
		/** `saved/<userId>/<id>/`: where its objects are (an attachment added from it points here too). */
		storageKey: text().notNull(),
		/** `pending` (uploading), `processing` (thumbnails), `ready`, `failed`. */
		status: text().notNull().default("pending"),
		width: integer(),
		height: integer(),
		durationSec: doublePrecision(),
		/** Where and when it was taken (its EXIF, read on the device): the feed's trip and area default. */
		lat: doublePrecision(),
		lng: doublePrecision(),
		takenAt: timestamp({ withTimezone: true }),
		thumbhash: text(),
		/** The multipart upload under way (`uploadId`, `partSize`, `parts`); `thumb` once made. */
		meta: jsonb().$type<Record<string, unknown>>().notNull().default({}),
		deletedAt: deletedAt(),
		createdAt: createdAt(),
		updatedAt: updatedAt(),
	},
	(t) => [
		index("saved_files_user_idx").on(t.userId),
		uniqueIndex("saved_files_position_uq").on(t.savedId, t.position),
		check(
			"saved_files_status_ck",
			sql`${t.status} in ('pending', 'processing', 'ready', 'failed')`,
		),
		check("saved_files_kind_ck", sql`${t.kind} in ('photo', 'video')`),
	],
);
