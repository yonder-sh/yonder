/**
 * Per-account storage quotas (ADDENDUM §12, the Google Drive model: the
 * uploader pays).
 *
 * - A file counts against the account that uploaded it (`attachments.created_by`),
 *   in every trip, whoever owns the trip. An anonymous link guest's upload
 *   counts against the trip's OWNER.
 * - Only the original upload counts (`size_bytes` of photos, videos and PDFs):
 *   thumbnails, posters, page renders, link previews and avatars don't.
 * - Unique storage objects per account: a duplicated trip's rows re-reference
 *   the source's objects (same `storage_key`) and count once.
 * - Deleting frees the space at once: soft-deleted attachments, and
 *   attachments on a deleted trip, node or item, don't count. Pending uploads
 *   (under way, or abandoned until the purge) do, so parallel uploads can't
 *   overshoot together.
 * - The quota is `user.storage_quota_bytes`, else STORAGE_QUOTA_DEFAULT_GB.
 *
 * Checked when an upload starts (`createUpload`, with the declared size, under
 * a per-account advisory lock) and again when it completes.
 */
import { sql } from "drizzle-orm";
import { fail } from "@/server/authz/session.server";
import type { SqlExec } from "@/server/graph.server";
import { quotaBytes, quotaMessage, usedBytes } from "./quota-usage.server";

export {
	billedUserFor,
	defaultQuotaBytes,
	quotaBytes,
	quotaMessage,
	type StorageUsage,
	storageUsage,
	usedBytes,
} from "./quota-usage.server";

/**
 * Serializes quota checks of one account inside the caller's transaction
 * (two uploads starting at once can't both take the last free space).
 */
export async function lockQuota(tx: SqlExec, userId: string): Promise<void> {
	await tx.execute(
		sql`select pg_advisory_xact_lock(hashtextextended(${`quota:${userId}`}, 0))`,
	);
}

/**
 * Refuses (`STORAGE_QUOTA` with `quotaMessage`) when `size` more bytes would
 * take `billedUserId` over its quota. Decisive inside a transaction after
 * `lockQuota`; also a cheap early check on the pool. `exclude`: the
 * attachment being completed.
 */
export async function assertQuota(
	tx: SqlExec,
	p: { billedUserId: string; own: boolean; size: number; exclude?: string },
): Promise<void> {
	// One after the other: a transaction is one client (no overlapping queries).
	const used = await usedBytes(tx, p.billedUserId, { exclude: p.exclude });
	const quota = await quotaBytes(tx, p.billedUserId);
	if (used + p.size > quota)
		fail(
			"STORAGE_QUOTA",
			quotaMessage({ needed: p.size, used, quota, own: p.own }),
		);
}
