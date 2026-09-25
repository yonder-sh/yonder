/**
 * Database, bucket and Redis lifecycle for this checkout (SPEC §5.3, §5.7).
 * Every step touches ONLY this checkout's own resources: the database in
 * DATABASE_URL, the bucket S3_BUCKET and the keys under REDIS_PREFIX. Nothing
 * here runs `docker compose down`, `FLUSHALL` or touches another agent's
 * database, bucket or prefix.
 */
import { DeleteObjectsCommand, ListObjectsV2Command } from "@aws-sdk/client-s3";
import { closeDb, getDb } from "../../src/db/db.server";
import {
	databaseName,
	dropDatabase,
	ensureDatabase,
	migrateDatabase,
} from "../../src/db/migrate.server";
import { seedDev } from "../../src/server/fixture.server";
import {
	closeRedis,
	redis,
	redisPrefix,
} from "../../src/server/live/redis.server";
import { bucket, ensureBucket, resetS3, s3 } from "../../src/server/s3.server";

export function databaseUrl(): string {
	const url = process.env.DATABASE_URL;
	if (!url) throw new Error("DATABASE_URL is not set (see .env.example)");
	return url;
}

/** Creates the database if missing, then migrates it. */
export async function createDatabase(url = databaseUrl()): Promise<void> {
	const created = await ensureDatabase(url);
	await migrateDatabase(url);
	console.log(
		`[db] ${databaseName(url)} ${created ? "created and " : ""}migrated`,
	);
}

/** Deletes every object in this checkout's bucket (never the bucket itself). */
export async function emptyBucket(name = bucket()): Promise<number> {
	let removed = 0;
	let token: string | undefined;
	try {
		do {
			const page = await s3().send(
				new ListObjectsV2Command({ Bucket: name, ContinuationToken: token }),
			);
			const keys = (page.Contents ?? []).flatMap((o) =>
				o.Key ? [{ Key: o.Key }] : [],
			);
			if (keys.length) {
				await s3().send(
					new DeleteObjectsCommand({ Bucket: name, Delete: { Objects: keys } }),
				);
				removed += keys.length;
			}
			token = page.IsTruncated ? page.NextContinuationToken : undefined;
		} while (token);
	} catch (e) {
		if ((e as { name?: string }).name === "NoSuchBucket") return 0;
		throw e;
	}
	return removed;
}

/** SCAN + UNLINK every key under `${REDIS_PREFIX}:` (never FLUSHALL). */
export async function deleteRedisPrefix(): Promise<number> {
	const r = redis();
	const pattern = `${redisPrefix()}:*`;
	let cursor = "0";
	let removed = 0;
	do {
		const [next, keys] = await r.scan(cursor, "MATCH", pattern, "COUNT", 500);
		cursor = next;
		if (keys.length) removed += await r.unlink(...keys);
	} while (cursor !== "0");
	return removed;
}

/**
 * `db:create`: this checkout's database and bucket if missing, migrated, the
 * bucket created, and (unless `seed: false`) the dev seed.
 */
export async function createAll(opts: { seed?: boolean } = {}): Promise<void> {
	await createDatabase();
	const made = await ensureBucket();
	console.log(`[s3] bucket ${bucket()} ${made ? "created" : "exists"}`);
	if (opts.seed !== false) {
		const r = await seedDev(getDb());
		console.log(
			`[seed] demo trip ${r.slug} (${r.tripId}); sign in as dev@example.com`,
		);
	}
}

/**
 * `db:reset`: drops this checkout's database (refusing `trip` unless `main`),
 * empties its bucket, deletes its Redis prefix, then `createAll`.
 */
export async function resetAll(
	opts: { main?: boolean; seed?: boolean } = {},
): Promise<void> {
	const url = databaseUrl();
	const name = databaseName(url);
	if (name === "trip" && !opts.main)
		throw new Error('refusing to reset the main database "trip" (pass --main)');
	await closeDb();
	await dropDatabase(url, { allowMain: opts.main });
	console.log(`[db] ${name} dropped`);
	console.log(`[s3] ${await emptyBucket()} objects removed from ${bucket()}`);
	console.log(
		`[redis] ${await deleteRedisPrefix()} keys removed under ${redisPrefix()}:`,
	);
	await createAll(opts);
}

/** Closes every client so the process can exit. */
export async function closeAll(): Promise<void> {
	await closeDb();
	await closeRedis();
	resetS3();
}

/** Runs a CLI body and exits non-zero on failure. */
export function run(name: string, body: () => Promise<void>): void {
	body()
		.catch((e: unknown) => {
			console.error(`[${name}]`, e instanceof Error ? e.message : e);
			process.exitCode = 1;
		})
		.finally(() => closeAll());
}
