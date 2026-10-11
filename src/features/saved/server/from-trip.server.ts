/**
 * Save from a trip (owner, 2026-10-11): a photo, video, link or embed in a
 * trip's gallery into the caller's own Saved, filed under the trip's city
 * and country for it (the target place's ancestors) and marked as in that
 * trip. Any member who can see it may (viewers too); link guests can't.
 *
 * A photo or video re-references the attachment's objects (`storage_key`, no
 * copy) and counts against the SAVER's quota (unique objects per account, so
 * their own upload counts once); the saved reference keeps the objects
 * alive (the purge checks `saved_files`). Saved twice answers the one there.
 */
import { sql } from "drizzle-orm";
import { v7 as uuidv7 } from "uuid";
import { db } from "@/db/db.server";
import { normName } from "@/features/home/share-classify";
import { classifyUrl } from "@/features/media/embeds";
import { canSeeRow } from "@/features/media/server/dto.server";
import type { AuthUser } from "@/server/auth.server";
import { fail } from "@/server/authz/session.server";
import { loadTripAccess } from "@/server/authz/trip-access.server";
import {
	lockQuota,
	quotaBytes,
	quotaMessage,
	usedBytes,
} from "@/server/quota.server";
import { mediaPrefix } from "@/server/s3.server";
import { assertRoom, enqueuePreview, linkKeyOf, SAVED } from "./saved.server";

type Att = {
	id: string;
	tripId: string;
	nodeId: string | null;
	expenseId: string | null;
	kind: string;
	status: "pending" | "processing" | "ready" | "failed";
	visibility: "everyone" | "members";
	createdBy: string | null;
	deletedAt: Date | null;
	storageKey: string | null;
	mime: string | null;
	sizeBytes: number | null;
	width: number | null;
	height: number | null;
	durationSec: number | null;
	thumbhash: string | null;
	takenAt: Date | null;
	url: string | null;
	title: string | null;
	description: string | null;
	author: string | null;
	siteName: string | null;
	thumb: boolean | null;
};

/** The trip's city and country for a place: its nearest `city` (self or ancestor), the first country code up the chain. */
export async function filingOf(
	tripId: string,
	nodeId: string | null,
): Promise<{
	countryCode: string;
	city: { name: string; lat: number | null; lng: number | null } | null;
} | null> {
	if (!nodeId) return null;
	const res = await db.execute(sql`
		with recursive up as (
			select id, parent_id, type::text as type, name, lat, lng, country_code, 0 as depth
			  from nodes where id = ${nodeId} and trip_id = ${tripId} and deleted_at is null
			union all
			select n.id, n.parent_id, n.type::text, n.name, n.lat, n.lng, n.country_code, up.depth + 1
			  from up join nodes n on n.id = up.parent_id and n.deleted_at is null
			 where up.depth < 16
		)
		select type, name, lat, lng, country_code as cc from up order by depth`);
	const rows = res.rows as {
		type: string;
		name: string;
		lat: number | null;
		lng: number | null;
		cc: string | null;
	}[];
	const cc = rows.find((r) => r.cc && /^[A-Z]{2}$/.test(r.cc))?.cc;
	if (!cc) return null;
	const city = rows.find((r) => r.type === "city");
	return {
		countryCode: cc,
		city: city ? { name: city.name, lat: city.lat, lng: city.lng } : null,
	};
}

export async function saveFromTrip(
	user: Pick<AuthUser, "id">,
	p: { tripId: string; attachmentId: string },
): Promise<{ id: string; created: boolean }> {
	const access = await loadTripAccess(p.tripId, user.id);
	// Members only: a link guest only views.
	if (!access || access.isGuest || !access.memberId) return fail("NOT_FOUND");
	const att = (
		await db.execute(sql`
			select a.id::text as id, a.trip_id::text as "tripId",
			       coalesce(a.node_id, i.node_id)::text as "nodeId", a.expense_id as "expenseId",
			       a.kind::text as kind, a.status::text as status, a.visibility::text as visibility,
			       a.created_by as "createdBy", a.deleted_at as "deletedAt", a.storage_key as "storageKey",
			       a.mime, a.size_bytes::float8 as "sizeBytes", a.width, a.height, a.duration_sec as "durationSec",
			       a.thumbhash, a.taken_at as "takenAt", a.url, a.title, a.description, a.author,
			       a.site_name as "siteName", (a.meta->>'thumb')::boolean as thumb
			  from attachments a left join items i on i.id = a.item_id
			 where a.id = ${p.attachmentId} and a.trip_id = ${p.tripId}`)
	).rows[0] as Att | undefined;
	if (!att || !(await canSeeRow(db, access, user.id, att)))
		return fail("NOT_FOUND");
	const media = att.kind === "photo" || att.kind === "video";
	const link = (att.kind === "link" || att.kind === "embed") && !!att.url;
	if (att.expenseId || !(media || link))
		return fail("VALIDATION", "Only photos, videos and links can be saved.");
	if (media && att.status !== "ready")
		return fail("VALIDATION", "It's still processing. Try again in a moment.");
	const where = await filingOf(p.tripId, att.nodeId);
	const key = link && att.url ? linkKeyOf(att.url) : null;
	const out = await db.transaction(async (tx) => {
		await lockQuota(tx, user.id);
		const had = (
			await tx.execute(sql`
				select id::text as id from saved_links
				 where user_id = ${user.id} and deleted_at is null
				   and (from_attachment_id = ${att.id} or (${key}::text is not null and link_key = ${key}))
				 limit 1`)
		).rows[0] as { id: string } | undefined;
		const id = had?.id ?? uuidv7();
		if (!had) {
			await assertRoom(tx, user.id);
			const before = await usedBytes(tx, user.id);
			const c = link && att.url ? classifyUrl(att.url) : null;
			const embed = c?.kind === "embed" ? c : null;
			const city = where?.city ?? null;
			await tx.execute(sql`
				insert into saved_links (id, user_id, url, link_key, provider, embed_id, ig_type, preview_status,
				                         preview_title, description, author, site_name, from_attachment_id,
				                         country_code, city, city_key, city_lat, city_lng, placed_at)
				values (${id}, ${user.id}, ${link ? att.url : null}, ${key},
				        ${embed?.provider ?? null}, ${embed?.embedId ?? null},
				        ${embed?.provider === "instagram" ? embed.igType : null},
				        ${link ? "pending" : "ready"},
				        ${att.title?.slice(0, SAVED.titleMax) ?? null}, ${att.description?.slice(0, SAVED.textMax) ?? null},
				        ${att.author}, ${att.siteName}, ${att.id},
				        ${where?.countryCode ?? null}, ${city?.name.slice(0, 120) ?? null},
				        ${city ? normName(city.name) || city.name.toLowerCase() : null},
				        ${city?.lat ?? null}, ${city?.lng ?? null}, ${where ? sql`now()` : sql`null`})`);
			if (media) {
				const thumb = !!att.thumb || (att.kind === "photo" && !!att.thumbhash);
				await tx.execute(sql`
					insert into saved_files (id, saved_id, user_id, position, kind, mime, size_bytes, storage_key,
					                         status, width, height, duration_sec, thumbhash, taken_at, meta)
					values (${uuidv7()}, ${id}, ${user.id}, 0, ${att.kind},
					        ${att.mime ?? (att.kind === "photo" ? "image/jpeg" : "video/mp4")}, ${att.sizeBytes ?? 0},
					        ${att.storageKey ?? mediaPrefix(att.tripId, att.id)}, 'ready', ${att.width}, ${att.height},
					        ${att.durationSec}, ${att.thumbhash}, ${att.takenAt},
					        ${JSON.stringify(thumb ? { thumb: true, ...(att.kind === "video" ? { poster: true } : {}) } : {})}::jsonb)`);
				// Only a new object counts: their own upload is already theirs.
				const after = await usedBytes(tx, user.id);
				const quota = await quotaBytes(tx, user.id);
				if (after > before && after > quota)
					fail(
						"STORAGE_QUOTA",
						quotaMessage({ needed: after - before, used: before, quota }),
					);
			}
		}
		await tx.execute(sql`
			insert into saved_link_trips (saved_id, trip_id, node_id)
			values (${id}, ${p.tripId}, ${att.nodeId})
			on conflict (saved_id, trip_id) do nothing`);
		return { id, created: !had };
	});
	if (out.created && link) await enqueuePreview(user.id, out.id);
	return out;
}
