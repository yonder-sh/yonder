/**
 * Client-side preparation of a file before upload (SPEC §15.2):
 * - HEIC/HEIF → JPEG with a lazily loaded `heic-to` (its CSP build: a blob
 *   worker, no `eval`); a failure says so plainly.
 * - Photos: the displayed size and EXIF `DateTimeOriginal` + GPS (`exifr`,
 *   lazy) for "Taken near … — attach there?".
 * - Videos: duration, size and a poster frame from a canvas at
 *   `min(1 s, duration / 3)`; none when the browser can't decode it (HEVC in
 *   Chrome) — the worker's ffmpeg makes one instead.
 */
import {
	isHeic,
	kindForMime,
	type UploadType,
	uploadProblem,
} from "../media-kinds";

export class PrepareError extends Error {}

export type Prepared = {
	blob: Blob;
	type: UploadType;
	name: string;
	kind: "photo" | "video" | "pdf";
	width?: number;
	height?: number;
	durationSec?: number;
	takenAt?: string;
	gps?: { lat: number; lng: number };
	poster?: Blob;
	/** An object URL for the local preview (revoke when done). */
	previewUrl: string | null;
};

const HEIC_FAIL =
	"Couldn't convert this HEIC photo — export it as JPEG and try again";

async function convertHeic(file: File): Promise<File> {
	try {
		const { heicTo } = await import("heic-to/csp");
		const jpeg = await heicTo({ blob: file, type: "image/jpeg", quality: 0.9 });
		const name = file.name.replace(/\.(heic|heif)$/i, "") || "photo";
		return new File([jpeg], `${name}.jpg`, { type: "image/jpeg" });
	} catch {
		throw new PrepareError(HEIC_FAIL);
	}
}

async function imageSize(
	blob: Blob,
): Promise<{ width: number; height: number } | null> {
	try {
		const bmp = await createImageBitmap(blob);
		const size = { width: bmp.width, height: bmp.height };
		bmp.close();
		return size;
	} catch {
		return null;
	}
}

async function exif(
	blob: Blob,
): Promise<{ takenAt?: string; gps?: { lat: number; lng: number } }> {
	try {
		const exifr = (await import("exifr")).default;
		const tags = (await exifr.parse(blob, {
			pick: ["DateTimeOriginal", "OffsetTimeOriginal", "latitude", "longitude"],
			gps: true,
		})) as
			| {
					DateTimeOriginal?: Date;
					OffsetTimeOriginal?: string;
					latitude?: number;
					longitude?: number;
			  }
			| undefined;
		if (!tags) return {};
		const out: { takenAt?: string; gps?: { lat: number; lng: number } } = {};
		if (
			tags.DateTimeOriginal instanceof Date &&
			!Number.isNaN(tags.DateTimeOriginal.getTime())
		)
			out.takenAt = tags.DateTimeOriginal.toISOString();
		if (
			typeof tags.latitude === "number" &&
			typeof tags.longitude === "number" &&
			Math.abs(tags.latitude) <= 90 &&
			Math.abs(tags.longitude) <= 180
		)
			out.gps = { lat: tags.latitude, lng: tags.longitude };
		return out;
	} catch {
		return {};
	}
}

function once(el: HTMLMediaElement, event: string, ms: number): Promise<void> {
	return new Promise((resolve, reject) => {
		const t = window.setTimeout(() => {
			cleanup();
			reject(new Error("timeout"));
		}, ms);
		const ok = () => {
			cleanup();
			resolve();
		};
		const bad = () => {
			cleanup();
			reject(new Error("media error"));
		};
		const cleanup = () => {
			window.clearTimeout(t);
			el.removeEventListener(event, ok);
			el.removeEventListener("error", bad);
		};
		el.addEventListener(event, ok);
		el.addEventListener("error", bad);
	});
}

async function videoInfo(url: string): Promise<{
	width?: number;
	height?: number;
	durationSec?: number;
	poster?: Blob;
}> {
	const v = document.createElement("video");
	v.muted = true;
	v.playsInline = true;
	v.preload = "metadata";
	v.src = url;
	try {
		await once(v, "loadedmetadata", 8_000);
		const out: {
			width?: number;
			height?: number;
			durationSec?: number;
			poster?: Blob;
		} = {};
		if (Number.isFinite(v.duration))
			out.durationSec = Math.round(v.duration * 10) / 10;
		if (v.videoWidth && v.videoHeight) {
			out.width = v.videoWidth;
			out.height = v.videoHeight;
			v.currentTime = Math.min(1, (v.duration || 3) / 3);
			await once(v, "seeked", 8_000);
			const scale = Math.min(1, 960 / Math.max(v.videoWidth, v.videoHeight));
			const c = document.createElement("canvas");
			c.width = Math.round(v.videoWidth * scale);
			c.height = Math.round(v.videoHeight * scale);
			c.getContext("2d")?.drawImage(v, 0, 0, c.width, c.height);
			const poster = await new Promise<Blob | null>((r) =>
				c.toBlob(r, "image/jpeg", 0.85),
			);
			if (poster && poster.size > 0) out.poster = poster;
		}
		return out;
	} catch {
		return {};
	} finally {
		v.removeAttribute("src");
		v.load();
	}
}

/** Validates and prepares one file; throws `PrepareError` with a sentence to show. */
export async function prepareFile(
	input: File,
	videoMaxBytes?: number,
): Promise<Prepared> {
	let file = input;
	if (isHeic(file)) file = await convertHeic(file);
	const problem = uploadProblem(file, videoMaxBytes);
	if (problem) throw new PrepareError(problem);
	const kind = kindForMime(file.type) as Prepared["kind"];
	const base: Prepared = {
		blob: file,
		type: file.type as UploadType,
		name: file.name,
		kind,
		previewUrl: kind === "pdf" ? null : URL.createObjectURL(file),
	};
	if (kind === "photo") {
		const [size, tags] = await Promise.all([imageSize(file), exif(file)]);
		return { ...base, ...(size ?? {}), ...tags };
	}
	if (kind === "video" && base.previewUrl) {
		return { ...base, ...(await videoInfo(base.previewUrl)) };
	}
	return base;
}
