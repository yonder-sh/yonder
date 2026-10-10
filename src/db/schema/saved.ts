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
 */
import { sql } from "drizzle-orm";
import {
	check,
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
