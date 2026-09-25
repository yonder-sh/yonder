/**
 * Upload types, size caps and filter buckets shared by the client (checks
 * before upload, MED-06) and the server (the same rules again, authoritative).
 * Isomorphic and import-free apart from types.
 */
import type { AttachmentKind } from "@/lib/schemas/enums";

/** The tooltip on upload affordances in suggest mode (EXTENSIONS §1.4). */
export const UPLOAD_EDIT_ONLY_REASON =
	"Photos need edit access — share a link instead";

/** SPEC §15.2 + ADDENDUM §9. No SVG/HTML ever (SECURITY §5); HEIC is converted on the client. */
export const IMAGE_TYPES = [
	"image/jpeg",
	"image/png",
	"image/webp",
	"image/gif",
	"image/avif",
] as const;
export const VIDEO_TYPES = [
	"video/mp4",
	"video/quicktime",
	"video/webm",
] as const;
export const PDF_TYPE = "application/pdf";

export type UploadType =
	| (typeof IMAGE_TYPES)[number]
	| (typeof VIDEO_TYPES)[number]
	| typeof PDF_TYPE;

export const MB = 1024 * 1024;
export const GB = 1024 * MB;
/** Per-file caps, the same on the client (before upload) and the server (authoritative). */
export const IMAGE_MAX_BYTES = 50 * MB;
export const PDF_MAX_BYTES = 50 * MB;
export const VIDEO_MAX_BYTES_DEFAULT = 2 * GB;
/**
 * Files larger than one part go up as an S3 multipart upload in parts of this
 * size (browser → S3 directly, a few at a time; Cloudflare in front of the
 * storage refuses request bodies over 100 MB). Smaller files are one PUT.
 */
export const MULTIPART_PART_BYTES = 16 * MB;
/** ADDENDUM §9: PDFs this small are kept for offline reading of the last trip. */
export const OFFLINE_PDF_MAX_BYTES = 5 * MB;
/** PDF pages the worker renders for the in-app viewer. */
export const PDF_MAX_PAGES = 40;

export function kindForMime(mime: string): AttachmentKind | null {
	if ((IMAGE_TYPES as readonly string[]).includes(mime)) return "photo";
	if ((VIDEO_TYPES as readonly string[]).includes(mime)) return "video";
	if (mime === PDF_TYPE) return "pdf";
	return null;
}

export function maxBytesFor(
	kind: AttachmentKind,
	videoMaxBytes = VIDEO_MAX_BYTES_DEFAULT,
): number {
	return kind === "video"
		? videoMaxBytes
		: kind === "pdf"
			? PDF_MAX_BYTES
			: IMAGE_MAX_BYTES;
}

export function isHeic(file: { type: string; name: string }): boolean {
	return (
		/^image\/hei[cf]/i.test(file.type) || /\.(heic|heif)$/i.test(file.name)
	);
}

/** A readable size: "820 KB", "12.4 MB", "2 GB". */
export function formatBytes(n: number): string {
	if (n < 1024) return `${n} B`;
	if (n < MB) return `${Math.round(n / 1024)} KB`;
	if (n >= GB) {
		const gb = n / GB;
		return `${Number.isInteger(gb) ? gb : gb.toFixed(1)} GB`;
	}
	const mb = n / MB;
	return `${mb >= 100 ? Math.round(mb) : mb.toFixed(1)} MB`;
}

/**
 * The Media filter buckets (DESIGN §7.2 + ADDENDUM §9 "Documents"); the URL
 * param `mf` uses the same names.
 */
export const MEDIA_FILTERS = [
	"photos",
	"videos",
	"social",
	"guides",
	"documents",
] as const;
export type MediaFilter = (typeof MEDIA_FILTERS)[number];

export const FILTER_LABEL: Record<MediaFilter | "all", string> = {
	all: "All",
	photos: "Photos",
	videos: "Videos",
	social: "Social",
	guides: "Guides",
	documents: "Documents",
};

export function filterOf(kind: AttachmentKind): MediaFilter {
	switch (kind) {
		case "photo":
			return "photos";
		case "video":
			return "videos";
		case "embed":
			return "social";
		case "link":
			return "guides";
		case "pdf":
			return "documents";
	}
}

/**
 * Why a file can't be uploaded, or null (checked before any request, MED-06).
 * `name` is shown to the user, so it is clipped.
 */
export function uploadProblem(
	file: { type: string; name: string; size: number },
	videoMaxBytes = VIDEO_MAX_BYTES_DEFAULT,
): string | null {
	const name =
		file.name.length > 40
			? `${file.name.slice(0, 37)}…`
			: file.name || "This file";
	const kind = kindForMime(file.type);
	if (!kind) {
		if (file.type === "image/svg+xml")
			return `${name}: SVG images aren't supported. Export it as PNG or JPEG.`;
		return `${name} isn't a photo, video or PDF.`;
	}
	if (file.size <= 0) return `${name} is empty.`;
	const max = maxBytesFor(kind, videoMaxBytes);
	if (file.size > max) {
		const what =
			kind === "video" ? "Videos" : kind === "pdf" ? "PDFs" : "Photos";
		return `${name} is ${formatBytes(file.size)} — ${what} can be up to ${formatBytes(max)}.`;
	}
	return null;
}

/** A filename safe to show and to put in `Content-Disposition` (no paths, no control chars). */
export function cleanFileName(name: string): string {
	const base = name.split(/[\\/]/).pop() ?? "";
	// biome-ignore lint/suspicious/noControlCharactersInRegex: stripping control characters is the point.
	const clean = base.replace(/[\u0000-\u001f\u007f"<>|*?:]/g, "").trim();
	return clean.slice(0, 200) || "document";
}
