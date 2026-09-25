/**
 * Sets one account's storage quota (ADDENDUM §12). No UI: run it where the
 * app's DATABASE_URL points.
 *
 *   N pnpm quota:set <email> <GB|default>                    (dev)
 *   node .output/scripts/set-quota.mjs <email> <GB|default>  (prod, app image)
 *
 * `<GB>` may be a decimal (1 GB = 1024³ bytes; 0.001 ≈ 1 MB); `default`
 * clears the override, so STORAGE_QUOTA_DEFAULT_GB applies again. Prints the
 * account's usage and effective quota.
 */
import { sql } from "drizzle-orm";
import { closeDb, getDb } from "../src/db/db.server";
import { formatBytes, GB } from "../src/features/media/media-kinds";
import {
	defaultQuotaBytes,
	storageUsage,
} from "../src/server/quota-usage.server";

const USAGE = "usage: set-quota <email> <GB|default>";

/** `"5"` → 5 GB in bytes, `"default"` → null; anything else throws. */
export function parseQuota(arg: string): number | null {
	if (arg === "default") return null;
	if (!/^\d+(\.\d+)?$/.test(arg)) throw new Error(`not a size in GB: ${arg}`);
	return Math.round(Number(arg) * GB);
}

async function main(): Promise<void> {
	const [email, arg] = process.argv.slice(2);
	if (!email || !arg) throw new Error(USAGE);
	const bytes = parseQuota(arg);
	const db = getDb();
	const res = await db.execute(sql`
		update "user" set storage_quota_bytes = ${bytes}, updated_at = now()
		 where lower(email) = lower(${email.trim()})
		 returning id`);
	const id = (res.rows[0] as { id: string } | undefined)?.id;
	if (!id) throw new Error(`no account with the email ${email}`);
	const u = await storageUsage(db, id);
	console.log(
		`[set-quota] ${email}: ${formatBytes(u.usedBytes)} of ${formatBytes(u.quotaBytes)} used` +
			(bytes === null
				? ` (the default, ${formatBytes(defaultQuotaBytes())})`
				: " (override)"),
	);
}

if (!process.env.VITEST)
	main()
		.catch((e: unknown) => {
			console.error("[set-quota]", e instanceof Error ? e.message : e);
			process.exitCode = 1;
		})
		.finally(() => closeDb());
