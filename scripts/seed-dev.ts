/**
 * The dev seed (SPEC §17.1): users dev@example.com (owner) and
 * maya@example.com (editor), the demo trip `demo` from the fixture with its
 * fixed UUIDs, bundle examples, notes and the share links
 * `dev-share-token-editor` / `dev-share-token-viewer`. Idempotent; refuses
 * NODE_ENV=production.
 *
 *   N pnpm db:seed
 */
import { getDb } from "../src/db/db.server";
import { seedDev } from "../src/server/fixture.server";
import { run } from "./lib/lifecycle";

run("db:seed", async () => {
	const r = await seedDev(getDb());
	console.log(
		`[db:seed] trip "${r.slug}" (${r.tripId}); users dev@example.com, maya@example.com; share tokens ${r.shareTokens.editor}, ${r.shareTokens.viewer}`,
	);
});
