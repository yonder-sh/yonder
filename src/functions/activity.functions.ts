/**
 * E6 change digest (EXTENSIONS §9), F-owned: `getDigest` and `markTripSeen`.
 * The digest is snapshotted once per trip open on the client
 * (`tripKeys.digest`, `staleTime: Infinity`); only "Got it" clears it.
 */
import { createServerFn } from "@tanstack/react-start";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db/db.server";
import { can, mustRedact } from "@/lib/auth/roles";
import type { ActivityMeta } from "@/lib/schemas/misc";
import {
	actorDisplayName,
	actorIsGuestSql,
	memberOnlyVerbsGuard,
} from "@/server/activity.server";
import { requireTripRole } from "@/server/authz/access.server";
import { withUser } from "@/server/authz/middleware";
import { fail } from "@/server/authz/session.server";
import { proposalVisibleSql } from "@/server/proposals/dto.server";
import { requireDirect } from "@/server/proposals/proposable.server";

/** At most this many rows per digest (newest first). */
export const DIGEST_MAX_ROWS = 300;

export type DigestRow = {
	id: string;
	at: string;
	version: number;
	verb: string;
	actorUserId: string | null;
	/** A link guest's name always ends in "(guest)" (SECURITY §2). */
	actorName: string;
	actorIsGuest?: boolean;
	summary: string;
	nodeId: string | null;
	itemId: string | null;
	legId: string | null;
	dayId: string | null;
	meta: ActivityMeta | null;
};

export type Digest = {
	seenVersion: number;
	seenAt: string | null;
	currentVersion: number;
	/** Other people's changes since `seenVersion`, newest first, ≤ DIGEST_MAX_ROWS. */
	rows: DigestRow[];
	/** Reviewers: open proposals to review (else 0). */
	openProposals: number;
	/** The caller's own proposals resolved since they last looked. */
	myResolved: {
		accepted: number;
		rejected: { id: string; summary: string; note: string | null }[];
	};
};

/**
 * `getDigest({ tripId })` (V). The first call for a user inserts
 * `seenVersion = currentVersion` and returns an empty digest. Guests never
 * get `expense.*` rows.
 */
export const getDigest = createServerFn({ method: "GET" })
	.middleware([withUser])
	.validator(z.object({ tripId: z.uuid() }).strict())
	.handler(async ({ data, context }): Promise<Digest> => {
		const access = await requireTripRole(data.tripId, "viewer", context.user);
		const me = context.user.id;
		return db.transaction(async (tx) => {
			const trip = await tx.execute(
				sql`select version from trips where id = ${data.tripId} and deleted_at is null`,
			);
			const currentVersion = Number(
				(trip.rows[0] as { version: number } | undefined)?.version ?? -1,
			);
			if (currentVersion < 0) return fail("NOT_FOUND");
			const seen = await tx.execute(sql`
				select seen_version as "seenVersion", seen_at as "seenAt" from trip_seen
				 where trip_id = ${data.tripId} and user_id = ${me}`);
			const row = seen.rows[0] as
				| { seenVersion: number; seenAt: Date }
				| undefined;
			const empty = {
				rows: [],
				openProposals: 0,
				myResolved: { accepted: 0, rejected: [] },
			};
			if (!row) {
				await tx.execute(sql`
					insert into trip_seen (trip_id, user_id, seen_version) values (${data.tripId}, ${me}, ${currentVersion})
					on conflict (trip_id, user_id) do nothing`);
				return {
					seenVersion: currentVersion,
					seenAt: null,
					currentVersion,
					...empty,
				};
			}
			const seenVersion = Number(row.seenVersion);
			const rows = await tx.execute(sql`
				select id::text as id, created_at as at, version, verb, actor_user_id as "actorUserId",
				       actor_name as "actorName", ${actorIsGuestSql(sql.raw("activity_log"))} as "actorIsGuest",
				       summary, node_id::text as "nodeId", item_id::text as "itemId",
				       leg_id::text as "legId", day_id::text as "dayId", meta
				  from activity_log
				 where trip_id = ${data.tripId} and version > ${seenVersion}
				   and actor_user_id is distinct from ${me}
				   ${memberOnlyVerbsGuard(sql`verb`, mustRedact(access))}
				 order by version desc, created_at desc, id desc
				 limit ${DIGEST_MAX_ROWS}`);
			const open = can(access, "reviewProposals")
				? Number(
						(
							(
								await tx.execute(
									sql`select count(*)::int as n from proposals p where p.trip_id = ${data.tripId} and p.status = 'open' and ${proposalVisibleSql(access, me)}`,
								)
							).rows[0] as { n: number }
						).n,
					)
				: 0;
			const resolved = await tx.execute(sql`
				select id::text as id, status::text as status, summary, review_note as note
				  from proposals
				 where trip_id = ${data.tripId} and author_user_id = ${me}
				   and status in ('accepted', 'rejected') and reviewed_at > ${row.seenAt}
				 order by reviewed_at desc limit 50`);
			const res = resolved.rows as {
				id: string;
				status: string;
				summary: string;
				note: string | null;
			}[];
			return {
				seenVersion,
				seenAt: new Date(row.seenAt).toISOString(),
				currentVersion,
				rows: (rows.rows as Record<string, unknown>[]).map((r) => ({
					id: String(r.id),
					at: new Date(r.at as string).toISOString(),
					version: Number(r.version),
					verb: String(r.verb),
					actorUserId: (r.actorUserId as string | null) ?? null,
					actorName: actorDisplayName(
						String(r.actorName),
						r.actorIsGuest === true,
					),
					actorIsGuest: r.actorIsGuest === true,
					summary: String(r.summary),
					nodeId: (r.nodeId as string | null) ?? null,
					itemId: (r.itemId as string | null) ?? null,
					legId: (r.legId as string | null) ?? null,
					dayId: (r.dayId as string | null) ?? null,
					meta: (r.meta as ActivityMeta | null) ?? null,
				})),
				openProposals: open,
				myResolved: {
					accepted: res.filter((r) => r.status === "accepted").length,
					rejected: res
						.filter((r) => r.status === "rejected")
						.map(({ id, summary, note }) => ({ id, summary, note })),
				},
			};
		});
	});

/**
 * "Got it": the digest is read up to `version` (the snapshot's
 * `currentVersion`). Never moves backwards; emits nothing. `{ direct: 'read' }`.
 */
export const markTripSeen = createServerFn({ method: "POST" })
	.middleware([withUser])
	.validator(
		z
			.object({ tripId: z.uuid(), version: z.number().int().nonnegative() })
			.strict(),
	)
	.handler(async ({ data, context }): Promise<{ seenVersion: number }> => {
		await requireDirect("markTripSeen", data.tripId, context.user);
		const res = await db.execute(sql`
			insert into trip_seen (trip_id, user_id, seen_version, seen_at)
			values (${data.tripId}, ${context.user.id},
			        least(${data.version}, (select version from trips where id = ${data.tripId})), now())
			on conflict (trip_id, user_id) do update
			  set seen_version = greatest(trip_seen.seen_version, excluded.seen_version),
			      seen_at = now()
			returning seen_version as "seenVersion"`);
		return {
			seenVersion: Number(
				(res.rows[0] as { seenVersion: number } | undefined)?.seenVersion ?? 0,
			),
		};
	});
