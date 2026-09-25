import { Redis, type RedisOptions } from "ioredis";
import { liveEnv, resetLiveEnv } from "./env.server";

/**
 * Redis connections for live events and jobs (SPEC §10.1, ADDENDUM §2).
 *
 * - `redis()`       shared command connection: PUBLISH, counters, gates. Commands
 *                   fail after a few reconnect attempts instead of queueing forever,
 *                   so a request never hangs on a Redis outage.
 * - `redisSub()`    a NEW dedicated connection for (P)SUBSCRIBE; the caller owns it.
 * - `redisForBull()` shared connection for BullMQ Queues/Workers, which require
 *                   `maxRetriesPerRequest: null`.
 * - `key(...parts)` the only way to build a key or channel: always
 *                   `${REDIS_PREFIX}:part:part` (SPEC §0 rule 19).
 *
 * Connections are lazy (`lazyConnect`) and cached on `globalThis`, so Vite/Nitro
 * dev reloads reuse them instead of leaking sockets.
 */

type LiveRedisStore = { cmd?: Redis; bull?: Redis; subs: Set<Redis> };
const STORE = Symbol.for("yonder.live.redis");
const g = globalThis as typeof globalThis & { [STORE]?: LiveRedisStore };
const store = (): LiveRedisStore => {
	g[STORE] ??= { subs: new Set() };
	return g[STORE];
};

/** `${REDIS_PREFIX}:a:b:c`. Parts must not be empty. */
export function key(...parts: (string | number)[]): string {
	if (parts.length === 0) throw new Error("key() needs at least one part");
	for (const p of parts) {
		if (p === "" || (typeof p === "string" && /\s/.test(p))) {
			throw new Error(`key(): bad part ${JSON.stringify(p)}`);
		}
	}
	return `${liveEnv().REDIS_PREFIX}:${parts.join(":")}`;
}

/** The configured prefix (for code that must build a pattern by hand). */
export function redisPrefix(): string {
	return liveEnv().REDIS_PREFIX;
}

function create(name: string, extra: RedisOptions): Redis {
	const client = new Redis(liveEnv().REDIS_URL, {
		lazyConnect: true,
		connectionName: `yonder-${name}`,
		...extra,
	});
	// Without a listener ioredis prints every reconnect error as unhandled.
	client.on("error", (e: Error) => {
		console.error(`[redis:${name}]`, e.message);
	});
	return client;
}

export function redis(): Redis {
	const s = store();
	s.cmd ??= create("cmd", { maxRetriesPerRequest: 2 });
	return s.cmd;
}

export function redisForBull(): Redis {
	const s = store();
	s.bull ??= create("bull", { maxRetriesPerRequest: null });
	return s.bull;
}

/** A fresh subscriber connection. Close it with `closeRedis()` or `client.quit()`. */
export function redisSub(name = "sub"): Redis {
	const client = create(name, {
		// The relay re-subscribes itself on 'ready' so it knows when the
		// subscription is live again (then it tells clients to resync).
		autoResubscribe: false,
		maxRetriesPerRequest: null,
	});
	store().subs.add(client);
	client.once("end", () => store().subs.delete(client));
	return client;
}

/** Closes every connection this module opened (graceful shutdown, tests). */
export async function closeRedis(): Promise<void> {
	const s = store();
	const all = [s.cmd, s.bull, ...s.subs].filter((c): c is Redis => !!c);
	s.cmd = undefined;
	s.bull = undefined;
	s.subs.clear();
	await Promise.allSettled(
		all.map((c) => (c.status === "wait" ? c.disconnect() : c.quit())),
	);
}

/** Tests only: close connections and re-read REDIS_URL / REDIS_PREFIX on next use. */
export async function resetRedisForTests(): Promise<void> {
	await closeRedis();
	resetLiveEnv();
}
