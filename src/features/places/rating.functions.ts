/**
 * The people who rate (owner, 2026-09-25):
 * - `setRatingsCounted`: leave one person's ratings out of every group score
 *   (someone who might not come, a placeholder's guesses), or count them
 *   again. Ratings are never deleted. Owners and editors; notifies nobody.
 * - `remindToRate`: a push to a member with places left to rate ("Dennis
 *   reminded you to rate 12 places in Summer in Japan"), at most once per
 *   member and trip every 12 hours. The row is also their line in the trip
 *   until they close it (`dismissRateReminder`), for anyone without push.
 * - `getRateReminders`: who was reminded in the last 12 hours, and your own
 *   unread reminder.
 */
import { createServerFn } from "@tanstack/react-start";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db/db.server";
import { canRateOwn } from "@/lib/auth/roles";
import { indexGraph } from "@/lib/engine/graph-index";
import { newId } from "@/lib/ids";
import { logActivity } from "@/server/activity.server";
import { requireTripRole } from "@/server/authz/access.server";
import { withNamedUser, withUser } from "@/server/authz/middleware";
import { fail } from "@/server/authz/session.server";
import { rateLimitPer } from "@/server/cache.server";
import { loadGraphForServer } from "@/server/graph.server";
import { tripOf } from "@/server/perms.server";
import { requireDirect } from "@/server/proposals/proposable.server";
import { actorOf } from "@/server/proposals/types";
import { mutationMeta, withTripTx } from "@/server/tx.server";
import { lockMember } from "../home/server/people.server";
import { openPlaces } from "./tab/model";

/** A member is reminded at most once per trip in this long. */
export const REMIND_EVERY_HOURS = 12;
/** Reminders one person may send per hour, across trips. */
export const REMINDS_PER_HOUR = 30;

const firstName = (name: string) => name.trim().split(/\s+/)[0] || name;

export const setRatingsCounted = createServerFn({ method: "POST" })
	.middleware([withNamedUser])
	.validator(z.object({ memberId: z.uuid(), counted: z.boolean() }).strict())
	.handler(async ({ data, context }): Promise<{ ok: true }> => {
		const tripId = await tripOf("trip_members", data.memberId);
		if (!tripId) return fail("NOT_FOUND", "member");
		const access = await requireDirect(
			"setRatingsCounted",
			tripId,
			context.user,
		);
		await rateLimitPer(`ratingsCounted:${context.user.id}`, 120, 3600);
		return withTripTx(
			tripId,
			async (tx, out) => {
				const m = await lockMember(tx, tripId, data.memberId);
				const res = await tx.execute(sql`
					update trip_members set ratings_counted = ${data.counted}, updated_at = now()
					 where id = ${m.id} and trip_id = ${tripId} and ratings_counted <> ${data.counted}
					returning id`);
				if (res.rows.length)
					await logActivity(tx, out, {
						tripId,
						actor: actorOf(context.user),
						verb: "person.ratings",
						summary: data.counted
							? `counted ${m.name}'s ratings again`
							: `left out ${m.name}'s ratings`,
						meta: { memberId: m.id, name: m.name },
					});
				out.emit({ entity: "member", keys: ["graph"] });
				return { ok: true as const };
			},
			mutationMeta(access, context.user),
		);
	});

export type RateReminders = {
	/** Members reminded in the last 12 hours (by anyone): their Remind reads "Reminded". */
	recent: { memberId: string; at: string }[];
	/** Your newest reminder you haven't closed. */
	mine: { byName: string; places: number; at: string } | null;
};

export const getRateReminders = createServerFn({ method: "GET" })
	.middleware([withUser])
	.validator(z.object({ tripId: z.uuid() }).strict())
	.handler(async ({ data, context }): Promise<RateReminders> => {
		const access = await requireTripRole(data.tripId, "viewer", context.user);
		const recent = await db.execute(sql`
			select member_id::text as "memberId", max(created_at) as at
			  from rate_reminders
			 where trip_id = ${data.tripId}
			   and created_at > now() - make_interval(hours => ${REMIND_EVERY_HOURS})
			 group by member_id`);
		const mine = access.memberId
			? ((
					await db.execute(sql`
						select by_name as "byName", places, created_at as at
						  from rate_reminders
						 where trip_id = ${data.tripId} and member_id = ${access.memberId} and seen_at is null
						 order by created_at desc limit 1`)
				).rows[0] as
					| { byName: string; places: number; at: Date | string }
					| undefined)
			: undefined;
		return {
			recent: (recent.rows as { memberId: string; at: Date | string }[]).map(
				(r) => ({ memberId: r.memberId, at: new Date(r.at).toISOString() }),
			),
			mine: mine
				? {
						byName: mine.byName,
						places: Number(mine.places),
						at: new Date(mine.at).toISOString(),
					}
				: null,
		};
	});

export const remindToRate = createServerFn({ method: "POST" })
	.middleware([withNamedUser])
	.validator(z.object({ tripId: z.uuid(), memberId: z.uuid() }).strict())
	.handler(async ({ data, context }): Promise<{ at: string }> => {
		const access = await requireDirect(
			"remindToRate",
			data.tripId,
			context.user,
		);
		if (!canRateOwn(access)) return fail("FORBIDDEN");
		if (data.memberId === access.memberId)
			return fail("VALIDATION", "You can't remind yourself.");
		await rateLimitPer(`remind:${context.user.id}`, REMINDS_PER_HOUR, 3600);
		const graph = await loadGraphForServer(db, data.tripId);
		if (!graph) return fail("NOT_FOUND");
		const target = graph.members.find((m) => m.id === data.memberId);
		if (!target) return fail("NOT_FOUND", "member");
		// Only people with an account get notifications.
		if (target.status !== "active" || !target.userId)
			return fail("VALIDATION", `${target.name} has no account yet.`);
		if (target.ratingsCounted === false)
			return fail("VALIDATION", `${target.name}'s ratings aren't counted.`);
		if (target.role === "viewer")
			return fail("VALIDATION", `${target.name} can't rate.`);
		const left = openPlaces(indexGraph(graph)).filter(
			(n) => n.priorities[target.id] === undefined,
		).length;
		if (!left)
			return fail("VALIDATION", `${target.name} has rated every place.`);
		const byName =
			context.user.firstName?.trim() || firstName(context.user.name);
		const who = target.firstName ?? firstName(target.name);
		return withTripTx(
			data.tripId,
			async (tx, out) => {
				// Serialized by the trip lock: two quick taps send one reminder.
				const last = await tx.execute(sql`
					select 1 from rate_reminders
					 where trip_id = ${data.tripId} and member_id = ${target.id}
					   and created_at > now() - make_interval(hours => ${REMIND_EVERY_HOURS})
					 limit 1`);
				if (last.rows.length)
					return fail(
						"CONFLICT",
						`${who} was reminded less than ${REMIND_EVERY_HOURS} hours ago.`,
					);
				const row = await tx.execute(sql`
					insert into rate_reminders (id, trip_id, member_id, by_user_id, by_name, places)
					values (${newId()}, ${data.tripId}, ${target.id}, ${context.user.id}, ${byName}, ${left})
					returning created_at as at`);
				out.notify({ kind: "remind", memberId: target.id, places: left });
				// Everyone's "Reminded" (and the recipient's line) refreshes.
				out.emit({ keys: ["sharing"] });
				const at = (row.rows[0] as { at: Date | string }).at;
				return { at: new Date(at).toISOString() };
			},
			{ ...mutationMeta(access, context.user), bumpVersion: false },
		);
	});

/** Closes your reminder line (every unread one on this trip). */
export const dismissRateReminder = createServerFn({ method: "POST" })
	.middleware([withUser])
	.validator(z.object({ tripId: z.uuid() }).strict())
	.handler(async ({ data, context }): Promise<{ ok: true }> => {
		const access = await requireDirect(
			"dismissRateReminder",
			data.tripId,
			context.user,
		);
		if (access.memberId)
			await db.execute(sql`
				update rate_reminders set seen_at = now()
				 where trip_id = ${data.tripId} and member_id = ${access.memberId} and seen_at is null`);
		return { ok: true };
	});
