/**
 * Background-job worker entry (SPEC §10.9, D16; ADDENDUM §2): BullMQ workers for
 * the `autofill`, `media`, `links`, `money`, `climate`, `hours` and `push` (Web Push,
 * `src/server/push`) queues. Handlers live in
 * `src/server/live/job-handlers.server.ts`; progress (`job` events) and gated
 * invalidations are published on the trip's Redis channel.
 *
 * Run: `pnpm dev:worker` (tsx watch), `pnpm start:worker` (built). Several worker
 * processes (or the collab process with COLLAB_RUN_WORKER=1) may run at once:
 * BullMQ workers are competing consumers.
 */
import { closeDb, getPool } from "@/db/db.server";
import { jobHandlers } from "@/server/live/job-handlers.server";
import {
	bullPrefix,
	closeQueues,
	scheduleRecurringJobs,
} from "@/server/live/jobs.server";
import { publishTripChange } from "@/server/live/realtime.server";
import {
	closeRedis,
	key,
	redis,
	redisForBull,
} from "@/server/live/redis.server";
import { startJobWorkers } from "./jobs";

const workers = startJobWorkers({
	connection: redisForBull(),
	prefix: bullPrefix(),
	commands: redis(),
	key,
	pool: getPool(),
	handlers: jobHandlers,
	publish: publishTripChange,
});
await workers.ready;
// The daily FX job (money.fxDaily, 16:30 Europe/Berlin) and the hourly OSM
// hours refresh (hours.osmRefresh); idempotent upserts.
await scheduleRecurringJobs();
console.log(
	`[worker] consuming ${workers.workers.map((w) => w.name).join(", ")} (prefix ${bullPrefix()})`,
);

let shuttingDown = false;
async function shutdown(signal: string) {
	if (shuttingDown) return;
	shuttingDown = true;
	console.log(`[worker] ${signal}: finishing active jobs`);
	const force = setTimeout(() => process.exit(1), 30_000);
	force.unref();
	try {
		await workers.close();
		await closeQueues();
		await closeRedis();
		await closeDb();
	} catch (e) {
		console.error("[worker] shutdown error:", e);
	}
	process.exit(0);
}
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
