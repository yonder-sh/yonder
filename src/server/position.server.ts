/**
 * Fractional-indexing positions (SPEC §6.1 "Ordering"): `position text COLLATE
 * "C"`, rows ordered by `(position, id)` within a scope.
 *
 * `positionsFor(tx, scope, n, { afterId | beforeId })` returns `n` keys that
 * sort right after `afterId`, right before `beforeId`, or at the end. If the
 * neighbours can't be split (equal keys after a restore or a clone, or keys
 * that are not valid fractional-indexing keys), the whole scope is re-keyed in
 * order first, so callers never see an error from the key generator.
 */
import { type SQL, sql } from "drizzle-orm";
import { generateNKeysBetween } from "fractional-indexing";
import type { ListKind } from "@/lib/schemas/enums";
import {
	type AttachmentTarget,
	attachmentTargetColumns,
} from "@/lib/schemas/targets";
import { fail } from "./authz/session.server";
import type { SqlExec } from "./graph.server";

/**
 * A sibling set: items of one day (or Unscheduled), nodes under one parent,
 * attachments on one target, list items of one kind on one target. Every
 * table keeps `position text COLLATE "C"` keys (SPEC §6.1).
 */
export type PositionScope =
	| { table: "items"; tripId: string; dayId: string | null }
	| { table: "nodes"; tripId: string; parentId: string | null }
	| { table: "attachments"; tripId: string; target: AttachmentTarget }
	| {
			table: "list_items";
			tripId: string;
			target: AttachmentTarget;
			list: ListKind;
	  };

/** `node_id = … and leg_id is null and …` for a target (all null = trip root). */
function targetWhere(target: AttachmentTarget, withExpense: boolean): SQL {
	const c = attachmentTargetColumns(target);
	const eqOrNull = (col: string, v: string | null) =>
		v === null ? sql`${sql.raw(col)} is null` : sql`${sql.raw(col)} = ${v}`;
	const parts = [
		eqOrNull("node_id", c.nodeId),
		eqOrNull("leg_id", c.legId),
		eqOrNull("item_id", c.itemId),
		eqOrNull("day_id", c.dayId),
	];
	if (withExpense) parts.push(eqOrNull("expense_id", c.expenseId));
	return sql.join(parts, sql` and `);
}

export type PositionOptions = {
	afterId?: string | null;
	beforeId?: string | null;
	/** Rows being moved: they don't count as neighbours. */
	exclude?: readonly string[];
};

type Sib = { id: string; position: string };

function scopeWhere(scope: PositionScope) {
	switch (scope.table) {
		case "items":
			return scope.dayId
				? sql`trip_id = ${scope.tripId} and day_id = ${scope.dayId} and deleted_at is null`
				: sql`trip_id = ${scope.tripId} and day_id is null and deleted_at is null`;
		case "nodes":
			return scope.parentId
				? sql`trip_id = ${scope.tripId} and parent_id = ${scope.parentId} and deleted_at is null`
				: sql`trip_id = ${scope.tripId} and parent_id is null and deleted_at is null`;
		case "attachments":
			return sql`trip_id = ${scope.tripId} and ${targetWhere(scope.target, true)} and deleted_at is null`;
		case "list_items":
			if (scope.target.kind === "expense")
				fail("VALIDATION", "list items can't hang on an expense");
			return sql`trip_id = ${scope.tripId} and list = ${scope.list} and ${targetWhere(scope.target, false)} and deleted_at is null`;
	}
}

/**
 * A neighbour id that is not a sibling must at least be a row of this trip:
 * an id from another trip is NOT_FOUND (never silently "the end"), so ids
 * can't be used to probe other trips. A same-trip id in another scope (a
 * stale client) still falls back to the end of the scope.
 */
async function assertNeighbourInTrip(
	tx: SqlExec,
	scope: PositionScope,
	id: string | null | undefined,
	sibs: Sib[],
	exclude: readonly string[],
): Promise<void> {
	if (!id || exclude.includes(id) || sibs.some((s) => s.id === id)) return;
	const res = await tx.execute(
		sql`select 1 from ${sql.raw(scope.table)} where id = ${id} and trip_id = ${scope.tripId}`,
	);
	if (res.rows.length === 0) fail("NOT_FOUND", "neighbour");
}

async function siblings(
	tx: SqlExec,
	scope: PositionScope,
	exclude: readonly string[],
): Promise<Sib[]> {
	const table = sql.raw(scope.table);
	const res = await tx.execute(sql`
		select id::text as id, position from ${table}
		 where ${scopeWhere(scope)}
		 order by position collate "C", id`);
	const skip = new Set(exclude);
	return (res.rows as Sib[]).filter((r) => !skip.has(r.id));
}

/** Rewrites the positions of `sibs` to fresh, evenly spread keys in their current order. */
async function rekey(
	tx: SqlExec,
	scope: PositionScope,
	sibs: Sib[],
): Promise<void> {
	if (sibs.length === 0) return;
	const keys = generateNKeysBetween(null, null, sibs.length);
	const table = sql.raw(scope.table);
	for (const [i, s] of sibs.entries()) {
		const key = keys[i] as string;
		s.position = key;
		await tx.execute(
			sql`update ${table} set position = ${key} where id = ${s.id}`,
		);
	}
}

function between(
	sibs: Sib[],
	opts: PositionOptions,
): [string | null, string | null] {
	const idx = (id: string) => sibs.findIndex((s) => s.id === id);
	if (opts.afterId) {
		const i = idx(opts.afterId);
		if (i >= 0)
			return [sibs[i]?.position ?? null, sibs[i + 1]?.position ?? null];
	}
	if (opts.beforeId) {
		const i = idx(opts.beforeId);
		if (i >= 0)
			return [sibs[i - 1]?.position ?? null, sibs[i]?.position ?? null];
	}
	return [sibs.at(-1)?.position ?? null, null];
}

/** `n` ordered keys for new or moved rows in `scope` (see the file comment). */
export async function positionsFor(
	tx: SqlExec,
	scope: PositionScope,
	n: number,
	opts: PositionOptions = {},
): Promise<string[]> {
	if (n <= 0) return [];
	const exclude = opts.exclude ?? [];
	const sibs = await siblings(tx, scope, exclude);
	await assertNeighbourInTrip(tx, scope, opts.afterId, sibs, exclude);
	await assertNeighbourInTrip(tx, scope, opts.beforeId, sibs, exclude);
	const [lo, hi] = between(sibs, opts);
	try {
		return generateNKeysBetween(lo, hi, n);
	} catch {
		await rekey(tx, scope, sibs);
		const [lo2, hi2] = between(sibs, opts);
		return generateNKeysBetween(lo2, hi2, n);
	}
}

/** One key (SPEC §13.1 `keyAfter`). */
export async function positionFor(
	tx: SqlExec,
	scope: PositionScope,
	opts: PositionOptions = {},
): Promise<string> {
	const [key] = await positionsFor(tx, scope, 1, opts);
	return key as string;
}

/** `n` fresh keys for an empty scope (fixture writers). */
export function freshKeys(n: number): string[] {
	return n > 0 ? generateNKeysBetween(null, null, n) : [];
}
