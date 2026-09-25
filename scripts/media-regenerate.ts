/**
 * Re-renders every photo's thumb and display variants (and video thumbs from
 * their poster) from the stored originals, after the variant sizes change.
 * Idempotent. Run where DATABASE_URL and S3_* point at the target:
 *
 *   N pnpm media:regenerate                        (dev)
 *   kubectl -n yonder exec deploy/worker -- node .output/collab/media-regenerate.mjs
 */
import { sql } from "drizzle-orm";
import { closeDb, getDb } from "../src/db/db.server";
import { IMAGE_MAX_BYTES } from "../src/features/media/media-kinds";
import {
	photoVariants,
	thumbFrom,
} from "../src/features/media/server/images.server";
import {
	putObject,
	readObject,
	rowKey,
	rowPrefix,
} from "../src/features/media/server/storage.server";

type Row = {
	id: string;
	tripId: string;
	storageKey: string | null;
	kind: string;
};

const db = getDb();
const rows = (
	await db.execute(sql`
		select id, trip_id as "tripId", storage_key as "storageKey", kind
		from attachments
		where status = 'ready' and kind in ('photo', 'video')`)
).rows as Row[];

// Duplicated trips share their source's objects: render each prefix once.
const seen = new Set<string>();
let done = 0;
let failed = 0;
for (const row of rows) {
	const prefix = rowPrefix(row);
	if (seen.has(prefix)) continue;
	seen.add(prefix);
	try {
		if (row.kind === "photo") {
			const buf = await readObject(rowKey(row, "original"), IMAGE_MAX_BYTES);
			const v = await photoVariants(buf);
			await putObject(rowKey(row, "thumb.webp"), v.thumb, "image/webp");
			await putObject(rowKey(row, "display.webp"), v.display, "image/webp");
		} else {
			const poster = await readObject(
				rowKey(row, "poster.jpg"),
				IMAGE_MAX_BYTES,
			);
			const v = await thumbFrom(poster);
			await putObject(rowKey(row, "thumb.webp"), v.thumb, "image/webp");
		}
		done++;
	} catch (e) {
		failed++;
		console.error(`[media] ${row.id}: ${(e as Error).message}`);
	}
}
console.log(`Re-rendered ${done} of ${seen.size} media (${failed} failed).`);
await closeDb();
