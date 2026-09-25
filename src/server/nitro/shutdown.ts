/**
 * Graceful shutdown of the built app server (`pnpm start`, the `app` image).
 * Nitro closes its HTTP server on SIGTERM/SIGINT and then calls the `close`
 * hooks; without this plugin the Postgres pool and the ioredis clients (live
 * publisher, cache and rate limiters, Better Auth's secondary storage, the
 * BullMQ queue connections) kept the process alive until Docker's SIGKILL.
 *
 * A last-resort unref'd timer exits after CLOSE_TIMEOUT_MS if some other
 * handle still holds the event loop.
 */
import { definePlugin } from "nitro";
import { closeDb } from "@/db/db.server";
import { closeQueues } from "@/server/live/jobs.server";
import { closeRedis } from "@/server/live/redis.server";

export const CLOSE_TIMEOUT_MS = 5_000;

/** Closes every long-lived client the app process opens. Never throws. */
export async function closeAppResources(): Promise<void> {
	await Promise.allSettled([closeQueues(), closeDb()]);
	await Promise.allSettled([closeRedis()]);
}

export default definePlugin((nitroApp) => {
	nitroApp.hooks.hook("close", async () => {
		const t0 = Date.now();
		setTimeout(() => process.exit(0), CLOSE_TIMEOUT_MS).unref();
		await closeAppResources();
		if (process.env.YONDER_DEBUG_SHUTDOWN) {
			console.log(
				`[shutdown] closed in ${Date.now() - t0} ms; still open:`,
				process.getActiveResourcesInfo(),
			);
			setTimeout(() => {
				const handles = (
					process as unknown as { _getActiveHandles(): unknown[] }
				)._getActiveHandles();
				console.log(
					"[shutdown] after 1 s:",
					handles.map((h) => {
						const o = h as {
							constructor?: { name?: string };
							remotePort?: number;
							localPort?: number;
							_idleTimeout?: number;
						};
						return `${o.constructor?.name}:${o.localPort ?? ""}->${o.remotePort ?? ""}`;
					}),
				);
			}, 1000).unref();
		}
	});
});
