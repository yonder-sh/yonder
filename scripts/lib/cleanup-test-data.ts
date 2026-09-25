/**
 * Removing leftover TEST data from a database that also holds real trips
 * (`scripts/cleanup-test-data.ts`): every trip not owned by the keeper and
 * every other account, through the app's own delete paths — `purgeTrip`
 * (media objects, then `hardDeleteTrip`) for trips and `deleteUserAccount`
 * for accounts — then, optionally, S3 objects nothing points at any more.
 *
 * Safety first (`planCleanup` → `blockers`; nothing is deleted while any
 * remain):
 * - the keeper exists and owns at least one trip;
 * - every account to delete is a test account: anonymous (a link guest) or an
 *   address on a test domain (example.com/.org/.net, *.test, *.invalid,
 *   *.example, localhost);
 * - no account to delete appears anywhere in a kept trip (member, invite,
 *   share grant, or the author of anything in it), so the kept trips are
 *   left exactly as they are; `fingerprintTrips` proves it before and after.
 */
import { sql } from "drizzle-orm";
import type { Db } from "../../src/db/db.server";
import { purgeTrip } from "../../src/features/media/server/purge.server";
import { deleteUserAccount } from "../../src/server/account-delete.server";

export type CleanupTrip = { id: string; slug: string; owner: string | null };
export type CleanupUser = { id: string; email: string; anonymous: boolean };
export type CleanupPlan = {
	keeper: { id: string; email: string } | null;
	keepTrips: CleanupTrip[];
	deleteTrips: CleanupTrip[];
	deleteUsers: CleanupUser[];
	/** Why nothing may be deleted yet (empty = safe to run). */
	blockers: string[];
};

/** A test address: never a real person's. */
export function isTestEmail(email: string): boolean {
	const domain = email.toLowerCase().split("@")[1] ?? "";
	return (
		/^(example\.(com|org|net))$/.test(domain) ||
		/(^|\.)(test|invalid|example|localhost)$/.test(domain)
	);
}

type Q = <T>(q: ReturnType<typeof sql>) => Promise<T[]>;
const query =
	(db: Db): Q =>
	async <T>(q: ReturnType<typeof sql>) =>
		(await db.execute(q)).rows as T[];

/** Tables with a `trip_id` and a user column that deleting the user would change. */
const USER_REFS: [table: string, cols: string[]][] = [
	["trip_members", ["user_id", "invited_by"]],
	["share_grants", ["user_id"]],
	["share_links", ["created_by"]],
	["nodes", ["created_by"]],
	["items", ["created_by"]],
	["legs", ["created_by"]],
	["list_items", ["created_by", "done_by"]],
	["attachments", ["created_by"]],
	["mentions", ["created_by"]],
	["activity_log", ["actor_user_id"]],
	["expenses", ["created_by"]],
	["expense_payments", ["created_by"]],
	["settlements", ["created_by"]],
	["budget_lines", ["created_by"]],
	["proposals", ["author_user_id", "reviewed_by"]],
	["trip_seen", ["user_id"]],
];

export async function planCleanup(
	db: Db,
	opts: { keepOwner: string; also?: string[] },
): Promise<CleanupPlan> {
	// Accounts the owner explicitly named for deletion even though they aren't test addresses
	// (or appear in a kept trip): their memberships there are retired by deleteUserAccount.
	const also = new Set((opts.also ?? []).map((e) => e.toLowerCase()));
	const q = query(db);
	const blockers: string[] = [];
	const [keeper] = await q<{ id: string; email: string }>(sql`
		select id, email from "user" where lower(email) = lower(${opts.keepOwner})`);
	if (!keeper) blockers.push(`the keeper ${opts.keepOwner} has no account`);
	const trips = await q<CleanupTrip>(sql`
		select t.id::text as id, t.slug, u.email as owner
		  from trips t
		  left join trip_members m on m.trip_id = t.id and m.role = 'owner'
		  left join "user" u on u.id = m.user_id
		 order by t.slug, t.id`);
	const keepTrips = keeper
		? trips.filter((t) => t.owner?.toLowerCase() === keeper.email.toLowerCase())
		: [];
	const keepIds = new Set(keepTrips.map((t) => t.id));
	const deleteTrips = keeper ? trips.filter((t) => !keepIds.has(t.id)) : [];
	if (keeper && !keepTrips.length)
		blockers.push(
			`${keeper.email} owns no trip: refusing to delete every trip`,
		);
	if (!keeper)
		return { keeper: null, keepTrips, deleteTrips, deleteUsers: [], blockers };
	const deleteUsers = (
		await q<{ id: string; email: string; anonymous: boolean | null }>(sql`
			select id, email, is_anonymous as anonymous from "user"
			 where id <> ${keeper.id} order by email`)
	).map((u) => ({ ...u, anonymous: !!u.anonymous }));

	const real = deleteUsers.filter(
		(u) =>
			!u.anonymous && !isTestEmail(u.email) && !also.has(u.email.toLowerCase()),
	);
	if (real.length)
		blockers.push(
			`not test accounts, so not deleted: ${real.map((u) => u.email).join(", ")}`,
		);
	// Nothing in a kept trip may point at an account that goes.
	const checked = deleteUsers.filter((u) => !also.has(u.email.toLowerCase()));
	if (keepTrips.length && checked.length) {
		const keep = sql.param(keepTrips.map((t) => t.id));
		const gone = sql.param(checked.map((u) => u.id));
		for (const [table, cols] of USER_REFS) {
			const where = sql.join(
				cols.map((c) => sql`${sql.identifier(c)} = any(${gone}::text[])`),
				sql` or `,
			);
			const [row] = await q<{ n: number }>(sql`
				select count(*)::int as n from ${sql.identifier(table)}
				 where trip_id = any(${keep}::uuid[]) and (${where})`);
			if (row?.n)
				blockers.push(
					`${row.n} ${table} row(s) in a kept trip point at an account to delete (${cols.join("/")})`,
				);
		}
		const [yjs] = await q<{ n: number }>(sql`
			select count(*)::int as n from yjs_documents
			 where (owner_user_id = any(${gone}::text[]) or updated_by = any(${gone}::text[]))
			   and trip_id = any(${keep}::uuid[])`);
		if (yjs?.n)
			blockers.push(
				`${yjs.n} note document(s) in a kept trip belong to an account to delete`,
			);
	}
	return { keeper, keepTrips, deleteTrips, deleteUsers, blockers };
}

/** Row counts per table (and version/updated_at) for these trips: equal before and after = untouched. */
export async function fingerprintTrips(
	db: Db,
	tripIds: readonly string[],
): Promise<Record<string, string>> {
	const q = query(db);
	const out: Record<string, string> = {};
	const tables = [
		"trip_members",
		"trip_days",
		"nodes",
		"items",
		"legs",
		"list_items",
		"attachments",
		"expenses",
		"expense_shares",
		"settlements",
		"budget_lines",
		"node_priorities",
		"mentions",
		"activity_log",
		"share_links",
		"share_grants",
		"proposals",
		"yjs_documents",
	];
	for (const id of tripIds) {
		const [t] = await q<{ v: string }>(sql`
			select concat_ws('|', slug, version, updated_at::text, deleted_at::text) as v
			  from trips where id = ${id}`);
		const counts: string[] = [];
		for (const table of tables) {
			const [r] = await q<{ n: number }>(sql`
				select count(*)::int as n from ${sql.identifier(table)} where trip_id = ${id}`);
			counts.push(`${table}=${r?.n ?? 0}`);
		}
		const [placeholders] = await q<{ n: number }>(sql`
			select count(*)::int as n from trip_members
			 where trip_id = ${id} and user_id is null`);
		out[id] =
			`${t?.v ?? "(gone)"} ${counts.join(" ")} placeholders=${placeholders?.n ?? 0}`;
	}
	return out;
}

export async function totals(db: Db): Promise<Record<string, number>> {
	const q = query(db);
	const [r] = await q<Record<string, number>>(sql`
		select (select count(*)::int from trips) as trips,
		       (select count(*)::int from "user") as users,
		       (select count(*)::int from "user" where is_anonymous) as anonymous_users,
		       (select count(*)::int from trip_members) as trip_members,
		       (select count(*)::int from attachments) as attachments,
		       (select count(*)::int from expenses) as expenses,
		       (select count(*)::int from session) as sessions`);
	return r ?? {};
}

export type CleanupIo = {
	/** Media objects under a `trips/<id>/…/` prefix (the purge's). */
	deletePrefix?: (prefix: string) => Promise<number>;
	listSubPrefixes?: (prefix: string) => Promise<string[]>;
	log?: (line: string) => void;
};

/** Deletes the plan's trips, then its accounts. Refuses a plan with blockers. */
export async function runCleanup(
	db: Db,
	plan: CleanupPlan,
	io: CleanupIo = {},
): Promise<{ trips: number; users: number; objects: number; retired: number }> {
	if (plan.blockers.length)
		throw new Error(`refusing to delete: ${plan.blockers.join("; ")}`);
	const log = io.log ?? (() => {});
	let objects = 0;
	let trips = 0;
	for (const t of plan.deleteTrips) {
		objects += await purgeTrip(db, t.id, io);
		trips += 1;
		if (trips % 50 === 0)
			log(`trips deleted: ${trips}/${plan.deleteTrips.length}`);
	}
	let users = 0;
	let retired = 0;
	for (const u of plan.deleteUsers) {
		const r = await db.transaction((tx) => deleteUserAccount(tx, u.id));
		retired += r.retired;
		users += 1;
	}
	return { trips, users, objects, retired };
}

export type OrphanIo = {
	/** Sub-prefixes of a prefix (`trips/` → `trips/<id>/`). */
	listSubPrefixes: (prefix: string) => Promise<string[]>;
	/** Deletes everything under a prefix; returns how many objects. */
	deleteAnyPrefix: (prefix: string) => Promise<number>;
	dryRun?: boolean;
	log?: (line: string) => void;
};

/**
 * S3 objects no row points at: `trips/<id>/` of trips that no longer exist
 * (and that no attachment of another trip still re-references: a duplicate
 * keeps its source's objects), and `avatars/<userId>/` of deleted accounts.
 */
export async function sweepOrphans(
	db: Db,
	io: OrphanIo,
): Promise<{ tripPrefixes: number; avatarPrefixes: number; objects: number }> {
	const q = query(db);
	const log = io.log ?? (() => {});
	const out = { tripPrefixes: 0, avatarPrefixes: 0, objects: 0 };
	const idOf = (p: string, root: string) =>
		p.slice(root.length).replace(/\/$/, "");
	for (const p of await io.listSubPrefixes("trips/")) {
		const id = idOf(p, "trips/");
		if (!/^[0-9a-f-]{36}$/.test(id)) continue;
		const [trip] = await q(sql`select 1 from trips where id::text = ${id}`);
		if (trip) continue;
		const [used] = await q(sql`
			select 1 from attachments a
			 where starts_with(a.storage_key, ${p}) or starts_with(a.image_key, ${p})
			    or starts_with(a.favicon_key, ${p}) limit 1`);
		if (used) {
			log(`kept ${p} (another trip still points into it)`);
			continue;
		}
		out.tripPrefixes += 1;
		if (!io.dryRun) out.objects += await io.deleteAnyPrefix(p);
	}
	for (const p of await io.listSubPrefixes("avatars/")) {
		const id = idOf(p, "avatars/");
		if (!id) continue;
		const [user] = await q(sql`select 1 from "user" where id = ${id}`);
		if (user) continue;
		out.avatarPrefixes += 1;
		if (!io.dryRun) out.objects += await io.deleteAnyPrefix(p);
	}
	return out;
}
