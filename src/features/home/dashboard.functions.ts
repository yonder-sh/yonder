/**
 * WP-Home dashboard reads and "Duplicate…" (SPEC §13.6; EXTENSIONS §1.4;
 * ADDENDUM §9). The SQL lives in `./server/dashboard.server.ts` and
 * `./server/duplicate.server.ts`; the DTOs in `./types.ts`.
 */
import { createServerFn } from "@tanstack/react-start";
import { getCookie } from "@tanstack/react-start/server";
import { z } from "zod";
import { db } from "@/db/db.server";
import { todayIn } from "@/lib/format";
import { IsoDate } from "@/lib/schemas/common";
import { getTripAccess } from "@/server/authz/access.server";
import { withAccount } from "@/server/authz/middleware";
import { fail } from "@/server/authz/session.server";
import { rateLimitPer } from "@/server/cache.server";
import { loadMyDeadlines, loadMyTrips } from "./server/dashboard.server";
import { duplicateTripCore } from "./server/duplicate.server";
import { TZ_COOKIE, zoneFromCookie } from "./today";
import type { MyDeadline, MyTrip } from "./types";

export type { MyDeadline, MyTrip, MyTripMember } from "./types";

/**
 * DASH-03: the dashboard's "today" for its server render, in the viewer's
 * zone (the `yonder-tz` cookie the dashboard sets), else the server's. The
 * `/` loader calls it during SSR only (the browser asks its own clock).
 */
export const dashboardToday = createServerFn({ method: "GET" })
	.middleware([withAccount])
	.handler(async (): Promise<string> => {
		let tz: string | undefined;
		try {
			tz = getCookie(TZ_COOKIE);
		} catch {
			// outside a request, or a cookie header that doesn't parse
		}
		// A malformed or unknown zone falls back to the server's date.
		return todayIn(zoneFromCookie(tz));
	});

/**
 * Trips where I'm an active member or hold a live grant (A): role (owner 0,
 * editor 1, suggester 2, rater 3, viewer 4), dates, members (≤ 5), countries, cover,
 * city-level route points, unread mentions, and the E4/E6/E7 chips
 * (`overdue`, `changesSince` ≤ 100, `openProposals` for reviewers).
 */
export const listMyTrips = createServerFn({ method: "GET" })
	.middleware([withAccount])
	.handler(
		async ({ context }): Promise<MyTrip[]> => loadMyTrips(context.user.id),
	);

/**
 * Open todos overdue, open now or due within 30 days across my trips (20
 * max), assigned to me or to nobody (`everyone: true` adds the ones assigned
 * only to others: the dashboard's "Everyone's"), overdue first. Relative
 * booking windows resolve against their item's day. Never someone else's
 * private item.
 */
export const listMyDeadlines = createServerFn({ method: "GET" })
	.middleware([withAccount])
	.validator(z.object({ everyone: z.boolean().optional() }).strict().optional())
	.handler(
		async ({ data, context }): Promise<MyDeadline[]> =>
			loadMyDeadlines(context.user.id, { everyone: data?.everyone === true }),
	);

/**
 * ADDENDUM §9 "Duplicate…": one transaction with new ids (an old → new map
 * for legs, mentions and bundle targets; Yjs note docs copied server-side).
 * Always copies the structure (hierarchy, days, items, legs, flights/stays);
 * `include` adds notes, lists (statuses reset to open), attachments
 * (re-referenced) and trip-default budgets. Never copies members (the caller
 * becomes the owner; placeholders only with `include.placeholders`), links,
 * expenses, settlements, proposals or activity, and never another member's
 * PRIVATE list items or private notes (ADDENDUM §7.2; the caller's own may be
 * copied). Remap `due_rule.itemId`, mention tokens and bundle targets through
 * the old → new map. The caller must be a non-guest member of the source
 * trip. Rate-limited like createTrip.
 */
export const DuplicateTripInput = z
	.object({
		tripId: z.uuid(),
		name: z.string().trim().min(1).max(120),
		/** Every day shifts by the same delta; pinned local times are kept. */
		startDate: IsoDate,
		include: z
			.object({
				notes: z.boolean(),
				lists: z.boolean(),
				media: z.boolean(),
				budgets: z.boolean(),
				placeholders: z.boolean(),
			})
			.strict(),
	})
	.strict();

/** SECURITY §10: like `createTrip` (CREATE_TRIP_PER_HOUR), per account. */
export const DUPLICATE_TRIP_PER_HOUR = 20;

export const duplicateTrip = createServerFn({ method: "POST" })
	.middleware([withAccount])
	.validator(DuplicateTripInput)
	.handler(
		async ({ data, context }): Promise<{ tripId: string; slug: string }> => {
			const access = await getTripAccess(data.tripId, context.user);
			if (!access) return fail("NOT_FOUND");
			// Link guests can't copy a trip (they don't own its contents).
			if (access.isGuest || !access.memberId)
				return fail("FORBIDDEN", "Only members of a trip can duplicate it.");
			await rateLimitPer(
				`createTrip:${context.user.id}`,
				DUPLICATE_TRIP_PER_HOUR,
				3600,
			);
			// A brand-new trip has no subscribers: one plain transaction, nothing to publish.
			return db.transaction((tx) =>
				duplicateTripCore(tx, {
					srcId: data.tripId,
					userId: context.user.id,
					srcMemberId: access.memberId,
					name: data.name,
					startDate: data.startDate,
					include: data.include,
				}),
			);
		},
	);
