/**
 * Creates this checkout's S3 bucket (`S3_BUCKET`) if it is missing (SPEC §5.3).
 *
 *   N pnpm s3:init
 */
import { bucket, ensureBucket, resetS3 } from "../src/server/s3.server";

const name = bucket();
ensureBucket(name)
	.then((created) =>
		console.log(`[s3:init] bucket ${name} ${created ? "created" : "exists"}`),
	)
	.catch((e: unknown) => {
		console.error("[s3:init]", e instanceof Error ? e.message : e);
		process.exitCode = 1;
	})
	.finally(() => resetS3());
