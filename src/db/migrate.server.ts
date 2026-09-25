/**
 * Database lifecycle helpers for scripts and tests: create or drop a database
 * and apply the `drizzle/` migrations with drizzle-orm's migrator (the same one
 * the prod `migrate` service runs through `.output/scripts/migrate.mjs`).
 *
 * Callers: `scripts/migrate.ts`, `scripts/db-create.ts`, `scripts/db-reset.ts`,
 * `scripts/db-test-prepare.ts` and DB tests. Server-only.
 */
import path from "node:path";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";
import { createDb } from "./db.server";

/** Where `drizzle-kit generate` writes migrations (drizzle.config.ts `out`). */
export const MIGRATIONS_FOLDER = path.resolve(process.cwd(), "drizzle");

const SAFE_DB_NAME = /^[a-z_][a-z0-9_]{0,62}$/;

/** The database name in a connection string, validated as a plain identifier. */
export function databaseName(connectionString: string): string {
	const name = decodeURIComponent(
		new URL(connectionString).pathname.replace(/^\//, ""),
	);
	if (!SAFE_DB_NAME.test(name)) {
		throw new Error(`unsafe or missing database name: "${name}"`);
	}
	return name;
}

/** Runs `fn` on a client connected to the server's `postgres` maintenance database. */
async function withMaintenanceClient<T>(
	connectionString: string,
	fn: (client: pg.Client) => Promise<T>,
): Promise<T> {
	const url = new URL(connectionString);
	url.pathname = "/postgres";
	const client = new pg.Client({ connectionString: url.toString() });
	await client.connect();
	try {
		return await fn(client);
	} finally {
		await client.end();
	}
}

/** Creates the database named in `connectionString` if it doesn't exist. Returns true if it was created. */
export async function ensureDatabase(
	connectionString: string,
): Promise<boolean> {
	const name = databaseName(connectionString);
	return withMaintenanceClient(connectionString, async (client) => {
		const { rowCount } = await client.query(
			"select 1 from pg_database where datname = $1",
			[name],
		);
		if (rowCount) return false;
		await client.query(`create database "${name}"`);
		return true;
	});
}

/**
 * Drops the database named in `connectionString` (`WITH (FORCE)` ends open
 * connections). Refuses the main dev database `trip` unless `allowMain` (§5.3).
 */
export async function dropDatabase(
	connectionString: string,
	options: { allowMain?: boolean } = {},
): Promise<void> {
	const name = databaseName(connectionString);
	if (name === "trip" && !options.allowMain) {
		throw new Error('refusing to drop the main database "trip" (pass --main)');
	}
	await withMaintenanceClient(connectionString, async (client) => {
		await client.query(`drop database if exists "${name}" with (force)`);
	});
}

/** Applies every pending migration in `drizzle/` to the database at `connectionString`. */
export async function migrateDatabase(
	connectionString: string,
	options: { migrationsFolder?: string } = {},
): Promise<void> {
	const { db, pool } = createDb({
		connectionString,
		max: 1,
		applicationName: "yonder-migrate",
	});
	try {
		await migrate(db, {
			migrationsFolder: options.migrationsFolder ?? MIGRATIONS_FOLDER,
		});
	} finally {
		await pool.end();
	}
}
