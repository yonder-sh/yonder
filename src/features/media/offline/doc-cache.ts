/**
 * Offline documents (ADDENDUM §9): the rendered pages (and first-page thumb)
 * of every small PDF (≤ 5 MB) of the LAST viewed trip are kept in Cache
 * Storage (`yonder-docs-<tripId>`), so the viewer works offline. Only one
 * trip is kept: syncing a trip deletes the other trips' caches. Sign-out
 * wipes every non-precache cache (`wipeClientData`), and the entries are only
 * ever same-origin `/media/…` responses the user was allowed to read; a
 * document that is deleted or hidden from this user drops out on the next
 * sync. Read-only offline (ADDENDUM §10).
 */
import { mediaPageUrl, mediaUrl } from "@/lib/media-url";
import { OFFLINE_PDF_MAX_BYTES } from "../media-kinds";
import type { MediaDto } from "../types";

const PREFIX = "yonder-docs-";
/** A generous ceiling on page images per trip. */
const MAX_ENTRIES = 400;

const hasCaches = () =>
	typeof window !== "undefined" && "caches" in window && window.isSecureContext;

export const docCacheName = (tripId: string) => `${PREFIX}${tripId}`;

const page = mediaPageUrl;
const thumb = (id: string) => mediaUrl(id, "thumb");

/** The documents of a trip that are kept offline. */
export function offlineDocs(items: readonly MediaDto[]): MediaDto[] {
	return items.filter(
		(i) =>
			i.kind === "pdf" &&
			i.status === "ready" &&
			i.target.kind !== "expense" &&
			i.pages > 0 &&
			(i.sizeBytes ?? Number.POSITIVE_INFINITY) <= OFFLINE_PDF_MAX_BYTES,
	);
}

/** The URLs to keep for these documents (thumb first, then pages in order). */
export function offlineUrls(docs: readonly MediaDto[]): string[] {
	const urls: string[] = [];
	for (const d of docs) {
		if (d.hasThumb) urls.push(thumb(d.id));
		for (let n = 1; n <= d.pages; n++) urls.push(page(d.id, n));
	}
	return urls.slice(0, MAX_ENTRIES);
}

let running: Promise<void> | null = null;

/**
 * Brings the cache in line with the trip's current documents. Safe to call
 * often: one sync at a time, nothing is fetched twice, nothing when offline.
 */
export function syncTripDocs(
	tripId: string,
	items: readonly MediaDto[],
): Promise<void> {
	if (!hasCaches()) return Promise.resolve();
	const next = (running ?? Promise.resolve())
		.catch(() => {})
		.then(() => doSync(tripId, items));
	running = next;
	return next;
}

async function doSync(
	tripId: string,
	items: readonly MediaDto[],
): Promise<void> {
	const name = docCacheName(tripId);
	for (const other of await caches.keys())
		if (other.startsWith(PREFIX) && other !== name) await caches.delete(other);
	const cache = await caches.open(name);
	const wanted = new Set(offlineUrls(offlineDocs(items)));
	for (const req of await cache.keys()) {
		const path = new URL(req.url).pathname;
		if (!wanted.has(path)) await cache.delete(req);
	}
	if (typeof navigator !== "undefined" && navigator.onLine === false) return;
	for (const url of wanted) {
		if (await cache.match(url)) continue;
		try {
			const res = await fetch(url, { credentials: "same-origin" });
			if (
				res.ok &&
				(res.headers.get("content-type") ?? "").startsWith("image/")
			)
				await cache.put(url, res);
		} catch {
			return; // the network went away: try again on the next sync
		}
	}
}

/** A blob URL for a cached page (the viewer's offline fallback), or null. */
export async function cachedPageUrl(
	id: string,
	n: number,
): Promise<string | null> {
	if (!hasCaches()) return null;
	for (const name of await caches.keys()) {
		if (!name.startsWith(PREFIX)) continue;
		const hit = await (await caches.open(name)).match(page(id, n));
		if (hit) return URL.createObjectURL(await hit.blob());
	}
	return null;
}

/** Drops a trip's offline documents (access lost, trip gone). */
export async function removeTripDocs(tripId: string): Promise<void> {
	if (!hasCaches()) return;
	await caches.delete(docCacheName(tripId));
}
