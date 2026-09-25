/**
 * `pnpm purge [--dry-run]` (SPEC §15.5): deletes S3 objects and rows of
 * attachments soft-deleted > 30 days ago and uploads pending > 24 h, nodes
 * and trips soft-deleted > 30 days ago (S3 prefix first), and anonymous users
 * with no grants and no recent session. The logic is in
 * `src/features/media/server/purge.server.ts`. Run it daily (cron) in prod.
 */
import { getDb } from "../src/db/db.server";
import { purge } from "../src/features/media/server/purge.server";
import { run } from "./lib/lifecycle";

const dryRun = process.argv.includes("--dry-run");

run("purge", async () => {
	const r = await purge(getDb(), {
		dryRun,
		log: (line) => console.log(`[purge]${dryRun ? " (dry run)" : ""} ${line}`),
	});
	console.log(`[purge] done: ${JSON.stringify(r)}`);
});
