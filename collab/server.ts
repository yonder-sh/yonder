/**
 * Collab process entry (SPEC §10, ADDENDUM §2): Hocuspocus 4 on HOCUSPOCUS_PORT
 * serving note Y.Docs, trip presence and live trip events, with
 * @hocuspocus/extension-redis for multi-instance sync. The browser reaches it at
 * same-origin `/collab` (Vite proxy in dev, the gateway's route in prod; the
 * path is not stripped, Hocuspocus accepts the upgrade on any path).
 * `GET /health` (200 while Redis answers, else 503) and `GET /healthz`
 * (always 200) on the same port are for probes.
 *
 * Run: `pnpm dev` / `pnpm dev:collab` (tsx watch), `pnpm start:collab` (built).
 * With COLLAB_RUN_WORKER=1 it also runs the BullMQ workers in-process.
 */
import { betterAuth } from "better-auth";
import { closeDb, getDb, getPool } from "@/db/db.server";
import { authOptions } from "@/server/auth-options";
import { liveEnv } from "@/server/live/env.server";
import { jobHandlers } from "@/server/live/job-handlers.server";
import {
	bullPrefix,
	closeQueues,
	scheduleRecurringJobs,
} from "@/server/live/jobs.server";
import {
	publishTripChange,
	tripChannelPattern,
} from "@/server/live/realtime.server";
import {
	closeRedis,
	key,
	redis,
	redisForBull,
} from "@/server/live/redis.server";
import { startCollabServer } from "./app";
import {
	betterAuthSessionLookup,
	createOriginCheck,
	type SessionApi,
} from "./auth";
import { collabDb } from "./db";
import { parseCollabEnv } from "./env";
import { type JobWorkers, startJobWorkers } from "./jobs";

const env = parseCollabEnv();

// The collab process's own Better Auth instance: the app's shared options WITHOUT
// tanstackStartCookies (spikes/auth gotcha 4), never refreshing sessions from here.
const auth = betterAuth({
	...authOptions,
	session: { ...authOptions.session, disableSessionRefresh: true },
});

const db = collabDb({ db: getDb(), pool: getPool() });

const collab = await startCollabServer({
	port: env.HOCUSPOCUS_PORT,
	host: env.HOCUSPOCUS_HOST,
	db,
	lookupSession: betterAuthSessionLookup(auth as unknown as SessionApi),
	originAllowed: createOriginCheck({
		allowedOrigins: env.allowedOrigins,
		allowAnyLocalhost: !env.isProduction,
	}),
	redis: {
		url: liveEnv().REDIS_URL,
		tripPattern: tripChannelPattern(),
		hocuspocusPrefix: key("hp"),
	},
	// `GET /health` for Kubernetes probes: 200 while Redis answers.
	health: async () => (await redis().ping()) === "PONG",
});

let workers: JobWorkers | undefined;
if (env.COLLAB_RUN_WORKER === "1") {
	workers = startJobWorkers({
		connection: redisForBull(),
		prefix: bullPrefix(),
		commands: redis(),
		key,
		pool: getPool(),
		handlers: jobHandlers,
		publish: publishTripChange,
	});
	await workers.ready;
	await scheduleRecurringJobs();
	console.log(
		"[collab] BullMQ workers running in-process (COLLAB_RUN_WORKER=1)",
	);
}

let shuttingDown = false;
async function shutdown(signal: string) {
	if (shuttingDown) return;
	shuttingDown = true;
	console.log(`[collab] ${signal}: flushing documents and closing`);
	const force = setTimeout(() => process.exit(1), 10_000);
	force.unref();
	try {
		await workers?.close();
		await collab.stop();
		await closeQueues();
		await closeRedis();
		await closeDb();
	} catch (e) {
		console.error("[collab] shutdown error:", e);
	}
	process.exit(0);
}
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
