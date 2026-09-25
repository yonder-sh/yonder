/**
 * Profile pictures (owner FB-16): the upload contract WP-Home's Profile
 * dialog calls (`@/lib/schemas/avatar` has the flow and limits). Accounts
 * only (link guests have no profile); `account` in MUTATION_POLICY.
 *
 *   const up = await createAvatarUpload({ data: { contentType, size } });
 *   await fetch(up.url, { method: "PUT", headers: up.headers, body: blob });
 *   const { image } = await commitAvatar({ data: { key: up.key } });
 *   // …or: await removeAvatar();
 *
 * The session query (`Viewer.image`), `graph.members[].image` and
 * `graph.me.image` pick the new URL up (Better Auth refreshes the cached
 * session; every trip the user is on gets a live `graph` invalidation).
 */
import { createServerFn } from "@tanstack/react-start";
import {
	type AvatarResult,
	type AvatarUpload,
	CommitAvatarInput,
	CreateAvatarUploadInput,
} from "@/lib/schemas/avatar";
import { withAccount } from "@/server/authz/middleware";
import { withStatus } from "@/server/authz/session.server";
import {
	commitAvatarFor,
	createAvatarUploadFor,
	removeAvatarFor,
} from "@/server/avatar.server";
import { rateLimitPer } from "@/server/cache.server";

/** 30 uploads/commits an hour per user: plenty for trying a few crops. */
async function limit(userId: string): Promise<void> {
	await rateLimitPer(`avatar:${userId}`, 30, 3600);
}

async function mapped<T>(run: () => Promise<T>): Promise<T> {
	try {
		return await run();
	} catch (e) {
		throw withStatus(e as Error);
	}
}

/** A presigned PUT for exactly `contentType` (JPEG/PNG/WebP) and `size` (≤ 5 MB) bytes. */
export const createAvatarUpload = createServerFn({ method: "POST" })
	.middleware([withAccount])
	.validator(CreateAvatarUploadInput)
	.handler(async ({ data, context }): Promise<AvatarUpload> => {
		await limit(context.user.id);
		return mapped(() => createAvatarUploadFor(context.user.id, data));
	});

/** Resizes the upload to 64/128/256 px WebP and sets `user.image` (a versioned app URL). */
export const commitAvatar = createServerFn({ method: "POST" })
	.middleware([withAccount])
	.validator(CommitAvatarInput)
	.handler(async ({ data, context }): Promise<AvatarResult> => {
		await limit(context.user.id);
		return mapped(() => commitAvatarFor(context.user.id, data.key));
	});

/** Clears `user.image` (initials in the presence colour) and deletes the stored pictures. */
export const removeAvatar = createServerFn({ method: "POST" })
	.middleware([withAccount])
	.handler(async ({ context }): Promise<AvatarResult> => {
		return mapped(() => removeAvatarFor(context.user.id));
	});
