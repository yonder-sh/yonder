/**
 * The trip's activity log (SPEC §12.3 "logActivity"; EXTENSIONS §9): creates,
 * deletes, moves, schedules, day operations, leg mode changes, list and media
 * adds, expenses and proposals, shown in the inspector footer (`listActivity`)
 * and folded into the change digest (E6). Duration nudges and other small
 * edits are not logged. Rows have no FKs to their targets, so history
 * outlives deletes.
 *
 * Each row carries the `trips.version` of the transaction that wrote it
 * (`out.version`, set by `withTripTx` before the body runs), which is how the
 * digest finds "what changed since you last looked".
 */
import { type SQL, sql } from "drizzle-orm";
import type { DbOrTx } from "@/db/db.server";
import { activityLog } from "@/db/schema";
import type { ActivityMeta } from "@/lib/schemas/misc";
import type { TxOutbox } from "@/server/live/outbox.server";

export const ACTIVITY_VERBS = [
	"trip.update",
	"trip.dates",
	"trip.delete",
	"node.create",
	"node.update",
	"node.move",
	"node.delete",
	"node.restore",
	"node.hours",
	"item.create",
	"item.move",
	"item.schedule",
	"item.unschedule",
	"item.delete",
	"item.restore",
	"day.insert",
	"day.move",
	"day.delete",
	"day.stay",
	"leg.update",
	"leg.relink",
	"leg.delete",
	// EXTENSIONS §9 (E6 digest)
	"list.create",
	"list.done",
	"list.delete",
	"media.add",
	// WP-Media: a caption edit / move and a delete (never receipts or members-only rows).
	"media.update",
	"media.delete",
	"expense.add",
	"expense.delete",
	"proposal.create",
	"proposal.accept",
	"proposal.reject",
	// ADDENDUM §7.3 "edits after settlement are allowed and flagged": the money
	// history (summaries never carry amounts; `meta.expenseId`).
	"expense.update",
	"expense.paid",
	"expense.restore",
	"settlement.add",
	"settlement.delete",
	"budget.update",
	// ADDENDUM §8/§10 people: a typed name became a placeholder; a merge/claim.
	"person.add",
	"person.merge",
	// Membership (WP-Home; the digest's "Maya joined the trip").
	"person.invite",
	"person.role",
	"person.remove",
	"person.leave",
	// E7 note additions ("added to the notes of Shibuya Sky").
	"note.append",
	// WP-Transit: flights and custom routes (member-visible, not money).
	"flight.save",
	"flight.create",
	"transit.route",
] as const;
export type ActivityVerb = (typeof ACTIVITY_VERBS)[number];

/** Verbs a share-link guest never sees (money is members-only, EXTENSIONS §8.5). */
export const MEMBER_ONLY_VERB_PREFIXES = [
	"expense.",
	"settlement.",
	"budget.",
] as const;

/**
 * `and <verb> not like 'expense.%' and …` for a guest's activity reads
 * (`listActivity`, `getDigest`, `countChangesSince`). Empty for members.
 */
export function memberOnlyVerbsGuard(verb: SQL, redact: boolean): SQL {
	if (!redact) return sql``;
	return sql.join(
		MEMBER_ONLY_VERB_PREFIXES.map((p) => sql` and ${verb} not like ${`${p}%`}`),
		sql``,
	);
}

export type ActivityInput = {
	tripId: string;
	actor: { userId: string | null; name: string };
	verb: ActivityVerb;
	/** "moved Itoya to Day 4" (no actor name; the UI prefixes it). NEVER an amount. */
	summary: string;
	nodeId?: string | null;
	itemId?: string | null;
	legId?: string | null;
	dayId?: string | null;
	/** Digest facts (E6). */
	meta?: ActivityMeta;
};

/**
 * SECURITY §2 "a guest can't pose as Dennis": a link guest's rows are marked
 * when written (`meta.guest`, so the mark survives the anonymous user being
 * deleted) and on read (an anonymous actor). SQL over the `activity_log`
 * alias `a`.
 */
export function actorIsGuestSql(a: SQL = sql.raw("a")): SQL {
	return sql`(coalesce((${a}.meta->>'guest')::boolean, false)
		or exists (select 1 from "user" gu where gu.id = ${a}.actor_user_id and gu.is_anonymous))`;
}

/** The name the UI shows for an actor: a guest's always carries "(guest)". */
export function actorDisplayName(name: string, isGuest: boolean): string {
	return isGuest ? `${name} (guest)` : name;
}

/**
 * Appends one entry inside the mutation's transaction. `out` is required so
 * the row carries this transaction's trip version (E6).
 */
export async function logActivity(
	tx: DbOrTx,
	out: Pick<TxOutbox, "version">,
	a: ActivityInput,
): Promise<void> {
	const guest = a.actor.userId
		? (
				await tx.execute(
					sql`select 1 from "user" where id = ${a.actor.userId} and is_anonymous`,
				)
			).rows.length > 0
		: false;
	await tx.insert(activityLog).values({
		tripId: a.tripId,
		actorUserId: a.actor.userId,
		actorName: a.actor.name.slice(0, 120) || "Someone",
		verb: a.verb,
		summary: a.summary.slice(0, 300),
		nodeId: a.nodeId ?? null,
		itemId: a.itemId ?? null,
		legId: a.legId ?? null,
		dayId: a.dayId ?? null,
		version: out.version,
		meta: guest ? { ...(a.meta ?? {}), guest: true } : (a.meta ?? null),
	});
}

/** The dashboard's "12 changes" cap (EXTENSIONS §9: "99+"). */
export const CHANGES_CAP = 100;

/**
 * `countChangesSince(userId, tripIds)` (E6 digest backend, for WP-Home's
 * `listMyTrips`): per trip, other people's activity rows newer than the
 * caller's `trip_seen.seen_version`, capped at 100. No `trip_seen` row yet
 * (the trip was never opened) counts 0, like `getDigest`'s first call. Link
 * guests (no active membership) never count money rows.
 */
export async function countChangesSince(
	exec: Pick<DbOrTx, "execute">,
	userId: string,
	tripIds: readonly string[],
): Promise<Record<string, number>> {
	if (!tripIds.length) return {};
	const res = await exec.execute(sql`
		select t.id::text as "tripId",
		       (select count(*)::int from (
		          select 1 from activity_log a
		           where a.trip_id = t.id
		             and a.version > coalesce(s.seen_version, t.version)
		             and a.actor_user_id is distinct from ${userId}
		             and (m.id is not null or (${sql.join(
										MEMBER_ONLY_VERB_PREFIXES.map(
											(p) => sql`a.verb not like ${`${p}%`}`,
										),
										sql` and `,
									)}))
		           limit ${CHANGES_CAP}) x) as n
		  from trips t
		  left join trip_seen s on s.trip_id = t.id and s.user_id = ${userId}
		  left join trip_members m on m.trip_id = t.id and m.user_id = ${userId} and m.status = 'active'
		 where t.id = any(${sql.param([...tripIds])}::uuid[])`);
	const out: Record<string, number> = {};
	for (const r of res.rows as { tripId: string; n: number }[])
		out[r.tripId] = Number(r.n);
	return out;
}
