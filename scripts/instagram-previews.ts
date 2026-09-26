/**
 * Fetches the picture and caption of every Instagram link saved before
 * Instagram links had previews (the rows without a picture), paced 2 s apart.
 * Idempotent: a second run only retries the rows Instagram still refused.
 * `--dry-run` only counts. Run where DATABASE_URL, REDIS_URL / REDIS_PREFIX
 * and S3_* point at the target:
 *
 *   N pnpm media:instagram-previews [--dry-run]            (dev)
 *   kubectl -n yonder exec deploy/worker -- node .output/collab/instagram-previews.mjs
 */
import { setTimeout as sleep } from "node:timers/promises";
import { parseArgs } from "node:util";
import { sql } from "drizzle-orm";
import { closeDb, getDb } from "../src/db/db.server";
import { linkPreview } from "../src/features/media/server/jobs.server";
import { closeRedis } from "../src/server/live/redis.server";

const { values } = parseArgs({
	options: { "dry-run": { type: "boolean", default: false } },
});

const rows = (
	await getDb().execute(sql`
		select id, trip_id as "tripId"
		from attachments
		where provider = 'instagram' and url is not null
			and image_key is null and deleted_at is null
		order by created_at`)
).rows as { id: string; tripId: string }[];

let done = 0;
if (!values["dry-run"])
	for (const [i, row] of rows.entries()) {
		if (i > 0) await sleep(2000);
		try {
			await linkPreview({ tripId: row.tripId, attachmentId: row.id });
			done++;
		} catch (e) {
			console.error(`[instagram] ${row.id}: ${(e as Error).message}`);
		}
	}
const left = (
	(
		await getDb().execute(sql`
			select count(*)::int as n from attachments
			where provider = 'instagram' and url is not null
				and image_key is null and deleted_at is null`)
	).rows[0] as { n: number }
).n;
console.log(
	values["dry-run"]
		? `${rows.length} Instagram links without a picture.`
		: `Fetched ${done} of ${rows.length}; ${left} still without a picture.`,
);
await closeDb();
await closeRedis();
