/**
 * `saved.preview`: a saved link's preview, after saving (so saving stays
 * instant). Maps links: the place it names, through the share page's own
 * resolver (`resolveUrlCached`; its answer is cached for the trip picker
 * too). Everything else: `linkMeta` (oEmbed for TikTok/YouTube, OpenGraph for
 * Instagram and the web) with its picture and favicon re-hosted under
 * `saved/<userId>/<id>/`; the page never loads a remote image.
 */
import { sql } from "drizzle-orm";
import { db } from "@/db/db.server";
import type { SavedPlace } from "@/db/schema/saved";
import { isMapsUrl, parseMapsUrl } from "@/features/home/share-classify";
import {
	faviconWebp,
	rehostPreview,
} from "@/features/media/server/images.server";
import { fetchImage } from "@/features/media/server/jobs.server";
import { cleanText, linkMeta } from "@/features/media/server/preview.server";
import {
	type SafeFetcher,
	safeFetch,
} from "@/features/media/server/safe-fetch.server";
import { putObject } from "@/features/media/server/storage.server";
import { resolveUrlCached } from "@/features/places/server/places.server";
import { savedPrefix } from "./saved.server";

export type SavedPreviewJob = { userId: string; savedId: string };

type Resolve = typeof resolveUrlCached;

function isMaps(url: string): boolean {
	try {
		return isMapsUrl(new URL(url));
	} catch {
		return false;
	}
}

/** The place a Maps link names: the resolver's, else what the link itself says. */
async function placeOf(
	url: string,
	userId: string,
	resolve: Resolve,
): Promise<SavedPlace | null> {
	const hint = parseMapsUrl(url);
	try {
		const { core, link } = await resolve(url, userId);
		if (core)
			return {
				name: core.name,
				lat: core.lat,
				lng: core.lng,
				...(core.address ? { address: core.address } : {}),
				...(core.countryCode ? { countryCode: core.countryCode } : {}),
			};
		if (link)
			return {
				name: link.name ?? hint.name ?? "Dropped pin",
				lat: link.lat,
				lng: link.lng,
			};
	} catch {
		// The provider is down: what the link says.
	}
	return hint.lat !== null && hint.lng !== null
		? { name: hint.name ?? "Dropped pin", lat: hint.lat, lng: hint.lng }
		: null;
}

export async function savedPreview(
	job: SavedPreviewJob,
	fetcher: SafeFetcher = safeFetch,
	resolve: Resolve = resolveUrlCached,
): Promise<void> {
	const res = await db.execute(sql`
		select url, embed_id as "embedId", provider from saved_links
		 where id = ${job.savedId} and user_id = ${job.userId} and deleted_at is null`);
	const row = res.rows[0] as
		| { url: string | null; embedId: string | null; provider: string | null }
		| undefined;
	if (!row?.url) return;

	if (isMaps(row.url)) {
		const place = await placeOf(row.url, job.userId, resolve);
		await db.execute(sql`
			update saved_links
			   set preview_status = ${place ? "ready" : "failed"}, place = ${place ? JSON.stringify(place) : null}::jsonb,
			       preview_title = ${place?.name ?? parseMapsUrl(row.url).name}, site_name = 'Google Maps', updated_at = now()
			 where id = ${job.savedId} and deleted_at is null`);
		return;
	}

	const meta = await linkMeta(row.url, fetcher);
	const prefix = savedPrefix(job.userId, job.savedId);
	let image: {
		key: string;
		w: number;
		h: number;
		thumbhash: string;
	} | null = null;
	if (meta.imageUrl) {
		const img = await fetchImage(fetcher, meta.imageUrl, 8 * 1024 * 1024);
		if (img)
			try {
				const r = await rehostPreview(img.body);
				await putObject(`${prefix}image.webp`, r.image, "image/webp");
				image = {
					key: `${prefix}image.webp`,
					w: r.width,
					h: r.height,
					thumbhash: r.thumbhash,
				};
			} catch {
				// not an image we accept: the tile goes without
			}
	}
	let favicon: string | null = null;
	if (meta.faviconUrl && !row.provider) {
		const ico = await fetchImage(fetcher, meta.faviconUrl, 256 * 1024);
		const webp = ico ? await faviconWebp(ico.body, ico.contentType) : null;
		if (webp) {
			await putObject(`${prefix}favicon.webp`, webp, "image/webp");
			favicon = `${prefix}favicon.webp`;
		}
	}
	await db.execute(sql`
		update saved_links
		   set preview_status = ${meta.ok || image ? "ready" : "failed"},
		       preview_title = ${meta.title}, description = ${meta.description},
		       author = ${meta.author}, site_name = ${cleanText(meta.siteName, 120)},
		       embed_id = coalesce(embed_id, ${meta.embedId}),
		       image_key = ${image?.key ?? null}, image_w = ${image?.w ?? null},
		       image_h = ${image?.h ?? null}, thumbhash = ${image?.thumbhash ?? null},
		       favicon_key = ${favicon}, updated_at = now()
		 where id = ${job.savedId} and deleted_at is null`);
}
