import { sql } from "drizzle-orm";
import type { Tx } from "@/db/db.server";
import { AppError } from "./authz/errors";
import { retireMember } from "./members.server";

/**
 * Deletes a user account (operator cleanup, `scripts/cleanup-test-data.ts`;
 * there is no self-service account deletion in v1: Better Auth's
 * `/delete-user` is disabled). What belongs to the account goes with the
 * `user` row (sessions, accounts, share grants, prefs, inbox reads, private
 * notes); rows they authored keep their content with the author nulled.
 *
 * What must not go is their place in other people's trips:
 * `trip_members.user_id` cascades, and since 0010 a member row takes its
 * splits, payments and settlements with it. So every live membership is
 * retired first (`retireMember`: the row stays as "Kai (former member)" with
 * all its tags, ratings and money, and no user), and an account that still
 * owns a trip is refused: delete those trips first (`purgeTrip`), or they'd be
 * left without an owner. Redis session copies end on their next read (the
 * `session` row is gone: `sessionsAndLimitsOnly`). Run it in a transaction.
 */
export async function deleteUserAccount(
	tx: Tx,
	userId: string,
): Promise<{ retired: number }> {
	const owned = (
		await tx.execute(sql`
			select t.slug from trip_members m join trips t on t.id = m.trip_id
			 where m.user_id = ${userId} and m.role = 'owner'
			 order by t.slug limit 5`)
	).rows as { slug: string }[];
	if (owned.length)
		throw new AppError(
			"CONFLICT",
			`the account still owns trips (${owned.map((o) => o.slug).join(", ")}): delete them first`,
		);
	const memberships = (
		await tx.execute(sql`
			select id::text as id, trip_id::text as "tripId" from trip_members
			 where user_id = ${userId} and status <> 'removed'
			 order by trip_id, id`)
	).rows as { id: string; tripId: string }[];
	for (const m of memberships) await retireMember(tx, null, m.tripId, m.id);
	await tx.execute(sql`delete from "user" where id = ${userId}`);
	return { retired: memberships.length };
}
