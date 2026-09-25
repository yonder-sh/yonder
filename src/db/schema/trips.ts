/**
 * Trips, members, share links and guest grants (SPEC §6.3 trips.ts).
 *
 * Trip isolation: every parent table has `unique(<t>_trip_id_id_uq)` on
 * `(trip_id, id)`, and child rows reference `(trip_id, x_id)` so a row can never
 * point into another trip (§6.1).
 */
import { sql } from "drizzle-orm";
import {
	bigint,
	boolean,
	check,
	date,
	foreignKey,
	index,
	integer,
	jsonb,
	pgTable,
	primaryKey,
	smallint,
	text,
	timestamp,
	unique,
	uniqueIndex,
	uuid,
} from "drizzle-orm/pg-core";
import type { TripSettings } from "../../lib/schemas/trips";
import { createdAt, deletedAt, pk, updatedAt } from "./_columns";
import { user } from "./auth";
import { memberStatus, shareRole, tripRole } from "./enums";

export const trips = pgTable(
	"trips",
	{
		id: pk(),
		/** URL slug (`/t/<slug>`); unique among live trips. */
		slug: text().notNull(),
		name: text().notNull(),
		/** = min/max(trip_days.date), maintained by the day functions. */
		startDate: date({ mode: "string" }),
		endDate: date({ mode: "string" }),
		/** IANA zone of the first country added, else UTC (§7.4). */
		defaultTz: text().notNull().default("UTC"),
		/** No FK (it would be a cycle); validated in the app. */
		coverAttachmentId: uuid(),
		settings: jsonb().$type<TripSettings>().notNull().default({}),
		/**
		 * +1 in every mutation transaction (`withTripTx`, D10, §10.5). Clients keep
		 * the last version they saw and refetch when an event skips one.
		 */
		version: bigint({ mode: "number" }).notNull().default(0),
		createdBy: text().references(() => user.id, { onDelete: "set null" }),
		createdAt: createdAt(),
		updatedAt: updatedAt(),
		deletedAt: deletedAt(),
	},
	(t) => [
		// A deleted trip frees its slug.
		uniqueIndex("trips_slug_uq").on(t.slug).where(sql`${t.deletedAt} is null`),
		check("trips_slug_ck", sql`${t.slug} ~ '^[a-z0-9-]{1,100}$'`),
		check(
			"trips_dates_ck",
			sql`${t.startDate} is null or ${t.endDate} is null or ${t.startDate} <= ${t.endDate}`,
		),
		check("trips_version_ck", sql`${t.version} >= 0`),
	],
);

/** `trip_id` column for every app table: cascades from the trip. */
export const tripRef = () =>
	uuid()
		.notNull()
		.references(() => trips.id, { onDelete: "cascade" });

/**
 * A named person on a trip (D13): an active user, an invited email or a
 * placeholder name. Everything person-related points here, never to user ids.
 */
export const tripMembers = pgTable(
	"trip_members",
	{
		id: pk(),
		tripId: tripRef(),
		userId: text().references(() => user.id, { onDelete: "cascade" }),
		status: memberStatus().notNull(),
		role: tripRole().notNull(),
		/** Lower-cased; set for 'invited'. */
		email: text(),
		/** Label for 'placeholder' and 'invited'. */
		displayName: text(),
		/** 0..7 → `--presence-(n+1)`; the least-used index in the trip (§7.5). */
		color: smallint().notNull(),
		invitedBy: text().references(() => user.id, { onDelete: "set null" }),
		joinedAt: timestamp({ withTimezone: true }),
		/** ADDENDUM §7.1: this member's budget lines show as "private" to others. */
		budgetPrivate: boolean().notNull().default(false),
		/**
		 * ADDENDUM §10 merge: a placeholder merged into an existing member keeps
		 * its row as `removed` with this pointer, so old ids (mention tokens in
		 * Yjs notes, activity) resolve to the member it became (`mergeMember`).
		 */
		mergedIntoId: uuid(),
		createdAt: createdAt(),
		updatedAt: updatedAt(),
	},
	(t) => [
		check(
			"trip_members_merged_ck",
			sql`${t.mergedIntoId} is null or ${t.mergedIntoId} <> ${t.id}`,
		),
		// ON DELETE SET NULL ("merged_into_id") since 0010 (hand-written: Drizzle
		// can't express a column-list SET NULL, and its snapshot doesn't track
		// it): the merged row stays a plain former member. As NO ACTION it failed
		// whole-trip deletes whenever the merge target's row went first.
		foreignKey({
			name: "trip_members_merged_into_fk",
			columns: [t.tripId, t.mergedIntoId],
			foreignColumns: [t.tripId, t.id],
		}),
		unique("trip_members_trip_id_id_uq").on(t.tripId, t.id),
		uniqueIndex("trip_members_trip_user_uq")
			.on(t.tripId, t.userId)
			.where(sql`${t.userId} is not null`),
		uniqueIndex("trip_members_trip_email_uq")
			.on(t.tripId, t.email)
			.where(sql`${t.email} is not null`),
		uniqueIndex("trip_members_one_owner_uq")
			.on(t.tripId)
			.where(sql`${t.role} = 'owner'`),
		index("trip_members_user_idx").on(t.userId),
		// claimInvites looks invites up by email across trips (§11.5).
		index("trip_members_invited_email_idx")
			.on(t.email)
			.where(sql`${t.status} = 'invited'`),
		// `removed` is compared as text: the value is added by ALTER TYPE in the same
		// migration transaction, where a literal cast to the enum is refused.
		check(
			"trip_members_status_ck",
			sql`(${t.status} = 'active' and ${t.userId} is not null)
			or (${t.status} = 'invited' and ${t.userId} is null and ${t.email} is not null)
			or (${t.status} = 'placeholder' and ${t.userId} is null)
			or (${t.status}::text = 'removed' and ${t.userId} is null and ${t.displayName} is not null)`,
		),
		check(
			"trip_members_placeholder_name_ck",
			sql`${t.status} <> 'placeholder' or ${t.displayName} is not null`,
		),
		check("trip_members_email_lower_ck", sql`${t.email} = lower(${t.email})`),
		check("trip_members_color_ck", sql`${t.color} between 0 and 7`),
	],
);

/**
 * The trip's link (FB-13: ONE per trip, like Google Docs, with a role,
 * on/off and reset; `src/server/sharing.server.ts` keeps one live row per
 * trip and the `*_single_trip_link` migration folded older per-role links
 * into one). `role` is read on every request, so changing it changes every
 * guest who came in through it. The raw token is never stored (SECURITY.md
 * §2, §13): lookups go by `token_hash` = SHA-256(token), and `token_sealed`
 * is the token encrypted with a server key so the owner can copy the link
 * again. Use the helpers in `src/db/share-token.server.ts`. "Reset" sets
 * `revoked_at` and inserts a new row.
 */
export const shareLinks = pgTable(
	"share_links",
	{
		id: pk(),
		tripId: tripRef(),
		/** base64url SHA-256 of the raw token (43 chars). */
		tokenHash: text().notNull(),
		/** First 6 characters of the raw token, for UI and logs. */
		tokenPrefix: text().notNull(),
		/** AES-256-GCM sealed raw token (`sealShareToken`), for the owner's copy button; null = shown once only. */
		tokenSealed: text(),
		role: shareRole().notNull(),
		enabled: boolean().notNull().default(true),
		/** Null = never expires. The server picks the default (SECURITY.md §2). */
		expiresAt: timestamp({ withTimezone: true }),
		lastUsedAt: timestamp({ withTimezone: true }),
		useCount: integer().notNull().default(0),
		createdBy: text().references(() => user.id, { onDelete: "set null" }),
		createdAt: createdAt(),
		revokedAt: timestamp({ withTimezone: true }),
	},
	(t) => [
		unique("share_links_trip_id_id_uq").on(t.tripId, t.id),
		uniqueIndex("share_links_token_hash_uq").on(t.tokenHash),
		uniqueIndex("share_links_live_role_uq")
			.on(t.tripId, t.role)
			.where(sql`${t.revokedAt} is null`),
		check("share_links_token_hash_ck", sql`char_length(${t.tokenHash}) = 43`),
		check(
			"share_links_token_prefix_ck",
			sql`char_length(${t.tokenPrefix}) between 1 and 12`,
		),
		check("share_links_use_count_ck", sql`${t.useCount} >= 0`),
	],
);

/** A guest's access through a share link (D2: guests are Better Auth anonymous users). */
export const shareGrants = pgTable(
	"share_grants",
	{
		tripId: uuid().notNull(),
		shareLinkId: uuid().notNull(),
		userId: text()
			.notNull()
			.references(() => user.id, { onDelete: "cascade" }),
		/** 0..7, assigned across members and guests (§7.5). */
		color: smallint().notNull(),
		createdAt: createdAt(),
		lastSeenAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
	},
	(t) => [
		primaryKey({ columns: [t.shareLinkId, t.userId] }),
		foreignKey({
			name: "share_grants_link_fk",
			columns: [t.tripId, t.shareLinkId],
			foreignColumns: [shareLinks.tripId, shareLinks.id],
		}).onDelete("cascade"),
		index("share_grants_user_idx").on(t.userId),
		index("share_grants_trip_idx").on(t.tripId),
		check("share_grants_color_ck", sql`${t.color} between 0 and 7`),
	],
);
