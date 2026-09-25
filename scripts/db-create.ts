/**
 * Creates this checkout's database and bucket if they are missing, migrates,
 * and seeds the demo trip (SPEC §5.3). Safe to re-run.
 *
 *   N pnpm db:create [--no-seed]
 */
import { createAll, run } from "./lib/lifecycle";

run("db:create", () =>
	createAll({ seed: !process.argv.includes("--no-seed") }),
);
