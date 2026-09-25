import type { MediaDto } from "../types";

/** Which items the lightbox shows (links open in a tab, PDFs in the viewer). */
export function inLightbox(item: MediaDto): boolean {
	return (
		item.status !== "failed" &&
		(item.kind === "photo" || item.kind === "video" || item.kind === "embed")
	);
}
