/**
 * Serving attachments (see `serveMedia`). Used by the `/media/$id/$variant`
 * route; kept here so it can be tested without the router.
 */
import { eq } from "drizzle-orm";
import { db } from "@/db/db.server";
import { attachments } from "@/db/schema";
import { getTripAccess } from "@/server/authz/access.server";
import { loadSession } from "@/server/authz/session.server";
import { type AttachmentRow, canSeeRow } from "./dto.server";
import {
	GET_WINDOW_SEC,
	prefixOfKey,
	presignGet,
	rowKey,
	type StoredVariant,
	streamObject,
} from "./storage.server";

/** How long a browser may reuse a 302 (SEC-R1-08; was 30 min). */
export const REDIRECT_MAX_AGE_SEC = GET_WINDOW_SEC;

/**
 * `GET /media/$id/$variant` (SPEC §13.4, §15.5; ADDENDUM §9): the session's
 * access to the attachment's trip is checked on every request (guests have
 * sessions), with the same read rules as `listTripMedia` (receipts and
 * "Hide from guests" rows never reach link guests). Then:
 *
 * - `thumb`, `image`, `favicon` and PDF pages `page-<n>` stream from S3
 *   (same origin, `private, max-age=86400`, cacheable offline);
 * - `display`, `original` and `poster` answer 302 to a presigned GET that
 *   lives 15 min, signed on a 5-min grid (Range requests work for video
 *   seeking); the redirect itself is cached 5 min, so long-open tabs re-sign
 *   (MED-09) and access changes bite within minutes (SEC-R1-08).
 *   Every presigned GET names the type the object was checked as and its
 *   disposition (`response-content-type`, `response-content-disposition`):
 *   in production the browser reads straight from the storage host, with no
 *   proxy adding headers, so the object's own metadata never decides how it
 *   renders. `inline` for photos, videos, posters and display images;
 *   `attachment` for PDFs and `?download=1`; always with a safe filename.
 * - A link guest asking for a photo's `original` gets the display WebP
 *   (re-encoded, no metadata) unless they uploaded it themselves: an
 *   original can still carry where it was taken (uploads from before GPS
 *   stripping, AVIF) (CONTENT-06, SECURITY §5 privacy). GIFs carry no EXIF
 *   and keep their animation.
 *
 * Keys come from the row (`rowKey`, `image_key`, `favicon_key`), never from
 * its id: a duplicated trip's copies share the source's objects (ADDENDUM §9).
 *
 * Anything missing or not allowed answers 404 (ids never reveal anything).
 */
const STREAMED: Record<string, StoredVariant> = {
	thumb: "thumb.webp",
	image: "image.webp",
	favicon: "favicon.webp",
};
const REDIRECTED: Record<string, StoredVariant> = {
	display: "display.webp",
	original: "original",
	poster: "poster.jpg",
};
const UUID_RE =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PAGE_RE = /^page-([1-9]\d{0,2})$/;

const notFound = () =>
	new Response("Not found", {
		status: 404,
		headers: { "Cache-Control": "no-store", "Content-Type": "text/plain" },
	});

function asciiName(name: string): string {
	return (
		name.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_") || "download"
	);
}

/** Types a stored original may be served as inline (it passed the upload checks). */
const INLINE_ORIGINAL =
	/^(image\/(jpeg|png|webp|gif|avif)|video\/(mp4|quicktime|webm))$/;

function disposition(
	row: AttachmentRow,
	download: boolean,
	/** A derived image is served (the display WebP, a poster JPEG): its extension. */
	derived?: ".webp" | ".jpg",
): string {
	const inline =
		!download &&
		(!!derived || (row.kind !== "pdf" && INLINE_ORIGINAL.test(row.mime ?? "")));
	const meta = (row.meta ?? {}) as { fileName?: string };
	const base =
		row.title ||
		meta.fileName ||
		(row.kind === "pdf" ? "document.pdf" : "photo");
	const name = derived
		? `${base.replace(/\.[A-Za-z0-9]{1,5}$/, "")}${derived}`
		: base;
	return `${inline ? "inline" : "attachment"}; filename="${asciiName(name)}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

export async function serveMedia(
	request: Request,
	id: string,
	variant: string,
): Promise<Response> {
	if (!UUID_RE.test(id)) return notFound();
	const page = PAGE_RE.exec(variant);
	const stored: StoredVariant | undefined = page
		? (`page-${Number(page[1])}.webp` as StoredVariant)
		: (STREAMED[variant] ?? REDIRECTED[variant]);
	if (!stored) return notFound();

	const session = await loadSession(request.headers);
	if (!session) return notFound();
	const [row] = await db
		.select()
		.from(attachments)
		.where(eq(attachments.id, id));
	if (!row) return notFound();
	const access = await getTripAccess(row.tripId, session.user);
	if (!access) return notFound();
	if (!(await canSeeRow(db, access, session.user.id, row))) return notFound();
	if (page && row.kind !== "pdf") return notFound();

	const remote =
		variant === "image" && prefixOfKey(row.imageKey)
			? row.imageKey
			: variant === "favicon" && prefixOfKey(row.faviconKey)
				? row.faviconKey
				: null;
	const key = remote ?? rowKey(row, stored);
	if (page || STREAMED[variant]) {
		const obj = await streamObject(key);
		if (!obj) return notFound();
		return new Response(obj.body, {
			status: 200,
			headers: {
				"Content-Type": "image/webp",
				"Cache-Control": "private, max-age=86400",
				"X-Content-Type-Options": "nosniff",
				"Content-Security-Policy": "default-src 'none'; sandbox",
				...(obj.size !== null ? { "Content-Length": String(obj.size) } : {}),
				...(obj.etag ? { ETag: obj.etag } : {}),
			},
		});
	}
	const download = new URL(request.url).searchParams.get("download") === "1";
	// CONTENT-06: link guests get a photo's display WebP instead of its original.
	const displayForGuest =
		variant === "original" &&
		row.kind === "photo" &&
		row.mime !== "image/gif" &&
		access.isGuest &&
		row.createdBy !== session.user.id;
	if (displayForGuest && row.status !== "ready") return notFound();
	const original = variant === "original" && !displayForGuest;
	const contentType = original
		? INLINE_ORIGINAL.test(row.mime ?? "") || row.mime === "application/pdf"
			? (row.mime as string)
			: "application/octet-stream"
		: variant === "poster"
			? "image/jpeg"
			: "image/webp";
	const url = await presignGet(
		displayForGuest ? rowKey(row, "display.webp") : key,
		{
			contentType,
			disposition: disposition(
				row,
				download,
				original ? undefined : variant === "poster" ? ".jpg" : ".webp",
			),
		},
	);
	return new Response(null, {
		status: 302,
		headers: {
			Location: url,
			// Shorter than the URL's remaining life (≥ 10 min, see `presignGet`).
			"Cache-Control": `private, max-age=${REDIRECT_MAX_AGE_SEC}`,
			"Referrer-Policy": "no-referrer",
		},
	});
}
