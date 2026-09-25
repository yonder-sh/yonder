import { createServerFn } from "@tanstack/react-start";
import { getRequestHeaders, getRequestIP } from "@tanstack/react-start/server";
import { z } from "zod";
import { announceTripChange } from "@/server/announce.server";
import { authLimits } from "@/server/auth/limits.server";
import { auth } from "@/server/auth.server";
import {
	withNamedUser,
	withSession,
	withUser,
} from "@/server/authz/middleware";
import { fail } from "@/server/authz/session.server";
import {
	guestNameClashes,
	openTripLink,
	tripLinkIsOpen,
} from "@/server/authz/share-links.server";
import { GuestName } from "./names";
import type { ShareRole } from "./roles";

/**
 * Opening a trip through its link, and guest identity (SPEC §13.6,
 * `renameGuest`; the 2026-09-25 redesign). The trip's address `/t/<slug>`
 * is its share link, like Google Drive: the `/t/$trip` route calls
 * `openTripByLink` when the viewer has no access of their own, and a
 * signed-out visitor's guard asks `tripLinkOpen` before it makes them an
 * anonymous guest. The `*.server` imports are only used inside handlers,
 * which TanStack Start strips from the client build (SPEC §0 rule 8). Like
 * every server function they answer `Cache-Control: private, no-store`
 * (`privateCacheHeaders`).
 */

const SlugInput = z.object({ slug: z.string().min(1).max(100) }).strict();

/**
 * One non-member trip open for this IP (30/min in production,
 * `authLimits`): false when over. Opening addresses as a non-member is how
 * someone would guess them, so both calls below spend it.
 */
async function withinTripOpenLimit(): Promise<boolean> {
	const wait = await authLimits().tripOpenRetryAfter(
		getRequestIP({ xForwardedFor: true }) ?? "",
	);
	return wait <= 0;
}

export interface OpenTripResult {
	tripId: string;
	slug: string;
	role: ShareRole;
}

/**
 * A signed-in non-member (an account, or the anonymous guest session made
 * for a signed-out visitor) opens the trip's address while "Anyone with the
 * link" is on: they get the link's role through a grant (SECURITY §2), never
 * a membership (QA LINK-08; a signed-in account on a "Can rate" link is the
 * one exception, PLACES §1c). An unknown slug, a link that is off, revoked or
 * expired, an active member, and an IP over its limit all answer the same
 * NOT_FOUND (404): the "no access" page, which never says which.
 */
export const openTripByLink = createServerFn({ method: "POST" })
	.middleware([withNamedUser])
	.validator(SlugInput)
	.handler(async ({ data, context }): Promise<OpenTripResult> => {
		if (!(await withinTripOpenLimit())) return fail("NOT_FOUND");
		const opened = await openTripLink(data.slug, context.user.id);
		if (!opened) return fail("NOT_FOUND");
		// The owner's Share dialog and guest list show the new guest (after COMMIT).
		await announceTripChange([opened.tripId], ["sharing", "graph"]);
		return { tripId: opened.tripId, slug: opened.slug, role: opened.role };
	});

/**
 * For a signed-out visitor at `/t/<slug>`: whether anyone with the link may
 * open it right now, so the page makes an anonymous guest session only when
 * it will be let in. `{ open: false }` for an unknown slug, a link that is
 * off, and an IP over its limit alike: it says nothing opening the address
 * wouldn't. A read, with or without a session (`withSession`).
 */
export const tripLinkOpen = createServerFn({ method: "GET" })
	.middleware([withSession])
	.validator(SlugInput)
	.handler(async ({ data }): Promise<{ open: boolean }> => {
		if (!(await withinTripOpenLimit())) return { open: false };
		return { open: await tripLinkIsOpen(data.slug) };
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
