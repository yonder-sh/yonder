import { sql } from "drizzle-orm";
import type { DbOrTx } from "@/db/db.server";

/**
 * Hard-deletes one trip and everything in it (seeds, the e2e fixture, the
 * importer's `--replace`, the purge and its `purgeTrip`). Since migration 0010
 * a plain `delete from trips` works too: the money → member keys cascade and
 * `trip_members_merged_into_fk` sets the pointer null (before it, they were NO
 * ACTION and whichever cascade reached `trip_members` first failed the whole
 * delete). The explicit steps stay so the order never matters and a database
 * that hasn't run 0010 yet still deletes cleanly; `items` go before the days
 * they sit on (`items_day_fk` is NO ACTION on purpose: a day with items is
 * never deleted on its own). Run it inside a transaction.
 */
export async function hardDeleteTrip(
	exec: DbOrTx,
	tripId: string,
): Promise<void> {
	// Shares, payments (+ payers), lines (+ members) and fees cascade.
	await exec.execute(sql`delete from expenses where trip_id = ${tripId}`);
	await exec.execute(sql`delete from settlements where trip_id = ${tripId}`);
	await exec.execute(
		sql`update trip_members set merged_into_id = null where trip_id = ${tripId} and merged_into_id is not null`,
	);
	await exec.execute(sql`delete from items where trip_id = ${tripId}`);
	await exec.execute(sql`delete from trips where id = ${tripId}`);
}

/** `hardDeleteTrip` for every trip matching a slug or id (seeds). */
export async function hardDeleteTripsWhere(
	exec: DbOrTx,
	match: { slug?: string; id?: string },
): Promise<void> {
	const rows = (
		await exec.execute(sql`
			select id::text as id from trips
			 where (${match.slug ?? null}::text is not null and slug = ${match.slug ?? null})
			    or (${match.id ?? null}::uuid is not null and id = ${match.id ?? null}::uuid)`)
	).rows as { id: string }[];
	for (const r of rows) await hardDeleteTrip(exec, r.id);
}
