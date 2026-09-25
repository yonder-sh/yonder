/**
 * Fills opening hours from OpenStreetMap for the places that have an OSM ref
 * but no OSM fetch for it yet (places added before the `hours` jobs existed),
 * in batched Overpass requests paced to 1/s (the pace is shared with the
 * worker through Redis). Never touches manual or Google hours; idempotent (a
 * second run finds nothing to do). `--stale` also refreshes OSM hours whose
 * last fetch is 30+ days old; `--dry-run` only counts. Run where
 * DATABASE_URL, REDIS_URL / REDIS_PREFIX and OSM_CONTACT point at the target:
 *
 *   N pnpm hours:osm-backfill [--stale] [--dry-run]            (dev)
 *   kubectl -n yonder exec deploy/worker -- node .output/collab/hours-osm-backfill.mjs
 */
import { parseArgs } from "node:util";
import { closeDb } from "../src/db/db.server";
import {
	dueOsmNodes,
	syncOsmHours,
} from "../src/features/insights/server/osm-hours-sync.server";
import { closeRedis } from "../src/server/live/redis.server";

const { values } = parseArgs({
	options: {
		stale: { type: "boolean", default: false },
		"dry-run": { type: "boolean", default: false },
	},
});
const stale = values.stale === true;
/** Places per round (one Overpass request per 100 of them). */
const ROUND = 400;

let cursor = "00000000-0000-0000-0000-000000000000";
let places = 0;
let looked = 0;
let stamped = 0;
let changed = 0;
try {
	if (values["dry-run"]) {
		for (;;) {
			const due = await dueOsmNodes({ stale, limit: 5000, afterId: cursor });
			if (!due.length) break;
			places += due.length;
			cursor = due.at(-1)?.id ?? cursor;
		}
		console.log(`${places} places would be fetched (dry run).`);
	} else {
		for (;;) {
			// By node id: each place is tried once per run, even one that fails.
			const due = await dueOsmNodes({ stale, limit: ROUND, afterId: cursor });
			if (!due.length) break;
			cursor = due.at(-1)?.id ?? cursor;
			const r = await syncOsmHours(due, {
				log: (m) => console.log(`[hours] ${m}`),
			});
			places += due.length;
			looked += r.looked;
			stamped += r.stamped;
			changed += r.changed.length;
			console.log(
				`[hours] ${places} places so far: ${stamped} fetched, ${changed} with new hours`,
			);
		}
		console.log(
			`OSM hours: ${places} places, ${looked} OSM objects, ${stamped} fetched, ${changed} got new hours (${places - stamped} left as they were).`,
		);
	}
} finally {
	await closeRedis();
	await closeDb();
}
