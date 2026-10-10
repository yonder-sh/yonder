/**
 * A share's photos and videos into Saved: each file to storage (a presigned
 * PUT, or parts for a big video) with progress, then checked on the server.
 * The share's device id (`entry.id`) names the saved item, so a share sent
 * again after the page closed or the network dropped carries on where it
 * stopped (finished files are skipped). The entry stays on the device until
 * every file is up.
 */

import { putBlob } from "@/features/media/upload/uploader";
import type { SharedEntry } from "@/features/offline/share-store";
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
	{ done: Promise<string>; listeners: Set<(p: ShareProgress) => void> }
>();

/** Uploads every file of `entry` (resuming); answers the saved item's id. */
export function uploadShare(
	entry: SharedEntry,
	onProgress: (p: ShareProgress) => void = () => {},
): Promise<string> {
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

async function upload(
	entry: SharedEntry,
	onProgress: (p: ShareProgress) => void,
): Promise<string> {
	const total = entry.files.reduce((n, f) => n + f.size, 0) || 1;
	let before = 0;
	let savedId = "";
	for (const [i, f] of entry.files.entries()) {
		const report = (part: number) =>
			onProgress({
				file: i,
				files: entry.files.length,
				fraction: (before + part * f.size) / total,
			});
		report(0);
		const s = await startSavedUpload({
			data: {
				clientId: entry.id,
				text: entry.text,
				title: entry.title,
				position: i,
				type: f.type as never,
				size: f.size,
			},
		});
		savedId = s.savedId;
		if (!s.done) {
			await putBlob({
				id: s.fileId,
				blob: f.blob,
				type: f.type,
				url: s.url,
				multipart: s.multipart,
				sign: (data) => signSavedUploadParts({ data }),
				onProgress: report,
			});
			await completeSavedUpload({ data: { id: s.fileId } });
		}
		before += f.size;
		report(0);
	}
	onProgress({
		file: entry.files.length,
		files: entry.files.length,
		fraction: 1,
	});
	return savedId;
}
