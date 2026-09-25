import { climateForCell } from "@/features/insights/server/climate.server";
import {
	osmHoursForTrip,
	osmHoursRefresh,
} from "@/features/insights/server/osm-hours-sync.server";
import {
	linkPreview,
	mediaPoster,
	mediaVariants,
} from "@/features/media/server/jobs.server";
import { fxDaily, fxRehome } from "@/features/money/server/fx.server";
import { autofillLeg } from "@/features/transit/server/autofill.server";
import type { TripKey } from "@/lib/query/keys";
import {
	handlePushEvents,
	handlePushFlush,
	handlePushRemind,
	handlePushSweep,
	handlePushSync,
} from "@/server/push/handlers.server";
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
 * WP-Money: `fxDaily`, `fxRehome`; WP-Insights: `climateForCell`,
 * `osmHoursForTrip`, `osmHoursRefresh`; Web Push:
 * `src/server/push/handlers.server.ts`); this file
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
	// Web Push: nothing to invalidate (a notification changes no trip data).
	push: {
		"push.events": async (data) => {
			await handlePushEvents(data);
			return {};
		},
		"push.flush": async (data) => {
			await handlePushFlush(data);
			return {};
		},
		"push.sync": async (data) => {
			await handlePushSync(data);
			return {};
		},
		"push.remind": async (data) => {
			await handlePushRemind(data);
			return {};
		},
		"push.sweep": async () => {
			await handlePushSweep();
			return {};
		},
		"test.ping": ping,
	},
	hours: {
		// Both announce their own changes (`graph`, per trip, after COMMIT).
		"hours.osm": async (data, ctx) => {
			const r = await osmHoursForTrip(data.tripId, { log: ctx.log });
			if (r.looked) ctx.log(osmSummary(r));
			return {};
		},
		"hours.osmRefresh": async (_data, ctx) => {
			const r = await osmHoursRefresh({ log: ctx.log });
			if (r.looked) ctx.log(osmSummary(r));
			return {};
		},
		"test.ping": ping,
	},
};

function osmSummary(r: {
	looked: number;
	stamped: number;
	changed: string[];
}): string {
	return `OSM hours: ${r.looked} objects, ${r.stamped} places stamped, ${r.changed.length} changed`;
}
