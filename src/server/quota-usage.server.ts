/**
 * Storage accounting for the per-account quota (ADDENDUM §12; the rules are
 * in `quota.server.ts`). Free of request code, so `scripts/set-quota.ts`
 * bundles it on its own.
 */
import { sql } from "drizzle-orm";
import { formatBytes, GB } from "@/features/media/media-kinds";
import { getEnv } from "@/server/env.server";
import type { SqlExec } from "@/server/graph.server";

/** Kinds whose original bytes count (links and embeds store only previews). */
const COUNTED_KINDS = sql`('photo', 'video', 'pdf')`;

export function defaultQuotaBytes(env = getEnv()): number {
	return Math.round(env.STORAGE_QUOTA_DEFAULT_GB * GB);
}

/** The account whose quota an upload by `uploader` to `tripId` uses (a guest's → the trip owner), or null. */
export async function billedUserFor(
	exec: SqlExec,
	tripId: string,
	uploader: { id: string; isAnonymous?: boolean | null },
): Promise<string | null> {
	if (!uploader.isAnonymous) return uploader.id;
	const res = await exec.execute(sql`
		select user_id from trip_members
		 where trip_id = ${tripId} and role = 'owner' and user_id is not null
		 limit 1`);
	return (res.rows[0] as { user_id: string } | undefined)?.user_id ?? null;
}

/** The account's quota in bytes (its override, else the default). */
export async function quotaBytes(
	exec: SqlExec,
	userId: string,
): Promise<number> {
	const res = await exec.execute(
		sql`select storage_quota_bytes as q from "user" where id = ${userId}`,
	);
	const q = (res.rows[0] as { q: string | number | null } | undefined)?.q;
	return q === null || q === undefined ? defaultQuotaBytes() : Number(q);
}

/**
 * Bytes stored for `userId` (see the file comment). `exclude` leaves out one
 * attachment (the upload being completed, which is re-added by the caller).
 */
export async function usedBytes(
	exec: SqlExec,
	userId: string,
	opts: { exclude?: string } = {},
): Promise<number> {
	const exclude = opts.exclude ?? null;
	// What counts, whoever uploaded it (see the file comment).
	const live = sql`a.deleted_at is null
		and a.size_bytes is not null
		and a.kind in ${COUNTED_KINDS}
		and (${exclude}::uuid is null or a.id <> ${exclude}::uuid)
		and not exists (select 1 from nodes n where n.id = a.node_id and n.deleted_at is not null)
		and not exists (select 1 from items i where i.id = a.item_id and i.deleted_at is not null)`;
	const key = sql`coalesce(a.storage_key, 'trips/' || a.trip_id || '/' || a.id || '/')`;
	// Two indexed branches (an OR would scan every attachment): the account's
	// own uploads, and link guests' uploads to trips it owns.
	const res = await exec.execute(sql`
		select coalesce(sum(size), 0)::bigint as used from (
			select distinct on (k) size from (
				select ${key} as k, a.size_bytes as size
				  from attachments a
				  join "user" u on u.id = a.created_by and not coalesce(u.is_anonymous, false)
				  join trips t on t.id = a.trip_id and t.deleted_at is null
				 where a.created_by = ${userId} and ${live}
				union all
				select ${key} as k, a.size_bytes as size
				  from trip_members m
				  join trips t on t.id = m.trip_id and t.deleted_at is null
				  join attachments a on a.trip_id = m.trip_id
				  join "user" u on u.id = a.created_by and u.is_anonymous
				 where m.user_id = ${userId} and m.role = 'owner' and ${live}
			) x
			order by k, size desc
		) y`);
	return Number((res.rows[0] as { used: string | number }).used);
}

export type StorageUsage = { usedBytes: number; quotaBytes: number };

export async function storageUsage(
	exec: SqlExec,
	userId: string,
): Promise<StorageUsage> {
	const used = await usedBytes(exec, userId);
	return { usedBytes: used, quotaBytes: await quotaBytes(exec, userId) };
}

/**
 * "This upload needs 1.2 GB but you have 300 MB left (4.7 GB of 5 GB used).
 * Delete some uploads or ask the trip owner." A guest's upload names the
 * trip owner's space instead.
 */
export function quotaMessage(p: {
	needed: number;
	used: number;
	quota: number;
	own: boolean;
}): string {
	const left = formatBytes(Math.max(0, p.quota - p.used));
	const usage = `${formatBytes(p.used)} of ${formatBytes(p.quota)} used`;
	return p.own
		? `This upload needs ${formatBytes(p.needed)} but you have ${left} left (${usage}). Delete some uploads or ask the trip owner.`
		: `This upload needs ${formatBytes(p.needed)} but the trip owner has ${left} left (${usage}). Ask the trip owner to free up space.`;
}
