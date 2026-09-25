import { climateForCell } from "@/features/insights/server/climate.server";
import {
	linkPreview,
	mediaPoster,
	mediaVariants,
} from "@/features/media/server/jobs.server";
import { fxDaily, fxRehome } from "@/features/money/server/fx.server";
import { autofillLeg } from "@/features/transit/server/autofill.server";
import type { TripKey } from "@/lib/query/keys";
import type { JobData, JobName, QueueName } from "./jobs.server";

/**
 * Job handlers, by queue and job name (SPEC §10.9). The worker process
 * (`collab/worker.ts`) validates each payload against `JOB_SCHEMAS` and calls the
 * handler here.
 *
 * A handler does the work and returns which TripKeys it changed; the worker then
 * publishes one `invalidate` for the trip at most every 2 s (plus the `job`
 * progress events). Handlers that write rows should do so through `withTripTx`
 * without `out.emit(...)`, so the version still goes up and the worker's gated
 * invalidation announces the change.
 *
 * Throwing fails the attempt; BullMQ retries with exponential backoff
 * (`DEFAULT_JOB_OPTIONS`). Throw `new UnrecoverableError(...)` from `bullmq` to
 * give up at once (e.g. the attachment was deleted).
 */

export type JobResult = {
	/** Keys to invalidate on the job's trip after it finished (none = no event). */
	keys?: TripKey[];
};

export type JobContext = {
	/** BullMQ job id (stable across retries). */
	jobId: string;
	/** 1-based attempt number. */
	attempt: number;
	signal?: AbortSignal;
	log: (msg: string) => void;
};

export type JobHandler<Q extends QueueName, N extends JobName<Q>> = (
	data: JobData<Q, N>,
	ctx: JobContext,
) => Promise<JobResult | undefined>;

export type JobHandlers = {
	[Q in QueueName]: { [N in JobName<Q>]: JobHandler<Q, N> };
};

/** The sample job: proves the pipeline end to end (enqueue → worker → events). */
const ping = async (
	data: { tripId: string; keys?: TripKey[]; failTimes?: number },
	ctx: JobContext,
): Promise<JobResult> => {
	if (data.failTimes && ctx.attempt <= data.failTimes) {
		throw new Error(
			`test.ping: planned failure ${ctx.attempt}/${data.failTimes}`,
		);
	}
	ctx.log(`test.ping for trip ${data.tripId}`);
	return { keys: data.keys ?? [] };
};

/**
 * The handler table. The bodies belong to the feature packages (WP-Transit:
 * `autofillLeg`; WP-Media: `mediaVariants`, `mediaPoster`, `linkPreview`;
 * WP-Money: `fxDaily`, `fxRehome`; WP-Insights: `climateForCell`); this file
 * only routes queue/job names to them, so a package never edits it.
 */
export const jobHandlers: JobHandlers = {
	autofill: {
		autofill: (data) => autofillLeg(data.tripId, data.target),
		"test.ping": ping,
	},
	media: {
		"media.variants": (data) => mediaVariants(data),
		"media.poster": (data) => mediaPoster(data),
		"test.ping": ping,
	},
	links: {
		"links.preview": (data) => linkPreview(data),
		"test.ping": ping,
	},
	money: {
		"money.fxDaily": async () => {
			await fxDaily();
			return {};
		},
		"money.fxRehome": async (data) => {
			await fxRehome(data.tripId);
			return { keys: ["money"] };
		},
		"test.ping": ping,
	},
	climate: {
		"climate.cell": async (data) => {
			await climateForCell(data.cell);
			// The node's ClimateCard reads it through `getClimate` (not a trip key).
			return {};
		},
		"test.ping": ping,
	},
};
