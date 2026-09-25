/**
 * Profile pictures (owner FB-16). Isomorphic: the upload contract's inputs
 * and limits, and the app URL that Better Auth's `user.image` holds.
 *
 * Flow (`@/functions/avatar.functions`):
 *   1. `createAvatarUpload({ contentType, size })` → a presigned PUT that only
 *      accepts exactly that type and length (≤ 5 MB, JPEG/PNG/WebP).
 *   2. The browser PUTs the cropped square (the square bounding the circle)
 *      with `headers`.
 *   3. `commitAvatar({ key })` → the server re-encodes it to 64/128/256 px
 *      WebP (centre-cropped to a square, metadata stripped), stores it
 *      privately and sets `user.image` to `/api/avatar/<userId>?v=<version>`.
 *   4. `removeAvatar()` clears it (initials in the presence colour again).
 *
 * `/api/avatar/<userId>?v=…&s=64|128|256` serves the picture only to the
 * user themself and to people who share a trip with them.
 */
import { z } from "zod";

export const AVATAR_CONTENT_TYPES = [
	"image/jpeg",
	"image/png",
	"image/webp",
] as const;
export type AvatarContentType = (typeof AVATAR_CONTENT_TYPES)[number];

/** Upload cap (the cropped square is usually far smaller). */
export const AVATAR_MAX_BYTES = 5 * 1024 * 1024;

/** The stored sizes (px, square WebP). */
export const AVATAR_SIZES = [64, 128, 256] as const;
export type AvatarSize = (typeof AVATAR_SIZES)[number];

export const CreateAvatarUploadInput = z
	.object({
		contentType: z.enum(AVATAR_CONTENT_TYPES),
		size: z.number().int().min(1).max(AVATAR_MAX_BYTES),
	})
	.strict();
export type CreateAvatarUploadInput = z.infer<typeof CreateAvatarUploadInput>;

export type AvatarUpload = {
	/** Pass back to `commitAvatar`. */
	key: string;
	/** Presigned PUT (10 min). */
	url: string;
	/** Send exactly these headers with the PUT (they are signed). */
	headers: { "Content-Type": AvatarContentType };
	expiresAt: string;
};

/** `avatars/<userId>/upload-<uuid>`: the only keys `commitAvatar` accepts. */
export const AVATAR_UPLOAD_KEY_RE =
	/^avatars\/[A-Za-z0-9_-]{1,64}\/upload-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export const CommitAvatarInput = z
	.object({ key: z.string().max(200).regex(AVATAR_UPLOAD_KEY_RE) })
	.strict();
export type CommitAvatarInput = z.infer<typeof CommitAvatarInput>;

/** What `commitAvatar`/`removeAvatar` answer: the new `user.image`. */
export type AvatarResult = { image: string | null };

const AVATAR_PATH_RE =
	/^\/api\/avatar\/([A-Za-z0-9_-]{1,64})\?v=([a-z0-9]{1,32})$/;

/** The app URL stored in `user.image`. */
export function avatarImageUrl(userId: string, version: string): string {
	return `/api/avatar/${encodeURIComponent(userId)}?v=${version}`;
}

/** `{ userId, version }` of a stored `user.image`, or null for anything else. */
export function parseAvatarImageUrl(
	image: string | null | undefined,
): { userId: string; version: string } | null {
	const m = image ? AVATAR_PATH_RE.exec(image) : null;
	return m?.[1] && m[2] ? { userId: m[1], version: m[2] } : null;
}

/**
 * The URL to render at `px` CSS pixels: picks the smallest stored size that
 * covers 2× density. Other URLs (none are stored today) pass through.
 */
export function avatarSrc(image: string, px: number): string {
	if (!parseAvatarImageUrl(image)) return image;
	const want = px * 2;
	const s = AVATAR_SIZES.find((n) => n >= want) ?? 256;
	return `${image}&s=${s}`;
}
