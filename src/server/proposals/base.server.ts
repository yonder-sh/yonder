/**
 * The server-only `base` of a proposal (EXTENSIONS §3.2, §3.4 step 6, §3.5):
 * a snapshot of the existing rows a proposal touches (`updatedAt` + the
 * values of the fields it changes), taken when it is proposed and compared
 * when it is accepted:
 *
 * - a missing or deleted row → `gone` (never forceable);
 * - a field whose value differs from the snapshot → `changed` (forceable).
 *
 * Fields are the def's `fields(input)` names (camelCase columns of the
 * entity's table), plus three derived ones: `assigneeIds` (the assignee
 * table), `priority:<memberId>` (`node_priorities`) and `deleted`/`deletedAt`
 * (the row is live). `position` is snapshotted but never makes a proposal
 * "equal to its base" on its own (a move back to the same day gets a new key).
 */
import { sql } from "drizzle-orm";
import type { ProposalBase } from "@/db/schema/proposals";
import type { EntityKind, Json } from "@/lib/schemas/proposals";
import type { SqlExec } from "@/server/graph.server";

export type BaseRef = ProposalBase["refs"][number];

type EntityTable = {
	table: string;
	/** Soft-deleted rows count as gone. */
	softDelete: boolean;
	/** The assignee table and its FK column, when the entity has assignees. */
	assignees?: { table: string; column: string };
};

/** Where each entity kind lives (`trip` = the trips row, id = the trip id). */
export const ENTITY_TABLES: Partial<Record<EntityKind, EntityTable>> = {
	node: { table: "nodes", softDelete: true },
	item: {
		table: "items",
		softDelete: true,
		assignees: { table: "item_assignees", column: "item_id" },
	},
	leg: {
		table: "legs",
		softDelete: false,
		assignees: { table: "leg_assignees", column: "leg_id" },
	},
	day: { table: "trip_days", softDelete: false },
	list: {
		table: "list_items",
		softDelete: true,
		assignees: { table: "list_item_assignees", column: "list_item_id" },
	},
	att: { table: "attachments", softDelete: true },
	trip: { table: "trips", softDelete: true },
};

/** `dayId` → `day_id`. */
export function snakeCase(field: string): string {
	return field.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
}

/** Deterministic JSON (sorted object keys) for field comparisons. */
export function stableJson(v: unknown): string {
	if (v === undefined) return "null";
	if (v === null || typeof v !== "object") return JSON.stringify(v);
	if (Array.isArray(v)) return `[${v.map(stableJson).join(",")}]`;
	const o = v as Record<string, unknown>;
	return `{${Object.keys(o)
		.filter((k) => o[k] !== undefined)
		.sort()
		.map((k) => `${JSON.stringify(k)}:${stableJson(o[k])}`)
		.join(",")}}`;
}

/** Timestamps from `to_jsonb` keep microseconds; compare them as instants. */
function normalise(field: string, v: unknown): Json {
	if (v === undefined) return null;
	if (
		typeof v === "string" &&
		/(_at|At)$/.test(field) &&
		!Number.isNaN(Date.parse(v))
	)
		return new Date(v).toISOString();
	return v as Json;
}

/**
 * The row's current snapshot for `fields`, or null when the row is missing or
 * deleted (or belongs to another trip).
 */
export async function snapshotRef(
	exec: SqlExec,
	tripId: string,
	kind: EntityKind,
	id: string | null,
	fields: readonly string[],
): Promise<BaseRef | null> {
	const t = ENTITY_TABLES[kind];
	if (!t) return null;
	const rowId = kind === "trip" ? tripId : id;
	if (!rowId) return null;
	const tripCol = kind === "trip" ? sql`id` : sql`trip_id`;
	const res = await exec.execute(sql`
		select to_jsonb(t) as row, t.updated_at::text as "updatedAt"
		  from ${sql.raw(t.table)} t
		 where t.id = ${rowId} and t.${tripCol} = ${tripId}
		   ${t.softDelete ? sql`and t.deleted_at is null` : sql``}`);
	const hit = res.rows[0] as
		| { row: Record<string, unknown>; updatedAt: string | null }
		| undefined;
	if (!hit) return null;
	const out: Record<string, Json> = {};
	for (const f of fields) {
		if (f === "deleted") out[f] = false;
		else if (f === "deletedAt") out[f] = null;
		else if (f === "assigneeIds" && t.assignees) {
			const a = await exec.execute(sql`
				select coalesce(array_agg(member_id::text order by member_id), '{}') as ids
				  from ${sql.raw(t.assignees.table)} where ${sql.raw(t.assignees.column)} = ${rowId}`);
			out[f] = ((a.rows[0] as { ids: string[] } | undefined)?.ids ??
				[]) as Json;
		} else if (f.startsWith("priority:") && kind === "node") {
			const memberId = f.slice("priority:".length);
			const p = await exec.execute(sql`
				select priority::text as priority, rating_comment as comment
				  from node_priorities where node_id = ${rowId} and member_id::text = ${memberId}`);
			const r = p.rows[0] as
				| { priority: string; comment: string | null }
				| undefined;
			out[f] = r ? { priority: r.priority, comment: r.comment } : null;
		} else out[f] = normalise(f, hit.row[snakeCase(f)]);
	}
	return { kind, id: rowId, updatedAt: hit.updatedAt, fields: out };
}

/** Fields whose current value differs from the snapshot. */
export function changedFields(
	base: BaseRef,
	current: BaseRef,
	opts: { ignorePosition?: boolean } = {},
): string[] {
	return Object.keys(base.fields).filter(
		(f) =>
			!(opts.ignorePosition && f === "position") &&
			stableJson(base.fields[f]) !== stableJson(current.fields[f]),
	);
}

/**
 * The leg row of a `{ target }` payload, when it exists (`leg.set` and the
 * transit ops name a pair or stay, not a leg id).
 */
export async function legIdOfTarget(
	exec: SqlExec,
	tripId: string,
	target: unknown,
): Promise<string | null> {
	if (!target || typeof target !== "object") return null;
	const t = target as Record<string, unknown>;
	const res =
		t.kind === "pair" &&
		typeof t.fromItemId === "string" &&
		typeof t.toItemId === "string"
			? await exec.execute(sql`
				select id::text as id from legs
				 where trip_id = ${tripId} and kind = 'pair'
				   and from_item_id = ${t.fromItemId} and to_item_id = ${t.toItemId}`)
			: t.kind === "stay" &&
					typeof t.dayId === "string" &&
					(t.end === "start" || t.end === "end")
				? await exec.execute(sql`
				select id::text as id from legs
				 where trip_id = ${tripId} and stay_day_id = ${t.dayId}
				   and kind = ${t.end === "start" ? "stay_start" : "stay_end"}`)
				: null;
	return (res?.rows[0] as { id: string } | undefined)?.id ?? null;
}

/** A short name for an entity ("Itoya", "Day 4", "the trip"), for summaries. */
export async function entityLabel(
	exec: SqlExec,
	tripId: string,
	kind: EntityKind,
	id: string | null,
): Promise<string> {
	if (kind === "trip") return "the trip";
	if (!id) return kind === "leg" ? "a leg" : "the plan";
	const q =
		kind === "node"
			? sql`select name as label from nodes where id = ${id} and trip_id = ${tripId}`
			: kind === "item"
				? sql`select coalesce(i.title, n.name) as label from items i
				        left join nodes n on n.id = i.node_id where i.id = ${id} and i.trip_id = ${tripId}`
				: kind === "day"
					? sql`select 'Day ' || (select count(*) from trip_days d2
					          where d2.trip_id = d.trip_id and d2.date <= d.date)::text as label
					        from trip_days d where d.id = ${id} and d.trip_id = ${tripId}`
					: kind === "list"
						? sql`select text as label from list_items
						       where id = ${id} and trip_id = ${tripId} and not is_private`
						: kind === "att"
							? sql`select coalesce(title, 'an attachment') as label from attachments where id = ${id} and trip_id = ${tripId}`
							: null;
	if (!q) return kind === "note" ? "a note" : "a leg";
	const r = (await exec.execute(q)).rows[0] as
		| { label: string | null }
		| undefined;
	const label = r?.label?.trim();
	if (label) return label.length > 60 ? `${label.slice(0, 59)}…` : label;
	return kind === "node"
		? "a place"
		: kind === "item"
			? "an item"
			: kind === "list"
				? "a to-do"
				: kind === "day"
					? "a day"
					: "an attachment";
}
