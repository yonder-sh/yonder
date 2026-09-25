/**
 * Activity log, digest cursors, climate normals and per-user preferences
 * (SPEC §6.3 misc.ts; EXTENSIONS §6, §9; ADDENDUM §7.2). There are no
 * route_cache or job_queue tables: provider caches, throttles, quotas and
 * BullMQ queues live in Redis (D16, §10.9).
 */
import { sql } from "drizzle-orm";
import {
	bigint,
	check,
	foreignKey,
	index,
	integer,
	jsonb,
	pgTable,
	primaryKey,
	real,
	smallint,
	text,
	timestamp,
	uuid,
} from "drizzle-orm/pg-core";
import type { ActivityMeta, UserPrefs } from "../../lib/schemas/misc";
import { createdAt, pk, updatedAt } from "./_columns";
import { user } from "./auth";
import { tripMembers, tripRef } from "./trips";

export const activityLog = pgTable(
	"activity_log",
	{
		id: pk(),
		tripId: tripRef(),
		actorUserId: text().references(() => user.id, { onDelete: "set null" }),
		/** Snapshot of the actor's name at the time (the user may be deleted later). */
		actorName: text().notNull(),
		/** `node.create` | `item.move` | `day.move` | `leg.update` | `media.add` | … */
		verb: text().notNull(),
		/** No FKs: rows outlive their targets. */
		nodeId: uuid(),
		itemId: uuid(),
		legId: uuid(),
		dayId: uuid(),
		summary: text().notNull(),
		/**
		 * E6: the `trips.version` of the transaction that wrote it (null on rows
		 * older than F-ext0). The digest reads rows newer than `trip_seen`.
		 */
		version: bigint({ mode: "number" }),
		/** E6: `{ name?, fromDayId?, toDayId?, parentId?, count?, proposalId? }` for digest lines. */
		meta: jsonb().$type<ActivityMeta>(),
		createdAt: createdAt(),
	},
	(t) => [
		index("activity_trip_idx").on(t.tripId, t.createdAt),
		index("activity_node_idx").on(t.nodeId, t.createdAt),
		index("activity_trip_version_idx").on(t.tripId, t.version),
	],
);

/**
 * E6: the last trip version each user (member or guest) has seen. Cleared
 * only by "Got it" (`markTripSeen`). Guest sign-in merges it (greatest wins).
 */
export const tripSeen = pgTable(
	"trip_seen",
	{
		tripId: tripRef(),
		userId: text()
			.notNull()
			.references(() => user.id, { onDelete: "cascade" }),
		seenVersion: bigint({ mode: "number" }).notNull().default(0),
		seenAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
		/** When they closed the welcome (shown once to people who didn't create the trip). */
		welcomeSeenAt: timestamp({ withTimezone: true }),
	},
	(t) => [
		primaryKey({ columns: [t.tripId, t.userId] }),
		index("trip_seen_user_idx").on(t.userId),
	],
);

/**
 * E3: 10-year monthly normals (2016–2025, Open-Meteo ERA5) per 0.25° cell.
 * Global (not per trip): one request per cell, ever.
 */
export const climateNormals = pgTable(
	"climate_normals",
	{
		/** lat,lng snapped to 0.25°: "35.75,139.75". */
		cell: text().notNull(),
		month: smallint().notNull(),
		tMaxC: real().notNull(),
		tMinC: real().notNull(),
		precipMm: real().notNull(),
		wetDays: real().notNull(),
		sunHours: real(),
		/** "2016–2025". */
		years: text().notNull(),
		fetchedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
	},
	(t) => [
		primaryKey({ columns: [t.cell, t.month] }),
		check("climate_month_ck", sql`${t.month} between 1 and 12`),
	],
);

/**
 * ADDENDUM §10 "one inbox": the single read state of the bell. Inbox items
 * are derived (mentions, suggestions to review, suggestion results, due or
 * opening todos, balance-changed and budget notices), each with a stable
 * `item_key` (`src/lib/schemas/inbox.ts`); a row here = read by that user.
 * Mention items also stamp `mentions.read_at`, so the two never disagree.
 * Guest sign-in merges these rows (`migrateGuestToUser`).
 */
export const inboxReads = pgTable(
	"inbox_reads",
	{
		userId: text()
			.notNull()
			.references(() => user.id, { onDelete: "cascade" }),
		itemKey: text().notNull(),
		tripId: tripRef(),
		readAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
	},
	(t) => [
		primaryKey({ columns: [t.userId, t.itemKey] }),
		index("inbox_reads_user_trip_idx").on(t.userId, t.tripId),
		check("inbox_reads_key_ck", sql`char_length(${t.itemKey}) <= 200`),
	],
);

/**
 * ADDENDUM §7.2: view settings synced to the account (default lens, tree
 * expand state per trip, map style, compact mode, 12/24 h, km/mi, display
 * currency). localStorage stays the fast cache. Private to the user.
 */
export const userPrefs = pgTable("user_prefs", {
	userId: text()
		.primaryKey()
		.references(() => user.id, { onDelete: "cascade" }),
	prefs: jsonb().$type<UserPrefs>().notNull().default({}),
	updatedAt: updatedAt(),
});

/**
 * "Remind" on the rating progress: a push to a member with places left to
 * rate, at most once per member and trip every 12 hours. The row is also
 * the recipient's in-app line until they close it (`seen_at`).
 */
export const rateReminders = pgTable(
	"rate_reminders",
	{
		id: pk(),
		tripId: tripRef(),
		memberId: uuid().notNull(),
		byUserId: text().references(() => user.id, { onDelete: "set null" }),
		/** The sender's first name when they sent it. */
		byName: text().notNull(),
		/** Places they had left to rate. */
		places: integer().notNull(),
		createdAt: createdAt(),
		seenAt: timestamp({ withTimezone: true }),
	},
	(t) => [
		foreignKey({
			name: "rate_reminders_member_fk",
			columns: [t.tripId, t.memberId],
			foreignColumns: [tripMembers.tripId, tripMembers.id],
		}).onDelete("cascade"),
		index("rate_reminders_member_idx").on(t.tripId, t.memberId, t.createdAt),
		check("rate_reminders_places_ck", sql`${t.places} >= 0`),
	],
);
