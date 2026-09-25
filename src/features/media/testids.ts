/**
 * WP-Media's own test ids (CONTRACTS §1 rule 8). Import-free; never rename.
 * The shared ones (`gallery-item`, `media-tab`, `media-panel`, `cover-strip`)
 * stay in `src/lib/testids.ts`.
 */
export const MEDIA_TESTID = {
	filterChip: "media-filter-chip",
	addButton: "media-add",
	addUpload: "media-add-upload",
	addLink: "media-add-link",
	linkInput: "media-link-input",
	linkSubmit: "media-link-submit",
	fileInput: "media-file-input",
	dropOverlay: "media-drop-overlay",
	group: "media-group",
	uploadTile: "media-upload-tile",
	uploadCancel: "media-upload-cancel",
	uploadRetry: "media-upload-retry",
	tileMenu: "media-tile-menu",
	visibility: "media-visibility",
	hiddenChip: "media-hidden-chip",
	captionInput: "media-caption-input",
	captionSave: "media-caption-save",
	lightbox: "media-lightbox",
	pdfViewer: "media-pdf-viewer",
	pdfPage: "media-pdf-page",
	pdfDownload: "media-pdf-download",
	pdfZoomIn: "media-pdf-zoom-in",
	pdfZoomOut: "media-pdf-zoom-out",
	embedFrame: "media-embed-frame",
	scopeToggle: "media-scope-toggle",
	empty: "media-empty",
} as const;
