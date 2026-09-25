/**
 * The propose path of the gate (EXTENSIONS §3.4 steps 0 and 2–6), F-ext1.
 * `proposable.run(op)` calls `proposeChange` inside its `withTripTx` when the
 * caller may propose but not apply (a suggester, an editor in suggest mode, a
 * `directIf` that didn't hold, or an edit of the caller's own ghost):
 *
 * 2. **Payload:** the input minus `proposal`, `expectedVersion` and
 *    `expectedUpdatedAt`; a guest's goes through `def.redact`.
 * 3. **Ids:** `id ??= uuidv7()` / `ids ??= […]` pinned into the payload.
 * 4. **Amend:** the author's open proposal with the same op on the same
 *    entity, or an edit of one of their own `createdIds`, changes that
 *    proposal instead of adding one; moving/renaming back withdraws it, and
 *    deleting your own proposed create withdraws it and its dependants.
 * 5. **Requires:** uuids in the payload that open proposals will create.
 * 6. **Dry run + insert:** in a SAVEPOINT, the `requires` chain's cores and
 *    then this core run for real (access raised to editor, actor = the
 *    author, `dryRun: true`, a scratch outbox), the activity they write gives
 *    the summary, and everything rolls back. A core's AppError reaches the
 *    caller unchanged, so suggesters get the editors' validation.
 */
import { and, eq, sql } from "drizzle-orm";
import { v7 as uuidv7 } from "uuid";
import type { Tx } from "@/db/db.server";
import { type ProposalBase, proposals } from "@/db/schema/proposals";
import type { TripAccess } from "@/lib/auth/roles";
import type {
	EntityKind,
	Json,
	ProposalFlag,
	ProposalOp,
	Proposed,
} from "@/lib/schemas/proposals";
import { logActivity } from "@/server/activity.server";
import type { AuthUser } from "@/server/auth.server";
import { fail } from "@/server/authz/session.server";
import type { SqlExec } from "@/server/graph.server";
import { TxOutbox } from "@/server/live/outbox.server";
import {
	type BaseRef,
	changedFields,
	entityLabel,
	legIdOfTarget,
	snapshotRef,
} from "./base.server";
import { REGISTRY } from "./registry.server";
import { actorOf, type ProposableDef } from "./types";
import { closeDependants } from "./withdraw.server";

// biome-ignore lint/suspicious/noExplicitAny: one code path for every op's def.
export type AnyDef = ProposableDef<any, any>;

/** EXTENSIONS §3.2 limits. */
export const MAX_OPEN_PER_TRIP = 300;
export const MAX_NEW_PER_AUTHOR_PER_HOUR = 60;
const LIMIT_MESSAGE = "Too many open suggestions — ask an editor to review.";
/** `proposals_payload_size_ck` is 32 KB of jsonb; refuse well before it. */
const MAX_PAYLOAD_CHARS = 30_000;

export async function loadDef(op: ProposalOp): Promise<AnyDef> {
	const entry = REGISTRY[op] as { load: () => Promise<AnyDef> } | undefined;
	if (!entry) return fail("VALIDATION", `unknown op ${op}`);
	return entry.load();
}

/** A proposal row as the server works with it (never sent as is: `base` is server-only). */
export type ProposalRow = {
	id: string;
	tripId: string;
	op: ProposalOp;
	payload: Record<string, Json>;
	base: ProposalBase;
	entityKind: EntityKind;
	entityId: string | null;
	createdIds: string[];
	requires: string[];
	summary: string;
	message: string | null;
	status: "open" | "accepted" | "rejected" | "withdrawn";
	authorUserId: string | null;
	authorMemberId: string | null;
	authorName: string;
	authorColor: number;
	authorIsGuest: boolean;
	reviewedBy: string | null;
	reviewedAt: string | null;
	reviewNote: string | null;
	lastError: Json | null;
	createdAt: string;
	updatedAt: string;
};

/** The select list for `ProposalRow` (alias `p`). */
export const PROPOSAL_COLUMNS = sql`
	p.id::text as id, p.trip_id::text as "tripId", p.op, p.payload, p.base,
	p.entity_kind as "entityKind", p.entity_id::text as "entityId",
	p.created_ids::text[] as "createdIds", p.requires::text[] as requires,
	p.summary, p.message, p.status::text as status,
	p.author_user_id as "authorUserId", p.author_member_id::text as "authorMemberId",
	p.author_name as "authorName", p.author_color as "authorColor",
	p.author_is_guest as "authorIsGuest", p.reviewed_by as "reviewedBy",
	p.reviewed_at as "reviewedAt", p.review_note as "reviewNote",
	p.last_error as "lastError", p.created_at as "createdAt", p.updated_at as "updatedAt"`;

const isoOf = (v: unknown): string => new Date(v as string).toISOString();

export function toProposalRow(r: Record<string, unknown>): ProposalRow {
	return {
		id: String(r.id),
		tripId: String(r.tripId),
		op: r.op as ProposalOp,
		payload: (r.payload ?? {}) as Record<string, Json>,
		base: (r.base ?? { tripVersion: 0, refs: [] }) as ProposalBase,
		entityKind: r.entityKind as EntityKind,
		entityId: (r.entityId as string | null) ?? null,
		createdIds: (r.createdIds as string[] | null) ?? [],
		requires: (r.requires as string[] | null) ?? [],
		summary: String(r.summary),
		message: (r.message as string | null) ?? null,
		status: r.status as ProposalRow["status"],
		authorUserId: (r.authorUserId as string | null) ?? null,
		authorMemberId: (r.authorMemberId as string | null) ?? null,
		authorName: String(r.authorName),
		authorColor: Number(r.authorColor),
		authorIsGuest: Boolean(r.authorIsGuest),
		reviewedBy: (r.reviewedBy as string | null) ?? null,
		reviewedAt: r.reviewedAt ? isoOf(r.reviewedAt) : null,
		reviewNote: (r.reviewNote as string | null) ?? null,
		lastError: (r.lastError as Json | null) ?? null,
		createdAt: isoOf(r.createdAt),
		updatedAt: isoOf(r.updatedAt),
	};
}

export async function loadProposal(
	exec: SqlExec,
	id: string,
	opts: { forUpdate?: boolean } = {},
): Promise<ProposalRow | null> {
	const res = await exec.execute(sql`
		select ${PROPOSAL_COLUMNS} from proposals p where p.id = ${id}
		${opts.forUpdate ? sql`for update` : sql``}`);
	const r = res.rows[0] as Record<string, unknown> | undefined;
	return r ? toProposalRow(r) : null;
}

const UUID_RE =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Every uuid string anywhere in a JSON value. */
export function uuidsIn(v: unknown, out = new Set<string>()): Set<string> {
	if (typeof v === "string") {
		if (UUID_RE.test(v)) out.add(v.toLowerCase());
	} else if (Array.isArray(v)) for (const x of v) uuidsIn(x, out);
	else if (v && typeof v === "object")
		for (const x of Object.values(v)) uuidsIn(x, out);
	return out;
}

/** Open proposals that will create one of `ids` (GIN on `created_ids`). */
export async function openGhosts(
	exec: SqlExec,
	ids: readonly string[],
	tripId?: string,
): Promise<ProposalRow[]> {
	if (!ids.length) return [];
	const res = await exec.execute(sql`
		select ${PROPOSAL_COLUMNS} from proposals p
		 where p.status = 'open' and p.created_ids && ${sql.param([...ids])}::uuid[]
		   ${tripId ? sql`and p.trip_id = ${tripId}` : sql``}
		 order by p.created_at, p.id`);
	return (res.rows as Record<string, unknown>[]).map(toProposalRow);
}

/**
 * The open proposals `direct` needs, deps first (topological), `direct`
 * included. Closed or missing requirements are skipped (an accepted one's
 * rows exist; a rejected one closed its dependants already).
 */
export async function requiresChain(
	exec: SqlExec,
	tripId: string,
	direct: readonly ProposalRow[],
): Promise<ProposalRow[]> {
	const byId = new Map<string, ProposalRow>();
	for (const p of direct) byId.set(p.id, p);
	let frontier = direct.flatMap((p) => p.requires);
	for (let depth = 0; frontier.length && depth < 20; depth++) {
		const missing = [...new Set(frontier)].filter((id) => !byId.has(id));
		if (!missing.length) break;
		const res = await exec.execute(sql`
			select ${PROPOSAL_COLUMNS} from proposals p
			 where p.trip_id = ${tripId} and p.status = 'open'
			   and p.id = any(${sql.param(missing)}::uuid[])`);
		const rows = (res.rows as Record<string, unknown>[]).map(toProposalRow);
		for (const r of rows) byId.set(r.id, r);
		frontier = rows.flatMap((r) => r.requires);
	}
	const out: ProposalRow[] = [];
	const seen = new Set<string>();
	const visit = (p: ProposalRow, stack: Set<string>) => {
		if (seen.has(p.id) || stack.has(p.id)) return;
		stack.add(p.id);
		for (const r of p.requires) {
			const dep = byId.get(r);
			if (dep) visit(dep, stack);
		}
		stack.delete(p.id);
		seen.add(p.id);
		out.push(p);
	};
	for (const p of [...byId.values()].sort((a, b) =>
		a.createdAt === b.createdAt
			? a.id.localeCompare(b.id)
			: a.createdAt.localeCompare(b.createdAt),
	))
		visit(p, new Set());
	return out;
}

/** The def's `fields(input)`, else the keys of `input.patch`. */
export function fieldsOf(def: AnyDef, payload: Record<string, unknown>) {
	if (def.fields) return def.fields(payload) as string[];
	const patch = payload.patch;
	return patch && typeof patch === "object" ? Object.keys(patch) : [];
}

/** The def's entity; a leg named by `{ target }` resolves to its row when there is one. */
export async function entityOfPayload(
	exec: SqlExec,
	tripId: string,
	def: AnyDef,
	payload: Record<string, unknown>,
): Promise<{ kind: EntityKind; id: string | null }> {
	const e = def.entityOf(payload) as { kind: EntityKind; id: string | null };
	if (e.kind === "leg" && !e.id && payload.target)
		return {
			kind: "leg",
			id: await legIdOfTarget(exec, tripId, payload.target),
		};
	return e;
}

/** How many `ids` a multi-row create needs (EXTENSIONS §2.2 documented orders). */
function idsNeeded(op: ProposalOp, payload: Record<string, unknown>): number {
	if (op === "node.createPath") {
		const chain = Array.isArray(payload.chain) ? payload.chain : [];
		return chain.filter(
			(c) =>
				c && typeof c === "object" && !("id" in (c as Record<string, unknown>)),
		).length;
	}
	if (op === "day.insert") return 1;
	if (op === "flight.create") return 3;
	return 0;
}

/** Step 3: pins `id` / `ids` into the payload; returns the ids it creates. */
export function pinIds(
	op: ProposalOp,
	def: AnyDef,
	payload: Record<string, Json>,
): { payload: Record<string, Json>; createdIds: string[] } {
	const shape = (def.input as { shape?: Record<string, unknown> }).shape ?? {};
	// A create declares its chosen id OPTIONAL (`id: z.uuid().optional()`); an
	// edit keys the EXISTING row with a required `id` (`updateListItem { id }`,
	// `deleteAttachment { id }`), which must never be claimed as a new id.
	const creates = (key: "id" | "ids"): boolean => {
		const field = shape[key] as
			| { safeParse?: (v: unknown) => { success: boolean } }
			| undefined;
		return !!field?.safeParse && field.safeParse(undefined).success;
	};
	const createsId = creates("id");
	const createsIds = creates("ids");
	const out: Record<string, Json> = { ...payload };
	if (createsId && out.id === undefined) out.id = uuidv7();
	if (createsIds && out.ids === undefined) {
		const n = idsNeeded(op, out);
		if (n > 0) out.ids = Array.from({ length: n }, () => uuidv7());
	}
	const createdIds: string[] = [];
	if (createsId && typeof out.id === "string") createdIds.push(out.id);
	if (createsIds && Array.isArray(out.ids)) {
		// Only the ids the op really uses (unused ones are ignored by the core).
		const n = idsNeeded(op, out);
		const used = n > 0 ? out.ids.slice(0, n) : out.ids;
		for (const x of used) if (typeof x === "string") createdIds.push(x);
	}
	return { payload: out, createdIds };
}

/** Step 2: the stored payload never carries concurrency or mode fields. */
export function stripPayload(
	input: Record<string, unknown>,
): Record<string, Json> {
	const {
		proposal: _p,
		expectedVersion: _v,
		expectedUpdatedAt: _u,
		...rest
	} = input;
	// JSON round trip: payloads are JSON by construction (validator output).
	return JSON.parse(JSON.stringify(rest)) as Record<string, Json>;
}

/** Private list items never become proposals (ADDENDUM §7.2). */
async function assertNotPrivate(
	exec: SqlExec,
	tripId: string,
	op: ProposalOp,
	payload: Record<string, Json>,
	entity: { kind: EntityKind; id: string | null },
): Promise<void> {
	if (!op.startsWith("list.")) return;
	const patch = payload.patch as Record<string, Json> | undefined;
	if (payload.isPrivate === true || patch?.isPrivate === true)
		fail("FORBIDDEN", "Private items can't be suggested.");
	if (entity.kind === "list" && entity.id) {
		const res = await exec.execute(sql`
			select 1 from list_items where id = ${entity.id} and trip_id = ${tripId} and is_private`);
		// Someone else's private row: it doesn't exist for the caller.
		if (res.rows.length) fail("NOT_FOUND");
	}
}

/** Tables whose ids a proposal may pin (`id` / `ids`, EXTENSIONS §2.2). */
const ID_TABLES = [
	"nodes",
	"items",
	"trip_days",
	"legs",
	"list_items",
	"attachments",
	"expenses",
] as const;

/** CONFLICT when an id already exists (any trip, live or deleted) or is another open proposal's. */
async function assertUnclaimed(
	exec: SqlExec,
	ids: readonly string[],
): Promise<void> {
	if (!ids.length) return;
	if (new Set(ids).size !== ids.length) fail("CONFLICT", "duplicate ids");
	const param = sql.param([...ids]);
	const taken = await exec.execute(sql`
		select 1 from (${sql.join(
			ID_TABLES.map(
				(t) =>
					sql`select id from ${sql.raw(t)} where id = any(${param}::uuid[])`,
			),
			sql` union all `,
		)}) x limit 1`);
	if (taken.rows.length) fail("CONFLICT", "that id is already taken");
	if ((await openGhosts(exec, ids)).length)
		fail("CONFLICT", "that id is already taken");
}

class DryRunDone extends Error {
	constructor() {
		super("dry run done");
	}
}

async function activityRows(
	exec: SqlExec,
	tripId: string,
	version: number | null,
): Promise<{ id: string; summary: string }[]> {
	if (version === null) return [];
	const res = await exec.execute(sql`
		select id::text as id, summary from activity_log
		 where trip_id = ${tripId} and version = ${version}
		 order by created_at, id`);
	return res.rows as { id: string; summary: string }[];
}

export type DryRunResult = {
	/** The first activity summary this core wrote (null: it logs nothing). */
	summary: string | null;
	/** The entity after the core ran (inside the savepoint), for "moved back". */
	after: BaseRef | null;
};

/**
 * Runs `chain` then `main` in a SAVEPOINT and rolls everything back (step 6).
 * Side effects go to a scratch outbox that is dropped.
 */
export async function dryRun(
	tx: Tx,
	out: TxOutbox,
	a: {
		tripId: string;
		access: TripAccess;
		user: AuthUser;
		chain: readonly ProposalRow[];
		def: AnyDef;
		payload: Record<string, Json>;
		inputRedacted: boolean;
		entity: { kind: EntityKind; id: string | null };
		fields: readonly string[];
	},
): Promise<DryRunResult> {
	let result: DryRunResult | null = null;
	const done = new DryRunDone();
	const access: TripAccess = { ...a.access, role: "editor" };
	try {
		await tx.transaction(async (sp) => {
			const scratch = new TxOutbox(a.tripId);
			scratch.version = out.version;
			const ctx = {
				access,
				user: a.user,
				actor: actorOf(a.user),
				dryRun: true,
			};
			for (const c of a.chain) {
				const cdef = await loadDef(c.op);
				const parsed = cdef.input.safeParse(c.payload);
				await cdef.core(sp, scratch, parsed.success ? parsed.data : c.payload, {
					...ctx,
					inputRedacted: c.authorIsGuest && !!cdef.redact,
				});
			}
			const before = new Set(
				(await activityRows(sp, a.tripId, out.version)).map((r) => r.id),
			);
			await a.def.core(sp, scratch, a.payload, {
				...ctx,
				inputRedacted: a.inputRedacted,
			});
			const rows = (await activityRows(sp, a.tripId, out.version)).filter(
				(r) => !before.has(r.id),
			);
			result = {
				summary: rows[0]?.summary ?? null,
				after: a.entity.id
					? await snapshotRef(
							sp,
							a.tripId,
							a.entity.kind,
							a.entity.id,
							a.fields,
						)
					: null,
			};
			throw done;
		});
	} catch (e) {
		if (e !== done) throw e;
	}
	if (!result) throw new Error("dry run produced no result");
	return result;
}

/** The base (step 6): the entity's row when it exists today. */
async function baseOf(
	exec: SqlExec,
	tripId: string,
	entity: { kind: EntityKind; id: string | null },
	fields: readonly string[],
	version: number | null,
): Promise<ProposalBase> {
	const ref =
		entity.kind === "trip" || entity.id
			? await snapshotRef(exec, tripId, entity.kind, entity.id, fields)
			: null;
	return { tripVersion: (version ?? 1) - 1, refs: ref ? [ref] : [] };
}

/** The first name ("Maya") of a snapshot name ("Maya Chen"). */
export function firstName(name: string): string {
	return name.trim().split(/\s+/)[0] || "Someone";
}

function entityCols(entity: { kind: EntityKind; id: string | null }) {
	return {
		nodeId: entity.kind === "node" ? entity.id : null,
		itemId: entity.kind === "item" ? entity.id : null,
		legId: entity.kind === "leg" ? entity.id : null,
		dayId: entity.kind === "day" ? entity.id : null,
	};
}

/** Withdraws one proposal and its dependants (amend back to base, own-create delete). */
async function withdrawOwn(
	tx: Tx,
	out: TxOutbox,
	p: ProposalRow,
	note: string,
): Promise<Proposed> {
	await tx.execute(sql`
		update proposals set status = 'withdrawn', review_note = ${note}, updated_at = now()
		 where id = ${p.id} and status = 'open'`);
	await closeDependants(tx, p.tripId, [p.id], "withdrawn");
	out.emit({ keys: ["proposals"] });
	return { proposed: { id: p.id, summary: `withdrew: ${p.summary}` } };
}

/** Merges an edit into the author's own open proposal on the same entity (step 4a). */
function mergePayload(
	prev: Record<string, Json>,
	next: Record<string, Json>,
): Record<string, Json> {
	const a = prev.patch;
	const b = next.patch;
	if (
		a &&
		b &&
		typeof a === "object" &&
		typeof b === "object" &&
		!Array.isArray(a) &&
		!Array.isArray(b)
	)
		return { ...prev, ...next, patch: { ...a, ...b } };
	return next;
}

export type ProposeArgs = {
	op: ProposalOp;
	def: AnyDef;
	input: Record<string, unknown>;
	flag: ProposalFlag | undefined;
	access: TripAccess;
	user: AuthUser;
	tripId: string;
};

/** Steps 2–6 inside the gate's `withTripTx`. */
export async function proposeChange(
	tx: Tx,
	out: TxOutbox,
	a: ProposeArgs,
): Promise<Proposed> {
	const { op, def, access, user, tripId } = a;
	const inputRedacted = access.isGuest && !!def.redact;
	// 2. Payload (guest strip) and 3. ids.
	let stripped = stripPayload(a.input);
	if (inputRedacted)
		stripped = JSON.parse(
			JSON.stringify(def.redact?.(stripped) ?? stripped),
		) as Record<string, Json>;
	const pinned = pinIds(op, def, stripped);
	let payload = pinned.payload;
	const createdIds = pinned.createdIds;
	if (JSON.stringify(payload).length > MAX_PAYLOAD_CHARS)
		fail("VALIDATION", "That suggestion is too large.");
	const entity = await entityOfPayload(tx, tripId, def, payload);
	const fields = fieldsOf(def, payload);
	await assertNotPrivate(tx, tripId, op, payload, entity);

	// Ghosts this payload references (re-read under the trip lock).
	const referenced = [...uuidsIn(payload)].filter(
		(id) => !createdIds.includes(id),
	);
	const ghosts = await openGhosts(tx, referenced, tripId);
	const other = ghosts.find((g) => g.authorUserId !== user.id);
	if (other)
		fail(
			"CONFLICT",
			`Suggested by ${firstName(other.authorName)} — review it first.`,
		);

	// 4. Amend: an edit of my own proposed create…
	const ownCreate = entity.id
		? ghosts.find((g) => g.createdIds.includes(entity.id as string))
		: undefined;
	if (ownCreate) {
		if (op.endsWith(".delete"))
			return withdrawOwn(tx, out, ownCreate, "deleted by its author");
		if (def.amend) {
			const createDef = await loadDef(ownCreate.op);
			const merged = createDef.input.safeParse(
				def.amend.merge(ownCreate.payload, payload),
			);
			if (merged.success) {
				const mergedPayload = JSON.parse(JSON.stringify(merged.data)) as Record<
					string,
					Json
				>;
				const chain = (await requiresChain(tx, tripId, [ownCreate])).filter(
					(p) => p.id !== ownCreate.id,
				);
				const createEntity = {
					kind: ownCreate.entityKind,
					id: ownCreate.entityId,
				};
				const dry = await dryRun(tx, out, {
					tripId,
					access,
					user,
					chain,
					def: createDef,
					payload: mergedPayload,
					inputRedacted: ownCreate.authorIsGuest && !!createDef.redact,
					entity: createEntity,
					fields: [],
				});
				const summary = dry.summary ?? ownCreate.summary;
				await tx
					.update(proposals)
					.set({
						payload: mergedPayload,
						summary,
						lastError: null,
						updatedAt: new Date(),
						...(a.flag?.message ? { message: a.flag.message } : {}),
					})
					.where(
						and(eq(proposals.id, ownCreate.id), eq(proposals.status, "open")),
					);
				out.emit({ keys: ["proposals"] });
				return { proposed: { id: ownCreate.id, summary } };
			}
		}
		// No amend for this edit: it becomes a new proposal that requires the create.
	}

	// …or the same op on the same existing entity. Never for propose-only ops
	// (`note.append`): two additions to one note stay two suggestions.
	if (entity.id && !ownCreate && !def.proposeOnly) {
		const res = await tx.execute(sql`
			select ${PROPOSAL_COLUMNS} from proposals p
			 where p.trip_id = ${tripId} and p.status = 'open' and p.op = ${op}
			   and p.entity_kind = ${entity.kind} and p.entity_id = ${entity.id}
			   and p.author_user_id = ${user.id}
			 order by p.created_at desc limit 1
			 for update`);
		const prev = res.rows[0]
			? toProposalRow(res.rows[0] as Record<string, unknown>)
			: null;
		if (prev) {
			payload = mergePayload(prev.payload, payload);
			const prevFields = fieldsOf(def, payload);
			const chain = (await requiresChain(tx, tripId, ghosts)).filter(
				(p) => p.id !== prev.id,
			);
			const dry = await dryRun(tx, out, {
				tripId,
				access,
				user,
				chain,
				def,
				payload,
				inputRedacted,
				entity,
				fields: prevFields,
			});
			// Keep the original base; fields the amend adds get today's values.
			let base: ProposalBase = prev.base;
			let baseRef = prev.base.refs.find(
				(r) => r.kind === entity.kind && r.id === entity.id,
			);
			const extra = baseRef
				? prevFields.filter((f) => !(f in (baseRef as BaseRef).fields))
				: [];
			if (baseRef && extra.length) {
				const cur = await snapshotRef(
					tx,
					tripId,
					entity.kind,
					entity.id,
					extra,
				);
				if (cur) {
					const grown: BaseRef = {
						...baseRef,
						fields: { ...baseRef.fields, ...cur.fields },
					};
					base = {
						...prev.base,
						refs: prev.base.refs.map((r) => (r === baseRef ? grown : r)),
					};
					baseRef = grown;
				}
			}
			// Moved back / renamed back: the proposal would change nothing.
			if (
				baseRef &&
				dry.after &&
				Object.keys(baseRef.fields).some((f) => f !== "position") &&
				changedFields(baseRef, dry.after, { ignorePosition: true }).length === 0
			)
				return withdrawOwn(tx, out, prev, "changed back by its author");
			const summary =
				dry.summary ??
				`changed ${await entityLabel(tx, tripId, entity.kind, entity.id)}`;
			await tx
				.update(proposals)
				.set({
					payload,
					base,
					summary,
					requires: chain.map((p) => p.id),
					lastError: null,
					updatedAt: new Date(),
					...(a.flag?.message ? { message: a.flag.message } : {}),
				})
				.where(and(eq(proposals.id, prev.id), eq(proposals.status, "open")));
			out.emit({ keys: ["proposals"] });
			return { proposed: { id: prev.id, summary } };
		}
	}

	// Chosen ids must be new everywhere (a proposal can't claim a row that
	// exists, or another proposal's ghost).
	await assertUnclaimed(tx, createdIds);

	// 5. Requires (deps first) and the limits.
	const chain = await requiresChain(tx, tripId, ghosts);
	const limits = (
		await tx.execute(sql`
			select (select count(*)::int from proposals where trip_id = ${tripId} and status = 'open') as open,
			       (select count(*)::int from proposals where author_user_id = ${user.id}
			          and created_at > now() - interval '1 hour') as recent`)
	).rows[0] as { open: number; recent: number };
	if (
		Number(limits.open) >= MAX_OPEN_PER_TRIP ||
		Number(limits.recent) >= MAX_NEW_PER_AUTHOR_PER_HOUR
	)
		fail("RATE_LIMITED", LIMIT_MESSAGE);

	// 6. Base, dry run, insert.
	const base = await baseOf(tx, tripId, entity, fields, out.version);
	const dry = await dryRun(tx, out, {
		tripId,
		access,
		user,
		chain,
		def,
		payload,
		inputRedacted,
		entity,
		fields,
	});
	const summary =
		dry.summary ??
		`changed ${await entityLabel(tx, tripId, entity.kind, entity.id)}`;
	const id = uuidv7();
	await tx.insert(proposals).values({
		id,
		tripId,
		op,
		payload,
		base,
		entityKind: entity.kind,
		entityId: entity.id,
		createdIds,
		requires: chain.map((p) => p.id),
		summary: summary.slice(0, 300),
		message: a.flag?.message || null,
		authorUserId: user.id,
		authorMemberId: access.memberId,
		authorName: (user.name || "Someone").slice(0, 120),
		authorColor: Math.min(Math.max(access.color, 0), 7),
		authorIsGuest: access.isGuest,
	});
	await logActivity(tx, out, {
		tripId,
		actor: actorOf(user),
		verb: "proposal.create",
		summary: `suggested: ${summary}`,
		...entityCols(entity),
		meta: { proposalId: id },
	});
	out.emit({ keys: ["proposals", "activity"] });
	// Web Push: "Maya made a suggestion" to the people who can review it.
	out.notify({ kind: "review", proposalId: id });
	return { proposed: { id, summary } };
}
