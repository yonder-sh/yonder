/**
 * Applies the `drizzle/` migrations to DATABASE_URL with drizzle-orm's migrator
 * (SPEC §5.2). Bundled by `pnpm build:scripts` to `.output/scripts/migrate.mjs`,
 * which the prod `migrate` service runs from `/app` (where `./drizzle` is copied).
 *
 *   N pnpm exec tsx --env-file=.env scripts/migrate.ts     (dev: `pnpm db:migrate` also works)
 *   node .output/scripts/migrate.mjs                        (prod)
 */
import { databaseName, migrateDatabase } from "../src/db/migrate.server";

async function main(): Promise<void> {
	const url = process.env.DATABASE_URL;
	if (!url) throw new Error("DATABASE_URL is not set");
	const started = Date.now();
	await migrateDatabase(url);
	console.log(
		`[migrate] ${databaseName(url)} is up to date (${Date.now() - started} ms)`,
	);
}

main().catch((e: unknown) => {
	console.error("[migrate]", e instanceof Error ? e.message : e);
	process.exitCode = 1;
});
