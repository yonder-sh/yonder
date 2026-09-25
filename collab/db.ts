import type pg from "pg";
import type { Db, Tx } from "@/db/db.server";
import { createWithTripTx } from "@/server/live/outbox.server";

/**
 * The database handles the collab and worker processes use: the pool for raw SQL
 * on the hot paths (auth, access, document fetch) and the Drizzle instance for
 * `withTripTx`, so note persistence locks the trip and publishes after COMMIT
 * exactly like a server function (with `bumpVersion: false`: a note body
 * leaves `trips.version` alone).
 *
 * Production passes the process-wide `{ db: getDb(), pool: getPool() }` from
 * `@/db/db.server`; tests pass `createDb(...)` on a scratch database.
 */
export type CollabDb = {
	pool: pg.Pool;
	db: Db;
	withTripTx: ReturnType<typeof createWithTripTx<Tx>>;
};

export function collabDb(handles: { db: Db; pool: pg.Pool }): CollabDb {
	return {
		pool: handles.pool,
		db: handles.db,
		withTripTx: createWithTripTx<Tx>(handles.db),
	};
}
