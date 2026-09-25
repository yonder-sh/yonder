/**
 * WP-Media BullMQ job bodies (SPEC §15.2–§15.4): sharp variants, ffmpeg
 * posters, PDF pages (poppler) and SSRF-safe link previews. The worker's
 * handler table (`src/server/live/job-handlers.server.ts`, F-owned) calls
 * these; each returns the TripKeys it changed and the worker publishes one
 * gated invalidation.
 *
 * Slow work (S3 reads, decoding, fetching) happens outside any transaction;
 * results are written in one short `withTripTx` (no `out.emit`: the worker
 * announces). A row that was deleted meanwhile is left alone. Failures that
 * retrying can't fix end as `failed` (uploads) or `fetch: failed` (links),
 * never as an endless retry.
 */
import { and, eq, isNull, ne } from "drizzle-orm";
import { db } from "@/db/db.server";
import { attachments } from "@/db/schema";
import type { JobResult } from "@/server/live/job-handlers.server";
import { withTripTx } from "@/server/tx.server";
import { IMAGE_MAX_BYTES, PDF_MAX_BYTES } from "../media-kinds";
import { type MediaMeta, metaOf } from "./dto.server";
import {
	faviconWebp,
	photoVariants,
	rehostPreview,
	thumbFrom,
	webpInside,
} from "./images.server";
import { renderPdfPages } from "./pdf.server";
import { cleanText, linkMeta } from "./preview.server";
import { type SafeFetcher, safeFetch } from "./safe-fetch.server";
import {
	headObject,
	objectKey,
	presignGet,
	putObject,
	readObject,
	rowKey,
	type StoredVariant,
} from "./storage.server";
import { stripGps } from "./strip-gps";
import { posterFrame } from "./video.server";

export type MediaJobInput = { tripId: string; attachmentId: string };

const MEDIA_KEYS: JobResult = { keys: ["media", "counts"] };

async function liveRow(tripId: string, id: string): Promise<Row | null> {
	const [row] = await db
		.select()
		.from(attachments)
		.where(
			and(
				eq(attachments.tripId, tripId),
				eq(attachments.id, id),
				isNull(attachments.deletedAt),
			),
		);
	return row ?? null;
}

type Row = typeof attachments.$inferSelect;
type Patch = Partial<typeof attachments.$inferInsert>;

/** Writes the job's result if the row is still live (merging `meta`). */
async function writeResult(
	tripId: string,
	id: string,
	patch: Patch,
	meta?: Partial<MediaMeta>,
): Promise<boolean> {
	return withTripTx(tripId, async (tx) => {
		const [cur] = await tx
			.select({ meta: attachments.meta })
			.from(attachments)
			.where(
				and(
					eq(attachments.tripId, tripId),
					eq(attachments.id, id),
					isNull(attachments.deletedAt),
				),
			)
			.for("update");
		if (!cur) return false;
		await tx
			.update(attachments)
			.set({
				...patch,
				...(meta ? { meta: { ...metaOf(cur), ...meta } } : {}),
				updatedAt: new Date(),
			})
			.where(and(eq(attachments.tripId, tripId), eq(attachments.id, id)));
		return true;
	});
}

/**
 * A trip duplicated while an upload was still processing copied the row as
 * `processing` (ADDENDUM §9: copies share the source's objects, same
 * `storage_key`). When the source's job ends, its outcome is copied onto
 * those rows too, one short transaction per trip, so they never spin forever.
 */
async function syncCopies(id: string): Promise<void> {
	try {
		const [src] = await db
			.select()
			.from(attachments)
			.where(eq(attachments.id, id));
		if (!src?.storageKey || src.status === "processing") return;
		const copies = await db
			.select({ id: attachments.id, tripId: attachments.tripId })
			.from(attachments)
			.where(
				and(
					eq(attachments.storageKey, src.storageKey),
					ne(attachments.id, src.id),
					eq(attachments.status, "processing"),
					isNull(attachments.deletedAt),
				),
			)
			.limit(50);
		const m = metaOf(src);
		for (const c of copies) {
			await withTripTx(c.tripId, async (tx, out) => {
				const [cur] = await tx
					.select({ meta: attachments.meta })
					.from(attachments)
					.where(
						and(eq(attachments.id, c.id), eq(attachments.tripId, c.tripId)),
					)
					.for("update");
				if (!cur) return;
				await tx
					.update(attachments)
					.set({
						status: src.status,
						width: src.width,
						height: src.height,
						thumbhash: src.thumbhash,
						// Link previews (the copy shares the re-hosted image/favicon).
						title: src.title,
						description: src.description,
						siteName: src.siteName,
						author: src.author,
						embedId: src.embedId,
						imageKey: src.imageKey,
						faviconKey: src.faviconKey,
						faviconUrl: src.faviconUrl,
						meta: {
							...metaOf(cur),
							thumb: m.thumb,
							pages: m.pages,
							pageCount: m.pageCount,
							...(m.fetch ? { fetch: m.fetch } : {}),
							...(m.imageW ? { imageW: m.imageW, imageH: m.imageH } : {}),
						},
						updatedAt: new Date(),
					})
					.where(
						and(eq(attachments.id, c.id), eq(attachments.status, "processing")),
					);
				out.emit({ keys: ["media", "counts"] });
			});
		}
	} catch (e) {
		console.error(`[media] copies of ${id}:`, (e as Error).message);
	}
}

// ---------------------------------------------------------------------------
// media.variants
// ---------------------------------------------------------------------------

export async function mediaVariants(job: MediaJobInput): Promise<JobResult> {
	const row = await liveRow(job.tripId, job.attachmentId);
	if (!row || row.status === "pending") return {};
	try {
		return await variantsOf(job, row);
	} finally {
		await syncCopies(row.id);
	}
}

async function variantsOf(job: MediaJobInput, row: Row): Promise<JobResult> {
	const key = (v: StoredVariant) => rowKey(row, v);

	if (row.kind === "photo") {
		try {
			const buf = await readObject(key("original"), IMAGE_MAX_BYTES);
			// CONTENT-06 / SECURITY §5: the served original loses its location
			// (losslessly, same length); the variants never had metadata.
			if (stripGps(buf, row.mime ?? ""))
				await putObject(key("original"), buf, row.mime ?? "image/jpeg");
			const v = await photoVariants(buf);
			await putObject(key("thumb.webp"), v.thumb, "image/webp");
			await putObject(key("display.webp"), v.display, "image/webp");
			await writeResult(
				job.tripId,
				row.id,
				{
					status: "ready",
					width: v.width || row.width,
					height: v.height || row.height,
					thumbhash: v.thumbhash,
				},
				{ thumb: true },
			);
		} catch (e) {
			// An undecodable image never gets better with retries.
			console.error(`[media] variants ${row.id}:`, (e as Error).message);
			await writeResult(job.tripId, row.id, { status: "failed" });
		}
		return MEDIA_KEYS;
	}

	if (row.kind === "video") {
		// The client uploaded a poster frame: the thumb comes from it.
		if (await headObject(key("poster.jpg"))) {
			try {
				const poster = await readObject(key("poster.jpg"), 10 * 1024 * 1024);
				const t = await thumbFrom(poster);
				await putObject(key("thumb.webp"), t.thumb, "image/webp");
				await writeResult(
					job.tripId,
					row.id,
					{
						status: "ready",
						thumbhash: t.thumbhash,
						width: row.width ?? t.width,
						height: row.height ?? t.height,
					},
					{ thumb: true },
				);
				return MEDIA_KEYS;
			} catch {
				// A broken poster: let ffmpeg make one.
			}
		}
		return posterOf(job, row);
	}

	if (row.kind === "pdf") {
		try {
			const buf = await readObject(key("original"), PDF_MAX_BYTES);
			const r = await renderPdfPages(buf);
			let first: { width: number; height: number } | null = null;
			for (const [i, png] of r.pages.entries()) {
				const page = await webpInside(png, 1600, 80);
				await putObject(key(`page-${i + 1}.webp`), page, "image/webp");
				if (i === 0) {
					const t = await thumbFrom(png);
					await putObject(key("thumb.webp"), t.thumb, "image/webp");
					first = { width: t.width, height: t.height };
					await writeResult(
						job.tripId,
						row.id,
						{ thumbhash: t.thumbhash, width: t.width, height: t.height },
						{ thumb: true },
					);
				}
			}
			await writeResult(
				job.tripId,
				row.id,
				{ status: "ready", ...(first ?? {}) },
				{ pages: r.pages.length, pageCount: r.pageCount ?? r.pages.length },
			);
		} catch (e) {
			// No poppler, an encrypted or broken file: the icon tile and a download.
			console.error(`[media] pdf ${row.id}:`, (e as Error).message);
			await writeResult(job.tripId, row.id, { status: "ready" }, { pages: 0 });
		}
		return MEDIA_KEYS;
	}
	return {};
}

// ---------------------------------------------------------------------------
// media.poster
// ---------------------------------------------------------------------------

export async function mediaPoster(job: MediaJobInput): Promise<JobResult> {
	const row = await liveRow(job.tripId, job.attachmentId);
	if (row?.kind !== "video" || row.status === "pending") return {};
	try {
		return await posterOf(job, row);
	} finally {
		await syncCopies(row.id);
	}
}

async function posterOf(job: MediaJobInput, row: Row): Promise<JobResult> {
	const key = (v: StoredVariant) => rowKey(row, v);
	try {
		const url = await presignGet(key("original"), { internal: true });
		const poster = await posterFrame(url, row.mime ?? "video/mp4");
		const t = await thumbFrom(poster);
		await putObject(key("poster.jpg"), poster, "image/jpeg");
		await putObject(key("thumb.webp"), t.thumb, "image/webp");
		await writeResult(
			job.tripId,
			row.id,
			{
				status: "ready",
				thumbhash: t.thumbhash,
				width: row.width ?? t.width,
				height: row.height ?? t.height,
			},
			{ thumb: true },
		);
	} catch (e) {
		// No ffmpeg or an undecodable video: a generic tile; it still plays.
		console.error(`[media] poster ${row.id}:`, (e as Error).message);
		await writeResult(
			job.tripId,
			row.id,
			{ status: "ready" },
			{ thumb: false },
		);
	}
	return MEDIA_KEYS;
}

// ---------------------------------------------------------------------------
// links.preview
// ---------------------------------------------------------------------------

async function fetchImage(
	fetcher: SafeFetcher,
	url: string,
	maxBytes: number,
): Promise<{ body: Buffer; contentType: string } | null> {
	try {
		const r = await fetcher(url, { accept: "image/*", maxBytes });
		if (r.status !== 200 || !r.body.length) return null;
		return { body: r.body, contentType: r.contentType };
	} catch {
		return null;
	}
}

export async function linkPreview(
	job: MediaJobInput & { url?: string },
	fetcher: SafeFetcher = safeFetch,
): Promise<JobResult> {
	const row = await liveRow(job.tripId, job.attachmentId);
	if (!row?.url || (row.kind !== "link" && row.kind !== "embed")) return {};
	const meta = await linkMeta(row.url, fetcher);
	// Always under the row's own prefix: a duplicated trip's copy that is
	// refreshed must not overwrite the source's shared preview.
	const key = (v: StoredVariant) => objectKey(job.tripId, row.id, v);

	let imageKey: string | null = row.imageKey;
	let faviconKey: string | null = row.faviconKey;
	const extra: Partial<MediaMeta> = { fetch: meta.ok ? "ok" : "failed" };
	let thumbhash = row.thumbhash;

	if (meta.imageUrl) {
		const img = await fetchImage(fetcher, meta.imageUrl, 8 * 1024 * 1024);
		if (img) {
			try {
				const r = await rehostPreview(img.body);
				await putObject(key("image.webp"), r.image, "image/webp");
				imageKey = key("image.webp");
				thumbhash = r.thumbhash;
				extra.imageW = r.width;
				extra.imageH = r.height;
			} catch {
				// not an image we accept: the card goes without
			}
		}
	}
	if (meta.faviconUrl && row.kind === "link") {
		const ico = await fetchImage(fetcher, meta.faviconUrl, 256 * 1024);
		const webp = ico ? await faviconWebp(ico.body, ico.contentType) : null;
		if (webp) {
			await putObject(key("favicon.webp"), webp, "image/webp");
			faviconKey = key("favicon.webp");
		}
	}
	await writeResult(
		job.tripId,
		row.id,
		{
			status: "ready",
			title: row.title ?? meta.title,
			description: row.description ?? meta.description,
			siteName: row.siteName ?? cleanText(meta.siteName, 120),
			author: row.author ?? meta.author,
			embedId: row.embedId ?? meta.embedId,
			imageKey,
			faviconKey,
			faviconUrl: meta.faviconUrl,
			thumbhash,
		},
		extra,
	);
	await syncCopies(row.id);
	return { keys: ["media"] };
}
