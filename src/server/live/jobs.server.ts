import { type JobsOptions, Queue } from "bullmq";
import { v7 as uuidv7 } from "uuid";
import { z } from "zod";
import {
	PushEventsJob,
	PushFlushJob,
	PushRemindJob,
	PushSweepJob,
	PushSyncJob,
} from "@/lib/push/jobs";
import { TRIP_KEYS } from "@/lib/query/keys";
import { isUuid, type JobKind } from "@/lib/realtime/protocol";
import { LegTarget } from "@/lib/schemas/targets";
import { pushEnabled } from "@/server/push/env.server";
import { key, redis, redisForBull } from "./redis.server";

/**
 * BullMQ queues (SPEC §10.9, D16, ADDENDUM §2): the contract between code that
 * enqueues (server functions, via `out.job(...)` in `withTripTx`) and the worker
 * process (`collab/worker.ts`), which runs the handlers in `job-handlers.server.ts`.
 *
 * Queues and their job names:
 *   autofill  `autofill`        fill a pair/stay leg's mode and duration (WP-Transit)
 *   media     `media.variants`  sharp thumbnails / display variants (WP-Media)
 *             `media.poster`    ffmpeg poster frame for a video (WP-Media)
 *   links     `links.preview`   SSRF-safe link preview fetch (WP-Media)
 *   money     `money.fxDaily`   daily FX rates + re-conversion of planned rows (WP-Money;
 *                               repeated at 16:30 Europe/Berlin by `scheduleRecurringJobs`)
 *             `money.fxRehome`  re-convert a trip after its home currency changed (WP-Money)
 *   climate   `climate.cell`    fetch one 0.25° cell's climate normals once (WP-Insights)
 *   push      `push.events`, `push.flush`, `push.sync`, `push.remind`, `push.sweep`:
 *             Web Push notifications (`src/lib/push/jobs.ts`, `src/server/push`)
 *   hours     `hours.osm`       OSM opening hours of a trip's new or re-linked places (WP-Insights)
 *             `hours.osmRefresh` the next places whose OSM hours are 30+ days old, all trips
 *                               (hourly, by `scheduleRecurringJobs`)
 *   (any)     `test.ping`       a no-op sample job: smoke tests and ops checks
 *
 * Trip jobs carry `tripId`: the worker reports per-trip progress (`job` events)
 * and invalidates the trip's queries after it. `money`, `climate`, `hours` and
 * `push` are SILENT queues: no progress toasts (their jobs may have no trip),
 * but a trip job's reported keys are still invalidated.
 */

const TripId = z.string().refine(isUuid, "tripId must be a UUID");
const AttachmentId = z.string().refine(isUuid, "attachmentId must be a UUID");

export const AutofillJob = z.object({ tripId: TripId, target: LegTarget });
export const MediaJob = z.object({
	tripId: TripId,
	attachmentId: AttachmentId,
});
export const LinkPreviewJob = z.object({
	tripId: TripId,
	attachmentId: AttachmentId,
	/** The URL to preview; the handler re-validates it through the SSRF-safe fetch. */
	url: z.url({ protocol: /^https?$/ }).max(4096),
});
/** `money.fxDaily`: all trips; `date` (YYYY-MM-DD) defaults to today. */
export const FxDailyJob = z.object({
	date: z
		.string()
		.regex(/^\d{4}-\d{2}-\d{2}$/)
		.optional(),
});
export const FxRehomeJob = z.object({ tripId: TripId });
/** `climate.cell`: "35.75,139.75" (lat,lng snapped to 0.25°). */
export const ClimateCellJob = z.object({
	cell: z.string().regex(/^-?\d{1,2}\.\d{2},-?\d{1,3}\.\d{2}$/),
	/** The trip whose node asked for it (its ClimateCard refetches). */
	tripId: TripId.optional(),
});
/** `hours.osm`: the trip's places still missing OSM hours for their `osm_ref`. */
export const OsmHoursJob = z.object({ tripId: TripId });
/** `hours.osmRefresh`: no payload (all trips). */
export const OsmHoursRefreshJob = z.object({});
export const PingJob = z.object({
	tripId: TripId,
	/** TripKeys the worker should invalidate after the job (tests use this). */
	keys: z.array(z.enum(TRIP_KEYS)).optional(),
	/** Makes the handler fail this many attempts first (tests of retries). */
	failTimes: z.number().int().min(0).max(5).optional(),
});

/** queue → job name → payload schema. */
export const JOB_SCHEMAS = {
	autofill: { autofill: AutofillJob, "test.ping": PingJob },
	media: {
		"media.variants": MediaJob,
		"media.poster": MediaJob,
		"test.ping": PingJob,
	},
	links: { "links.preview": LinkPreviewJob, "test.ping": PingJob },
	money: {
		"money.fxDaily": FxDailyJob,
		"money.fxRehome": FxRehomeJob,
		"test.ping": PingJob,
	},
	climate: { "climate.cell": ClimateCellJob, "test.ping": PingJob },
	push: {
		"push.events": PushEventsJob,
		"push.flush": PushFlushJob,
		"push.sync": PushSyncJob,
		"push.remind": PushRemindJob,
		"push.sweep": PushSweepJob,
		"test.ping": PingJob,
	},
	hours: {
		"hours.osm": OsmHoursJob,
		"hours.osmRefresh": OsmHoursRefreshJob,
		"test.ping": PingJob,
	},
} as const satisfies Record<JobKind | SilentQueue, Record<string, z.ZodType>>;

/** Queues without progress events (no toasts; jobs may have no trip). */
export const SILENT_QUEUES = ["money", "climate", "hours", "push"] as const;
export type SilentQueue = (typeof SILENT_QUEUES)[number];
export function isSilentQueue(q: string): q is SilentQueue {
	return (SILENT_QUEUES as readonly string[]).includes(q);
}

export type QueueName = keyof typeof JOB_SCHEMAS;
export type JobName<Q extends QueueName> = keyof (typeof JOB_SCHEMAS)[Q] &
	string;
export type JobData<Q extends QueueName, N extends JobName<Q>> = z.output<
	(typeof JOB_SCHEMAS)[Q][N]
>;

export const QUEUE_NAMES = Object.keys(JOB_SCHEMAS) as QueueName[];

/** Worker concurrency per queue (SPEC §10.9). */
export const QUEUE_CONCURRENCY: Record<QueueName, number> = {
	autofill: 1,
	media: 2,
	links: 4,
	money: 1,
	climate: 2,
	push: 4,
	// Overpass is paced to 1 request/s anyway.
	hours: 1,
};

/** Default options of every job (SPEC §10.9). */
export const DEFAULT_JOB_OPTIONS = {
	attempts: 4,
	backoff: { type: "exponential", delay: 30_000 },
	removeOnComplete: { age: 7 * 24 * 3600 },
	removeOnFail: { age: 14 * 24 * 3600 },
} as const satisfies JobsOptions;

/** BullMQ's key prefix: `${REDIS_PREFIX}:bull` (queue keys become `…:bull:<queue>:…`). */
export function bullPrefix(): string {
	return key("bull");
}

/** Per-trip progress counters (reset by the worker when everything is done). */
export function jobCounterKeys(tripId: string, queue: QueueName) {
	return {
		total: key("jobs", tripId, queue, "total"),
		done: key("jobs", tripId, queue, "done"),
	};
}
/** Counters expire so a crashed or purged queue never leaves progress stuck forever. */
export const JOB_COUNTER_TTL_S = 24 * 3600;

const QUEUES = Symbol.for("yonder.live.queues");
const g = globalThis as typeof globalThis & {
	[QUEUES]?: Map<string, Queue>;
};

/** The (lazily created, cached) Queue for `name`. */
export function getQueue(name: QueueName): Queue {
	g[QUEUES] ??= new Map();
	const cacheKey = `${bullPrefix()}|${name}`;
	let q = g[QUEUES].get(cacheKey);
	if (!q) {
		q = new Queue(name, { connection: redisForBull(), prefix: bullPrefix() });
		q.on("error", (e) => console.error(`[jobs:${name}]`, e.message));
		g[QUEUES].set(cacheKey, q);
	}
	return q;
}

/** Closes every cached Queue (graceful shutdown, tests). */
export async function closeQueues(): Promise<void> {
	const qs = [...(g[QUEUES]?.values() ?? [])];
	g[QUEUES]?.clear();
	await Promise.allSettled(qs.map((q) => q.close()));
}

export type EnqueueOptions = {
	/** Jobs with the same id are not added again while one is waiting or running. */
	dedupeId?: string;
	/**
	 * With `dedupeId`: an add while that job is RUNNING queues one follow-up
	 * run (BullMQ `keepLastIfActive`), so a change made mid-run is never missed.
	 */
	dedupeKeepLast?: boolean;
	/** A fixed job id (an add is a no-op while a job with it exists). No ':'. */
	jobId?: string;
	/** Run no earlier than this many ms from now. */
	delay?: number;
	/** Override retries (tests). */
	attempts?: number;
	backoffMs?: number;
};

export type Enqueued = { id: string; added: boolean };

/**
 * Adds a job. Validates the payload, applies the SPEC defaults and increments the
 * trip's `total` progress counter when a job was really added (not deduplicated).
 *
 * Call it only after the data it refers to has COMMITTED (use `out.job(...)` inside
 * `withTripTx`, which does exactly that). Returns null — and logs — when Redis is
 * unavailable; it never throws for that, because the caller's write already happened.
 */
export async function enqueue<Q extends QueueName, N extends JobName<Q>>(
	queue: Q,
	name: N,
	data: JobData<Q, N>,
	opts: EnqueueOptions = {},
): Promise<Enqueued | null> {
	const schema = (JOB_SCHEMAS[queue] as Record<string, z.ZodType>)[name];
	if (!schema) throw new Error(`unknown job ${queue}/${name}`);
	const payload = schema.parse(data) as { tripId?: string };
	const jobId = opts.jobId ?? uuidv7();
	try {
		const job = await getQueue(queue).add(name, payload, {
			...DEFAULT_JOB_OPTIONS,
			...(opts.attempts !== undefined ? { attempts: opts.attempts } : {}),
			...(opts.backoffMs !== undefined
				? { backoff: { type: "exponential", delay: opts.backoffMs } }
				: {}),
			jobId,
			...(opts.delay ? { delay: opts.delay } : {}),
			...(opts.dedupeId
				? {
						deduplication: {
							id: opts.dedupeId,
							...(opts.dedupeKeepLast ? { keepLastIfActive: true } : {}),
						},
					}
				: {}),
		});
		// A deduplicated add returns the job that already exists.
		const added = job.id === jobId;
		if (added && payload.tripId && !isSilentQueue(queue)) {
			const k = jobCounterKeys(payload.tripId, queue);
			await redis()
				.multi()
				.incr(k.total)
				.expire(k.total, JOB_COUNTER_TTL_S)
				.expire(k.done, JOB_COUNTER_TTL_S)
				.exec();
		}
		return { id: job.id ?? jobId, added };
	} catch (e) {
		console.error(
			`[jobs] enqueue ${queue}/${name} failed${payload.tripId ? ` for trip ${payload.tripId}` : ""}:`,
			e instanceof Error ? e.message : e,
		);
		return null;
	}
}

/** When the daily FX job runs (EXTENSIONS §8.5: after the ECB/currency-api publish). */
export const FX_DAILY_SCHEDULE = {
	pattern: "30 16 * * *",
	tz: "Europe/Berlin",
} as const;

/** When the OSM hours refresh runs: hourly, at an odd minute (not on the hour). */
export const OSM_HOURS_REFRESH_SCHEDULE = { pattern: "23 * * * *" } as const;

/**
 * Web Push: every trip that may still plan a reminder is synced hourly, so
 * reminders beyond the 48 h scheduling horizon are picked up in time.
 */
export const PUSH_SWEEP_SCHEDULE = { pattern: "7 * * * *" } as const;

/**
 * Registers the repeating jobs (idempotent: an upsert by scheduler id), from
 * every worker process at start: `money.fxDaily` at 16:30 Europe/Berlin,
 * `hours.osmRefresh` hourly and, while push is on, `push.sweep` hourly (plus
 * one sweep right away, so a restart never leaves a gap). Never throws (a
 * Redis hiccup must not stop the worker).
 */
export async function scheduleRecurringJobs(): Promise<void> {
	try {
		await getQueue("hours").upsertJobScheduler(
			"hours.osmRefresh",
			OSM_HOURS_REFRESH_SCHEDULE,
			{
				name: "hours.osmRefresh",
				data: {},
				opts: {
					// The next run is an hour away: one retry is plenty.
					attempts: 2,
					backoff: DEFAULT_JOB_OPTIONS.backoff,
					removeOnComplete: DEFAULT_JOB_OPTIONS.removeOnComplete,
					removeOnFail: DEFAULT_JOB_OPTIONS.removeOnFail,
				},
			},
		);
	} catch (e) {
		console.error(
			"[jobs] scheduling hours.osmRefresh failed:",
			e instanceof Error ? e.message : e,
		);
	}
	try {
		await getQueue("money").upsertJobScheduler(
			"money.fxDaily",
			FX_DAILY_SCHEDULE,
			{
				name: "money.fxDaily",
				data: {},
				opts: {
					attempts: DEFAULT_JOB_OPTIONS.attempts,
					backoff: DEFAULT_JOB_OPTIONS.backoff,
					removeOnComplete: DEFAULT_JOB_OPTIONS.removeOnComplete,
					removeOnFail: DEFAULT_JOB_OPTIONS.removeOnFail,
				},
			},
		);
	} catch (e) {
		console.error(
			"[jobs] scheduling money.fxDaily failed:",
			e instanceof Error ? e.message : e,
		);
	}
	try {
		const push = getQueue("push");
		if (pushEnabled()) {
			await push.upsertJobScheduler("push.sweep", PUSH_SWEEP_SCHEDULE, {
				name: "push.sweep",
				data: {},
				opts: {
					attempts: 2,
					removeOnComplete: { age: 24 * 3600 },
					removeOnFail: DEFAULT_JOB_OPTIONS.removeOnFail,
				},
			});
			await enqueue("push", "push.sweep", {}, { dedupeId: "push-sweep-start" });
		} else await push.removeJobScheduler("push.sweep");
	} catch (e) {
		console.error(
			"[jobs] scheduling push.sweep failed:",
			e instanceof Error ? e.message : e,
		);
	}
}
