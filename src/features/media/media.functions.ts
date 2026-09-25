/**
 * WP-Media server functions (SPEC §13.4, §15; EXTENSIONS §1.4; ADDENDUM §9).
 * Links, updates and deletes run through the gate (cores in
 * `server/proposable.server.ts`); uploads are edit-only, except receipts on
 * an expense (`manageExpenses`). Keys: media and counts.
 *
 * Upload flow (spikes/media): `createUpload` checks the uploader's storage
 * quota (ADDENDUM §12), inserts a `pending` row and presigns a PUT (10 min)
 * to the upload key with the type and exact length signed → the browser PUTs
 * to S3 → `completeUpload` copies the upload to the served key and checks
 * that copy (HeadObject + magic bytes), marks it `processing` and, after
 * COMMIT, queues the worker job that writes the variants and sets `ready`.
 * The browser can never write to a served key, so a second PUT with the same
 * URL can't replace what was checked (SEC-R1-08).
 *
 * Files over one part (`MULTIPART_PART_BYTES`, 16 MB) go up as an S3
 * multipart upload instead of one PUT: `createUpload` starts it (type bound
 * there) and answers the part count; `signUploadParts` presigns parts as the
 * browser gets to them, each with its exact length signed and the same
 * 10-minute life; `completeUpload` finishes it from storage's own part list
 * (every part present, each exactly its size) onto the upload key, then
 * copies and checks it exactly like a single PUT. `abortUpload` (cancel or
 * failure) drops the parts and the pending row.
 */
import { createServerFn } from "@tanstack/react-start";
import { and, asc, eq, isNotNull, isNull, ne, sql } from "drizzle-orm";
import { v7 as uuidv7 } from "uuid";
import { z } from "zod";
import { db } from "@/db/db.server";
import { attachments } from "@/db/schema";
import { mustRedact } from "@/lib/auth/roles";
import { AttachmentVisibility } from "@/lib/schemas/enums";
import {
	AttachmentTarget,
	attachmentTargetColumns,
	attachmentTargetOf,
} from "@/lib/schemas/targets";
import {
	requireTripCapability,
	requireTripRole,
} from "@/server/authz/access.server";
import { withNamedUser, withUser } from "@/server/authz/middleware";
import { fail } from "@/server/authz/session.server";
import { rateLimit, rateLimitPer } from "@/server/cache.server";
import { requireAttachment } from "@/server/perms.server";
import { positionFor } from "@/server/position.server";
import {
	proposable,
	requireDirect,
	requireEditOnly,
} from "@/server/proposals/proposable.server";
import { assertQuota, billedUserFor, lockQuota } from "@/server/quota.server";
import { mediaPrefix } from "@/server/s3.server";
import { mutationMeta, withTripTx } from "@/server/tx.server";
import {
	cleanFileName,
	formatBytes,
	IMAGE_MAX_BYTES,
	IMAGE_TYPES,
	kindForMime,
	MB,
	MULTIPART_PART_BYTES,
	maxBytesFor,
	PDF_MAX_BYTES,
	PDF_TYPE,
	VIDEO_MAX_BYTES_DEFAULT,
	VIDEO_TYPES,
} from "./media-kinds";
import {
	assertAttachmentTarget,
	canSeeRow,
	defaultVisibility,
	metaOf,
	toDto,
} from "./server/dto.server";
import { logMediaAdd } from "./server/media-activity.server";
import {
	AddLinkInput,
	DeleteAttachmentInput,
	UpdateAttachmentInput,
} from "./server/proposable.server";
import { sniffMatches } from "./server/sniff";
import {
	abortMultipart,
	checkParts,
	completeMultipart,
	copyObject,
	createMultipart,
	deleteObject,
	headObject,
	objectKey,
	partSizes,
	presignPart,
	presignPut,
	readHead,
	uploadKey,
} from "./server/storage.server";
import type { MediaDto } from "./types";

export type { MediaDto } from "./types";

/** Per-trip storage quota (SECURITY §5 "per-trip storage quota at presign time"). */
const TRIP_QUOTA_BYTES = 25 * 1024 * MB;

export const listTripMedia = createServerFn({ method: "GET" })
	.middleware([withUser])
	.validator(z.object({ tripId: z.uuid() }).strict())
	.handler(async ({ data, context }): Promise<MediaDto[]> => {
		const access = await requireTripRole(data.tripId, "viewer", context.user);
		const guest = mustRedact(access);
		const rows = await db
			.select()
			.from(attachments)
			.where(
				and(
					eq(attachments.tripId, data.tripId),
					isNull(attachments.deletedAt),
					// Uploads that never finished are nobody's tile.
					ne(attachments.status, "pending"),
					// Receipts are money: never for guests, and a private expense's
					// receipts only for its creator (EXTENSIONS §8.3, ADDENDUM §6).
					guest
						? and(
								isNull(attachments.expenseId),
								// ADDENDUM §9: "Hide from guests".
								eq(attachments.visibility, "everyone"),
								ne(attachments.status, "failed"),
							)
						: sql`(${attachments.expenseId} is null or exists (
								select 1 from expenses e where e.id = ${attachments.expenseId}
								   and (not e.is_private or e.created_by = ${context.user.id})))`,
				),
			)
			.orderBy(asc(attachments.position), asc(attachments.id));
		return rows.map((a) => toDto(a, context.user.id));
	});

const UPLOAD_TYPES = [...IMAGE_TYPES, ...VIDEO_TYPES, PDF_TYPE] as const;

/**
 * Per-type caps in bytes (photos and PDFs 50 MB, videos 2 GB). The content
 * type and exact length are signed into the presigned PUT (or, multipart,
 * the type into the upload and each part's exact length into its URL).
 */
export const UPLOAD_MAX_BYTES = {
	image: IMAGE_MAX_BYTES,
	video: VIDEO_MAX_BYTES_DEFAULT,
	pdf: PDF_MAX_BYTES,
} as const;

/**
 * `createUpload`'s answer: one presigned PUT, or (over one part) a multipart
 * upload whose parts `signUploadParts` presigns.
 */
export type CreatedUpload =
	| { id: string; url: string; multipart?: undefined }
	| {
			id: string;
			url?: undefined;
			multipart: { partSize: number; parts: number };
	  };

/** The multipart state of a pending upload, in `attachments.meta.multipart` (never in a DTO). */
type MultipartMeta = { uploadId: string; partSize: number; parts: number };

/** Presigning parts stops this long after the upload started (the purge drops pending rows at 24 h). */
const MULTIPART_MAX_AGE_MS = 24 * 3600 * 1000;

/** The access for writing an attachment on `target`: receipts need manageExpenses, the rest edit. */
async function uploadAccess(
	fn:
		| "createUpload"
		| "completeUpload"
		| "createPosterUpload"
		| "signUploadParts"
		| "abortUpload",
	tripId: string,
	expense: boolean,
	user: Parameters<typeof requireEditOnly>[2],
) {
	return expense
		? requireTripCapability(tripId, "manageExpenses", user)
		: requireEditOnly(fn, tripId, user);
}

export const createUpload = createServerFn({ method: "POST" })
	.middleware([withNamedUser])
	.validator(
		z
			.object({
				tripId: z.uuid(),
				/** An `expense` target (a receipt) needs `manageExpenses`, not `uploadMedia`. */
				target: AttachmentTarget,
				type: z.enum(UPLOAD_TYPES),
				size: z.number().int().positive(),
				name: z.string().max(255),
			})
			.strict(),
	)
	.handler(async ({ data, context }): Promise<CreatedUpload> => {
		const access = await uploadAccess(
			"createUpload",
			data.tripId,
			data.target.kind === "expense",
			context.user,
		);
		const kind = kindForMime(data.type);
		if (!kind) return fail("VALIDATION", "That file type isn't supported.");
		const max = maxBytesFor(kind);
		if (data.size > max)
			return fail(
				"VALIDATION",
				`That file is too large (max ${formatBytes(max)}).`,
			);
		await rateLimitPer(`upload:${context.user.id}`, 120, 60);
		// ADDENDUM §12: the uploader's quota (a link guest's: the trip owner's),
		// before any storage call; again below under the account's lock.
		const billed = await billedUserFor(db, data.tripId, context.user);
		const quota = billed
			? {
					billedUserId: billed,
					own: billed === context.user.id,
					size: data.size,
				}
			: null;
		if (quota) await assertQuota(db, quota);
		const id = uuidv7();
		const multipart = data.size > MULTIPART_PART_BYTES;
		// Started before the row exists, so the row carries its id; a failed
		// insert (quota, target) aborts it again below.
		const uploadId = multipart
			? await createMultipart(
					uploadKey(data.tripId, id, "original.upload"),
					data.type,
				)
			: null;
		try {
			await withTripTx(
				data.tripId,
				async (tx) => {
					if (quota) {
						await lockQuota(tx, quota.billedUserId);
						await assertQuota(tx, quota);
					}
					const used = await tx.execute(sql`
					select coalesce(sum(size_bytes), 0)::bigint as n from attachments
					 where trip_id = ${data.tripId} and deleted_at is null`);
					const n = Number((used.rows[0] as { n: string | number }).n);
					if (n + data.size > TRIP_QUOTA_BYTES)
						return fail("VALIDATION", "This trip is out of storage space.");
					await assertAttachmentTarget(
						tx,
						data.tripId,
						data.target,
						context.user.id,
					);
					const position = await positionFor(tx, {
						table: "attachments",
						tripId: data.tripId,
						target: data.target,
					});
					const visibility = await defaultVisibility(
						tx,
						data.tripId,
						data.target,
						kind,
					);
					const fileName = cleanFileName(data.name);
					const mp: MultipartMeta | null = uploadId
						? {
								uploadId,
								partSize: MULTIPART_PART_BYTES,
								parts: partSizes(data.size, MULTIPART_PART_BYTES).length,
							}
						: null;
					await tx.insert(attachments).values({
						id,
						tripId: data.tripId,
						...attachmentTargetColumns(data.target),
						kind,
						status: "pending",
						visibility,
						storageKey: mediaPrefix(data.tripId, id),
						mime: data.type,
						sizeBytes: data.size,
						title: kind === "pdf" ? fileName : null,
						meta: mp ? { fileName, multipart: mp } : { fileName },
						position,
						createdBy: context.user.id,
					});
				},
				mutationMeta(access, context.user),
			);
		} catch (e) {
			if (uploadId)
				await abortMultipart(
					uploadKey(data.tripId, id, "original.upload"),
					uploadId,
				).catch(() => {});
			throw e;
		}
		if (uploadId)
			return {
				id,
				multipart: {
					partSize: MULTIPART_PART_BYTES,
					parts: partSizes(data.size, MULTIPART_PART_BYTES).length,
				},
			};
		const url = await presignPut(
			uploadKey(data.tripId, id, "original.upload"),
			data.type,
			data.size,
		);
		return { id, url };
	});

/**
 * The uploader's own pending row, for the part and abort calls: NOT_FOUND
 * for anyone else, and for a receipt on someone else's private expense.
 */
async function ownPendingUpload(
	fn: "signUploadParts" | "abortUpload",
	id: string,
	user: Parameters<typeof requireEditOnly>[2],
) {
	// Deleted rows too: a second abort (cancel after a failure) is a no-op.
	const { tripId } = await requireAttachment(id, "viewer", user, {
		includeDeleted: true,
	});
	const [row] = await db
		.select()
		.from(attachments)
		.where(and(eq(attachments.tripId, tripId), eq(attachments.id, id)));
	if (!row || row.createdBy !== user.id) return fail("NOT_FOUND");
	const access = await uploadAccess(fn, tripId, !!row.expenseId, user);
	if (
		row.expenseId &&
		!(await canSeeRow(db, access, user.id, row, { includePending: true }))
	)
		return fail("NOT_FOUND");
	return { tripId, row, access };
}

function multipartOf(meta: unknown): MultipartMeta | null {
	const mp = (meta as { multipart?: MultipartMeta } | null)?.multipart;
	return mp?.uploadId ? mp : null;
}

/**
 * Presigned part URLs of the caller's own multipart upload, each valid
 * `PUT_TTL_SEC` and only for exactly that part's length (the last part is
 * the rest). The browser asks as it goes, so no URL outlives SEC-R1-08.
 */
export const signUploadParts = createServerFn({ method: "POST" })
	.middleware([withNamedUser])
	.validator(
		z
			.object({
				id: z.uuid(),
				parts: z.array(z.number().int().min(1).max(10_000)).min(1).max(32),
			})
			.strict(),
	)
	.handler(
		async ({
			data,
			context,
		}): Promise<{ urls: { part: number; url: string }[] }> => {
			const { tripId, row } = await ownPendingUpload(
				"signUploadParts",
				data.id,
				context.user,
			);
			const mp = multipartOf(row.meta);
			if (row.deletedAt || !mp) return fail("NOT_FOUND");
			if (row.status !== "pending")
				return fail("CONFLICT", "That upload is already finished.");
			if (Date.now() - row.createdAt.getTime() > MULTIPART_MAX_AGE_MS)
				return fail("VALIDATION", "That upload took too long. Start it again.");
			await rateLimitPer(`upload-parts:${context.user.id}`, 600, 60);
			const sizes = partSizes(row.sizeBytes ?? 0, mp.partSize);
			const key = uploadKey(tripId, row.id, "original.upload");
			const urls: { part: number; url: string }[] = [];
			for (const part of new Set(data.parts)) {
				const size = sizes[part - 1];
				if (!size) return fail("VALIDATION", "That part isn't in this upload.");
				urls.push({
					part,
					url: await presignPart(key, mp.uploadId, part, size),
				});
			}
			return { urls };
		},
	);

/**
 * Cancel or failure of the caller's own upload: aborts its multipart upload
 * (the parts go) and drops the pending row, so no tile or quota use remains.
 * A finished upload is left alone.
 */
export const abortUpload = createServerFn({ method: "POST" })
	.middleware([withNamedUser])
	.validator(z.object({ id: z.uuid() }).strict())
	.handler(async ({ data, context }): Promise<{ ok: true }> => {
		const { tripId, row, access } = await ownPendingUpload(
			"abortUpload",
			data.id,
			context.user,
		);
		if (row.status !== "pending" || row.deletedAt) return { ok: true };
		const mp = multipartOf(row.meta);
		if (mp)
			await abortMultipart(
				uploadKey(tripId, row.id, "original.upload"),
				mp.uploadId,
			);
		await withTripTx(
			tripId,
			async (tx, out) => {
				await tx
					.update(attachments)
					.set({ deletedAt: new Date(), updatedAt: new Date() })
					.where(
						and(
							eq(attachments.tripId, tripId),
							eq(attachments.id, row.id),
							eq(attachments.status, "pending"),
							isNull(attachments.deletedAt),
						),
					);
				out.emit({ keys: ["media", "counts"] });
			},
			mutationMeta(access, context.user),
		);
		return { ok: true };
	});

/** The uploader's own pending video row, for the poster PUT. */
export const createPosterUpload = createServerFn({ method: "POST" })
	.middleware([withNamedUser])
	.validator(
		z
			.object({
				id: z.uuid(),
				/** The poster JPEG's exact size (signed into the PUT; ≤ 10 MB). */
				size: z
					.number()
					.int()
					.positive()
					.max(10 * MB)
					.optional(),
			})
			.strict(),
	)
	.handler(async ({ data, context }): Promise<{ url: string }> => {
		if (!data.size) return fail("VALIDATION", "The poster size is required.");
		const { tripId } = await requireAttachment(data.id, "viewer", context.user);
		const [row] = await db
			.select()
			.from(attachments)
			.where(and(eq(attachments.tripId, tripId), eq(attachments.id, data.id)));
		if (!row || row.createdBy !== context.user.id || row.kind !== "video")
			return fail("NOT_FOUND");
		const access = await uploadAccess(
			"createPosterUpload",
			tripId,
			!!row.expenseId,
			context.user,
		);
		// A receipt on a private expense is its creator's alone (SEC-R1-07).
		if (
			row.expenseId &&
			!(await canSeeRow(db, access, context.user.id, row, {
				includePending: true,
			}))
		)
			return fail("NOT_FOUND");
		if (row.status !== "pending")
			return fail("CONFLICT", "That upload is already finished.");
		const url = await presignPut(
			uploadKey(tripId, row.id, "poster.upload"),
			"image/jpeg",
			data.size,
		);
		return { url };
	});

/**
 * The client's poster frame: copied from its upload key to `poster.jpg` and
 * checked there (a JPEG). False when there is none or it isn't one (the
 * worker's ffmpeg makes the poster instead).
 */
async function finalizePoster(tripId: string, id: string): Promise<boolean> {
	const upload = uploadKey(tripId, id, "poster.upload");
	if (!(await headObject(upload))) return false;
	const key = objectKey(tripId, id, "poster.jpg");
	await copyObject(upload, key);
	await deleteObject(upload);
	if (sniffMatches("image/jpeg", await readHead(key, 16))) return true;
	await deleteObject(key);
	return false;
}

export const completeUpload = createServerFn({ method: "POST" })
	.middleware([withNamedUser])
	.validator(
		z
			.object({
				id: z.uuid(),
				width: z.number().int().positive().max(100_000).optional(),
				height: z.number().int().positive().max(100_000).optional(),
				durationSec: z.number().nonnegative().max(86_400).optional(),
				takenAt: z.iso.datetime({ offset: true }).optional(),
				hasPoster: z.boolean(),
			})
			.strict(),
	)
	.handler(async ({ data, context }): Promise<MediaDto> => {
		const { tripId } = await requireAttachment(data.id, "viewer", context.user);
		const [pending] = await db
			.select()
			.from(attachments)
			.where(and(eq(attachments.tripId, tripId), eq(attachments.id, data.id)));
		// Only the uploader finishes their upload (finalize takes an id, never a key).
		if (!pending || pending.createdBy !== context.user.id || pending.deletedAt)
			return fail("NOT_FOUND");
		const access = await uploadAccess(
			"completeUpload",
			tripId,
			!!pending.expenseId,
			context.user,
		);
		// A receipt on a private expense is its creator's alone (SEC-R1-07).
		if (
			pending.expenseId &&
			!(await canSeeRow(db, access, context.user.id, pending, {
				includePending: true,
			}))
		)
			return fail("NOT_FOUND");
		if (pending.status !== "pending") return toDto(pending, context.user.id);

		const upload = uploadKey(tripId, pending.id, "original.upload");
		const key = objectKey(tripId, pending.id, "original");
		const mp = multipartOf(pending.meta);

		// ADDENDUM §12: the quota again, before anything is kept (the size is
		// the declared one, bound to the signatures). Over it, the upload goes.
		const billed = await billedUserFor(db, tripId, context.user);
		if (billed)
			try {
				await assertQuota(db, {
					billedUserId: billed,
					own: billed === context.user.id,
					size: pending.sizeBytes ?? 0,
					exclude: pending.id,
				});
			} catch (e) {
				if (mp) await abortMultipart(upload, mp.uploadId).catch(() => {});
				await deleteObject(upload).catch(() => {});
				await withTripTx(
					tripId,
					async (tx, out) => {
						await tx
							.update(attachments)
							.set({
								status: "failed",
								deletedAt: new Date(),
								updatedAt: new Date(),
							})
							.where(
								and(
									eq(attachments.tripId, tripId),
									eq(attachments.id, pending.id),
								),
							);
						out.emit({ keys: ["media", "counts"] });
					},
					mutationMeta(access, context.user),
				);
				throw e;
			}

		// A multipart upload is finished here, from storage's own part list:
		// every part present with exactly its signed size (a retry after it
		// finished finds the object, or its checked copy, instead).
		let uploaded = !!(await headObject(upload));
		if (!uploaded && mp && !(await headObject(key))) {
			const parts = await checkParts(
				upload,
				mp.uploadId,
				partSizes(pending.sizeBytes ?? 0, mp.partSize),
			);
			if (!parts.ok)
				return fail("VALIDATION", "The upload didn't arrive. Try again.");
			await completeMultipart(upload, mp.uploadId, parts.parts);
			uploaded = true;
		}

		// SEC-R1-08: the browser's PUT URL stays valid after this call, so the
		// upload is copied to the served key (which only the server writes)
		// and the COPY is checked: size, type, magic bytes.
		// (A retry after a copy that already happened finds only the copy.)
		if (uploaded) {
			await copyObject(upload, key);
			await deleteObject(upload);
		}
		const head = await headObject(key);
		if (!head)
			return fail("VALIDATION", "The upload didn't arrive. Try again.");
		const head64 = await readHead(key, 64);
		const ok =
			head.size === pending.sizeBytes &&
			(!head.contentType || head.contentType === pending.mime) &&
			sniffMatches(pending.mime ?? "", head64);
		const hasPoster =
			ok &&
			data.hasPoster &&
			pending.kind === "video" &&
			(await finalizePoster(tripId, pending.id));

		const result = await withTripTx(
			tripId,
			async (tx, out) => {
				if (!ok) {
					await tx
						.update(attachments)
						.set({
							status: "failed",
							deletedAt: new Date(),
							updatedAt: new Date(),
						})
						.where(
							and(
								eq(attachments.tripId, tripId),
								eq(attachments.id, pending.id),
							),
						);
					return null;
				}
				const [row] = await tx
					.update(attachments)
					.set({
						status: "processing",
						width: data.width ?? null,
						height: data.height ?? null,
						durationSec: data.durationSec ?? null,
						takenAt: data.takenAt ? new Date(data.takenAt) : null,
						updatedAt: new Date(),
					})
					.where(
						and(
							eq(attachments.tripId, tripId),
							eq(attachments.id, pending.id),
							eq(attachments.status, "pending"),
							isNull(attachments.deletedAt),
						),
					)
					.returning();
				if (!row) return fail("NOT_FOUND");
				await logMediaAdd(tx, out, {
					tripId,
					actor: { userId: context.user.id, name: context.user.name },
					target: attachmentTargetOf(row),
					kind: row.kind,
					visibility: row.visibility,
				});
				if (row.kind === "video" && !hasPoster)
					out.job(
						"media",
						"media.poster",
						{ tripId, attachmentId: row.id },
						{ dedupeId: `media:${row.id}` },
					);
				else
					out.job(
						"media",
						"media.variants",
						{ tripId, attachmentId: row.id },
						{ dedupeId: `media:${row.id}` },
					);
				out.emit({ keys: ["media", "counts"] });
				return row;
			},
			mutationMeta(access, context.user),
		);
		if (!result)
			return fail(
				"VALIDATION",
				"That file isn't what its name says. Export it again and retry.",
			);
		return toDto(result, context.user.id);
	});

/**
 * ADDENDUM §9 "Hide from guests": any member (never a guest) flips an
 * attachment between `everyone` and `members`. Receipts always stay
 * `members`. Direct, never a proposal. Keys: media, counts.
 */
export const setAttachmentVisibility = createServerFn({ method: "POST" })
	.middleware([withNamedUser])
	.validator(
		z.object({ id: z.uuid(), visibility: AttachmentVisibility }).strict(),
	)
	.handler(async ({ data, context }): Promise<{ ok: true }> => {
		const { tripId } = await requireAttachment(data.id, "viewer", context.user);
		const access = await requireDirect(
			"setAttachmentVisibility",
			tripId,
			context.user,
		);
		return withTripTx(
			tripId,
			async (tx, out) => {
				const [row] = await tx
					.select()
					.from(attachments)
					.where(
						and(
							eq(attachments.tripId, tripId),
							eq(attachments.id, data.id),
							isNull(attachments.deletedAt),
						),
					)
					.for("update");
				if (!row || !(await canSeeRow(tx, access, context.user.id, row)))
					return fail("NOT_FOUND");
				if (row.expenseId && data.visibility === "everyone")
					return fail("VALIDATION", "Receipts are always hidden from guests.");
				if (row.visibility !== data.visibility) {
					await tx
						.update(attachments)
						.set({ visibility: data.visibility, updatedAt: new Date() })
						.where(
							and(eq(attachments.tripId, tripId), eq(attachments.id, row.id)),
						);
					out.emit({ keys: ["media", "counts"] });
				}
				return { ok: true as const };
			},
			mutationMeta(access, context.user),
		);
	});

/** `attachment.link`: a URL (the preview job runs after COMMIT). Keys: media, counts. */
export const addLink = createServerFn({ method: "POST" })
	.middleware([withNamedUser])
	.validator(proposable.input(AddLinkInput))
	.handler(proposable.run("attachment.link"));

/** Imported links (`meta.fetch = 'unfetched'`) or a failed preview: fetch it again. Edit-only. */
export const refreshLinkMeta = createServerFn({ method: "POST" })
	.middleware([withNamedUser])
	.validator(z.object({ id: z.uuid() }).strict())
	.handler(async ({ data, context }): Promise<{ ok: true }> => {
		const { tripId } = await requireAttachment(data.id, "viewer", context.user);
		const access = await requireEditOnly(
			"refreshLinkMeta",
			tripId,
			context.user,
		);
		await rateLimit(`links:${context.user.id}`, access.isGuest ? 10 : 30);
		return withTripTx(
			tripId,
			async (tx, out) => {
				const [row] = await tx
					.select()
					.from(attachments)
					.where(
						and(
							eq(attachments.tripId, tripId),
							eq(attachments.id, data.id),
							isNull(attachments.deletedAt),
							isNotNull(attachments.url),
						),
					)
					.for("update");
				if (
					!row?.url ||
					(row.kind !== "link" && row.kind !== "embed") ||
					!(await canSeeRow(tx, access, context.user.id, row))
				)
					return fail("NOT_FOUND");
				await tx
					.update(attachments)
					.set({
						status: "processing",
						meta: { ...metaOf(row), fetch: "unfetched" },
						updatedAt: new Date(),
					})
					.where(
						and(eq(attachments.tripId, tripId), eq(attachments.id, row.id)),
					);
				out.job(
					"links",
					"links.preview",
					{ tripId, attachmentId: row.id, url: row.url },
					{ dedupeId: `links:${row.id}` },
				);
				out.emit({ keys: ["media"] });
				return { ok: true as const };
			},
			mutationMeta(access, context.user),
		);
	});

/** `attachment.update`: caption, target (an expense = a receipt) or order. */
export const updateAttachment = createServerFn({ method: "POST" })
	.middleware([withNamedUser])
	.validator(proposable.input(UpdateAttachmentInput))
	.handler(proposable.run("attachment.update"));

/** `attachment.delete`. */
export const deleteAttachment = createServerFn({ method: "POST" })
	.middleware([withNamedUser])
	.validator(proposable.input(DeleteAttachmentInput))
	.handler(proposable.run("attachment.delete"));

/** Undo of a delete (edit-only). Receipts need manageExpenses. */
export const restoreAttachment = createServerFn({ method: "POST" })
	.middleware([withNamedUser])
	.validator(z.object({ id: z.uuid() }).strict())
	.handler(async ({ data, context }): Promise<{ ok: true }> => {
		const { tripId } = await requireAttachment(
			data.id,
			"viewer",
			context.user,
			{
				includeDeleted: true,
			},
		);
		const [row] = await db
			.select()
			.from(attachments)
			.where(and(eq(attachments.tripId, tripId), eq(attachments.id, data.id)));
		if (!row) return fail("NOT_FOUND");
		const access = row.expenseId
			? await requireTripCapability(tripId, "manageExpenses", context.user)
			: await requireEditOnly("restoreAttachment", tripId, context.user);
		return withTripTx(
			tripId,
			async (tx, out) => {
				if (
					!(await canSeeRow(tx, access, context.user.id, row, {
						includeDeleted: true,
					}))
				)
					return fail("NOT_FOUND");
				// A cancelled upload or a failed check never comes back.
				if (row.status === "pending" || row.status === "failed")
					return fail("NOT_FOUND");
				await tx
					.update(attachments)
					.set({ deletedAt: null, updatedAt: new Date() })
					.where(
						and(eq(attachments.tripId, tripId), eq(attachments.id, row.id)),
					);
				out.emit({ keys: ["media", "counts"] });
				return { ok: true as const };
			},
			mutationMeta(access, context.user),
		);
	});
