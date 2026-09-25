/**
 * The attachment DTO (SPEC §13.4 `listTripMedia`): everything the client
 * needs to draw a tile, never a storage key or a presigned URL. Isomorphic;
 * re-exported from `media.functions.ts`.
 */
import type { ProposalMark } from "@/lib/engine/proposals";
import type {
	AttachmentKind,
	AttachmentStatus,
	AttachmentVisibility,
} from "@/lib/schemas/enums";
import type { AttachmentTarget } from "@/lib/schemas/targets";

export type MediaDto = {
	id: string;
	/** Where it hangs; `expense` = a receipt (members only, never for guests). */
	target: AttachmentTarget;
	kind: AttachmentKind;
	status: AttachmentStatus;
	/** ADDENDUM §9: `members` = hidden from link guests (never sent to them). */
	visibility: AttachmentVisibility;
	mime: string | null;
	width: number | null;
	height: number | null;
	durationSec: number | null;
	thumbhash: string | null;
	takenAt: string | null;
	url: string | null;
	provider: string | null;
	embedId: string | null;
	title: string | null;
	siteName: string | null;
	caption: string | null;
	position: string;
	createdAt: string;
	// ---- WP-Media additions (all derived; safe for every reader) ----
	updatedAt: string;
	description: string | null;
	author: string | null;
	sizeBytes: number | null;
	/** `/media/<id>/thumb` exists (photos, posters, PDF page 1). */
	hasThumb: boolean;
	/** `/media/<id>/image` exists (a re-hosted link preview or social thumbnail). */
	hasImage: boolean;
	/** `/media/<id>/favicon` exists. */
	hasFavicon: boolean;
	/** width / height for tiles without stored dimensions (embeds, link images). */
	aspect: number | null;
	/** PDFs: pages rendered for the viewer (`/media/<id>/page-<n>`), 0 = icon only. */
	pages: number;
	/** PDFs: pages in the document (may exceed `pages`). */
	pageCount: number | null;
	/** Instagram: `p` | `reel` | `tv`. */
	igType: string | null;
	/** Imported photos: attribution. */
	license: string | null;
	licenseUrl: string | null;
	sourceUrl: string | null;
	/** Link previews: `unfetched` (imported), `ok`, `failed`. */
	fetch: "unfetched" | "ok" | "failed" | null;
	/** The current user uploaded it. */
	mine: boolean;
	/** Client-only: an open `attachment.link` proposal drawn as a ghost tile (E7). */
	proposed?: ProposalMark;
};
