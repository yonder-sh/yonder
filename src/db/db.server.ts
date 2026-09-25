/**
 * The database client (SPEC §6.1): one `pg` Pool per process (app, collab,
 * worker, scripts), created lazily on first use so that importing this module
 * (e.g. from the Better Auth config under `auth generate`) never needs a
 * database or even `DATABASE_URL`. Server-only: never import it from client code.
 */
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "./schema";

export { schema };
export type Schema = typeof schema;
export type Db = NodePgDatabase<Schema>;
/** The `tx` handed to `db.transaction(async (tx) => …)`. */
export type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
/** Anything that can run a query: the pool-backed `db` or a transaction. */
export type DbOrTx = Db | Tx;

export type CreateDbOptions = {
	connectionString: string;
	/** Pool size (default 10). Connections open on demand and close after 30 s idle. */
	max?: number;
	/** Shown in `pg_stat_activity`, e.g. `yonder-app`, `yonder-collab`. */
	applicationName?: string;
};

/** A new pool + Drizzle instance. Use for tests and scripts that target another database; the app uses `db`. */
export function createDb(options: CreateDbOptions): { db: Db; pool: pg.Pool } {
	const pool = new pg.Pool({
		connectionString: options.connectionString,
		max: options.max ?? 10,
		idleTimeoutMillis: 30_000,
		connectionTimeoutMillis: 10_000,
		application_name: options.applicationName ?? "yonder",
	});
	// An idle client losing its connection (Postgres restart) must not crash the process.
	pool.on("error", (err) => {
		console.error("[db] idle client error:", err.message);
	});
	const db = drizzle({ client: pool, schema, casing: "snake_case" });
	return { db, pool };
}

/**
 * The process's pool lives on `globalThis` (like the Redis clients): the
 * built server bundles the app (SSR + server functions) and Nitro plugins
 * separately, and each bundle has its own copy of this module. A module-level
 * variable would give the shutdown plugin a different, empty instance, and
 * the real pool would keep the process alive after SIGTERM.
 */
const DB = Symbol.for("yonder.db");
const g = globalThis as typeof globalThis & {
	[DB]?: { db: Db; pool: pg.Pool };
};

function getInstance(): { db: Db; pool: pg.Pool } {
	if (!g[DB]) {
		const connectionString = process.env.DATABASE_URL;
		if (!connectionString) {
			throw new Error("DATABASE_URL is not set (see .env.example)");
		}
		g[DB] = createDb({ connectionString });
	}
	return g[DB];
}

/** This process's pool (created on first call). Collab and the worker use it for raw SQL. */
export function getPool(): pg.Pool {
	return getInstance().pool;
}

/** This process's Drizzle instance (created on first call). */
export function getDb(): Db {
	return getInstance().db;
}

/**
 * The process-wide Drizzle instance. A lazy proxy: nothing is created until a
 * property is read, so `import { db }` is free at module load.
 */
export const db: Db = new Proxy({} as Db, {
	get(_target, prop) {
		const real = getDb();
		const value = Reflect.get(real, prop, real);
		return typeof value === "function" ? value.bind(real) : value;
	},
	has(_target, prop) {
		return Reflect.has(getDb(), prop);
	},
});

/** Ends the pool (scripts and tests call this so the process can exit). Safe to call when unused. */
export async function closeDb(): Promise<void> {
	const current = g[DB];
	g[DB] = undefined;
	await current?.pool.end();
}
