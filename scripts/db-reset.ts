/**
 * Drops and recreates this checkout's database, empties its bucket and deletes
 * its Redis keys, then migrates and seeds (SPEC §5.3). Refuses the main
 * database `trip` unless `--main` is passed.
 *
 *   N pnpm db:reset [--main] [--no-seed]
 */
import { resetAll, run } from "./lib/lifecycle";

run("db:reset", () =>
	resetAll({
		main: process.argv.includes("--main"),
		seed: !process.argv.includes("--no-seed"),
	}),
);
