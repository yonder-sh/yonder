/**
 * S3 clients (SPEC §15.1; spikes/media). Server-only.
 *
 * - `s3()` talks to `S3_ENDPOINT` for server I/O (uploads checks, variants,
 *   purges, bucket setup).
 * - `publicS3()` uses `S3_PUBLIC_ENDPOINT` (the host the BROWSER reaches) and
 *   exists ONLY for presigning; SigV4 signs the host, so a URL presigned against
 *   the internal endpoint would not work in the browser.
 *
 * Both are path-style (s3proxy) and only send checksums when an operation
 * requires them: SDK >= 3.729 otherwise puts `x-amz-checksum-*` into presigned
 * PUT URLs, which a browser can't compute (spikes/media gotcha).
 *
 * Object keys: `trips/<tripId>/<attachmentId>/{original, thumb.webp,
 * display.webp, poster.jpg, image.webp, favicon.webp}` (`mediaKey`). User
 * filenames are never used.
 */
import {
	CreateBucketCommand,
	HeadBucketCommand,
	S3Client,
} from "@aws-sdk/client-s3";
import { getEnv } from "./env.server";

let internal: S3Client | undefined;
let external: S3Client | undefined;

function makeClient(endpoint: string): S3Client {
	const env = getEnv();
	return new S3Client({
		endpoint,
		region: env.S3_REGION,
		forcePathStyle: env.S3_FORCE_PATH_STYLE,
		credentials: {
			accessKeyId: env.S3_ACCESS_KEY_ID,
			secretAccessKey: env.S3_SECRET_ACCESS_KEY,
		},
		requestChecksumCalculation: "WHEN_REQUIRED",
		responseChecksumValidation: "WHEN_REQUIRED",
	});
}

/** The client for server-side S3 I/O (`S3_ENDPOINT`). */
export function s3(): S3Client {
	internal ??= makeClient(getEnv().S3_ENDPOINT);
	return internal;
}

/** The client for presigning browser URLs (`S3_PUBLIC_ENDPOINT`, else `S3_ENDPOINT`). Never use it for I/O. */
export function publicS3(): S3Client {
	const env = getEnv();
	external ??= makeClient(env.S3_PUBLIC_ENDPOINT ?? env.S3_ENDPOINT);
	return external;
}

/** The bucket (`S3_BUCKET`; per agent `trip-media-a<n>`). */
export function bucket(): string {
	return getEnv().S3_BUCKET;
}

export type MediaVariant =
	| "original"
	| "thumb.webp"
	| "display.webp"
	| "poster.jpg"
	| "image.webp"
	| "favicon.webp";

/** `trips/<tripId>/<attachmentId>/` — the prefix of every object of one attachment. */
export function mediaPrefix(tripId: string, attachmentId: string): string {
	return `trips/${tripId}/${attachmentId}/`;
}

/** The object key of one variant of an attachment. */
export function mediaKey(
	tripId: string,
	attachmentId: string,
	variant: MediaVariant,
): string {
	return `${mediaPrefix(tripId, attachmentId)}${variant}`;
}

/** Creates the bucket if it doesn't exist. Returns true when it was created. */
export async function ensureBucket(name = bucket()): Promise<boolean> {
	try {
		await s3().send(new HeadBucketCommand({ Bucket: name }));
		return false;
	} catch (e) {
		const status = (e as { $metadata?: { httpStatusCode?: number } }).$metadata
			?.httpStatusCode;
		if (status !== 404 && (e as { name?: string }).name !== "NotFound") throw e;
	}
	await s3().send(new CreateBucketCommand({ Bucket: name }));
	return true;
}

/** Tests and scripts: drop the memoized clients (e.g. after changing env). */
export function resetS3(): void {
	internal?.destroy();
	external?.destroy();
	internal = undefined;
	external = undefined;
}
