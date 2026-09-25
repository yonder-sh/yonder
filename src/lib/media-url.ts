/**
 * Same-origin media URLs (SPEC §13.4, §15.5): `/media/<id>/<variant>`. The
 * route checks the session and trip access, then streams small variants
 * (cacheable offline) or redirects to a presigned GET for large ones.
 */
export const MEDIA_VARIANTS = [
	"original",
	"display",
	"thumb",
	"poster",
	"image",
	"favicon",
] as const;
export type MediaVariant = (typeof MEDIA_VARIANTS)[number];

export function mediaUrl(attachmentId: string, variant: MediaVariant): string {
	return `/media/${encodeURIComponent(attachmentId)}/${variant}`;
}

/** One rendered page of a PDF attachment (1-based; the route serves pages 1–999). */
export function mediaPageUrl(attachmentId: string, page: number): string {
	const n = Math.min(999, Math.max(1, Math.floor(page)));
	return `/media/${encodeURIComponent(attachmentId)}/page-${n}`;
}
