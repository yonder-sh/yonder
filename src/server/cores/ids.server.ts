/**
 * Client- or gate-chosen ids (EXTENSIONS §2.2): proposable creates accept
 * `id?` / `ids?` so a proposal can pin the ids of what it will create (and
 * later proposals can reference them). An id that already exists anywhere —
 * in any trip, live or deleted — is a CONFLICT, never an overwrite.
 */
import { sql } from "drizzle-orm";
import { fail } from "@/server/authz/session.server";
import type { SqlExec } from "@/server/graph.server";

export type IdTable =
	| "nodes"
	| "items"
	| "trip_days"
	| "legs"
	| "list_items"
	| "attachments"
	| "expenses";

export async function assertFreshIds(
	exec: SqlExec,
	table: IdTable,
	ids: readonly string[],
): Promise<void> {
	if (ids.length === 0) return;
	if (new Set(ids).size !== ids.length) fail("CONFLICT", "duplicate ids");
	const res = await exec.execute(
		sql`select 1 from ${sql.raw(table)} where id = any(${sql.param([...ids])}::uuid[]) limit 1`,
	);
	if (res.rows.length) fail("CONFLICT", "that id is already taken");
}
