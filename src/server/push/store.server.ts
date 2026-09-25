/**
 * The push subscription store and the notification settings (Postgres).
 * Every function takes the executor, so the server functions, the worker
 * and the db tests share them.
 *
 * - A subscription is one browser on one device. Saving an endpoint that
 *   another user had moves it to the caller (a shared device signs in as
 *   someone else); each user keeps at most `MAX_DEVICES`, the least recently
 *   used go first.
 * - Endpoints must be https on a known push service (Google, Mozilla,
 *   Apple, Microsoft): the worker POSTs to them, so an arbitrary URL would be
 *   a request-forgery hole.
 */
import { createECDH } from "node:crypto";
import { sql } from "drizzle-orm";
import { v7 as uuidv7 } from "uuid";
import type { DbOrTx } from "@/db/db.server";
import { isPushType, type PushType } from "@/lib/push/types";

type Exec = Pick<DbOrTx, "execute">;

export const MAX_DEVICES = 20;

/** Push services browsers use (Chrome/Edge/Opera via FCM, Firefox, Safari, legacy Edge). */
const PUSH_HOSTS = [
	/^fcm\.googleapis\.com$/,
	/^android\.googleapis\.com$/,
	/^([a-z0-9-]+\.)*push\.services\.mozilla\.com$/,
	/^([a-z0-9-]+\.)*push\.apple\.com$/,
	/^([a-z0-9-]+\.)*notify\.windows\.com$/,
];

export function isPushEndpoint(endpoint: string): boolean {
	let u: URL;
	try {
		u = new URL(endpoint);
	} catch {
		return false;
	}
	return (
		u.protocol === "https:" &&
		!u.username &&
		!u.password &&
		(u.port === "" || u.port === "443") &&
		endpoint.length <= 2048 &&
		PUSH_HOSTS.some((re) => re.test(u.hostname))
	);
}

/**
 * The browser's keys must be usable: `p256dh` a point on P-256 (65 bytes,
 * uncompressed) and `auth` a 16-byte secret. Anything else could never be
 * encrypted to, so it is refused instead of stored.
 */
export function isUsableKeys(p256dh: string, auth: string): boolean {
	try {
		const pub = Buffer.from(p256dh, "base64url");
		if (pub.length !== 65 || pub[0] !== 4) return false;
		if (Buffer.from(auth, "base64url").length !== 16) return false;
		// Throws unless the point is on the curve.
		const ecdh = createECDH("prime256v1");
		ecdh.generateKeys();
		ecdh.computeSecret(pub);
		return true;
	} catch {
		return false;
	}
}

export type SubscriptionInput = {
	endpoint: string;
	p256dh: string;
	auth: string;
	userAgent?: string | null;
};

export type StoredSubscription = {
	id: string;
	userId: string;
	endpoint: string;
	p256dh: string;
	auth: string;
};

/** Upserts by endpoint (moving it to `userId`), then trims to MAX_DEVICES. */
export async function saveSubscription(
	exec: Exec,
	userId: string,
	sub: SubscriptionInput,
): Promise<void> {
	if (!isPushEndpoint(sub.endpoint)) throw new Error("not a push endpoint");
	if (!isUsableKeys(sub.p256dh, sub.auth))
		throw new Error("unusable push keys");
	await exec.execute(sql`
		insert into push_subscriptions (id, user_id, endpoint, p256dh, auth, user_agent)
		values (${uuidv7()}, ${userId}, ${sub.endpoint}, ${sub.p256dh}, ${sub.auth}, ${sub.userAgent?.slice(0, 300) ?? null})
		on conflict (endpoint) do update
		  set user_id = excluded.user_id, p256dh = excluded.p256dh, auth = excluded.auth,
		      user_agent = excluded.user_agent,
		      created_at = case when push_subscriptions.user_id = excluded.user_id
		                        then push_subscriptions.created_at else now() end`);
	await exec.execute(sql`
		delete from push_subscriptions
		 where user_id = ${userId}
		   and id not in (
		     select id from push_subscriptions where user_id = ${userId}
		      order by coalesce(last_used_at, created_at) desc, created_at desc
		      limit ${MAX_DEVICES})`);
}

/** Removes the caller's own subscription for this endpoint ("this device: off"). */
export async function deleteSubscription(
	exec: Exec,
	userId: string,
	endpoint: string,
): Promise<boolean> {
	const res = await exec.execute(sql`
		delete from push_subscriptions where user_id = ${userId} and endpoint = ${endpoint}`);
	return (res.rowCount ?? 0) > 0;
}

/** The push service said the endpoint is gone (404/410). */
export async function removeGoneSubscription(
	exec: Exec,
	id: string,
): Promise<void> {
	await exec.execute(sql`delete from push_subscriptions where id = ${id}`);
}

export async function markSubscriptionUsed(
	exec: Exec,
	id: string,
): Promise<void> {
	await exec.execute(
		sql`update push_subscriptions set last_used_at = now() where id = ${id}`,
	);
}

export async function listSubscriptions(
	exec: Exec,
	userIds: readonly string[],
): Promise<StoredSubscription[]> {
	if (!userIds.length) return [];
	const res = await exec.execute(sql`
		select id::text as id, user_id as "userId", endpoint, p256dh, auth
		  from push_subscriptions
		 where user_id = any(${sql.param([...userIds])}::text[])
		 order by user_id, created_at`);
	return res.rows as StoredSubscription[];
}

/** Whether this endpoint is stored for this user (the settings' "this device"). */
export async function hasSubscription(
	exec: Exec,
	userId: string,
	endpoint: string,
): Promise<boolean> {
	const res = await exec.execute(sql`
		select 1 from push_subscriptions where user_id = ${userId} and endpoint = ${endpoint}`);
	return res.rows.length > 0;
}

/** The users among `userIds` with at least one device. */
export async function subscribedUsers(
	exec: Exec,
	userIds: readonly string[],
): Promise<Set<string>> {
	if (!userIds.length) return new Set();
	const res = await exec.execute(sql`
		select distinct user_id as "userId" from push_subscriptions
		 where user_id = any(${sql.param([...userIds])}::text[])`);
	return new Set((res.rows as { userId: string }[]).map((r) => r.userId));
}

/** Whether anyone who can open the trip (member or live link guest) has a device. */
export async function tripHasSubscribers(
	exec: Exec,
	tripId: string,
): Promise<boolean> {
	const res = await exec.execute(sql`
		select 1 from push_subscriptions s
		 where s.user_id in (
		   select m.user_id from trip_members m
		    where m.trip_id = ${tripId} and m.status = 'active' and m.user_id is not null
		   union
		   select g.user_id from share_grants g
		     join share_links l on l.id = g.share_link_id and l.trip_id = g.trip_id
		    where g.trip_id = ${tripId} and l.enabled and l.revoked_at is null)
		 limit 1`);
	return res.rows.length > 0;
}

export type NotificationSettings = {
	offTypes: PushType[];
	mutedTripIds: string[];
};

export async function getSettings(
	exec: Exec,
	userId: string,
): Promise<NotificationSettings> {
	const map = await settingsFor(exec, [userId]);
	return map.get(userId) ?? { offTypes: [], mutedTripIds: [] };
}

/** Stored settings per user (users without rows are absent: everything on). */
export async function settingsFor(
	exec: Exec,
	userIds: readonly string[],
): Promise<Map<string, NotificationSettings>> {
	const out = new Map<string, NotificationSettings>();
	if (!userIds.length) return out;
	const ids = sql.param([...new Set(userIds)]);
	const prefs = await exec.execute(sql`
		select user_id as "userId", off_types as "offTypes" from notification_prefs
		 where user_id = any(${ids}::text[])`);
	for (const r of prefs.rows as { userId: string; offTypes: string[] }[])
		out.set(r.userId, {
			offTypes: (r.offTypes ?? []).filter(isPushType),
			mutedTripIds: [],
		});
	const mutes = await exec.execute(sql`
		select user_id as "userId", trip_id::text as "tripId" from notification_mutes
		 where user_id = any(${ids}::text[])`);
	for (const r of mutes.rows as { userId: string; tripId: string }[]) {
		const s = out.get(r.userId) ?? { offTypes: [], mutedTripIds: [] };
		s.mutedTripIds.push(r.tripId);
		out.set(r.userId, s);
	}
	return out;
}

/** Switches one type on or off for the user. */
export async function setTypeEnabled(
	exec: Exec,
	userId: string,
	type: PushType,
	on: boolean,
): Promise<PushType[]> {
	const res = on
		? await exec.execute(sql`
			insert into notification_prefs (user_id, off_types) values (${userId}, '{}')
			on conflict (user_id) do update
			  set off_types = array_remove(notification_prefs.off_types, ${type}), updated_at = now()
			returning off_types as "offTypes"`)
		: await exec.execute(sql`
			insert into notification_prefs (user_id, off_types) values (${userId}, array[${type}]::text[])
			on conflict (user_id) do update
			  set off_types = case when ${type} = any(notification_prefs.off_types)
			                       then notification_prefs.off_types
			                       else array_append(notification_prefs.off_types, ${type}) end,
			      updated_at = now()
			returning off_types as "offTypes"`);
	return (
		(res.rows[0] as { offTypes: string[] } | undefined)?.offTypes ?? []
	).filter(isPushType);
}

export async function setTripMuted(
	exec: Exec,
	userId: string,
	tripId: string,
	muted: boolean,
): Promise<void> {
	if (muted)
		await exec.execute(sql`
			insert into notification_mutes (user_id, trip_id) values (${userId}, ${tripId})
			on conflict do nothing`);
	else
		await exec.execute(sql`
			delete from notification_mutes where user_id = ${userId} and trip_id = ${tripId}`);
}

/** Muted trips with their names (live trips only), for the settings list. */
export async function mutedTrips(
	exec: Exec,
	userId: string,
): Promise<{ id: string; name: string; slug: string }[]> {
	const res = await exec.execute(sql`
		select t.id::text as id, t.name, t.slug from notification_mutes n
		  join trips t on t.id = n.trip_id and t.deleted_at is null
		 where n.user_id = ${userId}
		 order by n.created_at`);
	return res.rows as { id: string; name: string; slug: string }[];
}
