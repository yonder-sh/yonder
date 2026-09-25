/**
 * Imported photos (SPEC §17.3 step 10, §15.1–§15.2): the original plus the
 * §15 variants, written with sharp exactly like the worker would —
 * `thumb.webp` (480, q75) and `display.webp` (1920, q80), EXIF stripped, and a
 * base64 thumbhash of the 100 × 100 RGBA — under the attachment's keys
 * `trips/<tripId>/<attachmentId>/{original,thumb.webp,display.webp}`.
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import {
	DeleteObjectsCommand,
	ListObjectsV2Command,
	PutObjectCommand,
} from "@aws-sdk/client-s3";
import sharp from "sharp";
import { rgbaToThumbHash } from "thumbhash";
import { bucket, mediaKey, mediaPrefix, s3 } from "@/server/s3.server";

export type ProcessedPhoto = {
	original: Buffer;
	contentType: string;
	thumb: Buffer;
	display: Buffer;
	width: number;
	height: number;
	thumbhash: string;
	sizeBytes: number;
};

/** Every untrusted decode goes through the pixel limit and EXIF rotation (§15.2). */
const open = (buf: Buffer) =>
	sharp(buf, { limitInputPixels: 50e6, failOn: "error" }).rotate();

export async function processPhoto(
	file: string,
	contentType: string,
): Promise<ProcessedPhoto> {
	const original = await readFile(file);
	const meta = await sharp(original, { limitInputPixels: 50e6 }).metadata();
	const width = meta.autoOrient?.width ?? meta.width;
	const height = meta.autoOrient?.height ?? meta.height;
	if (!width || !height) throw new Error(`${file}: not an image`);
	const [thumb, display, small] = await Promise.all([
		open(original)
			.resize(480, 480, { fit: "inside", withoutEnlargement: true })
			.webp({ quality: 75 })
			.toBuffer(),
		open(original)
			.resize(1920, 1920, { fit: "inside", withoutEnlargement: true })
			.webp({ quality: 80 })
			.toBuffer(),
		open(original)
			.resize(100, 100, { fit: "inside" })
			.ensureAlpha()
			.raw()
			.toBuffer({ resolveWithObject: true }),
	]);
	const hash = rgbaToThumbHash(
		small.info.width,
		small.info.height,
		new Uint8Array(
			small.data.buffer,
			small.data.byteOffset,
			small.data.byteLength,
		),
	);
	return {
		original,
		contentType,
		thumb,
		display,
		width,
		height,
		thumbhash: Buffer.from(hash).toString("base64"),
		sizeBytes: original.byteLength,
	};
}

export async function uploadPhoto(
	tripId: string,
	attachmentId: string,
	p: ProcessedPhoto,
): Promise<void> {
	const put = (
		variant: "original" | "thumb.webp" | "display.webp",
		body: Buffer,
		type: string,
	) =>
		s3().send(
			new PutObjectCommand({
				Bucket: bucket(),
				Key: mediaKey(tripId, attachmentId, variant),
				Body: body,
				ContentType: type,
				ContentLength: body.byteLength,
			}),
		);
	await put("original", p.original, p.contentType);
	await put("thumb.webp", p.thumb, "image/webp");
	await put("display.webp", p.display, "image/webp");
}

/** Deletes every object under `trips/<tripId>/` (the `--replace` cleanup and failed imports). */
export async function deleteTripObjects(tripId: string): Promise<number> {
	const prefix = `trips/${tripId}/`;
	let removed = 0;
	let token: string | undefined;
	do {
		const page = await s3().send(
			new ListObjectsV2Command({
				Bucket: bucket(),
				Prefix: prefix,
				ContinuationToken: token,
			}),
		);
		const keys = (page.Contents ?? []).flatMap((o) =>
			o.Key ? [{ Key: o.Key }] : [],
		);
		if (keys.length) {
			await s3().send(
				new DeleteObjectsCommand({
					Bucket: bucket(),
					Delete: { Objects: keys },
				}),
			);
			removed += keys.length;
		}
		token = page.IsTruncated ? page.NextContinuationToken : undefined;
	} while (token);
	return removed;
}

/** Runs `fn` over `xs` with at most `limit` in flight (keeps sharp's memory bounded). */
export async function mapLimit<T, R>(
	xs: readonly T[],
	limit: number,
	fn: (x: T, i: number) => Promise<R>,
): Promise<R[]> {
	const out: R[] = new Array(xs.length);
	let next = 0;
	const worker = async () => {
		while (next < xs.length) {
			const i = next++;
			out[i] = await fn(xs[i] as T, i);
		}
	};
	await Promise.all(Array.from({ length: Math.min(limit, xs.length) }, worker));
	return out;
}

export const photoPath = (mediaDir: string, file: string) =>
	path.join(mediaDir, file);
export { mediaPrefix };
