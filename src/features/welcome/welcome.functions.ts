/**
 * The welcome for people who join a trip (owner, 2026-09-25): shown the
 * first time someone opens a trip they didn't create, members and link
 * guests alike, remembered per person and trip on the server
 * (`trip_seen.welcome_seen_at`, merged when a guest signs in) so it doesn't
 * come back on another device.
 * - `getWelcome`: whether to show it, how you came in ("Maya invited you",
 *   or the trip link) and the inviter's note.
 * - `markWelcomeSeen`: closed.
 */
import { createServerFn } from "@tanstack/react-start";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db/db.server";
import { requireTripRole } from "@/server/authz/access.server";
import { withUser } from "@/server/authz/middleware";
import { requireDirect } from "@/server/proposals/proposable.server";

export type WelcomeInfo = {
	/** Show it on open: you didn't create the trip and haven't closed it yet. */
	show: boolean;
	/** "Maya invited you", or "You're joining through the trip link". */
	via: "invite" | "link" | null;
	/** The inviter's first name and account (by email invite). */
	invitedBy: string | null;
	inviterUserId: string | null;
	/** The inviter's one-line note, with their first name. */
	note: { text: string; by: string } | null;
};

const TripId = z.object({ tripId: z.uuid() }).strict();

const first = (name: string | null | undefined, firstName?: string | null) =>
	firstName?.trim() || (name ?? "").trim().split(/\s+/)[0] || null;

export const getWelcome = createServerFn({ method: "GET" })
	.middleware([withUser])
	.validator(TripId)
	.handler(async ({ data, context }): Promise<WelcomeInfo> => {
		const access = await requireTripRole(data.tripId, "viewer", context.user);
		const me = context.user.id;
		const res = await db.execute(sql`
			select t.created_by = ${me} as creator,
			       s.welcome_seen_at is not null as seen,
			       m.invited_by as "inviterUserId", coalesce(m.joined_by_link, false) as "byLink",
			       m.invite_note as "inviteNote", iu.name as "inviterName", iu.first_name as "inviterFirst",
			       l.note as "linkNote", lu.name as "linkByName", lu.first_name as "linkByFirst",
			       ou.name as "ownerName", ou.first_name as "ownerFirst"
			  from trips t
			  left join trip_seen s on s.trip_id = t.id and s.user_id = ${me}
			  left join trip_members m on m.trip_id = t.id and m.user_id = ${me} and m.status = 'active'
			  left join "user" iu on iu.id = m.invited_by
			  left join lateral (
			        select note, created_by from share_links
			         where trip_id = t.id and revoked_at is null
			         order by created_at desc, id desc limit 1) l on true
			  left join "user" lu on lu.id = l.created_by
			  left join trip_members om on om.trip_id = t.id and om.role = 'owner'
			  left join "user" ou on ou.id = om.user_id
			 where t.id = ${data.tripId}`);
		const r = res.rows[0] as
			| {
					creator: boolean | null;
					seen: boolean;
					inviterUserId: string | null;
					byLink: boolean;
					inviteNote: string | null;
					inviterName: string | null;
					inviterFirst: string | null;
					linkNote: string | null;
					linkByName: string | null;
					linkByFirst: string | null;
					ownerName: string | null;
					ownerFirst: string | null;
			  }
			| undefined;
		if (!r)
			return {
				show: false,
				via: null,
				invitedBy: null,
				inviterUserId: null,
				note: null,
			};
		const owner = first(r.ownerName, r.ownerFirst) ?? "the owner";
		const invited = !!r.inviterUserId;
		const invitedBy = invited ? first(r.inviterName, r.inviterFirst) : null;
		const via = invited ? "invite" : access.isGuest || r.byLink ? "link" : null;
		const note =
			via === "invite" && r.inviteNote
				? { text: r.inviteNote, by: invitedBy ?? owner }
				: via === "link" && r.linkNote
					? {
							text: r.linkNote,
							by: first(r.linkByName, r.linkByFirst) ?? owner,
						}
					: null;
		return {
			show: r.creator !== true && !r.seen,
			via,
			invitedBy,
			inviterUserId: r.inviterUserId,
			note,
		};
	});

/** Closed ("Look around", Escape, or a button): it doesn't come back. */
export const markWelcomeSeen = createServerFn({ method: "POST" })
	.middleware([withUser])
	.validator(TripId)
	.handler(async ({ data, context }): Promise<{ ok: true }> => {
		await requireDirect("markWelcomeSeen", data.tripId, context.user);
		// A first row starts the digest at the trip's current version (like `getDigest`).
		await db.execute(sql`
			insert into trip_seen (trip_id, user_id, seen_version, welcome_seen_at)
			values (${data.tripId}, ${context.user.id},
			        (select version from trips where id = ${data.tripId}), now())
			on conflict (trip_id, user_id) do update
			  set welcome_seen_at = coalesce(trip_seen.welcome_seen_at, now())`);
		return { ok: true };
	});
