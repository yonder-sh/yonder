import { sql } from "drizzle-orm";
import { db } from "@/db/db.server";
import { announceTripChange } from "@/server/announce.server";
import { joinRateLinks } from "@/server/authz/share-links.server";
import { mergeMember } from "@/server/members.server";

/**
 * Account lifecycle hooks that touch app tables (SPEC §11.1, §11.5). They use
 * raw SQL on the documented table/column names (SPEC §6.3) so they don't
 * depend on the Drizzle export names.
 */

type Row = Record<string, unknown>;
const rows = <T extends Row>(r: { rows: unknown[] }) => r.rows as T[];

/**
 * `claimInvites(userId)` (SPEC §11.5): turns `invited` member rows for the
 * user's email into active memberships, and drops invites for trips the user
 * already belongs to. Conflict-safe, skipped for anonymous users, and never
 * throws into sign-in (the caller logs).
 */
export async function claimInvites(userId: string): Promise<number> {
	const found = rows<{ email: string; is_anonymous: boolean | null }>(
		await db.execute(
			sql`select email, is_anonymous from "user" where id = ${userId}`,
		),
	)[0];
	if (!found || found.is_anonymous) return 0;
	const email = found.email.trim().toLowerCase();
	const tripIds = await db.transaction(async (tx) => {
		const claimed = await tx.execute(sql`
			update trip_members m
			   set user_id = ${userId}, status = 'active', joined_at = now(), email = null, updated_at = now()
			 where m.status = 'invited' and m.email = ${email}
			   and not exists (select 1 from trip_members x where x.trip_id = m.trip_id and x.user_id = ${userId})
			returning m.trip_id::text as "tripId"`);
		// Invites for trips the user already belongs to are MERGED into that
		// membership (ADDENDUM §10: an invite may be a linked placeholder carrying
		// tags, mentions, splits and budgets), never deleted.
		const dupes = await tx.execute(sql`
			select m.id::text as id, m.trip_id::text as "tripId", x.id::text as "intoId"
			  from trip_members m
			  join trip_members x on x.trip_id = m.trip_id and x.user_id = ${userId}
			 where m.status = 'invited' and m.email = ${email}`);
		for (const d of dupes.rows as {
			id: string;
			tripId: string;
			intoId: string;
		}[])
			await mergeMember(tx, null, d.tripId, d.id, d.intoId);
		return (claimed.rows as { tripId: string }[]).map((r) => r.tripId);
	});
	// After COMMIT: the invite turned into a member on those trips' Share dialogs and member lists.
	if (tripIds.length) await announceTripChange(tripIds, ["sharing", "graph"]);
	return tripIds.length;
}

/** User-reference columns that aren't foreign keys in every table, by name. */
const ATTRIBUTION_COLUMNS = [
	"created_by",
	"updated_by",
	"done_by",
	"actor_user_id",
];
/**
 * Tables whose user columns are NOT re-pointed: Better Auth's own tables (it
 * deletes the anonymous user and its sessions itself), grants (handled first,
 * with de-duplication) and memberships (a guest never becomes a member by
 * signing in, SPEC §11.2 flow 7).
 */
const SKIP_TABLES = new Set([
	"user",
	"session",
	"account",
	"verification",
	"share_grants",
	"trip_members",
	// Merged explicitly below (one row per user: a blind re-point would collide).
	"trip_seen",
	"user_prefs",
	"inbox_reads",
]);

/**
 * Single user columns that are never re-pointed: a private note's owner is
 * part of the document name (`…/u/<userId>`, checked by a constraint), and
 * guests can't hold private notes anyway.
 */
const SKIP_COLUMNS = new Set(["yjs_documents.owner_user_id"]);

/**
 * `migrateGuestToUser(anonId, userId)` (SPEC §11.1): when a guest signs in,
 * move their share grants and every attribution column from the anonymous
 * user to the account, in one transaction. No membership is created, except
 * on a "Can rate" link (`joinRateLinks`, PLACES §1c: signing in is what lets
 * a rate-link guest rate).
 * Columns are discovered from the catalog (FKs to "user".id plus the
 * attribution names), so later tables are covered without editing this.
 */
export async function migrateGuestToUser(
	anonId: string,
	userId: string,
): Promise<void> {
	if (anonId === userId) return;
	let joined: string[] = [];
	await db.transaction(async (tx) => {
		await tx.execute(sql`
			delete from share_grants g
			 where g.user_id = ${anonId}
			   and exists (select 1 from share_grants x where x.share_link_id = g.share_link_id and x.user_id = ${userId})`);
		await tx.execute(
			sql`update share_grants set user_id = ${userId} where user_id = ${anonId}`,
		);
		joined = await joinRateLinks(tx, userId);

		const columns = rows<{ table_name: string; column_name: string }>(
			await tx.execute(sql`
				select distinct c.table_name, c.column_name
				  from information_schema.columns c
				 where c.table_schema = 'public'
				   and c.data_type = 'text'
				   and (
				     c.column_name in ${ATTRIBUTION_COLUMNS}
				     or exists (
				       select 1
				         from information_schema.key_column_usage k
				         join information_schema.referential_constraints r
				           on r.constraint_name = k.constraint_name and r.constraint_schema = k.constraint_schema
				         join information_schema.key_column_usage p
				           on p.constraint_name = r.unique_constraint_name and p.constraint_schema = r.unique_constraint_schema
				        where k.table_schema = c.table_schema and k.table_name = c.table_name
				          and k.column_name = c.column_name
				          and p.table_name = 'user' and p.column_name = 'id'))`),
		).filter(
			(c) =>
				!SKIP_TABLES.has(c.table_name) &&
				!SKIP_COLUMNS.has(`${c.table_name}.${c.column_name}`),
		);

		// E6: digest cursors merge, the furthest "seen" wins (EXTENSIONS §9).
		await tx.execute(sql`
			insert into trip_seen (trip_id, user_id, seen_version, seen_at, welcome_seen_at)
			select trip_id, ${userId}, seen_version, seen_at, welcome_seen_at from trip_seen where user_id = ${anonId}
			on conflict (trip_id, user_id) do update
			  set seen_version = greatest(trip_seen.seen_version, excluded.seen_version),
			      seen_at = greatest(trip_seen.seen_at, excluded.seen_at),
			      welcome_seen_at = coalesce(trip_seen.welcome_seen_at, excluded.welcome_seen_at)`);
		await tx.execute(sql`delete from trip_seen where user_id = ${anonId}`);
		// One inbox read state (ADDENDUM §10): union, the account's rows win.
		await tx.execute(sql`
			insert into inbox_reads (user_id, item_key, trip_id, read_at)
			select ${userId}, item_key, trip_id, read_at from inbox_reads where user_id = ${anonId}
			on conflict (user_id, item_key) do nothing`);
		await tx.execute(sql`delete from inbox_reads where user_id = ${anonId}`);
		// View settings: the account's own win; a guest's are dropped.
		await tx.execute(sql`delete from user_prefs where user_id = ${anonId}`);

		for (const { table_name, column_name } of columns) {
			// Identifiers come from the catalog, and sql.identifier() quotes them.
			const t = sql.identifier(table_name);
			const c = sql.identifier(column_name);
			await tx.execute(
				sql`update ${t} set ${c} = ${userId} where ${c} = ${anonId}`,
			);
		}
	});
	// Rate-link guests who became members: everyone's People list and graph.
	if (joined.length) await announceTripChange(joined, ["sharing", "graph"]);
}
