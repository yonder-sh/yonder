import { createServerFn } from "@tanstack/react-start";
import {
	getRequestHeaders,
	getRequestIP,
	setResponseHeader,
} from "@tanstack/react-start/server";
import { z } from "zod";
import { announceTripChange } from "@/server/announce.server";
import { authLimits } from "@/server/auth/limits.server";
import { auth } from "@/server/auth.server";
import { withNamedUser, withUser } from "@/server/authz/middleware";
import { fail } from "@/server/authz/session.server";
import {
	guestNameClashes,
	redeemShareToken,
} from "@/server/authz/share-links.server";
import { GuestName } from "./names";
import type { ShareRole } from "./roles";

/**
 * Share-link and guest-identity server functions (SPEC §13.6 `redeemShareLink`,
 * `renameGuest`). The `*.server` imports are only used inside handlers, which
 * TanStack Start strips from the client build (SPEC §0 rule 8).
 */

export interface RedeemResult {
	tripId: string;
	slug: string;
	role: ShareRole;
}

/**
 * Exchanges a share token for a grant on its trip (SECURITY §2). The caller
 * must be signed in: `/join` first creates an anonymous guest session when
 * there is none. Unknown, disabled and revoked tokens all answer
 * `NOT_FOUND: link` (404), and redemptions are limited to 10/min per IP (429).
 * A signed-in non-member gets the link's role for that trip only; they are
 * never added as a member (QA LINK-08).
 */
export const redeemShareLink = createServerFn({ method: "POST" })
	.middleware([withNamedUser])
	.validator(z.object({ token: z.string().min(1).max(256) }).strict())
	.handler(async ({ data, context }): Promise<RedeemResult> => {
		setResponseHeader("Cache-Control", "private, no-store");
		setResponseHeader("Referrer-Policy", "no-referrer");
		const wait = await authLimits().redeemRetryAfter(
			getRequestIP({ xForwardedFor: true }) ?? "",
		);
		if (wait > 0) {
			setResponseHeader("Retry-After", String(Math.ceil(wait / 1000)));
			return fail("RATE_LIMITED");
		}
		const redeemed = await redeemShareToken(data.token, context.user.id);
		if (!redeemed) return fail("NOT_FOUND", "link");
		// The owner's Share dialog and guest list show the new guest (after COMMIT).
		await announceTripChange([redeemed.tripId], ["sharing", "graph"]);
		return {
			tripId: redeemed.tripId,
			slug: redeemed.slug,
			role: redeemed.role,
		};
	});

/**
 * A guest renames themselves (shown in presence with a "guest" badge; guests
 * are never mentionable or assignable). Accounts use Profile instead.
 */
export const renameGuest = createServerFn({ method: "POST" })
	.middleware([withUser])
	.validator(z.object({ name: z.string().max(200) }).strict())
	.handler(async ({ data, context }): Promise<{ name: string }> => {
		if (!context.user.isAnonymous) return fail("FORBIDDEN", "guests only");
		const parsed = GuestName.safeParse(data.name);
		if (!parsed.success)
			return fail(
				"VALIDATION",
				parsed.error.issues[0]?.message ?? "invalid name",
			);
		// SECURITY §2: a guest can't take the name of a member of a trip they are
		// on (their rows are marked "(guest)" anyway; this keeps chat and presence
		// honest too).
		if (await guestNameClashes(context.user.id, parsed.data))
			return fail("VALIDATION", "That name belongs to a trip member.");
		// Through Better Auth so the Redis session cache and the cookie cache refresh.
		await auth.api.updateUser({
			headers: getRequestHeaders(),
			body: { name: parsed.data },
		});
		return { name: parsed.data };
	});
