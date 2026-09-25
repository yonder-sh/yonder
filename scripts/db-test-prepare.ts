/**
 * Creates DATABASE_URL_TEST if it is missing and migrates it (SPEC §5.4).
 * Used twice: as the Vitest `globalSetup` of the "db" project (default export)
 * and directly via `pnpm db:test:prepare`. DB test files that need isolation
 * create their own scratch database on top of this.
 */
import {
	databaseName,
	ensureDatabase,
	migrateDatabase,
} from "../src/db/migrate.server";
import { loadDotEnv } from "./load-env";

export default async function setup(): Promise<void> {
	loadDotEnv();
	const url = process.env.DATABASE_URL_TEST;
	if (!url) throw new Error("DATABASE_URL_TEST is not set (see .env.example)");
	if (databaseName(url) === "trip")
		throw new Error("DATABASE_URL_TEST must not be the main database");
	await ensureDatabase(url);
	await migrateDatabase(url);
}

if (process.argv[1]?.endsWith("db-test-prepare.ts")) {
	setup()
		.then(() =>
			console.log(
				`[db:test:prepare] ${databaseName(process.env.DATABASE_URL_TEST ?? "")} ready`,
			),
		)
		.catch((e: unknown) => {
			console.error("[db:test:prepare]", e instanceof Error ? e.message : e);
			process.exitCode = 1;
		});
}
