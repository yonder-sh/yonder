/**
 * The iPhone Shortcut "Save to Yonder" (src/server/shortcut.server.ts). Its
 * keys are Better Auth API keys (`apikey`, config "shortcut").
 *
 * - `shortcut_shares`: links the Shortcut sent, waiting for the app to pick
 *   them up (the app moves them to its on-device share inbox and deletes them
 *   here). Unclaimed rows expire after 7 days.
 */
import { sql } from "drizzle-orm";
import { check, index, pgTable, text } from "drizzle-orm/pg-core";
import { createdAt, pk } from "./_columns";
import { apikey, user } from "./auth";

export const shortcutShares = pgTable(
	"shortcut_shares",
	{
		id: pk(),
		userId: text()
			.notNull()
			.references(() => user.id, { onDelete: "cascade" }),
		/** The phone's key (`apikey.id`); removing the phone drops its links. */
		deviceId: text().references(() => apikey.id, { onDelete: "cascade" }),
		url: text(),
		text: text(),
		createdAt: createdAt(),
	},
	(t) => [
		index("shortcut_shares_user_idx").on(t.userId, t.createdAt),
		check(
			"shortcut_shares_size_ck",
			sql`char_length(coalesce(${t.url}, '')) <= 2000 and char_length(coalesce(${t.text}, '')) <= 2000`,
		),
	],
);
