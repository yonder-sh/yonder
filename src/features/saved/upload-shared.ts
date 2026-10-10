/**
 * A share's photos and videos into Saved: each file to storage (a presigned
 * PUT, or parts for a big video) with progress, then checked on the server.
 * The share's device id (`entry.id`) names the saved item, so a share sent
 * again after the page closed or the network dropped carries on where it
 * stopped (finished files are skipped). The entry stays on the device until
 * every file is up. As trip uploads, a HEIC photo becomes a JPEG on the
 * device and its EXIF date and location go up with it. A file refused for
 * good (its type, its size) is left out, saying why, never retried.
 */

import {
	type Prepared,
	PrepareError,
	prepareFile,
} from "@/features/media/upload/prepare";
import { putBlob } from "@/features/media/upload/uploader";
import type { SharedEntry } from "@/features/offline/share-store";
import { errorCode, humanError } from "@/lib/errors";
import {
	completeSavedUpload,
	signSavedUploadParts,
	startSavedUpload,
} from "./saved.functions";

export type ShareProgress = { file: number; files: number; fraction: number };

/** "Uploading 3 photos…", "Uploading a video…", "Uploading 2 photos and a video…". */
export function uploadingLabel(files: readonly { type: string }[]): string {
	const videos = files.filter((f) => f.type.startsWith("video/")).length;
	const photos = files.length - videos;
	const part = (n: number, one: string, many: string) =>
		n === 1 ? `a ${one}` : `${n} ${many}`;
	const what = [
		photos ? part(photos, "photo", "photos") : null,
		videos ? part(videos, "video", "videos") : null,
	]
		.filter(Boolean)
		.join(" and ");
	return `Uploading ${what}…`;
}

/** Shares uploading now (one upload per share, however many ask). */
const running = new Map<
	string,
	{
		done: Promise<ShareUploaded>;
		listeners: Set<(p: ShareProgress) => void>;
	}
>();

/**
 * Uploads every file of `entry` (resuming); answers the saved item's id and
 * the files refused for good. Every file refused: `ShareRefused`.
 */
export function uploadShare(
	entry: SharedEntry,
	onProgress: (p: ShareProgress) => void = () => {},
): Promise<ShareUploaded> {
	let run = running.get(entry.id);
	if (!run) {
		const listeners = new Set<(p: ShareProgress) => void>();
		const done = upload(entry, (p) => {
			for (const l of listeners) l(p);
		}).finally(() => running.delete(entry.id));
		run = { done, listeners };
		running.set(entry.id, run);
	}
	run.listeners.add(onProgress);
	return run.done;
}

/** Nothing in the share can be saved (every file's type or size refused): drop it, saying why. */
export class ShareRefused extends Error {}

export type ShareUploaded = {
	savedId: string;
	/** Files left out for good, each with why ("IMG_0042.tif isn't a photo, video or PDF."). */
	refused: string[];
};

/** A file refused for good: by the device's checks, or the server's (`VALIDATION`). */
function refusal(e: unknown): string | null {
	if (e instanceof PrepareError) return e.message;
	return errorCode(e) === "VALIDATION" ? humanError(e) : null;
}

async function upload(
	entry: SharedEntry,
	onProgress: (p: ShareProgress) => void,
): Promise<ShareUploaded> {
	const total = entry.files.reduce((n, f) => n + f.size, 0) || 1;
	const refused: string[] = [];
	let before = 0;
	let savedId = "";
	let position = 0;
	for (const [i, f] of entry.files.entries()) {
		const report = (part: number) =>
			onProgress({
				file: i,
				files: entry.files.length,
				fraction: (before + part * f.size) / total,
			});
		report(0);
		let prepared: Prepared | null = null;
		try {
			// As trip uploads: HEIC becomes JPEG; where and when it was taken.
			prepared = await prepareFile(
				new File([f.blob], f.name, { type: f.type }),
			);
			if (prepared.kind === "pdf")
				throw new PrepareError(`${f.name} isn't a photo or video.`);
			const s = await startSavedUpload({
				data: {
					clientId: entry.id,
					text: entry.text,
					title: entry.title,
					position: position++,
					type: prepared.type as never,
					size: prepared.blob.size,
				},
			});
			savedId = s.savedId;
			if (!s.done) {
				await putBlob({
					id: s.fileId,
					blob: prepared.blob,
					type: prepared.type,
					url: s.url,
					multipart: s.multipart,
					sign: (data) => signSavedUploadParts({ data }),
					onProgress: report,
				});
				await completeSavedUpload({
					data: {
						id: s.fileId,
						...(prepared.width && prepared.height
							? { width: prepared.width, height: prepared.height }
							: {}),
						...(prepared.durationSec !== undefined
							? { durationSec: prepared.durationSec }
							: {}),
						...(prepared.takenAt ? { takenAt: prepared.takenAt } : {}),
						...(prepared.gps ? { gps: prepared.gps } : {}),
					},
				});
			}
		} catch (e) {
			const why = refusal(e);
			if (why === null) throw e;
			refused.push(why);
		} finally {
			if (prepared?.previewUrl) URL.revokeObjectURL(prepared.previewUrl);
		}
		before += f.size;
		report(0);
	}
	if (!savedId)
		throw new ShareRefused(
			refused.join(" ") || "Nothing in that share could be saved.",
		);
	onProgress({
		file: entry.files.length,
		files: entry.files.length,
		fraction: 1,
	});
	return { savedId, refused };
}
