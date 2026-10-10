/**
 * Photos and videos shared into Saved (`saved_files`), uploaded by the share
 * page in the foreground, the way trip uploads go: a presigned PUT (or
 * multipart parts) straight to storage under `saved/<userId>/<fileId>/`,
 * then `completeSavedFile` copies and checks the upload and the `saved.file`
 * job makes the thumbnails (a video's poster). One share is one saved item
 * (the device's id for it, `client_id`); each file is a slide, by position.
 * Starting a file again (the page closed mid-way) restarts only that file;
 * a finished one answers `done`.
 *
 * Quota (ADDENDUM §12): they count against their owner like uploads in a
 * trip, checked when a file starts under the account's lock. Added to a
 * trip (`attachSaved`), the attachments re-reference the same objects
 * (`storage_key`), so they count once.
 */
import { sql } from "drizzle-orm";
import { v7 as uuidv7 } from "uuid";
import { db } from "@/db/db.server";
import { attachments } from "@/db/schema";
import {
	IMAGE_MAX_BYTES,
	kindForMime,
	MULTIPART_PART_BYTES,
	maxBytesFor,
} from "@/features/media/media-kinds";
import {
	assertAttachmentTarget,
	defaultVisibility,
} from "@/features/media/server/dto.server";
import {
	photoVariants,
	thumbFrom,
} from "@/features/media/server/images.server";
import { logMediaAdd } from "@/features/media/server/media-activity.server";
import { sniffMatches } from "@/features/media/server/sniff";
import {
	abortMultipart,
	checkParts,
	completeMultipart,
	copyObject,
	createMultipart,
	deleteObject,
	headObject,
	partSizes,
	presignGet,
	presignPart,
	presignPut,
	putObject,
	readHead,
	readObject,
} from "@/features/media/server/storage.server";
import { stripGps } from "@/features/media/server/strip-gps";
import { posterFrame } from "@/features/media/server/video.server";
import type { AuthUser } from "@/server/auth.server";
import { fail } from "@/server/authz/session.server";
import { enqueue } from "@/server/live/jobs.server";
import { positionFor } from "@/server/position.server";
import { requireEditOnly } from "@/server/proposals/proposable.server";
import { assertQuota, lockQuota } from "@/server/quota.server";
import { mutationMeta, withTripTx } from "@/server/tx.server";
import { assertRoom, SAVED } from "./saved.server";

type Multipart = { uploadId: string; partSize: number; parts: number };

type FileRow = {
	id: string;
	savedId: string;
	userId: string;
	kind: "photo" | "video";
	mime: string;
	size: number;
	storageKey: string;
	status: "pending" | "processing" | "ready" | "failed";
	width: number | null;
	height: number | null;
	durationSec: number | null;
	thumbhash: string | null;
	meta: { multipart?: Multipart; thumb?: boolean; poster?: boolean };
};

const FILE_COLS = sql`id::text as id, saved_id::text as "savedId", user_id as "userId", kind, mime,
	size_bytes::float8 as size, storage_key as "storageKey", status, width, height,
	duration_sec as "durationSec", thumbhash, meta`;

/** `saved/<userId>/<fileId>/`. */
export function savedFilePrefix(userId: string, fileId: string): string {
	return `saved/${userId}/${fileId}/`;
}

const uploadOf = (f: Pick<FileRow, "storageKey">) =>
	`${f.storageKey}original.upload`;
const originalOf = (f: Pick<FileRow, "storageKey">) =>
	`${f.storageKey}original`;

/** The caller's own saved file (not deleted), or null. */
export async function ownFile(
	userId: string,
	fileId: string,
): Promise<FileRow | null> {
	const res = await db.execute(sql`
		select ${FILE_COLS} from saved_files
		 where id = ${fileId} and user_id = ${userId} and deleted_at is null`);
	return (res.rows[0] as FileRow | undefined) ?? null;
}

export type StartedFile =
	| { savedId: string; fileId: string; done: true }
	| {
			savedId: string;
			fileId: string;
			done: false;
			url?: string;
			multipart?: { partSize: number; parts: number };
	  };

/**
 * Starts (or starts again) file `position` of the share `clientId`: its
 * saved item is made with the first file. Over the quota: `STORAGE_QUOTA`.
 */
export async function startSavedFile(
	userId: string,
	p: {
		clientId: string;
		text: string | null;
		title: string | null;
		position: number;
		type: string;
		size: number;
	},
): Promise<StartedFile> {
	const kind = kindForMime(p.type);
	if (kind !== "photo" && kind !== "video")
		return fail("VALIDATION", "That file type isn't supported.");
	if (p.size > maxBytesFor(kind))
		return fail("VALIDATION", "That file is too large.");
	const started = await db.transaction(async (tx) => {
		await lockQuota(tx, userId);
		let savedId = (
			(
				await tx.execute(sql`
					select id::text as id from saved_links
					 where user_id = ${userId} and client_id = ${p.clientId}`)
			).rows[0] as { id: string } | undefined
		)?.id;
		if (!savedId) {
			await assertRoom(tx, userId);
			savedId = uuidv7();
			await tx.execute(sql`
				insert into saved_links (id, user_id, client_id, text, title, preview_status)
				values (${savedId}, ${userId}, ${p.clientId},
				        ${p.text?.slice(0, SAVED.textMax) ?? null}, ${p.title?.slice(0, SAVED.titleMax) ?? null}, 'ready')`);
		}
		const had = (
			await tx.execute(sql`
				select ${FILE_COLS} from saved_files
				 where saved_id = ${savedId} and position = ${p.position} and deleted_at is null
				 for update`)
		).rows[0] as FileRow | undefined;
		if (had && (had.status === "ready" || had.status === "processing"))
			return { savedId, file: had, done: true as const, old: null };
		await assertQuota(tx, {
			billedUserId: userId,
			size: p.size,
			...(had ? { excludeSavedFile: had.id } : {}),
		});
		const id = had?.id ?? uuidv7();
		const storageKey = savedFilePrefix(userId, id);
		if (had)
			await tx.execute(sql`
				update saved_files
				   set kind = ${kind}, mime = ${p.type}, size_bytes = ${p.size}, status = 'pending',
				       meta = '{}'::jsonb, updated_at = now()
				 where id = ${id}`);
		else
			await tx.execute(sql`
				insert into saved_files (id, saved_id, user_id, position, kind, mime, size_bytes, storage_key)
				values (${id}, ${savedId}, ${userId}, ${p.position}, ${kind}, ${p.type}, ${p.size}, ${storageKey})`);
		return {
			savedId,
			file: { id, storageKey } as FileRow,
			done: false as const,
			old: had?.meta.multipart ?? null,
		};
	});
	if (started.done)
		return { savedId: started.savedId, fileId: started.file.id, done: true };
	const upload = uploadOf(started.file);
	if (started.old)
		await abortMultipart(upload, started.old.uploadId).catch(() => {});
	if (p.size > MULTIPART_PART_BYTES) {
		const mp: Multipart = {
			uploadId: await createMultipart(upload, p.type),
			partSize: MULTIPART_PART_BYTES,
			parts: partSizes(p.size, MULTIPART_PART_BYTES).length,
		};
		await db.execute(sql`
			update saved_files set meta = ${JSON.stringify({ multipart: mp })}::jsonb
			 where id = ${started.file.id}`);
		return {
			savedId: started.savedId,
			fileId: started.file.id,
			done: false,
			multipart: { partSize: mp.partSize, parts: mp.parts },
		};
	}
	return {
		savedId: started.savedId,
		fileId: started.file.id,
		done: false,
		url: await presignPut(upload, p.type, p.size),
	};
}

/** Presigned part URLs of the caller's own multipart saved file. */
export async function signSavedFileParts(
	userId: string,
	fileId: string,
	parts: number[],
): Promise<{ part: number; url: string }[]> {
	const f = await ownFile(userId, fileId);
	const mp = f?.meta.multipart;
	if (!f || !mp || f.status !== "pending") return fail("NOT_FOUND");
	const sizes = partSizes(f.size, mp.partSize);
	const urls: { part: number; url: string }[] = [];
	for (const part of new Set(parts)) {
		const size = sizes[part - 1];
		if (!size) return fail("VALIDATION", "That part isn't in this upload.");
		urls.push({
			part,
			url: await presignPart(uploadOf(f), mp.uploadId, part, size),
		});
	}
	return urls;
}

/**
 * The caller's file arrived: the upload is copied to its served key and the
 * copy checked (size, type, magic bytes), then the thumbnails follow.
 * `done`: every file of its share is up.
 */
export async function completeSavedFile(
	userId: string,
	p: {
		fileId: string;
		width?: number;
		height?: number;
		durationSec?: number;
	},
): Promise<{ savedId: string; done: boolean }> {
	const f = await ownFile(userId, p.fileId);
	if (!f) return fail("NOT_FOUND");
	if (f.status === "pending") {
		const upload = uploadOf(f);
		const key = originalOf(f);
		const mp = f.meta.multipart;
		let uploaded = !!(await headObject(upload));
		if (!uploaded && mp && !(await headObject(key))) {
			const parts = await checkParts(
				upload,
				mp.uploadId,
				partSizes(f.size, mp.partSize),
			);
			if (!parts.ok)
				return fail("VALIDATION", "The upload didn't arrive. Try again.");
			await completeMultipart(upload, mp.uploadId, parts.parts);
			uploaded = true;
		}
		if (uploaded) {
			await copyObject(upload, key);
			await deleteObject(upload);
		}
		const head = await headObject(key);
		if (!head)
			return fail("VALIDATION", "The upload didn't arrive. Try again.");
		const ok =
			head.size === f.size &&
			(!head.contentType || head.contentType === f.mime) &&
			sniffMatches(f.mime, await readHead(key, 64));
		if (!ok) {
			await db.execute(sql`
				update saved_files set status = 'failed', updated_at = now() where id = ${f.id}`);
			return fail(
				"VALIDATION",
				"That file isn't what its name says. Export it again and retry.",
			);
		}
		await db.execute(sql`
			update saved_files
			   set status = 'processing', width = ${p.width ?? null}, height = ${p.height ?? null},
			       duration_sec = ${p.durationSec ?? null}, meta = '{}'::jsonb, updated_at = now()
			 where id = ${f.id} and status = 'pending'`);
		await enqueue(
			"saved",
			"saved.file",
			{ userId, fileId: f.id },
			{ dedupeId: `saved-file-${f.id}` },
		);
	}
	const left = await db.execute(sql`
		select count(*)::int as n from saved_files
		 where saved_id = ${f.savedId} and deleted_at is null and status = 'pending'`);
	return {
		savedId: f.savedId,
		done: (left.rows[0] as { n: number }).n === 0,
	};
}

/** `saved.file`: a saved photo's thumb and display WebPs, or a video's poster and thumb. */
export async function savedFileVariants(job: {
	userId: string;
	fileId: string;
}): Promise<void> {
	const f = await ownFile(job.userId, job.fileId);
	if (f?.status !== "processing") return;
	const key = (v: string) => `${f.storageKey}${v}`;
	try {
		if (f.kind === "photo") {
			const buf = await readObject(key("original"), IMAGE_MAX_BYTES);
			// The served original loses its location (CONTENT-06).
			if (stripGps(buf, f.mime)) await putObject(key("original"), buf, f.mime);
			const v = await photoVariants(buf);
			await putObject(key("thumb.webp"), v.thumb, "image/webp");
			await putObject(key("display.webp"), v.display, "image/webp");
			await db.execute(sql`
				update saved_files
				   set status = 'ready', width = ${v.width || f.width}, height = ${v.height || f.height},
				       thumbhash = ${v.thumbhash}, meta = '{"thumb": true}'::jsonb, updated_at = now()
				 where id = ${f.id}`);
		} else {
			const url = await presignGet(key("original"), { internal: true });
			const poster = await posterFrame(url, f.mime);
			const t = await thumbFrom(poster);
			await putObject(key("poster.jpg"), poster, "image/jpeg");
			await putObject(key("thumb.webp"), t.thumb, "image/webp");
			await db.execute(sql`
				update saved_files
				   set status = 'ready', width = coalesce(width, ${t.width}), height = coalesce(height, ${t.height}),
				       thumbhash = ${t.thumbhash}, meta = '{"thumb": true, "poster": true}'::jsonb, updated_at = now()
				 where id = ${f.id}`);
		}
	} catch (e) {
		// An undecodable photo never gets better; a video without ffmpeg still plays.
		console.error(`[saved] variants ${f.id}:`, (e as Error).message);
		await db.execute(sql`
			update saved_files set status = ${f.kind === "photo" ? "failed" : "ready"}, updated_at = now()
			 where id = ${f.id}`);
	}
}

/**
 * A saved share's photos and videos onto a place in a trip (edit access):
 * new attachments that re-reference the saved objects (`storage_key`), so
 * nothing is copied and nothing counts twice.
 */
export async function attachSaved(
	user: AuthUser,
	p: { savedId: string; tripId: string; nodeId: string },
): Promise<{ count: number }> {
	const access = await requireEditOnly("attachSavedFiles", p.tripId, user);
	const files = (
		await db.execute(sql`
			select ${FILE_COLS} from saved_files f
			 where f.saved_id = ${p.savedId} and f.user_id = ${user.id} and f.deleted_at is null
			   and f.status in ('processing', 'ready')
			   and exists (select 1 from saved_links s where s.id = f.saved_id and s.deleted_at is null)
			 order by position`)
	).rows as FileRow[];
	if (!files.length) return fail("NOT_FOUND");
	const target = { kind: "node" as const, nodeId: p.nodeId };
	await withTripTx(
		p.tripId,
		async (tx, out) => {
			await assertAttachmentTarget(tx, p.tripId, target, user.id);
			for (const f of files) {
				const id = uuidv7();
				const visibility = await defaultVisibility(
					tx,
					p.tripId,
					target,
					f.kind,
				);
				await tx.insert(attachments).values({
					id,
					tripId: p.tripId,
					nodeId: p.nodeId,
					kind: f.kind,
					status: f.status === "ready" ? "ready" : "processing",
					visibility,
					storageKey: f.storageKey,
					mime: f.mime,
					sizeBytes: f.size,
					width: f.width,
					height: f.height,
					durationSec: f.durationSec,
					thumbhash: f.thumbhash,
					meta: f.meta.thumb ? { thumb: true } : {},
					position: await positionFor(tx, {
						table: "attachments",
						tripId: p.tripId,
						target,
					}),
					createdBy: user.id,
				});
				await logMediaAdd(tx, out, {
					tripId: p.tripId,
					actor: { userId: user.id, name: user.name },
					target,
					kind: f.kind,
					visibility,
				});
				// Still making its thumbnails: the trip's own job makes them (same objects).
				if (f.status !== "ready")
					out.job(
						"media",
						f.kind === "video" ? "media.poster" : "media.variants",
						{ tripId: p.tripId, attachmentId: id },
						{ dedupeId: `media:${id}` },
					);
			}
			out.emit({ keys: ["media", "counts"] });
		},
		mutationMeta(access, user),
	);
	return { count: files.length };
}
