/**
 * Profile pictures (owner FB-16), server side. The browser PUTs the cropped
 * square to `avatars/<userId>/upload-<uuid>` (never served); `commitAvatar`
 * re-encodes it to square WebPs under `avatars/<userId>/<version>/<px>.webp`
 * and points Better Auth's `user.image` at `/api/avatar/<userId>?v=<version>`
 * (`@/lib/schemas/avatar`). The bucket is private: pictures only leave
 * through `serveAvatar`, which checks the viewer shares a trip with the user.
 *
 * `user.image` is written only here (through Better Auth's internal adapter,
 * so the Redis session copies refresh and `announceUserChange` reaches every
 * open trip); a client can't set it (`applyUserUpdate`).
 */
import { randomUUID } from "node:crypto";
import {
	DeleteObjectsCommand,
	GetObjectCommand,
	HeadObjectCommand,
	ListObjectsV2Command,
	PutObjectCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { sql } from "drizzle-orm";
import { db } from "@/db/db.server";
import {
	AVATAR_MAX_BYTES,
	AVATAR_SIZES,
	type AvatarContentType,
	type AvatarResult,
	type AvatarSize,
	type AvatarUpload,
	avatarImageUrl,
	parseAvatarImageUrl,
} from "@/lib/schemas/avatar";
import { auth } from "@/server/auth.server";
import { loadTripAccess } from "@/server/authz/trip-access.server";
import { AppError } from "@/server/errors";
import { bucket, publicS3, s3 } from "@/server/s3.server";

/** A presigned PUT lives 10 min (SEC-R1-08, like media). */
const PUT_TTL_SEC = 600;
/** Decompression-bomb guard: a 5 MB PNG can claim a huge canvas. */
const LIMIT = { limitInputPixels: 40e6, failOn: "error" as const };

export function avatarPrefix(userId: string): string {
	return `avatars/${userId}/`;
}

function variantKey(userId: string, version: string, px: AvatarSize): string {
	return `${avatarPrefix(userId)}${version}/${px}.webp`;
}

function statusOf(e: unknown): number | undefined {
	return (e as { $metadata?: { httpStatusCode?: number } }).$metadata
		?.httpStatusCode;
}

/** Step 1: a PUT URL that only accepts exactly `contentType` and `size` bytes. */
export async function createAvatarUploadFor(
	userId: string,
	input: { contentType: AvatarContentType; size: number },
): Promise<AvatarUpload> {
	const key = `${avatarPrefix(userId)}upload-${randomUUID()}`;
	const url = await getSignedUrl(
		publicS3(),
		new PutObjectCommand({
			Bucket: bucket(),
			Key: key,
			ContentType: input.contentType,
			ContentLength: input.size,
		}),
		{
			expiresIn: PUT_TTL_SEC,
			signableHeaders: new Set(["content-type", "content-length"]),
		},
	);
	return {
		key,
		url,
		headers: { "Content-Type": input.contentType },
		expiresAt: new Date(Date.now() + PUT_TTL_SEC * 1000).toISOString(),
	};
}

/** What the decoder saw: only real JPEG/PNG/WebP pass (never trust the header). */
const DECODED = new Set(["jpeg", "png", "webp"]);

/**
 * Square WebPs of `buf` at every `AVATAR_SIZES`: auto-oriented, centre
 * cropped to a square (the client already sends the square bounding the
 * circle; anything else is cropped here), metadata stripped.
 */
export async function avatarVariants(
	buf: Buffer,
): Promise<Record<AvatarSize, Buffer>> {
	const { default: sharp } = await import("sharp");
	let format: string | undefined;
	try {
		format = (await sharp(buf, LIMIT).metadata()).format;
	} catch {
		throw new AppError("VALIDATION", "That file isn't a picture we can read.");
	}
	if (!format || !DECODED.has(format))
		throw new AppError("VALIDATION", "Use a JPEG, PNG or WebP picture.");
	const out = await Promise.all(
		AVATAR_SIZES.map((px) =>
			sharp(buf, LIMIT)
				.rotate()
				.resize(px, px, { fit: "cover", position: "centre" })
				.webp({ quality: px <= 64 ? 82 : 80 })
				.toBuffer(),
		),
	);
	return Object.fromEntries(
		AVATAR_SIZES.map((px, i) => [px, out[i]]),
	) as Record<AvatarSize, Buffer>;
}

async function readUpload(key: string): Promise<Buffer> {
	try {
		const head = await s3().send(
			new HeadObjectCommand({ Bucket: bucket(), Key: key }),
		);
		if (Number(head.ContentLength ?? 0) > AVATAR_MAX_BYTES)
			throw new AppError("VALIDATION", "Pictures can be at most 5 MB.");
		const r = await s3().send(
			new GetObjectCommand({ Bucket: bucket(), Key: key }),
		);
		const bytes = await r.Body?.transformToByteArray();
		const buf = Buffer.from(bytes ?? []);
		if (buf.length === 0 || buf.length > AVATAR_MAX_BYTES)
			throw new AppError("VALIDATION", "Pictures can be at most 5 MB.");
		return buf;
	} catch (e) {
		if (e instanceof AppError) throw e;
		if (statusOf(e) === 404 || (e as { name?: string }).name === "NotFound")
			throw new AppError("NOT_FOUND", "upload missing; try again");
		throw e;
	}
}

/** Deletes every object under the user's prefix except `keep` (a version prefix). */
async function purgeAvatarObjects(
	userId: string,
	keep?: string,
): Promise<void> {
	let token: string | undefined;
	do {
		const page = await s3().send(
			new ListObjectsV2Command({
				Bucket: bucket(),
				Prefix: avatarPrefix(userId),
				ContinuationToken: token,
			}),
		);
		const keys = (page.Contents ?? [])
			.map((o) => o.Key)
			.filter((k): k is string => !!k && !(keep && k.startsWith(keep)));
		if (keys.length)
			await s3().send(
				new DeleteObjectsCommand({
					Bucket: bucket(),
					Delete: { Objects: keys.map((Key) => ({ Key })), Quiet: true },
				}),
			);
		token = page.IsTruncated ? page.NextContinuationToken : undefined;
	} while (token);
}

/** Better Auth's internal update: runs the user hooks and refreshes the cached sessions. */
async function setUserImage(
	userId: string,
	image: string | null,
): Promise<void> {
	const ctx = await auth.$context;
	await ctx.internalAdapter.updateUser(userId, { image });
}

/** Step 3: re-encode the upload, store the sizes, point `user.image` at them. */
export async function commitAvatarFor(
	userId: string,
	key: string,
): Promise<AvatarResult> {
	if (!key.startsWith(`${avatarPrefix(userId)}upload-`))
		throw new AppError("NOT_FOUND");
	const buf = await readUpload(key);
	const variants = await avatarVariants(buf);
	const version = Date.now().toString(36);
	await Promise.all(
		AVATAR_SIZES.map((px) =>
			s3().send(
				new PutObjectCommand({
					Bucket: bucket(),
					Key: variantKey(userId, version, px),
					Body: variants[px],
					ContentType: "image/webp",
				}),
			),
		),
	);
	const image = avatarImageUrl(userId, version);
	await setUserImage(userId, image);
	// The upload and every older version go (best effort: the new one is live).
	await purgeAvatarObjects(userId, `${avatarPrefix(userId)}${version}/`).catch(
		(e) => console.error("[avatar] purge failed:", (e as Error).message),
	);
	return { image };
}

/** `removeAvatar`: back to initials; the stored pictures are deleted. */
export async function removeAvatarFor(userId: string): Promise<AvatarResult> {
	await setUserImage(userId, null);
	await purgeAvatarObjects(userId).catch((e) =>
		console.error("[avatar] purge failed:", (e as Error).message),
	);
	return { image: null };
}

/**
 * May `viewerId` see `userId`'s picture? Themself, or anyone with access to
 * a live trip `userId` is on (an active member or a guest with a live link).
 * The same rule as seeing their name in that trip.
 */
export async function maySeeAvatar(
	viewerId: string,
	userId: string,
): Promise<boolean> {
	if (viewerId === userId) return true;
	// Fast path: both are active members of one live trip.
	const both = await db.execute(sql`
		select 1
		  from trip_members a
		  join trip_members b on b.trip_id = a.trip_id
		  join trips t on t.id = a.trip_id and t.deleted_at is null
		 where a.user_id = ${userId} and a.status = 'active'
		   and b.user_id = ${viewerId} and b.status = 'active'
		 limit 1`);
	if (both.rows.length) return true;
	// Link guests (either side): check the viewer's live access to each trip
	// the user is on, the same way every read does.
	const trips = (
		await db.execute(sql`
			select m.trip_id::text as "tripId"
			  from trip_members m
			  join trips t on t.id = m.trip_id and t.deleted_at is null
			 where m.user_id = ${userId} and m.status = 'active'
			union
			select g.trip_id::text
			  from share_grants g
			  join trips t on t.id = g.trip_id and t.deleted_at is null
			 where g.user_id = ${userId}
			 limit 100`)
	).rows as { tripId: string }[];
	for (const { tripId } of trips) {
		if (!(await loadTripAccess(tripId, viewerId))) continue;
		// The user must still be on that trip for the viewer (a guest's own grant
		// may have lapsed): members always are; a guest only with a live grant.
		if (await loadTripAccess(tripId, userId)) return true;
	}
	return false;
}

const notFound = () =>
	new Response("Not found", {
		status: 404,
		headers: {
			"Cache-Control": "private, no-store",
			"Content-Type": "text/plain",
			Vary: "Cookie",
		},
	});

/**
 * `GET /api/avatar/<userId>?v=<version>&s=64|128|256`: the current picture
 * (whatever `v` says; a stale `v` is only cached briefly), streamed from S3.
 * Anything missing or not allowed is 404 (ids reveal nothing).
 */
export async function serveAvatar(
	request: Request,
	userId: string,
	viewerId: string | null,
): Promise<Response> {
	if (!viewerId || !/^[A-Za-z0-9_-]{1,64}$/.test(userId)) return notFound();
	const url = new URL(request.url);
	const s = Number(url.searchParams.get("s") ?? 128);
	const px = (AVATAR_SIZES as readonly number[]).includes(s)
		? (s as AvatarSize)
		: 128;
	const row = (
		await db.execute(sql`select image from "user" where id = ${userId}`)
	).rows[0] as { image: string | null } | undefined;
	const current = parseAvatarImageUrl(row?.image);
	if (!current || current.userId !== userId) return notFound();
	if (!(await maySeeAvatar(viewerId, userId))) return notFound();
	const etag = `"${current.version}-${px}"`;
	const fresh = url.searchParams.get("v") === current.version;
	const headers: Record<string, string> = {
		"Content-Type": "image/webp",
		// A versioned URL never changes; access is re-checked after a day.
		"Cache-Control": fresh
			? "private, max-age=86400"
			: "private, max-age=0, must-revalidate",
		ETag: etag,
		Vary: "Cookie",
		"X-Content-Type-Options": "nosniff",
		"Content-Security-Policy": "default-src 'none'; sandbox",
		"Cross-Origin-Resource-Policy": "same-origin",
	};
	if (request.headers.get("if-none-match") === etag)
		return new Response(null, { status: 304, headers });
	try {
		const r = await s3().send(
			new GetObjectCommand({
				Bucket: bucket(),
				Key: variantKey(userId, current.version, px),
			}),
		);
		if (!r.Body) return notFound();
		return new Response(r.Body.transformToWebStream(), {
			status: 200,
			headers: {
				...headers,
				...(r.ContentLength != null
					? { "Content-Length": String(r.ContentLength) }
					: {}),
			},
		});
	} catch (e) {
		if (statusOf(e) === 404 || (e as { name?: string }).name === "NoSuchKey")
			return notFound();
		throw e;
	}
}
