/**
 * Web Push notifications (docs: the push round; `src/server/push`).
 *
 * - `push_subscriptions`: one row per user and device (browser push
 *   endpoint + its keys). An endpoint belongs to one user at a time: a device
 *   that signs in as someone else moves to them. Rows the push service
 *   answers 404/410 for are deleted by the sender.
 * - `notification_prefs`: the per-type switches. Every type is on unless it
 *   is listed in `off_types` (opt-out).
 * - `notification_mutes`: "Mute notifications" per trip.
 */
import { sql } from "drizzle-orm";
import {
	check,
	index,
	pgTable,
	primaryKey,
	text,
	timestamp,
	uniqueIndex,
} from "drizzle-orm/pg-core";
import { createdAt, pk, updatedAt } from "./_columns";
import { user } from "./auth";
import { tripRef } from "./trips";

export const pushSubscriptions = pgTable(
	"push_subscriptions",
	{
		id: pk(),
		userId: text()
			.notNull()
			.references(() => user.id, { onDelete: "cascade" }),
		/** The push service URL (https, a known push service host). */
		endpoint: text().notNull(),
		/** The browser's P-256 public key and auth secret (base64url). */
		p256dh: text().notNull(),
		auth: text().notNull(),
		/** The browser's user agent when it subscribed (a device label). */
		userAgent: text(),
		createdAt: createdAt(),
		/** The last push the service accepted. */
		lastUsedAt: timestamp({ withTimezone: true }),
	},
	(t) => [
		uniqueIndex("push_subscriptions_endpoint_uq").on(t.endpoint),
		index("push_subscriptions_user_idx").on(t.userId),
		check(
			"push_subscriptions_endpoint_ck",
			sql`${t.endpoint} ~ '^https://' and char_length(${t.endpoint}) <= 2048`,
		),
	],
);

export const notificationPrefs = pgTable("notification_prefs", {
	userId: text()
		.primaryKey()
		.references(() => user.id, { onDelete: "cascade" }),
	/** `PushType`s switched off (src/lib/push/types.ts). */
	offTypes: text().array().notNull().default(sql`'{}'::text[]`),
	updatedAt: updatedAt(),
});

export const notificationMutes = pgTable(
	"notification_mutes",
	{
		userId: text()
			.notNull()
			.references(() => user.id, { onDelete: "cascade" }),
		tripId: tripRef(),
		createdAt: createdAt(),
	},
	(t) => [
		primaryKey({ columns: [t.userId, t.tripId] }),
		index("notification_mutes_trip_idx").on(t.tripId),
	],
);
