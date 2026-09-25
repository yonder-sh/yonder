import { type Job, UnrecoverableError, Worker } from "bullmq";
import type { Redis } from "ioredis";
import type pg from "pg";
import type { z } from "zod";
import type { TripKey } from "@/lib/query/keys";
import type { TripEvent } from "@/lib/realtime/protocol";
import type {
	JobContext,
	JobHandlers,
	JobResult,
} from "@/server/live/job-handlers.server";
import {
	isSilentQueue,
	JOB_COUNTER_TTL_S,
	JOB_SCHEMAS,
	jobCounterKeys,
	QUEUE_CONCURRENCY,
	QUEUE_NAMES,
	type QueueName,
} from "@/server/live/jobs.server";

/**
 * The BullMQ worker side (SPEC §10.9, D16): one `Worker` per queue, with
 * - payload validation against `JOB_SCHEMAS` (a bad payload fails for good);
 * - per-trip progress: after every finished job (success, or the last failed
 *   attempt) `…:done` goes up and a `{ type: 'job', remaining, total }` event is
 *   published; both counters reset when nothing remains;
 * - a gated `invalidate` of the keys the handlers report, at most once per
 *   `gateMs` per trip (Redis `SET NX PX`), with a trailing publish so the last
 *   change in a burst is never swallowed. Its `version` is the trip's current
 *   `trips.version`.
 */
export type JobWorkersOptions = {
	/** A BullMQ-compatible connection (`maxRetriesPerRequest: null`). */
	connection: Redis;
	/** `bullPrefix()` */
	prefix: string;
	/** A normal command connection for counters and gates. */
	commands: Redis;
	/** Builds `${REDIS_PREFIX}:…` keys (`key` from redis.server). */
	key: (...parts: (string | number)[]) => string;
	pool: pg.Pool;
	handlers: JobHandlers;
	publish: (event: TripEvent) => Promise<unknown>;
	queues?: readonly QueueName[];
	gateMs?: number;
	log?: (msg: string) => void;
};

export type JobWorkers = {
	workers: Worker[];
	/** Resolves when every worker is connected and waiting for jobs. */
	ready: Promise<void>;
	close(): Promise<void>;
};

type TripJobData = { tripId: string };

export function startJobWorkers(opts: JobWorkersOptions): JobWorkers {
	const log = opts.log ?? ((m: string) => console.log(`[worker] ${m}`));
	const gateMs = opts.gateMs ?? 2_000;
	const pending = new Map<
		string,
		{ keys: Set<TripKey>; timer?: ReturnType<typeof setTimeout> }
	>();
	let closing = false;

	async function readVersion(tripId: string): Promise<number | null> {
		const { rows } = await opts.pool.query<{ version: string | number }>(
			"select version from trips where id = $1",
			[tripId],
		);
		return rows[0] ? Number(rows[0].version) : null;
	}

	async function publishKeys(tripId: string, keys: TripKey[]) {
		const version = await readVersion(tripId);
		if (version === null) return; // the trip is gone
		await opts.publish({ type: "invalidate", tripId, version, keys });
	}

	async function tryFlush(tripId: string, force = false): Promise<void> {
		const p = pending.get(tripId);
		if (!p || p.keys.size === 0) {
			pending.delete(tripId);
			return;
		}
		const gate = opts.key("gate", tripId);
		const acquired =
			force ||
			(await opts.commands.set(gate, "1", "PX", gateMs, "NX")) === "OK";
		if (acquired) {
			pending.delete(tripId);
			await publishKeys(tripId, [...p.keys]);
			return;
		}
		if (closing) return;
		const ttl = await opts.commands.pttl(gate);
		p.timer = setTimeout(() => {
			p.timer = undefined;
			void tryFlush(tripId).catch((e) =>
				log(`gated publish failed: ${String(e)}`),
			);
		}, Math.max(ttl, 0) + 20);
	}

	async function gatedInvalidate(tripId: string, keys: readonly TripKey[]) {
		if (keys.length === 0) return;
		let p = pending.get(tripId);
		if (!p) {
			p = { keys: new Set() };
			pending.set(tripId, p);
		}
		for (const k of keys) p.keys.add(k);
		if (!p.timer) await tryFlush(tripId);
	}

	async function progress(queue: QueueName, tripId: string) {
		// Silent queues (money, climate) never show progress.
		if (isSilentQueue(queue)) return;
		const k = jobCounterKeys(tripId, queue);
		const res = await opts.commands
			.multi()
			.incr(k.done)
			.expire(k.done, JOB_COUNTER_TTL_S)
			.get(k.total)
			.exec();
		const done = Number(res?.[0]?.[1] ?? 0);
		const total = Math.max(Number(res?.[2]?.[1] ?? 0), done);
		const remaining = Math.max(total - done, 0);
		if (remaining === 0) await opts.commands.del(k.total, k.done);
		await opts.publish({ type: "job", tripId, kind: queue, remaining, total });
	}

	async function afterJob(
		queue: QueueName,
		job: Job<TripJobData>,
		keys: readonly TripKey[],
	) {
		const tripId = job.data?.tripId;
		if (typeof tripId !== "string") return;
		try {
			await progress(queue, tripId);
			await gatedInvalidate(tripId, keys);
		} catch (e) {
			log(
				`post-job events for ${queue}/${job.name} failed: ${e instanceof Error ? e.message : e}`,
			);
		}
	}

	const workers = (opts.queues ?? QUEUE_NAMES).map((queue) => {
		const schemas = JOB_SCHEMAS[queue] as Record<string, z.ZodType>;
		const handlers = opts.handlers[queue] as Record<
			string,
			(data: unknown, ctx: JobContext) => Promise<JobResult | undefined>
		>;
		const worker = new Worker<TripJobData, JobResult>(
			queue,
			async (job, _token, signal) => {
				const schema = schemas[job.name];
				const handler = handlers[job.name];
				if (!schema || !handler)
					throw new UnrecoverableError(`unknown job ${queue}/${job.name}`);
				const parsed = schema.safeParse(job.data);
				if (!parsed.success) {
					throw new UnrecoverableError(
						`invalid payload for ${queue}/${job.name}`,
					);
				}
				const result = await handler(parsed.data, {
					jobId: job.id ?? "",
					attempt: job.attemptsMade + 1,
					signal,
					log: (m) => log(`${queue}/${job.name} ${job.id}: ${m}`),
				});
				return result ?? {};
			},
			{
				connection: opts.connection,
				prefix: opts.prefix,
				concurrency: QUEUE_CONCURRENCY[queue],
			},
		);
		worker.on("completed", (job, result) => {
			void afterJob(queue, job, result?.keys ?? []);
		});
		worker.on("failed", (job, err) => {
			if (!job) return;
			const attempts = job.opts.attempts ?? 1;
			const final =
				err instanceof UnrecoverableError || job.attemptsMade >= attempts;
			log(
				`${queue}/${job.name} ${job.id} failed (attempt ${job.attemptsMade}/${attempts}${final ? ", giving up" : ""}): ${err.message}`,
			);
			if (final) void afterJob(queue, job, []);
		});
		worker.on("error", (e) => log(`${queue} worker error: ${e.message}`));
		return worker;
	});

	return {
		workers,
		ready: Promise.all(workers.map((w) => w.waitUntilReady())).then(
			() => undefined,
		),
		async close() {
			closing = true;
			await Promise.all(workers.map((w) => w.close()));
			// Publish what is still pending right away instead of waiting for the gate.
			for (const [tripId, p] of pending) {
				if (p.timer) clearTimeout(p.timer);
				await tryFlush(tripId, true).catch(() => {});
			}
		},
	};
}
