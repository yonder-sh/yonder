/**
 * Row-level authorization helpers (SPEC §11.3). Each loads the row's `tripId`
 * (live rows only, unless asked), checks the caller's role on that trip with
 * `requireTripRole`, and returns `{ tripId, access }`. A missing row and no
 * access both answer 404, so ids never reveal whether something exists.
 *
 * Inside the mutation's transaction, re-read the row itself (`for update` where
 * order matters): these helpers only authorize.
 */
import { sql } from "drizzle-orm";
import { db } from "@/db/db.server";
import type { TripAccess, TripRole } from "@/lib/auth/roles";
import type {
	AttachmentTarget,
	BundleTarget,
	LegTarget,
} from "@/lib/schemas/targets";
import type { AuthUser } from "./auth.server";
import { requireTripRole } from "./authz/access.server";
import { fail } from "./authz/session.server";
import type { SqlExec } from "./graph.server";

export type Authorized = {
	tripId: string;
	access: TripAccess & { user: AuthUser };
};

type Table =
	| "nodes"
	| "items"
	| "legs"
	| "trip_days"
	| "trip_members"
	| "attachments"
	| "list_items"
	| "expenses";

const SOFT_DELETE: ReadonlySet<Table> = new Set([
	"nodes",
	"items",
	"attachments",
	"list_items",
	"expenses",
]);

/** The trip of a row, or null. Soft-deleted rows count only with `includeDeleted`. */
export async function tripOf(
	table: Table,
	id: string,
	opts: { includeDeleted?: boolean; exec?: SqlExec } = {},
): Promise<string | null> {
	const live =
		SOFT_DELETE.has(table) && !opts.includeDeleted
			? sql` and deleted_at is null`
			: sql``;
	const res = await (opts.exec ?? db).execute(
		sql`select trip_id::text as "tripId" from ${sql.raw(table)} where id = ${id}${live}`,
	);
	const row = res.rows[0] as { tripId: string } | undefined;
	return row?.tripId ?? null;
}

async function requireRow(
	table: Table,
	id: string,
	min: TripRole,
	user: AuthUser,
	opts: { includeDeleted?: boolean } = {},
): Promise<Authorized> {
	const tripId = await tripOf(table, id, opts);
	if (!tripId) return fail("NOT_FOUND");
	const access = await requireTripRole(tripId, min, user);
	return { tripId, access };
}

export const requireNode = (
	id: string,
	min: TripRole,
	user: AuthUser,
	opts?: { includeDeleted?: boolean },
) => requireRow("nodes", id, min, user, opts);

export const requireItem = (
	id: string,
	min: TripRole,
	user: AuthUser,
	opts?: { includeDeleted?: boolean },
) => requireRow("items", id, min, user, opts);

export const requireLeg = (id: string, min: TripRole, user: AuthUser) =>
	requireRow("legs", id, min, user);

export const requireDay = (id: string, min: TripRole, user: AuthUser) =>
	requireRow("trip_days", id, min, user);

export const requireMember = (id: string, min: TripRole, user: AuthUser) =>
	requireRow("trip_members", id, min, user);

export const requireAttachment = (
	id: string,
	min: TripRole,
	user: AuthUser,
	opts?: { includeDeleted?: boolean },
) => requireRow("attachments", id, min, user, opts);

export const requireListItem = (
	id: string,
	min: TripRole,
	user: AuthUser,
	opts?: { includeDeleted?: boolean },
) => requireRow("list_items", id, min, user, opts);

/**
 * A leg target: both items of a pair (live, same trip, different) or the day
 * of a stay leg.
 */
export async function requireLegTarget(
	target: LegTarget,
	min: TripRole,
	user: AuthUser,
): Promise<Authorized> {
	if (target.kind === "stay") return requireDay(target.dayId, min, user);
	if (target.fromItemId === target.toItemId)
		return fail("VALIDATION", "a leg joins two different items");
	const a = await tripOf("items", target.fromItemId);
	const b = await tripOf("items", target.toItemId);
	if (!a || !b || a !== b) return fail("NOT_FOUND");
	const access = await requireTripRole(a, min, user);
	return { tripId: a, access };
}

/**
 * Checks that a bundle target names a live row of `tripId` (the composite FKs
 * are the backstop). Call it inside the transaction with `tx`.
 */
export async function assertBundleTarget(
	exec: SqlExec,
	tripId: string,
	target: BundleTarget | AttachmentTarget,
): Promise<void> {
	if (target.kind === "trip") return;
	const [table, id] =
		target.kind === "node"
			? (["nodes", target.nodeId] as const)
			: target.kind === "leg"
				? (["legs", target.legId] as const)
				: target.kind === "item"
					? (["items", target.itemId] as const)
					: target.kind === "expense"
						? (["expenses", target.expenseId] as const)
						: (["trip_days", target.dayId] as const);
	const found = await tripOf(table, id, { exec });
	if (found !== tripId) fail("NOT_FOUND", `${target.kind}`);
	if (target.kind === "expense" && target.paymentId) {
		// A payment of THIS expense (the composite FK is the backstop).
		const res = await exec.execute(sql`
			select 1 from expense_payments
			 where id = ${target.paymentId} and expense_id = ${target.expenseId} and trip_id = ${tripId}`);
		if (!res.rows.length) fail("NOT_FOUND", "payment");
	}
}

/**
 * Keeps only ids that are members of the trip (active, invited or
 * placeholder; never guests, never removed members). Order kept, duplicates
 * dropped.
 */
export async function tripMemberIds(
	exec: SqlExec,
	tripId: string,
	memberIds: readonly string[],
): Promise<string[]> {
	if (memberIds.length === 0) return [];
	const res = await exec.execute(sql`
		select id::text as id from trip_members
		 where trip_id = ${tripId} and status::text <> 'removed'
		   and id = any(${sql.param([...new Set(memberIds)])}::uuid[])`);
	const ok = new Set((res.rows as { id: string }[]).map((r) => r.id));
	return [...new Set(memberIds)].filter((m) => ok.has(m));
}
