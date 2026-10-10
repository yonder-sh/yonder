/**
 * Saved in the app (`./server/saved.server.ts`), the caller's own rows only:
 *
 * - `listSavedLinks`: what's still waiting for a trip, newest first.
 * - `saveSharedLink`: a link from the share sheet, a paste or `/share?url=`
 *   (the device's `clientId` makes a retried upload save once).
 * - `markSavedAdded`: it went into a trip (the trip's own functions did the
 *   adding and checked the role); it leaves the grid.
 * - `deleteSavedLink`: gone, pictures too.
 */
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { db } from "@/db/db.server";
import { roleAtLeast } from "@/lib/auth/roles";
import { withAccount } from "@/server/authz/middleware";
import { fail } from "@/server/authz/session.server";
import { loadTripAccess } from "@/server/authz/trip-access.server";
import { rateLimitPer } from "@/server/cache.server";
import { shareInput } from "@/server/shortcut.server";
import {
	deleteSaved,
	listSaved,
	markAdded,
	SAVED,
	saveLink,
} from "./server/saved.server";
import type { SavedLink } from "./types";

export type { SavedLink };

export const listSavedLinks = createServerFn({ method: "GET" })
	.middleware([withAccount])
	.handler(
		async ({ context }): Promise<SavedLink[]> => listSaved(db, context.user.id),
	);

export const saveSharedLink = createServerFn({ method: "POST" })
	.middleware([withAccount])
	.validator(
		z
			.object({
				url: z.string().max(SAVED.textMax).nullish(),
				text: z.string().max(SAVED.textMax).nullish(),
				title: z.string().max(SAVED.titleMax).nullish(),
				clientId: z
					.string()
					.regex(/^[A-Za-z0-9_-]{1,64}$/)
					.nullish(),
			})
			.strict(),
	)
	.handler(async ({ data, context }): Promise<{ id: string }> => {
		await rateLimitPer(`saved:${context.user.id}`, 120, 3600);
		// The same reading as the Shortcut's: the link, and the words around it.
		const share = shareInput(
			data.url && data.text?.includes(data.url)
				? data.text
				: [data.url, data.text].filter(Boolean).join(" "),
		);
		if (!share.url && !share.text) return fail("VALIDATION", "nothing to save");
		const { id } = await saveLink(db, context.user.id, {
			...share,
			title: data.title?.trim() || null,
			clientId: data.clientId ?? null,
		});
		return { id };
	});

export const markSavedAdded = createServerFn({ method: "POST" })
	.middleware([withAccount])
	.validator(
		z
			.object({
				id: z.uuid(),
				tripId: z.uuid(),
				nodeId: z.uuid().nullable(),
			})
			.strict(),
	)
	.handler(async ({ data, context }): Promise<{ ok: true }> => {
		const access = await loadTripAccess(data.tripId, context.user.id);
		if (!access || !roleAtLeast(access.role, "suggester"))
			return fail("NOT_FOUND");
		if (
			!(await markAdded(db, context.user.id, data.id, {
				tripId: data.tripId,
				nodeId: data.nodeId,
			}))
		)
			return fail("NOT_FOUND");
		return { ok: true };
	});

export const deleteSavedLink = createServerFn({ method: "POST" })
	.middleware([withAccount])
	.validator(z.object({ id: z.uuid() }).strict())
	.handler(async ({ data, context }): Promise<{ ok: true }> => {
		if (!(await deleteSaved(db, context.user.id, data.id)))
			return fail("NOT_FOUND");
		return { ok: true };
	});
