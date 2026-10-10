/**
 * Saved on the server (`saved_links`, `saved_files`): save, list, mark
 * added, delete and undo. Saving is instant; the preview comes from the
 * `saved.preview` job (`./preview.server.ts`); photos and videos upload
 * through `./files.server.ts`. A link already waiting in Saved is never saved
 * twice (`link_key`, its canonical link): saving it again answers that row.
 * Delete is a soft delete (Undo puts it back; the space is free at once, the
 * objects go in the purge). Every read and write is the caller's own rows.
 */
import { sql } from "drizzle-orm";
import { v7 as uuidv7 } from "uuid";
import type { DbOrTx } from "@/db/db.server";
import type { SavedPlace } from "@/db/schema/saved";
import { canonicalLink, classifyUrl } from "@/features/media/embeds";
import { AppError } from "@/server/errors";
import { enqueue } from "@/server/live/jobs.server";
import { assertQuota, lockQuota } from "@/server/quota.server";
import type { SavedFile, SavedLink } from "../types";

type Exec = Pick<DbOrTx, "execute">;

export const SAVED = {
	/** Live saved links per account (add or delete some to save more). */
	max: 1000,
	/** The grid shows at most this many. */
	list: 500,
	textMax: 2000,
	titleMax: 300,
} as const;

/** Where a saved link's re-hosted pictures live in the bucket. */
export function savedPrefix(userId: string, id: string): string {
	return `saved/${userId}/${id}/`;
}

/** Asks for the preview (once while one is waiting or running). */
export async function enqueuePreview(userId: string, id: string) {
	await enqueue(
		"saved",
		"saved.preview",
		{ userId, savedId: id },
		{ dedupeId: `saved-${id}` },
	);
}

export type SaveInput = {
	url: string | null;
	text: string | null;
	title?: string | null;
	/** The device's id for it: saving it again answers the same row. */
	clientId?: string | null;
};

/** The link a saved row is known by: `canonicalLink` (an Instagram post without its tracking), else the URL. */
export function linkKeyOf(url: string): string {
	const c = classifyUrl(url);
	return c.kind === "embed"
		? (canonicalLink(
				c.provider,
				c.embedId,
				url,
				c.provider === "instagram" ? c.igType : null,
			) ?? url)
		: url;
}

/** The caller's row for a device id, or the waiting row for the same link. */
async function existing(
	db: Exec,
	userId: string,
	input: SaveInput,
): Promise<string | null> {
	const key = input.url ? linkKeyOf(input.url) : null;
	const had = await db.execute(sql`
		select id::text as id from saved_links
		 where user_id = ${userId}
		   and ((${input.clientId ?? null}::text is not null and client_id = ${input.clientId ?? null})
		     or (${key}::text is not null and link_key = ${key} and deleted_at is null and added_at is null))
		 order by (client_id is not distinct from ${input.clientId ?? null}) desc
		 limit 1`);
	return (had.rows[0] as { id: string } | undefined)?.id ?? null;
}

/** Saves a link (or words) for `userId`; its preview follows. A link already waiting answers its row. */
export async function saveLink(
	db: Exec,
	userId: string,
	input: SaveInput,
	retried = false,
): Promise<{ id: string; created: boolean }> {
	const had = await existing(db, userId, input);
	if (had) return { id: had, created: false };
	await assertRoom(db, userId);
	const c = input.url ? classifyUrl(input.url) : null;
	const embed = c?.kind === "embed" ? c : null;
	const id = uuidv7();
	// Any unique key taken meanwhile (the same device id, the same link): that row.
	const res = await db.execute(sql`
		insert into saved_links (id, user_id, client_id, url, link_key, text, title, provider, embed_id, ig_type, preview_status)
		values (${id}, ${userId}, ${input.clientId ?? null}, ${input.url},
		        ${input.url ? linkKeyOf(input.url) : null},
		        ${input.text?.slice(0, SAVED.textMax) ?? null}, ${input.title?.slice(0, SAVED.titleMax) ?? null},
		        ${embed?.provider ?? null}, ${embed?.embedId ?? null},
		        ${embed?.provider === "instagram" ? embed.igType : null},
		        ${input.url ? "pending" : "ready"})
		on conflict do nothing
		returning id::text as id`);
	if (!res.rows.length) {
		if (retried) throw new AppError("CONFLICT", "That's already in Saved.");
		return saveLink(db, userId, input, true);
	}
	if (input.url) await enqueuePreview(userId, id);
	return { id, created: true };
}

/** Refuses a new saved item past `SAVED.max` waiting ones. */
export async function assertRoom(db: Exec, userId: string): Promise<void> {
	const live = await db.execute(sql`
		select count(*)::int as n from saved_links
		 where user_id = ${userId} and deleted_at is null and added_at is null`);
	if ((live.rows[0] as { n: number }).n >= SAVED.max)
		throw new AppError(
			"CONFLICT",
			"Saved is full. Add some to a trip or delete a few first.",
		);
}

type Row = {
	id: string;
	url: string | null;
	text: string | null;
	title: string | null;
	provider: string | null;
	embedId: string | null;
	igType: string | null;
	status: SavedLink["status"];
	previewTitle: string | null;
	description: string | null;
	author: string | null;
	siteName: string | null;
	imageKey: string | null;
	imageW: number | null;
	imageH: number | null;
	thumbhash: string | null;
	faviconKey: string | null;
	place: SavedPlace | null;
	createdAt: Date | string;
	updatedAt: Date | string;
};

function dto(r: Row, nearTrips: string[], files: SavedFile[]): SavedLink {
	const v = new Date(r.updatedAt).getTime().toString(36);
	return {
		id: r.id,
		url: r.url,
		text: r.text,
		title: r.title,
		provider: r.provider,
		embedId: r.embedId,
		igType: r.igType,
		status: r.status,
		previewTitle: r.previewTitle,
		description: r.description,
		author: r.author,
		siteName: r.siteName,
		image: r.imageKey ? `/api/saved/${r.id}/image?v=${v}` : null,
		imageW: r.imageW,
		imageH: r.imageH,
		thumbhash: r.thumbhash,
		favicon: r.faviconKey ? `/api/saved/${r.id}/favicon?v=${v}` : null,
		place: r.place,
		nearTrips,
		files,
		createdAt: new Date(r.createdAt).getTime(),
	};
}

/**
 * The caller's saved links still waiting for a trip, newest first. A preview
 * that never came (Redis was down, links moved from the old Shortcut table)
 * is asked for again.
 */
export async function listSaved(
	db: Exec,
	userId: string,
): Promise<SavedLink[]> {
	const res = await db.execute(sql`
		select id::text as id, url, text, title, provider, embed_id as "embedId", ig_type as "igType",
		       preview_status as status, preview_title as "previewTitle", description, author,
		       site_name as "siteName", image_key as "imageKey", image_w as "imageW", image_h as "imageH",
		       thumbhash, favicon_key as "faviconKey", place, created_at as "createdAt", updated_at as "updatedAt"
		  from saved_links
		 where user_id = ${userId} and deleted_at is null and added_at is null
		 order by created_at desc, id desc
		 limit ${SAVED.list}`);
	const rows = res.rows as Row[];
	const stale = rows.filter(
		(r) =>
			r.status === "pending" &&
			Date.now() - new Date(r.updatedAt).getTime() > 2 * 60_000,
	);
	if (stale.length) {
		await db.execute(sql`
			update saved_links set updated_at = now()
			 where user_id = ${userId} and id in (${sql.join(
					stale.map((r) => sql`${r.id}::uuid`),
					sql`, `,
				)})`);
		for (const r of stale) await enqueuePreview(userId, r.id);
	}
	const near = rows.some((r) => r.place) ? await nearTrips(db, userId) : null;
	const files = rows.length
		? await filesOf(
				db,
				userId,
				rows.map((r) => r.id),
			)
		: new Map<string, SavedFile[]>();
	// A share of photos shows once every file is up (the device finishes it).
	return rows
		.filter((r) => {
			const f = files.get(r.id);
			return f
				? f.length > 0 && f.every((x) => x.status !== "pending")
				: !!(r.url || r.text);
		})
		.map((r) => dto(r, near?.get(r.id) ?? [], files.get(r.id) ?? []));
}

/** The saved photos and videos of these rows, in order (failed ones left out). */
async function filesOf(
	db: Exec,
	userId: string,
	ids: string[],
): Promise<Map<string, SavedFile[]>> {
	const res = await db.execute(sql`
		select id::text as id, saved_id::text as "savedId", kind, mime, status, width, height,
		       duration_sec as "durationSec", thumbhash, (meta->>'thumb')::boolean as thumb,
		       (meta->>'poster')::boolean as poster
		  from saved_files
		 where user_id = ${userId} and deleted_at is null and status <> 'failed'
		   and saved_id = any(${sql.param(ids)}::uuid[])
		 order by saved_id, position`);
	const out = new Map<string, SavedFile[]>();
	for (const r of res.rows as (SavedFile & {
		savedId: string;
		thumb: boolean | null;
		poster: boolean | null;
	})[]) {
		const { savedId, thumb, poster, ...f } = r;
		out.set(savedId, [
			...(out.get(savedId) ?? []),
			{ ...f, hasThumb: !!thumb, hasPoster: !!poster },
		]);
	}
	return out;
}

/**
 * For each saved Maps place, the trips I can add to (owner, editor,
 * suggester) with a city, area or place within about 50 km, nearest first.
 */
async function nearTrips(
	db: Exec,
	userId: string,
): Promise<Map<string, string[]>> {
	const res = await db.execute(sql`
		with s as (
			select id, (place->>'lat')::float8 as lat, (place->>'lng')::float8 as lng
			  from saved_links
			 where user_id = ${userId} and place is not null and deleted_at is null and added_at is null)
		select s.id::text as id, n.trip_id::text as "tripId",
		       min(power(n.lat - s.lat, 2) + power((n.lng - s.lng) * cos(radians(s.lat)), 2)) as d
		  from s
		  join trip_members m on m.user_id = ${userId} and m.status = 'active'
		   and m.role in ('owner', 'editor', 'suggester')
		  join trips t on t.id = m.trip_id and t.deleted_at is null
		  join nodes n on n.trip_id = m.trip_id and n.deleted_at is null
		   and n.type in ('city', 'area', 'place') and n.lat is not null and n.lng is not null
		   and abs(n.lat - s.lat) < 0.45 and abs(n.lng - s.lng) < 0.45 / greatest(cos(radians(s.lat)), 0.2)
		 group by s.id, n.trip_id
		 order by s.id, d`);
	const out = new Map<string, string[]>();
	for (const r of res.rows as { id: string; tripId: string }[])
		out.set(r.id, [...(out.get(r.id) ?? []), r.tripId]);
	return out;
}

/** Notes where the link went (it leaves the grid). False: not the caller's, or gone. */
export async function markAdded(
	db: Exec,
	userId: string,
	id: string,
	to: { tripId: string; nodeId: string | null },
): Promise<boolean> {
	const res = await db.execute(sql`
		update saved_links
		   set added_trip_id = ${to.tripId}, added_node_id = ${to.nodeId}, added_at = now(), updated_at = now()
		 where id = ${id} and user_id = ${userId} and deleted_at is null
		returning id`);
	return res.rows.length > 0;
}

/**
 * Deletes some of the caller's saved links (a soft delete: Undo restores
 * them; their photos stop counting at once, the purge removes the objects
 * later). Answers the ids it deleted (anything not the caller's is skipped).
 */
export async function deleteSaved(
	db: Exec,
	userId: string,
	ids: readonly string[],
): Promise<string[]> {
	if (!ids.length) return [];
	const res = await db.execute(sql`
		update saved_links set deleted_at = now(), updated_at = now()
		 where id = any(${sql.param([...ids])}::uuid[]) and user_id = ${userId}
		   and deleted_at is null and added_at is null
		returning id::text as id`);
	return (res.rows as { id: string }[]).map((r) => r.id);
}

/**
 * Undo: deleted saved links back where they were, all or none. Refused when
 * their photos no longer fit the quota, or a link was saved again meanwhile.
 */
export async function restoreSaved(
	db: DbOrTx,
	userId: string,
	ids: readonly string[],
): Promise<string[]> {
	if (!ids.length) return [];
	return db.transaction(async (tx) => {
		const list = sql.param([...ids]);
		const rows = (
			await tx.execute(sql`
				select id::text as id, link_key as "linkKey" from saved_links
				 where id = any(${list}::uuid[]) and user_id = ${userId} and deleted_at is not null
				 for update`)
		).rows as { id: string; linkKey: string | null }[];
		if (!rows.length) return [];
		const keys = rows.flatMap((r) => (r.linkKey ? [r.linkKey] : []));
		if (keys.length) {
			const twin = await tx.execute(sql`
				select 1 from saved_links
				 where user_id = ${userId} and link_key = any(${sql.param(keys)}::text[])
				   and deleted_at is null and added_at is null`);
			if (twin.rows.length)
				throw new AppError("CONFLICT", "That link is in Saved again already.");
		}
		const found = sql.param(rows.map((r) => r.id));
		const size = await tx.execute(sql`
			select coalesce(sum(size_bytes), 0)::bigint as n from saved_files
			 where saved_id = any(${found}::uuid[]) and deleted_at is null and status <> 'failed'`);
		const n = Number((size.rows[0] as { n: string | number }).n);
		if (n) {
			await lockQuota(tx, userId);
			await assertQuota(tx, { billedUserId: userId, size: n });
		}
		await tx.execute(sql`
			update saved_links set deleted_at = null, updated_at = now()
			 where id = any(${found}::uuid[])`);
		return rows.map((r) => r.id);
	});
}

/** A picture key of the caller's live saved link (`image` | `favicon`), or null. */
export async function savedObjectKey(
	db: Exec,
	userId: string,
	id: string,
	variant: "image" | "favicon",
): Promise<string | null> {
	const res = await db.execute(sql`
		select image_key as image, favicon_key as favicon from saved_links
		 where id = ${id} and user_id = ${userId} and deleted_at is null`);
	const row = res.rows[0] as
		| { image: string | null; favicon: string | null }
		| undefined;
	const key = row?.[variant] ?? null;
	return key?.startsWith(savedPrefix(userId, id)) ? key : null;
}
