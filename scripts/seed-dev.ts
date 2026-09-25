/**
 * The dev seed (SPEC §17.1): users dev@example.com (owner) and
 * maya@example.com (editor), the demo trip `demo` from the fixture with its
 * fixed UUIDs, bundle examples and notes, at the fixed address `/t/demo`
 * (link sharing off: turning it on in the Share dialog gives the address its
 * random tail). Idempotent; refuses NODE_ENV=production.
 *
 *   N pnpm db:seed
 */
import { getDb } from "../src/db/db.server";
import { seedDev } from "../src/server/fixture.server";
import { run } from "./lib/lifecycle";

run("db:seed", async () => {
	const r = await seedDev(getDb());
	console.log(
		`[db:seed] trip "${r.slug}" (${r.tripId}); users dev@example.com, maya@example.com`,
	);
});
