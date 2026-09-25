/**
 * The push pipeline's Redis state (all under `${REDIS_PREFIX}:push:…`):
 *
 * - `buf:<user|trip|group>` / `bufm:…`  the coalescing buffer and its window marker;
 * - `sent:<user>:<inbox key>`           an inbox item already pushed (30 days);
 * - `actors:<trip>`                     who changed the trip lately (sorted by time):
 *                                       the snapshot diff never tells them about it;
 * - `snap:<trip>`                       the last snapshot (`src/lib/push/changes.ts`);
 * - `rem:<trip>`                        reminder jobs scheduled: job id → fireAt.
 *
 * And the two ways work gets onto the `push` queue from outside the worker:
 * `requestPushSync` (after any change to a trip's plan or lists) and
 * `enqueuePushEvents` (what a transaction wants people to hear about).
 */

import type { PushSnapshot } from "@/lib/push/changes";
import type { CoalesceStore } from "@/lib/push/coalesce";
import type { PushEventsJob } from "@/lib/push/jobs";
import { enqueue } from "@/server/live/jobs.server";
import { key, redis } from "@/server/live/redis.server";
import { pushEnabled } from "./env.server";

export class RedisCoalesceStore implements CoalesceStore {
	async append(k: string, entry: string, windowMs: number): Promise<boolean> {
		const list = key("push", "buf", k);
		const res = await redis()
			.multi()
			.rpush(list, entry)
			.expire(list, Math.ceil(windowMs / 1000) + 600)
			.set(key("push", "bufm", k), "1", "PX", windowMs + 60_000, "NX")
			.exec();
		return res?.[2]?.[1] === "OK";
	}

	async take(k: string): Promise<string[]> {
		const list = key("push", "buf", k);
		const res = await redis()
			.multi()
			.lrange(list, 0, -1)
			.del(list)
			.del(key("push", "bufm", k))
			.exec();
		return (res?.[0]?.[1] as string[] | undefined) ?? [];
	}
}

/** True the first time an inbox item is pushed to this person. */
export async function markPushedOnce(
	userId: string,
	itemKey: string,
): Promise<boolean> {
	const ok = await redis().set(
		key("push", "sent", userId, itemKey.replace(/\s+/g, "_")),
		"1",
		"EX",
		30 * 86_400,
		"NX",
	);
	return ok === "OK";
}

// ---- who changed the trip -----------------------------------------------------

const ACTOR_KEEP_MS = 10 * 60_000;
/** Everyone who changed the trip within this window is an actor of the diff. */
export const ACTOR_WINDOW_MS = 3 * 60_000;
const SYNC_DELAY_MS = 3_000;

/**
 * Remembers who just changed the trip: the next snapshot diff never tells
 * them about it (an accepted suggestion's author counts too).
 */
export async function noteActor(tripId: string, userId: string): Promise<void> {
	const k = key("push", "actors", tripId);
	const now = Date.now();
	await redis()
		.multi()
		.zadd(k, now, userId)
		.zremrangebyscore(k, 0, now - ACTOR_KEEP_MS)
		.expire(k, Math.ceil(ACTOR_KEEP_MS / 1000))
		.exec();
}

/**
 * After a change to a trip's plan or lists (called from the outbox after
 * COMMIT): remembers who made it and queues one `push.sync` (a burst of
 * edits runs one; an edit during a run queues exactly one more). Never
 * throws; a no-op while push is off.
 */
export async function requestPushSync(
	tripId: string,
	actorUserId?: string | null,
): Promise<void> {
	if (!pushEnabled()) return;
	try {
		if (actorUserId) await noteActor(tripId, actorUserId);
		await enqueue(
			"push",
			"push.sync",
			{ tripId },
			{
				dedupeId: `push-sync-${tripId}`,
				dedupeKeepLast: true,
				delay: SYNC_DELAY_MS,
				attempts: 2,
			},
		);
	} catch (e) {
		console.error(
			"[push] sync request failed:",
			e instanceof Error ? e.message : e,
		);
	}
}

/** Who changed the trip within the last `ACTOR_WINDOW_MS`. */
export async function recentActors(tripId: string): Promise<string[]> {
	return redis().zrangebyscore(
		key("push", "actors", tripId),
		Date.now() - ACTOR_WINDOW_MS,
		"+inf",
	);
}

/** Queues what a committed transaction wants people to hear about. Never throws. */
export async function enqueuePushEvents(job: PushEventsJob): Promise<void> {
	if (!pushEnabled() || !job.events.length) return;
	await enqueue("push", "push.events", job, { attempts: 2 });
}

// ---- snapshot and scheduled reminders ------------------------------------------

const SNAP_TTL_S = 90 * 86_400;

export async function readSnapshot(
	tripId: string,
): Promise<PushSnapshot | null> {
	const raw = await redis().get(key("push", "snap", tripId));
	if (!raw) return null;
	try {
		const v = JSON.parse(raw) as PushSnapshot;
		return v?.v === 1 ? v : null;
	} catch {
		return null;
	}
}

export async function writeSnapshot(
	tripId: string,
	snap: PushSnapshot,
): Promise<void> {
	await redis().set(
		key("push", "snap", tripId),
		JSON.stringify(snap),
		"EX",
		SNAP_TTL_S,
	);
}

export async function dropSnapshot(tripId: string): Promise<void> {
	await redis().del(key("push", "snap", tripId));
}

export async function scheduledReminders(
	tripId: string,
): Promise<Record<string, number>> {
	const raw = await redis().hgetall(key("push", "rem", tripId));
	return Object.fromEntries(
		Object.entries(raw).map(([k, v]) => [k, Number(v)]),
	);
}

export async function recordReminders(
	tripId: string,
	add: readonly { jobId: string; fireAt: number }[],
	remove: readonly string[],
): Promise<void> {
	const k = key("push", "rem", tripId);
	const m = redis().multi();
	if (remove.length) m.hdel(k, ...remove);
	for (const a of add) m.hset(k, a.jobId, String(a.fireAt));
	m.expire(k, 30 * 86_400);
	await m.exec();
}
