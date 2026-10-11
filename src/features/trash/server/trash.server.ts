/**
 * Trash (owner, 2026-10-11): each account's deleted uploads, kept 30 days.
 * Nothing is stored for it; Trash is what is deleted and not yet purged:
 *
 * - photos, videos and PDFs the user uploaded to a trip that were deleted, or
 *   whose stop, place, expense or trip was (the earliest of those is when it
 *   went to Trash: the purge's 30-day clock);
 * - Saved shares with photos or videos the user deleted.
 *
 * It counts toward the quota until deleted for good (`usedBytes`): by Delete
 * forever, Empty trash, or the purge (`purge.server.ts`). Objects shared with
 * a live row (a duplicated trip, Saved) stay (`dropUnsharedPrefixes`).
 *
 * Restore (`targetOf`): back where it was when that is still there; a
 * deleted stop's file onto its place, else onto the trip's own media, when
 * the user may still edit the trip; otherwise a photo or video goes to Saved
 * and a PDF can't come back. Undo puts it back in Trash with its old clock.
 */
import { sql } from "drizzle-orm";
import { v7 as uuidv7 } from "uuid";
import { db } from "@/db/db.server";
import {
	dropSavedLinks,
	dropUnsharedPrefixes,
	KEY_COLS,
	type KeyRow,
} from "@/features/media/server/purge.server";
import {
	deletePrefix,
	rowKey,
	streamObject,
} from "@/features/media/server/storage.server";
import {
	assertRoom,
	restoreSaved,
	SAVED,
} from "@/features/saved/server/saved.server";
import { can, type TripAccess } from "@/lib/auth/roles";
import type { AuthUser } from "@/server/auth.server";
import { fail, loadSession } from "@/server/authz/session.server";
import { loadTripAccess } from "@/server/authz/trip-access.server";
import { mutationMeta, withTripTx } from "@/server/tx.server";
import {
	type Restored,
	type RestoreTarget,
	TRASH_DAYS,
	type TrashItem,
} from "../types";

type Drop = (prefix: string) => Promise<number>;

const ATT_FROM = sql`
	from attachments a
	join trips t on t.id = a.trip_id
	left join nodes n on n.id = a.node_id
	left join items i on i.id = a.item_id
	left join nodes inode on inode.id = i.node_id
	left join expenses e on e.id = a.expense_id`;
const TRASHED_AT = sql`least(a.deleted_at, n.deleted_at, i.deleted_at, e.deleted_at, t.deleted_at)`;
/** A finished upload of `userId` that is in Trash. */
const inTrash = (userId: string) => sql`a.created_by = ${userId}
	and a.kind in ('photo', 'video', 'pdf') and a.status in ('ready', 'processing')
	and a.size_bytes is not null and ${TRASHED_AT} is not null`;

type AttRow = KeyRow & {
	kind: "photo" | "video" | "pdf";
	name: string | null;
	size: number;
	mime: string | null;
	width: number | null;
	height: number | null;
	durationSec: number | null;
	takenAt: Date | null;
	thumbhash: string | null;
	thumb: boolean | null;
	expenseId: string | null;
	trashedAt: Date;
	tripName: string;
	tripGone: boolean;
	parentGone: boolean;
	placeId: string | null;
	placeName: string | null;
	whereName: string | null;
};

async function attRows(userId: string, ids?: readonly string[]) {
	const only = ids
		? sql`and a.id = any(${sql.param([...ids])}::uuid[])`
		: sql``;
	const res = await db.execute(sql`
		select ${KEY_COLS}, a.kind::text as kind, coalesce(a.title, a.meta->>'fileName') as name,
		       a.size_bytes::float8 as size, a.mime, a.width, a.height, a.duration_sec as "durationSec",
		       a.taken_at as "takenAt", a.thumbhash, (a.meta->>'thumb')::boolean as thumb,
		       a.expense_id::text as "expenseId", ${TRASHED_AT} as "trashedAt",
		       t.name as "tripName", t.deleted_at is not null as "tripGone",
		       coalesce(n.deleted_at, i.deleted_at, e.deleted_at) is not null as "parentGone",
		       case when i.deleted_at is not null and inode.deleted_at is null then inode.id::text end as "placeId",
		       inode.name as "placeName", coalesce(n.name, inode.name, i.title, e.title) as "whereName"
		${ATT_FROM}
		 where ${inTrash(userId)} ${only}
		 order by "trashedAt" desc
		 limit 2000`);
	return res.rows as AttRow[];
}

type SavedRow = {
	id: string;
	userId: string;
	name: string | null;
	trashedAt: Date;
	count: number;
	size: number;
	fileId: string;
	kind: "photo" | "video";
	thumbhash: string | null;
	thumb: boolean | null;
};

async function savedRows(userId: string, ids?: readonly string[]) {
	const only = ids
		? sql`and s.id = any(${sql.param([...ids])}::uuid[])`
		: sql``;
	const res = await db.execute(sql`
		select s.id::text as id, s.user_id as "userId", coalesce(s.preview_title, s.title) as name,
		       s.deleted_at as "trashedAt", count(*)::int as count, sum(f.size_bytes)::float8 as size,
		       (array_agg(f.id::text order by f.position))[1] as "fileId",
		       (array_agg(f.kind order by f.position))[1] as kind,
		       (array_agg(f.thumbhash order by f.position))[1] as thumbhash,
		       (array_agg((f.meta->>'thumb')::boolean order by f.position))[1] as thumb
		  from saved_links s
		  join saved_files f on f.saved_id = s.id and f.deleted_at is null
		                    and f.status in ('ready', 'processing')
		 where s.user_id = ${userId} and s.deleted_at is not null ${only}
		 group by s.id
		 order by s.deleted_at desc
		 limit 1000`);
	return res.rows as SavedRow[];
}

/** Where Restore puts it (see the file comment); null: it can't come back. */
export function targetOf(
	r: Pick<AttRow, "kind" | "tripGone" | "parentGone" | "placeId" | "expenseId">,
	access: Pick<TripAccess, "role" | "isGuest"> | null,
): RestoreTarget | null {
	if (!r.tripGone && can(access, "edit")) {
		if (r.parentGone) return r.placeId ? "place" : "trip";
		return r.expenseId && !can(access, "manageExpenses") ? "trip" : "here";
	}
	return r.kind === "pdf" ? null : "saved";
}

/** Each trip's access, loaded once. */
function accessCache(userId: string) {
	const m = new Map<string, Promise<TripAccess | null>>();
	return (tripId: string) => {
		const p = m.get(tripId) ?? loadTripAccess(tripId, userId);
		m.set(tripId, p);
		return p;
	};
}

/** The caller's Trash, most recently deleted first. */
export async function listTrash(userId: string): Promise<TrashItem[]> {
	const access = accessCache(userId);
	const atts = await attRows(userId);
	const items: TrashItem[] = [];
	for (const r of atts) {
		const to = targetOf(r, r.tripGone ? null : await access(r.trip_id));
		items.push({
			id: `a:${r.id}`,
			kind: r.kind,
			name: r.name,
			from: r.whereName ? `${r.tripName} · ${r.whereName}` : r.tripName,
			sizeBytes: r.size,
			count: 1,
			thumb:
				r.thumb || (r.kind === "photo" && r.thumbhash)
					? `/api/trash/${r.id}/thumb`
					: null,
			thumbhash: r.thumbhash,
			trashedAt: new Date(r.trashedAt).getTime(),
			restoreTo: to,
			restoreName:
				to === "place" ? r.placeName : to === "trip" ? r.tripName : null,
		});
	}
	for (const s of await savedRows(userId))
		items.push({
			id: `s:${s.id}`,
			kind: s.kind,
			name: s.name,
			from: "Saved",
			sizeBytes: s.size,
			count: s.count,
			thumb:
				s.thumb || (s.kind === "photo" && s.thumbhash)
					? `/api/saved-file/${s.fileId}/thumb`
					: null,
			thumbhash: s.thumbhash,
			trashedAt: new Date(s.trashedAt).getTime(),
			restoreTo: "saved",
			restoreName: null,
		});
	return items.sort((a, b) => b.trashedAt - a.trashedAt);
}

/** Splits `a:`/`s:` ids (anything else is ignored). */
function split(ids: readonly string[]) {
	const uuid = /^[0-9a-f-]{36}$/i;
	const of = (p: string) =>
		ids.flatMap((id) =>
			id.startsWith(p) && uuid.test(id.slice(2)) ? [id.slice(2)] : [],
		);
	return { att: of("a:"), saved: of("s:") };
}

/** A trip's photo or video into Saved (Unsorted); the attachment row goes. Null: it was in Saved already. */
async function intoSaved(userId: string, r: AttRow): Promise<string | null> {
	const key = r.storage_key ?? `trips/${r.trip_id}/${r.id}/`;
	return db.transaction(async (tx) => {
		const had = await tx.execute(sql`
			select 1 from saved_files f join saved_links s on s.id = f.saved_id
			 where f.user_id = ${userId} and f.storage_key = ${key} and s.deleted_at is null limit 1`);
		let id: string | null = null;
		if (!had.rows.length) {
			await assertRoom(tx, userId);
			id = uuidv7();
			await tx.execute(sql`
				insert into saved_links (id, user_id, preview_status, preview_title)
				values (${id}, ${userId}, 'ready', ${r.name?.slice(0, SAVED.titleMax) ?? null})`);
			const meta = r.thumb
				? { thumb: true, ...(r.kind === "video" ? { poster: true } : {}) }
				: {};
			await tx.execute(sql`
				insert into saved_files (id, saved_id, user_id, position, kind, mime, size_bytes, storage_key,
				                         status, width, height, duration_sec, thumbhash, taken_at, meta)
				values (${uuidv7()}, ${id}, ${userId}, 0, ${r.kind},
				        ${r.mime ?? (r.kind === "photo" ? "image/jpeg" : "video/mp4")}, ${r.size}, ${key},
				        'ready', ${r.width}, ${r.height}, ${r.durationSec}, ${r.thumbhash}, ${r.takenAt},
				        ${JSON.stringify(meta)}::jsonb)`);
		}
		// Its objects now belong to the saved file: only the row goes.
		await tx.execute(sql`delete from attachments where id = ${r.id}`);
		return id;
	});
}

/** Restores some of the caller's Trash (see the file comment). */
export async function restoreTrash(
	user: Pick<AuthUser, "id" | "name">,
	ids: readonly string[],
): Promise<Restored[]> {
	const { att, saved } = split(ids);
	const out: Restored[] = [];
	const access = accessCache(user.id);
	for (const r of att.length ? await attRows(user.id, att) : []) {
		const acc = r.tripGone ? null : await access(r.trip_id);
		const to = targetOf(r, acc);
		const trashedAt = new Date(r.trashedAt).getTime();
		if (!to)
			fail(
				"CONFLICT",
				"Its trip was deleted and Saved keeps only photos and videos.",
			);
		if (to === "saved") {
			const id = await intoSaved(user.id, r);
			out.push({ id: id && `s:${id}`, to, trashedAt });
			continue;
		}
		const moved =
			to === "here"
				? sql``
				: to === "place"
					? sql`, item_id = null, node_id = ${r.placeId}`
					: sql`, node_id = null, item_id = null, leg_id = null, day_id = null, expense_id = null, payment_id = null`;
		await withTripTx(
			r.trip_id,
			async (tx, o) => {
				await tx.execute(sql`
					update attachments set deleted_at = null, updated_at = now() ${moved}
					 where id = ${r.id} and trip_id = ${r.trip_id}`);
				o.emit({ keys: ["media", "counts"] });
			},
			mutationMeta(acc as TripAccess, user),
		);
		out.push({ id: `a:${r.id}`, to, trashedAt });
	}
	if (saved.length) {
		const was = (
			await db.execute(sql`
				select id::text as id, deleted_at as at from saved_links
				 where id = any(${sql.param(saved)}::uuid[]) and user_id = ${user.id} and deleted_at is not null`)
		).rows as { id: string; at: Date }[];
		const back = new Set(await restoreSaved(db, user.id, saved));
		for (const r of was)
			if (back.has(r.id))
				out.push({
					id: `s:${r.id}`,
					to: "saved",
					trashedAt: new Date(r.at).getTime(),
				});
	}
	return out;
}

/** Undo of Restore: the restored items back in Trash, with the clock they had. */
export async function retrash(
	user: Pick<AuthUser, "id" | "name">,
	items: readonly { id: string; trashedAt: number }[],
): Promise<void> {
	const now = Date.now();
	const clamp = (t: number) =>
		new Date(Math.min(now, Math.max(now - TRASH_DAYS * 86_400_000, t)));
	for (const it of items) {
		const { att, saved } = split([it.id]);
		const at = clamp(it.trashedAt);
		if (saved[0])
			await db.execute(sql`
				update saved_links set deleted_at = ${at}, updated_at = now()
				 where id = ${saved[0]} and user_id = ${user.id} and deleted_at is null`);
		if (!att[0]) continue;
		const row = (
			await db.execute(sql`
				select trip_id::text as "tripId" from attachments
				 where id = ${att[0]} and created_by = ${user.id} and deleted_at is null`)
		).rows[0] as { tripId: string } | undefined;
		if (!row) continue;
		const access = await loadTripAccess(row.tripId, user.id);
		if (!access || !can(access, "edit")) fail("NOT_FOUND");
		await withTripTx(
			row.tripId,
			async (tx, o) => {
				await tx.execute(sql`
					update attachments set deleted_at = ${at}, updated_at = now()
					 where id = ${att[0]} and trip_id = ${row.tripId}`);
				o.emit({ keys: ["media", "counts"] });
			},
			mutationMeta(access, user),
		);
	}
}

/** Deletes some of the caller's Trash for good (objects first, unless shared). Answers how many. */
export async function deleteForever(
	userId: string,
	ids: readonly string[],
	drop: Drop = deletePrefix,
): Promise<number> {
	const { att, saved } = split(ids);
	let n = 0;
	for (const r of att.length ? await attRows(userId, att) : []) {
		await dropUnsharedPrefixes(db, [r], drop);
		await db.execute(sql`delete from attachments where id = ${r.id}`);
		n += 1;
	}
	const links = saved.length ? await savedRows(userId, saved) : [];
	await dropSavedLinks(db, links, drop);
	return n + links.length;
}

/** Empty trash: everything in it, for good. */
export async function emptyTrash(
	userId: string,
	drop: Drop = deletePrefix,
): Promise<number> {
	const all = (await listTrash(userId)).map((t) => t.id);
	return all.length ? deleteForever(userId, all, drop) : 0;
}

const UUID_RE =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** `GET /api/trash/<id>/thumb`: a trip file's thumbnail, for its uploader only (Trash tiles). */
export async function serveTrashThumb(
	request: Request,
	id: string,
): Promise<Response> {
	const notFound = () =>
		new Response("Not found", {
			status: 404,
			headers: { "Cache-Control": "no-store", "Content-Type": "text/plain" },
		});
	if (!UUID_RE.test(id)) return notFound();
	const session = await loadSession(request.headers);
	if (!session) return notFound();
	const row = (
		await db.execute(sql`
			select id::text as id, trip_id::text as "tripId", storage_key as "storageKey"
			  from attachments where id = ${id} and created_by = ${session.user.id}`)
	).rows[0] as { id: string; tripId: string; storageKey: string | null };
	if (!row) return notFound();
	const obj = await streamObject(rowKey(row, "thumb.webp"));
	if (!obj) return notFound();
	return new Response(obj.body, {
		status: 200,
		headers: {
			"Content-Type": "image/webp",
			"Cache-Control": "private, max-age=86400",
			"X-Content-Type-Options": "nosniff",
			"Content-Security-Policy": "default-src 'none'; sandbox",
		},
	});
}
