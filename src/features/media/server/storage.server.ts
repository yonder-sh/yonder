/**
 * S3 object helpers for WP-Media on top of F's clients (`@/server/s3.server`,
 * SPEC §15.1): presigned PUTs with the content type and length signed
 * (spikes/media), short-lived presigned GETs, copies, streaming and prefix
 * deletes. Keys always come from `mediaKey`/`mediaPrefix` (never a user
 * filename).
 *
 * Browsers PUT to an upload key (`original.upload`, `poster.upload`) that is
 * never served or processed; `completeUpload` copies it to the served key and
 * checks the copy (SEC-R1-08). A presigned PUT stays usable until it expires,
 * so a second PUT after finalize only replaces the unused upload object.
 *
 * A duplicated trip's attachments re-reference the source's objects (ADDENDUM
 * §9 "re-referenced, not re-uploaded"): the copy keeps the source row's
 * `storage_key`, `image_key` and `favicon_key`. So reads always go through
 * `rowKey` (the row's own `storage_key` prefix), and the purge only deletes a
 * prefix nothing else still points at.
 */
import {
	AbortMultipartUploadCommand,
	CompleteMultipartUploadCommand,
	CopyObjectCommand,
	CreateMultipartUploadCommand,
	DeleteObjectCommand,
	DeleteObjectsCommand,
	GetObjectCommand,
	HeadObjectCommand,
	ListObjectsV2Command,
	ListPartsCommand,
	PutObjectCommand,
	UploadPartCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { bucket, mediaPrefix, publicS3, s3 } from "@/server/s3.server";

/** Every variant name we store under an attachment's prefix (pages are `page-<n>.webp`). */
export type StoredVariant =
	| "original"
	| "thumb.webp"
	| "display.webp"
	| "poster.jpg"
	| "image.webp"
	| "favicon.webp"
	| `page-${number}.webp`;

export function objectKey(
	tripId: string,
	attachmentId: string,
	variant: StoredVariant,
): string {
	return `${mediaPrefix(tripId, attachmentId)}${variant}`;
}

const PREFIX_RE =
	/^trips\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/$/i;

/** True for an attachment prefix `trips/<uuid>/<uuid>/`. */
export function isAttachmentPrefix(p: string | null | undefined): p is string {
	return !!p && PREFIX_RE.test(p);
}

/** Where the browser PUTs an upload before `completeUpload` copies it to its served key. */
export type UploadSlot = "original.upload" | "poster.upload";

export function uploadKey(
	tripId: string,
	attachmentId: string,
	slot: UploadSlot,
): string {
	return `${mediaPrefix(tripId, attachmentId)}${slot}`;
}

/** The attachment prefix a stored key lives under, or null. */
export function prefixOfKey(key: string | null | undefined): string | null {
	if (!key) return null;
	const p = key.slice(0, key.lastIndexOf("/") + 1);
	return isAttachmentPrefix(p) ? p : null;
}

type KeyedRow = { tripId: string; id: string; storageKey: string | null };

/**
 * Where a row's uploaded objects live: its `storage_key` (a duplicated trip's
 * copy shares the source's), else its own `trips/<trip>/<id>/`.
 */
export function rowPrefix(row: KeyedRow): string {
	return isAttachmentPrefix(row.storageKey)
		? row.storageKey
		: mediaPrefix(row.tripId, row.id);
}

/** One variant of a row's uploaded objects (see `rowPrefix`). */
export function rowKey(row: KeyedRow, variant: StoredVariant): string {
	return `${rowPrefix(row)}${variant}`;
}

/** How long a presigned PUT lives (SEC-R1-08: at most 10 min). */
export const PUT_TTL_SEC = 600;
/**
 * How long a presigned GET lives (SEC-R1-08: at most 15 min, so a removed
 * member or a "Hide from guests" change is not bypassed for long). Signing
 * dates are floored to `GET_WINDOW_SEC`, so one variant keeps one URL (and
 * the browser's cached copy) for that window, and every URL handed out is
 * valid for at least `GET_TTL_SEC - GET_WINDOW_SEC` = 10 min.
 */
export const GET_TTL_SEC = 900;
export const GET_WINDOW_SEC = 300;

/** A browser PUT URL (`PUT_TTL_SEC`) that only accepts exactly this type and length. */
export async function presignPut(
	key: string,
	contentType: string,
	contentLength: number,
): Promise<string> {
	return getSignedUrl(
		publicS3(),
		new PutObjectCommand({
			Bucket: bucket(),
			Key: key,
			ContentType: contentType,
			ContentLength: contentLength,
		}),
		{
			expiresIn: PUT_TTL_SEC,
			signableHeaders: new Set(["content-type", "content-length"]),
		},
	);
}

/**
 * Multipart uploads (files over `MULTIPART_PART_BYTES`): the server starts
 * the upload with the content type (`createMultipart`), presigns each part
 * with its exact length signed (`presignPart`, `PUT_TTL_SEC`, on request as
 * the browser gets to it), and finishes it from its own `ListParts`
 * (`completeMultipart`: every part there, each exactly its size), so the
 * browser never supplies ETags or sizes. The result lands on the upload key,
 * and `completeUpload` copies and checks it like a single PUT (SEC-R1-08).
 */
export async function createMultipart(
	key: string,
	contentType: string,
): Promise<string> {
	const r = await s3().send(
		new CreateMultipartUploadCommand({
			Bucket: bucket(),
			Key: key,
			ContentType: contentType,
		}),
	);
	if (!r.UploadId) throw new Error("storage returned no upload id");
	return r.UploadId;
}

/** A browser PUT URL (`PUT_TTL_SEC`) for one part that only accepts exactly `contentLength` bytes. */
export async function presignPart(
	key: string,
	uploadId: string,
	partNumber: number,
	contentLength: number,
): Promise<string> {
	return getSignedUrl(
		publicS3(),
		new UploadPartCommand({
			Bucket: bucket(),
			Key: key,
			UploadId: uploadId,
			PartNumber: partNumber,
			ContentLength: contentLength,
		}),
		{
			expiresIn: PUT_TTL_SEC,
			signableHeaders: new Set(["content-length"]),
		},
	);
}

/** Part sizes of a `size`-byte file in `partSize` parts (the last one is the rest). */
export function partSizes(size: number, partSize: number): number[] {
	const n = Math.max(1, Math.ceil(size / partSize));
	return Array.from({ length: n }, (_, i) =>
		i < n - 1 ? partSize : size - partSize * (n - 1),
	);
}

export type PartsCheck =
	| { ok: true; parts: { PartNumber: number; ETag: string }[] }
	| { ok: false; reason: "gone" | "incomplete" };

/**
 * The upload's parts as storage has them, checked against the expected
 * sizes: every part 1…n present with exactly its size, nothing beyond n.
 * `gone` when storage no longer knows the upload (finished or aborted).
 */
export async function checkParts(
	key: string,
	uploadId: string,
	expected: number[],
): Promise<PartsCheck> {
	const seen = new Map<number, { size: number; etag: string }>();
	let marker: string | undefined;
	try {
		do {
			const r = await s3().send(
				new ListPartsCommand({
					Bucket: bucket(),
					Key: key,
					UploadId: uploadId,
					PartNumberMarker: marker,
				}),
			);
			for (const p of r.Parts ?? [])
				if (p.PartNumber && p.ETag)
					seen.set(p.PartNumber, { size: Number(p.Size ?? -1), etag: p.ETag });
			marker = r.IsTruncated ? r.NextPartNumberMarker : undefined;
		} while (marker);
	} catch (e) {
		if (isNoSuchUpload(e)) return { ok: false, reason: "gone" };
		throw e;
	}
	if (seen.size !== expected.length) return { ok: false, reason: "incomplete" };
	const parts: { PartNumber: number; ETag: string }[] = [];
	for (const [i, size] of expected.entries()) {
		const p = seen.get(i + 1);
		if (!p || p.size !== size) return { ok: false, reason: "incomplete" };
		parts.push({ PartNumber: i + 1, ETag: p.etag });
	}
	return { ok: true, parts };
}

export async function completeMultipart(
	key: string,
	uploadId: string,
	parts: { PartNumber: number; ETag: string }[],
): Promise<void> {
	await s3().send(
		new CompleteMultipartUploadCommand({
			Bucket: bucket(),
			Key: key,
			UploadId: uploadId,
			MultipartUpload: { Parts: parts },
		}),
	);
}

/** Drops an unfinished multipart upload and its parts (an unknown one is fine). */
export async function abortMultipart(
	key: string,
	uploadId: string,
): Promise<void> {
	try {
		await s3().send(
			new AbortMultipartUploadCommand({
				Bucket: bucket(),
				Key: key,
				UploadId: uploadId,
			}),
		);
	} catch (e) {
		if (!isNoSuchUpload(e)) throw e;
	}
}

function isNoSuchUpload(e: unknown): boolean {
	const status = (e as { $metadata?: { httpStatusCode?: number } }).$metadata
		?.httpStatusCode;
	return (e as { name?: string }).name === "NoSuchUpload" || status === 404;
}

/**
 * A browser GET URL. The signing date is floored to `GET_WINDOW_SEC` and the
 * URL lives `GET_TTL_SEC`, so one variant keeps one URL for 5 min (browser
 * caching) and every URL handed out is valid for at least another 10 min
 * (SPEC §15.5, tightened by SEC-R1-08).
 */
export async function presignGet(
	key: string,
	opts: {
		contentType?: string | null;
		disposition?: string;
		/** Server-side use (ffmpeg): sign against the internal endpoint. */
		internal?: boolean;
		now?: Date;
	} = {},
): Promise<string> {
	const now = (opts.now ?? new Date()).getTime();
	const step = GET_WINDOW_SEC * 1000;
	const signingDate = new Date(Math.floor(now / step) * step);
	return getSignedUrl(
		opts.internal ? s3() : publicS3(),
		new GetObjectCommand({
			Bucket: bucket(),
			Key: key,
			...(opts.contentType ? { ResponseContentType: opts.contentType } : {}),
			...(opts.disposition
				? { ResponseContentDisposition: opts.disposition }
				: {}),
		}),
		{ expiresIn: GET_TTL_SEC, signingDate },
	);
}

export type Head = { size: number; contentType: string | null } | null;

/** The object's size and type, or null when it doesn't exist. */
export async function headObject(key: string): Promise<Head> {
	try {
		const r = await s3().send(
			new HeadObjectCommand({ Bucket: bucket(), Key: key }),
		);
		return {
			size: Number(r.ContentLength ?? 0),
			contentType: r.ContentType ?? null,
		};
	} catch (e) {
		const status = (e as { $metadata?: { httpStatusCode?: number } }).$metadata
			?.httpStatusCode;
		if (status === 404 || (e as { name?: string }).name === "NotFound")
			return null;
		throw e;
	}
}

/** The first `n` bytes (magic-byte sniffing). */
export async function readHead(key: string, n = 64): Promise<Buffer> {
	const r = await s3().send(
		new GetObjectCommand({
			Bucket: bucket(),
			Key: key,
			Range: `bytes=0-${n - 1}`,
		}),
	);
	const bytes = await r.Body?.transformToByteArray();
	return Buffer.from(bytes ?? []);
}

/** The whole object, refusing anything over `maxBytes`. */
export async function readObject(
	key: string,
	maxBytes: number,
): Promise<Buffer> {
	const r = await s3().send(
		new GetObjectCommand({ Bucket: bucket(), Key: key }),
	);
	if (Number(r.ContentLength ?? 0) > maxBytes) {
		r.Body?.transformToWebStream().cancel();
		throw new Error("object too large");
	}
	const bytes = await r.Body?.transformToByteArray();
	return Buffer.from(bytes ?? []);
}

/** A web stream of the object for a same-origin response, or null when missing. */
export async function streamObject(key: string): Promise<{
	body: ReadableStream;
	size: number | null;
	etag: string | null;
} | null> {
	try {
		const r = await s3().send(
			new GetObjectCommand({ Bucket: bucket(), Key: key }),
		);
		if (!r.Body) return null;
		return {
			body: r.Body.transformToWebStream(),
			size: r.ContentLength ?? null,
			etag: r.ETag ?? null,
		};
	} catch (e) {
		const status = (e as { $metadata?: { httpStatusCode?: number } }).$metadata
			?.httpStatusCode;
		if (status === 404 || (e as { name?: string }).name === "NoSuchKey")
			return null;
		throw e;
	}
}

export async function putObject(
	key: string,
	body: Buffer,
	contentType: string,
): Promise<void> {
	await s3().send(
		new PutObjectCommand({
			Bucket: bucket(),
			Key: key,
			Body: body,
			ContentType: contentType,
			ContentLength: body.length,
		}),
	);
}

/** Server-side copy of one object (keeps its content type). */
export async function copyObject(from: string, to: string): Promise<void> {
	await s3().send(
		new CopyObjectCommand({
			Bucket: bucket(),
			Key: to,
			CopySource: `${bucket()}/${from.split("/").map(encodeURIComponent).join("/")}`,
			MetadataDirective: "COPY",
		}),
	);
}

/** Deletes one object (missing is fine). */
export async function deleteObject(key: string): Promise<void> {
	await s3().send(new DeleteObjectCommand({ Bucket: bucket(), Key: key }));
}

/** The attachment prefixes (`trips/<trip>/<id>/`) under a trip prefix. */
export async function listSubPrefixes(prefix: string): Promise<string[]> {
	const out: string[] = [];
	let token: string | undefined;
	do {
		const list = await s3().send(
			new ListObjectsV2Command({
				Bucket: bucket(),
				Prefix: prefix,
				Delimiter: "/",
				ContinuationToken: token,
			}),
		);
		for (const c of list.CommonPrefixes ?? []) if (c.Prefix) out.push(c.Prefix);
		token = list.IsTruncated ? list.NextContinuationToken : undefined;
	} while (token);
	return out;
}

/** Deletes every object under `prefix`; returns how many were deleted. */
export async function deletePrefix(prefix: string): Promise<number> {
	if (!prefix.startsWith("trips/") || !prefix.endsWith("/"))
		throw new Error(`refusing to delete prefix ${prefix}`);
	let deleted = 0;
	let token: string | undefined;
	do {
		const list = await s3().send(
			new ListObjectsV2Command({
				Bucket: bucket(),
				Prefix: prefix,
				ContinuationToken: token,
			}),
		);
		const keys = (list.Contents ?? [])
			.map((o) => o.Key)
			.filter((k): k is string => !!k);
		if (keys.length) {
			await s3().send(
				new DeleteObjectsCommand({
					Bucket: bucket(),
					Delete: { Objects: keys.map((Key) => ({ Key })), Quiet: true },
				}),
			);
			deleted += keys.length;
		}
		token = list.IsTruncated ? list.NextContinuationToken : undefined;
	} while (token);
	return deleted;
}
