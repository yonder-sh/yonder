/**
 * The caller's storage use and quota (ADDENDUM §12), for the profile's
 * "1.2 GB of 5 GB used". Account-level; link guests have no storage of their
 * own (their uploads count against the trip owner), so they get null.
 */
import { createServerFn } from "@tanstack/react-start";
import { db } from "@/db/db.server";
import { withUser } from "@/server/authz/middleware";
import { type StorageUsage, storageUsage } from "@/server/quota.server";

export type { StorageUsage } from "@/server/quota.server";

export const getStorageUsage = createServerFn({ method: "GET" })
	.middleware([withUser])
	.handler(
		async ({ context }): Promise<StorageUsage | null> =>
			context.user.isAnonymous ? null : storageUsage(db, context.user.id),
	);
