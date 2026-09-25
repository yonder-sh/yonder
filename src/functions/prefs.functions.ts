/**
 * Per-user view settings synced to the account (ADDENDUM §7.2): default lens,
 * tree expand state per trip, map style, compact mode, 12/24 h, km/mi and the
 * display currency. localStorage stays the fast cache; this is the durable
 * copy. Account-level (not trip-scoped), private to the user.
 */
import { createServerFn } from "@tanstack/react-start";
import { sql } from "drizzle-orm";
import { db } from "@/db/db.server";
import { mergeUserPrefs, readUserPrefs, UserPrefs } from "@/lib/schemas/misc";
import { withUser } from "@/server/authz/middleware";

/** The caller's prefs (`{}` when none are stored yet). */
export const getUserPrefs = createServerFn({ method: "GET" })
	.middleware([withUser])
	.handler(async ({ context }): Promise<UserPrefs> => {
		const res = await db.execute(
			sql`select prefs from user_prefs where user_id = ${context.user.id}`,
		);
		return readUserPrefs(
			(res.rows[0] as { prefs: unknown } | undefined)?.prefs,
		);
	});

/**
 * Merges `patch` into the stored prefs (`mergeUserPrefs`: keys not sent keep
 * their value, `null` removes a key, `treeExpanded` merges per trip). `account`.
 */
export const setUserPrefs = createServerFn({ method: "POST" })
	.middleware([withUser])
	.validator(UserPrefs)
	.handler(
		async ({ data, context }): Promise<UserPrefs> =>
			db.transaction(async (tx) => {
				const cur = await tx.execute(
					sql`select prefs from user_prefs where user_id = ${context.user.id} for update`,
				);
				const next = mergeUserPrefs(
					readUserPrefs((cur.rows[0] as { prefs: unknown } | undefined)?.prefs),
					data,
				);
				await tx.execute(sql`
				insert into user_prefs (user_id, prefs, updated_at)
				values (${context.user.id}, ${JSON.stringify(next)}::jsonb, now())
				on conflict (user_id) do update
				  set prefs = excluded.prefs, updated_at = now()`);
				return next;
			}),
	);
