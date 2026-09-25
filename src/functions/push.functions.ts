/**
 * Web Push settings and devices (account-level; accounts only, never link
 * guests without an account). The worker does the sending
 * (`src/server/push`); these only store what the person chose:
 *
 * - `getPushSettings`: whether push is set up on this server (its VAPID
 *   public key), the types switched off, the muted trips, and whether the
 *   calling device (`endpoint`) is registered.
 * - `savePushSubscription` / `deletePushSubscription`: this device on / off.
 * - `setPushType`: one per-type switch (every type starts on).
 * - `setTripMuted`: "Mute notifications" for one trip the caller can open.
 */
import { createServerFn } from "@tanstack/react-start";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db/db.server";
import { PUSH_TYPES, type PushType } from "@/lib/push/types";
import { withAccount } from "@/server/authz/middleware";
import { fail } from "@/server/authz/session.server";
import { loadTripAccess } from "@/server/authz/trip-access.server";
import { pushConfig } from "@/server/push/env.server";
import { requestPushSync } from "@/server/push/redis-state.server";
import {
	deleteSubscription,
	getSettings,
	hasSubscription,
	isPushEndpoint,
	isUsableKeys,
	mutedTrips,
	saveSubscription,
	setTypeEnabled,
	setTripMuted as storeTripMuted,
} from "@/server/push/store.server";

export type PushSettingsDto = {
	/** The VAPID public key; null = push is not set up on this server. */
	publicKey: string | null;
	offTypes: PushType[];
	mutedTrips: { id: string; name: string; slug: string }[];
	/** The calling device's endpoint is registered for this account. */
	thisDevice: boolean;
};

const Endpoint = z
	.string()
	.max(2048)
	.refine(isPushEndpoint, "not a push service endpoint");
const B64Url = (min: number, max: number) =>
	z
		.string()
		.min(min)
		.max(max)
		.regex(/^[A-Za-z0-9_-]+=*$/);

export const getPushSettings = createServerFn({ method: "GET" })
	.middleware([withAccount])
	.validator(z.object({ endpoint: z.string().max(2048).optional() }).strict())
	.handler(async ({ data, context }): Promise<PushSettingsDto> => {
		const userId = context.user.id;
		const settings = await getSettings(db, userId);
		return {
			publicKey: pushConfig()?.publicKey ?? null,
			offTypes: settings.offTypes,
			mutedTrips: await mutedTrips(db, userId),
			thisDevice: data.endpoint
				? await hasSubscription(db, userId, data.endpoint)
				: false,
		};
	});

/** Every trip the caller can open (so their reminders get planned). */
async function tripsOf(userId: string): Promise<string[]> {
	const res = await db.execute(sql`
		select m.trip_id::text as id from trip_members m
		  join trips t on t.id = m.trip_id and t.deleted_at is null
		 where m.user_id = ${userId} and m.status = 'active'
		union
		select g.trip_id::text from share_grants g
		  join trips t on t.id = g.trip_id and t.deleted_at is null
		 where g.user_id = ${userId}
		 limit 200`);
	return (res.rows as { id: string }[]).map((r) => r.id);
}

export const savePushSubscription = createServerFn({ method: "POST" })
	.middleware([withAccount])
	.validator(
		z
			.object({
				endpoint: Endpoint,
				keys: z
					.object({ p256dh: B64Url(80, 120), auth: B64Url(16, 48) })
					.strict()
					.refine((k) => isUsableKeys(k.p256dh, k.auth), "unusable push keys"),
				userAgent: z.string().max(300).optional(),
			})
			.strict(),
	)
	.handler(async ({ data, context }): Promise<{ ok: true }> => {
		if (!pushConfig())
			return fail("CONFLICT", "Notifications aren't set up here.");
		await saveSubscription(db, context.user.id, {
			endpoint: data.endpoint,
			p256dh: data.keys.p256dh,
			auth: data.keys.auth,
			userAgent: data.userAgent ?? null,
		});
		// Trips nobody could be told about had nothing planned: plan them now.
		for (const tripId of await tripsOf(context.user.id))
			await requestPushSync(tripId, null);
		return { ok: true };
	});

export const deletePushSubscription = createServerFn({ method: "POST" })
	.middleware([withAccount])
	.validator(z.object({ endpoint: z.string().max(2048) }).strict())
	.handler(async ({ data, context }): Promise<{ ok: true }> => {
		await deleteSubscription(db, context.user.id, data.endpoint);
		return { ok: true };
	});

export const setPushType = createServerFn({ method: "POST" })
	.middleware([withAccount])
	.validator(z.object({ type: z.enum(PUSH_TYPES), on: z.boolean() }).strict())
	.handler(
		async ({ data, context }): Promise<{ offTypes: PushType[] }> => ({
			offTypes: await setTypeEnabled(db, context.user.id, data.type, data.on),
		}),
	);

export const setTripMuted = createServerFn({ method: "POST" })
	.middleware([withAccount])
	.validator(z.object({ tripId: z.uuid(), muted: z.boolean() }).strict())
	.handler(async ({ data, context }): Promise<{ muted: boolean }> => {
		// Unmuting a trip you lost access to is fine; muting needs access.
		if (data.muted && !(await loadTripAccess(data.tripId, context.user.id)))
			return fail("NOT_FOUND");
		await storeTripMuted(db, context.user.id, data.tripId, data.muted);
		return { muted: data.muted };
	});
