/**
 * Trip-level server functions (SPEC §7.7, §13.1; EXTENSIONS §5): create,
 * resolve, update, the date operations and soft delete. `setTripDates` and
 * `shiftTripDates` are proposable (the gate, `editTripDates`); `updateTrip`
 * ({ direct: 'tripSettings' }) is the reference shape of a direct mutation:
 * authz → `withTripTx` (lock, version bump) → `out.emit` → published after
 * COMMIT.
 *
 * `*.server` modules are imported at the top but only USED inside handlers,
 * which TanStack Start strips from the client bundle (SPEC §0 rule 9).
 */
import { createServerFn } from "@tanstack/react-start";
import { and, eq, isNull } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db/db.server";
import { tripDays, tripMembers, trips } from "@/db/schema";
import { newId } from "@/lib/ids";
import { slugBaseFromName } from "@/lib/trip-slug";
import { logActivity } from "@/server/activity.server";
import {
	requireTripCapability,
	requireTripRole,
} from "@/server/authz/access.server";
import {
	withAccount,
	withNamedUser,
	withUser,
} from "@/server/authz/middleware";
import { fail } from "@/server/authz/session.server";
import { rateLimitPer } from "@/server/cache.server";
import {
	CreateTripInput,
	datesBetween,
	MAX_TRIP_DAYS,
	PreviewTripDatesInput,
	type PreviewTripDatesResult,
	previewTripDatesRead,
	SetTripDatesInput,
	ShiftTripDatesInput,
	TripSlug,
	UpdateTripInput,
	updateTripCore,
} from "@/server/cores/trips.server";
import {
	proposable,
	requireDirect,
} from "@/server/proposals/proposable.server";
import { freshTripSlug } from "@/server/trip-slug.server";
import { mutationMeta, withTripTx } from "@/server/tx.server";

export type { PreviewTripDatesResult } from "@/server/cores/trips.server";

function isUniqueViolation(e: unknown): boolean {
	return (
		typeof e === "object" &&
		e !== null &&
		"code" in e &&
		(e as { code: unknown }).code === "23505"
	);
}

// ---------------------------------------------------------------------------
// createTrip (A)
// ---------------------------------------------------------------------------

export type CreateTripResult = { tripId: string; slug: string };

/** SECURITY §10: trips (with up to 366 day rows each) per account per hour. */
export const CREATE_TRIP_PER_HOUR = 20;

/**
 * A new trip owned by the caller: the trip, the owner member (colour 0), one
 * day per date in the range and its address: the name's readable part and
 * a random tail (`asia-2027-k7m2qxw9`, `src/lib/trip-slug.ts`). Nobody else
 * can be subscribed to a brand-new trip, so nothing is published.
 */
export const createTrip = createServerFn({ method: "POST" })
	.middleware([withAccount])
	.validator(CreateTripInput)
	.handler(async ({ data, context }): Promise<CreateTripResult> => {
		await rateLimitPer(
			`createTrip:${context.user.id}`,
			CREATE_TRIP_PER_HOUR,
			3600,
		);
		const dates =
			data.startDate && data.endDate
				? datesBetween(data.startDate, data.endDate)
				: [];
		if (dates.length > MAX_TRIP_DAYS)
			return fail("VALIDATION", "A trip can be at most a year long.");

		const base = slugBaseFromName(data.name, newId());
		for (let attempt = 0; attempt < 3; attempt++) {
			const { slug, slugTail } = await freshTripSlug(db, base);
			try {
				return await db.transaction(async (tx) => {
					const [trip] = await tx
						.insert(trips)
						.values({
							slug,
							slugTail,
							name: data.name,
							startDate: dates[0] ?? null,
							endDate: dates.at(-1) ?? null,
							defaultTz: data.defaultTz ?? "UTC",
							createdBy: context.user.id,
						})
						.returning({ id: trips.id, slug: trips.slug });
					if (!trip) throw new Error("createTrip: insert returned no row");
					await tx.insert(tripMembers).values({
						tripId: trip.id,
						userId: context.user.id,
						status: "active",
						role: "owner",
						color: 0,
						joinedAt: new Date(),
					});
					if (dates.length > 0) {
						await tx
							.insert(tripDays)
							.values(dates.map((date) => ({ tripId: trip.id, date })));
					}
					return { tripId: trip.id, slug: trip.slug };
				});
			} catch (e) {
				// The same address taken at once (astronomically rare): a new tail.
				if (!isUniqueViolation(e) || attempt === 2) throw e;
			}
		}
		return fail("CONFLICT");
	});

// ---------------------------------------------------------------------------
// resolveTripSlug (V)
// ---------------------------------------------------------------------------

/** `/t/<slug>` → `{ tripId }` for a live trip the caller can see; else 404. */
export const resolveTripSlug = createServerFn({ method: "GET" })
	.middleware([withUser])
	.validator(z.object({ slug: z.string().min(1).max(100) }).strict())
	.handler(async ({ data, context }): Promise<{ tripId: string }> => {
		if (!TripSlug.safeParse(data.slug).success) return fail("NOT_FOUND");
		const [trip] = await db
			.select({ id: trips.id })
			.from(trips)
			.where(and(eq(trips.slug, data.slug), isNull(trips.deletedAt)))
			.limit(1);
		if (!trip) return fail("NOT_FOUND");
		// No access answers 404 too, so a slug never reveals that a trip exists.
		await requireTripRole(trip.id, "viewer", context.user);
		return { tripId: trip.id };
	});

// ---------------------------------------------------------------------------
// updateTrip ({ direct: 'tripSettings' }; slug: changeSlug)
// ---------------------------------------------------------------------------

/**
 * Renames the trip, changes the readable part of its address (owner only:
 * `slug` is what they type, the tail stays; a tail-less seeded address gets
 * one), cover (a live photo or video of this trip) or settings. The example
 * of a direct mutation. Answers the trip's (new) address.
 */
export const updateTrip = createServerFn({ method: "POST" })
	.middleware([withNamedUser])
	.validator(UpdateTripInput)
	.handler(async ({ data, context }): Promise<{ slug: string }> => {
		const access = data.slug
			? await requireTripCapability(data.tripId, "changeSlug", context.user)
			: await requireDirect("updateTrip", data.tripId, context.user);
		return withTripTx(
			data.tripId,
			(tx, out) => updateTripCore(tx, out, data, access),
			mutationMeta(access, context.user),
		);
	});

// ---------------------------------------------------------------------------
// Trip dates (§7.7; EXTENSIONS §5) and deletion
// ---------------------------------------------------------------------------

/**
 * Read-only preview for the dates confirmation (QA TRIP-02) and the E2
 * what-if (`{ deltaDays }` → `blockedBy` only). `{ direct: 'propose' }`.
 */
export const previewTripDates = createServerFn({ method: "GET" })
	.middleware([withUser])
	.validator(PreviewTripDatesInput)
	.handler(async ({ data, context }): Promise<PreviewTripDatesResult> => {
		await requireDirect("previewTripDates", data.tripId, context.user);
		return previewTripDatesRead(data);
	});

/** `trip.dates` (§7.7): never deletes items (they move to Unscheduled). `expectedVersion?` → CONFLICT. Keys: graph, lists, media, notes, counts, money. */
export const setTripDates = createServerFn({ method: "POST" })
	.middleware([withNamedUser])
	.validator(proposable.input(SetTripDatesInput))
	.handler(proposable.run("trip.dates"));

/** `trip.shift` (§7.7): shifts every day and re-dates timed legs. `expectedVersion?` → CONFLICT. Keys: graph. */
export const shiftTripDates = createServerFn({ method: "POST" })
	.middleware([withNamedUser])
	.validator(proposable.input(ShiftTripDatesInput))
	.handler(proposable.run("trip.shift"));

/** Soft delete ({ direct: 'deleteTrip' }, owner). Keys: access. */
export const deleteTrip = createServerFn({ method: "POST" })
	.middleware([withAccount])
	.validator(z.object({ tripId: z.uuid() }).strict())
	.handler(async ({ data, context }): Promise<{ ok: true }> => {
		const access = await requireDirect("deleteTrip", data.tripId, context.user);
		return withTripTx(
			data.tripId,
			async (tx, out) => {
				await tx
					.update(trips)
					.set({ deletedAt: new Date(), updatedAt: new Date() })
					.where(eq(trips.id, data.tripId));
				await logActivity(tx, out, {
					tripId: data.tripId,
					actor: { userId: context.user.id, name: context.user.name },
					verb: "trip.delete",
					summary: "deleted the trip",
				});
				// Everyone connected loses access: collab closes their sockets (§11.4).
				out.access();
				return { ok: true as const };
			},
			mutationMeta(access, context.user),
		);
	});
