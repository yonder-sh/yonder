/**
 * Resolving proposals (EXTENSIONS §3.5), F-ext1: accept (the `requires`
 * chain first, then the proposal, in one `withTripTx`), reject, withdraw, and
 * the cascades. The server functions in `src/functions/proposals.functions.ts`
 * wrap these.
 *
 * Accept, per proposal: the reviewer needs the op's capability; the payload
 * re-parses with the op's STRICT schema; its trip must be the proposal's; a
 * guest author's payload is redacted again (`inputRedacted`). Then the base:
 * a missing/deleted row is `gone` (never forceable), a changed field is
 * `changed` (unless `force`, which also drops dead anchors). The core runs as
 * the reviewer with the author as actor ("Maya (accepted by Dennis)"); its
 * AppError becomes `invalid`. On any conflict the transaction rolls back and
 * a second, small one records `last_error`.
 */
import { sql } from "drizzle-orm";
import { db, type Tx } from "@/db/db.server";
import { can, mustRedact, type TripAccess } from "@/lib/auth/roles";
import type {
	Json,
	ProposalConflict,
	ProposalOp,
} from "@/lib/schemas/proposals";
import { logActivity } from "@/server/activity.server";
import type { AuthUser } from "@/server/auth.server";
import { AppError } from "@/server/authz/errors";
import { fail } from "@/server/authz/session.server";
import type { SqlExec } from "@/server/graph.server";
import type { TxOutbox } from "@/server/live/outbox.server";
import { mutationMeta, withTripTx } from "@/server/tx.server";
import { changedFields, entityLabel, snapshotRef } from "./base.server";
import { proposalVisibleTo } from "./dto.server";
import {
	fieldsOf,
	firstName,
	loadDef,
	loadProposal,
	type ProposalRow,
	requiresChain,
} from "./propose.server";
import { REGISTRY } from "./registry.server";
import { closeDependants } from "./withdraw.server";

export type ResolveResult =
	| { ok: true; status: "accepted" | "rejected" }
	| {
			ok: false;
			conflict: {
				reason: "gone" | "changed" | "invalid";
				fields?: string[];
				message: string;
			};
	  };

export type ResolveInput = {
	proposalId: string;
	decision: "accept" | "reject";
	note?: string;
	force?: boolean;
	appliedClientSide?: boolean;
};

/** Thrown inside the accept transaction to roll it back with a conflict. */
class AcceptConflict extends Error {
	constructor(
		readonly proposalId: string,
		readonly conflict: ProposalConflict,
	) {
		super(conflict.message);
	}
}

/** Anchor keys an accepted move may name; `force` drops the dead ones. */
const ANCHOR_TABLE: Record<string, string> = {
	afterItemId: "items",
	beforeItemId: "items",
};
function anchorTable(op: ProposalOp, key: string): string | null {
	if (ANCHOR_TABLE[key]) return ANCHOR_TABLE[key];
	if (key !== "afterId" && key !== "beforeId") return null;
	if (op.startsWith("node.")) return "nodes";
	if (op.startsWith("list.")) return "list_items";
	if (op.startsWith("attachment.")) return "attachments";
	return null;
}

async function dropDeadAnchors(
	exec: SqlExec,
	tripId: string,
	op: ProposalOp,
	payload: Record<string, Json>,
): Promise<Record<string, Json>> {
	const out = { ...payload };
	for (const key of Object.keys(out)) {
		const table = anchorTable(op, key);
		const id = out[key];
		if (!table || typeof id !== "string") continue;
		const res = await exec.execute(sql`
			select 1 from ${sql.raw(table)} where id = ${id} and trip_id = ${tripId} and deleted_at is null`);
		if (!res.rows.length) delete out[key];
	}
	return out;
}

/** "the trip" → "The trip" (conflict messages are shown as sentences). */
function sentenceStart(label: string): string {
	return label.replace(/^[a-z]/, (c) => c.toUpperCase());
}

/** "Maya accepted" / "the author" for activity names. */
function authorActor(p: ProposalRow, reviewer: AuthUser) {
	return {
		userId: p.authorUserId,
		name: `${firstName(p.authorName)} (accepted by ${firstName(reviewer.name)})`,
	};
}

/** Accepts one proposal inside the caller's transaction (throws AcceptConflict). */
async function acceptOne(
	tx: Tx,
	out: TxOutbox,
	p: ProposalRow,
	a: {
		access: TripAccess;
		user: AuthUser;
		force: boolean;
		appliedClientSide: boolean;
	},
): Promise<void> {
	const entry = REGISTRY[p.op] as { capability: Parameters<typeof can>[1] };
	if (!entry)
		throw new AcceptConflict(p.id, {
			reason: "invalid",
			message: "This kind of suggestion no longer exists.",
		});
	if (!can(a.access, entry.capability))
		fail("FORBIDDEN", `not allowed: ${entry.capability}`);
	const def = await loadDef(p.op);
	if (def.proposeOnly && !a.appliedClientSide)
		fail("VALIDATION", "Insert the suggested text into the note first.");
	// Base first: a gone row is never forceable.
	for (const ref of p.base.refs) {
		const cur = await snapshotRef(
			tx,
			p.tripId,
			ref.kind as Parameters<typeof snapshotRef>[2],
			ref.id,
			Object.keys(ref.fields),
		);
		if (!cur)
			throw new AcceptConflict(p.id, {
				reason: "gone",
				message: `${sentenceStart(
					await entityLabel(
						tx,
						p.tripId,
						ref.kind as Parameters<typeof entityLabel>[2],
						ref.id,
					),
				)} was deleted since it was suggested.`,
			});
		const changed = changedFields(ref, cur);
		if (changed.length && !a.force)
			throw new AcceptConflict(p.id, {
				reason: "changed",
				fields: changed.slice(0, 50),
				message: `${sentenceStart(
					await entityLabel(
						tx,
						p.tripId,
						ref.kind as Parameters<typeof entityLabel>[2],
						ref.id,
					),
				)} was changed since it was suggested.`,
			});
	}
	let payload = p.payload;
	if (a.force) payload = await dropDeadAnchors(tx, p.tripId, p.op, payload);
	const parsed = def.input.safeParse(payload);
	if (!parsed.success)
		throw new AcceptConflict(p.id, {
			reason: "invalid",
			message: "This suggestion no longer fits the plan.",
		});
	let input = parsed.data as Record<string, unknown>;
	const inputRedacted = p.authorIsGuest && !!def.redact;
	if (inputRedacted) input = def.redact?.(input) ?? input;
	let tripId: string | null = null;
	try {
		tripId = await def.tripIdOf(input, tx);
	} catch (e) {
		if (!(e instanceof AppError)) throw e;
	}
	if (tripId !== p.tripId)
		throw new AcceptConflict(p.id, {
			reason: tripId === null ? "gone" : "invalid",
			message:
				tripId === null
					? "What this suggestion changes was deleted."
					: "This suggestion belongs to another trip.",
		});
	try {
		await def.core(tx, out, input, {
			access: a.access,
			user: a.user,
			actor: authorActor(p, a.user),
			inputRedacted,
			dryRun: false,
		});
	} catch (e) {
		// A guest reviewer who can't see the row (a hidden attachment): their
		// failed attempt says nothing about the proposal, so no `last_error`.
		if (e instanceof AppError && e.code === "NOT_FOUND" && mustRedact(a.access))
			throw e;
		if (e instanceof AppError)
			throw new AcceptConflict(p.id, {
				reason: "invalid",
				message: (e.detail ?? "This suggestion can't be applied any more.")
					.slice(0, 500)
					.replace(/^[a-z]/, (c) => c.toUpperCase()),
			});
		throw e;
	}
	await tx.execute(sql`
		update proposals set status = 'accepted', reviewed_by = ${a.user.id}, reviewed_at = now(),
		       last_error = null, updated_at = now()
		 where id = ${p.id}`);
	await logActivity(tx, out, {
		tripId: p.tripId,
		actor: { userId: a.user.id, name: a.user.name },
		verb: "proposal.accept",
		summary: `accepted ${firstName(p.authorName)}'s suggestion: ${p.summary}`,
		meta: { proposalId: p.id },
	});
	// Stacked alternatives on the same (entity, field) now conflict.
	if (p.entityId) {
		const fields = new Set(fieldsOf(def, p.payload));
		const others = await tx.execute(sql`
			select id::text as id, op, payload from proposals
			 where trip_id = ${p.tripId} and status = 'open' and id <> ${p.id}
			   and entity_kind = ${p.entityKind} and entity_id = ${p.entityId}`);
		for (const o of others.rows as {
			id: string;
			op: ProposalOp;
			payload: Record<string, unknown>;
		}[]) {
			const odef = REGISTRY[o.op] ? await loadDef(o.op) : null;
			const ofields = odef ? fieldsOf(odef, o.payload) : [];
			const overlap = fields.size > 0 && ofields.some((f) => fields.has(f));
			if (!overlap) continue;
			const conflict: ProposalConflict = {
				reason: "changed",
				fields: ofields.filter((f) => fields.has(f)).slice(0, 50),
				message: `${firstName(p.authorName)}'s suggestion for this was accepted.`,
			};
			await tx.execute(sql`
				update proposals set last_error = ${JSON.stringify(conflict)}::jsonb, updated_at = now()
				 where id = ${o.id}`);
		}
	}
}

/** Accept or reject one proposal (EXTENSIONS §3.5). */
export async function resolveProposalById(
	user: AuthUser,
	input: ResolveInput,
	requireReviewer: (tripId: string) => Promise<TripAccess>,
): Promise<ResolveResult> {
	const found = await loadProposalAnywhere(input.proposalId);
	if (!found) return fail("NOT_FOUND");
	const access = await requireReviewer(found.tripId);
	// A proposal the caller can't see (a guest and a hidden attachment) doesn't
	// exist for them: no accept, no reject, and no `last_error` left behind.
	if (!(await proposalVisibleTo(db, found.id, access, user.id)))
		return fail("NOT_FOUND");
	if (found.status !== "open")
		return fail("CONFLICT", "That suggestion was already reviewed.");

	if (input.decision === "reject") {
		await withTripTx(
			found.tripId,
			async (tx, out) => {
				const p = await loadProposal(tx, found.id, { forUpdate: true });
				if (p?.status !== "open")
					return fail("CONFLICT", "That suggestion was already reviewed.");
				await tx.execute(sql`
					update proposals set status = 'rejected', review_note = ${input.note?.trim() || null},
					       reviewed_by = ${user.id}, reviewed_at = now(), updated_at = now()
					 where id = ${p.id}`);
				await closeDependants(tx, p.tripId, [p.id], "rejected");
				await logActivity(tx, out, {
					tripId: p.tripId,
					actor: { userId: user.id, name: user.name },
					verb: "proposal.reject",
					summary: `rejected ${firstName(p.authorName)}'s suggestion: ${p.summary}`,
					meta: { proposalId: p.id },
				});
				out.emit({ keys: ["proposals", "activity"] });
			},
			mutationMeta(access, user),
		);
		return { ok: true, status: "rejected" };
	}

	try {
		await withTripTx(
			found.tripId,
			async (tx, out) => {
				const p = await loadProposal(tx, found.id, { forUpdate: true });
				if (p?.status !== "open")
					return fail("CONFLICT", "That suggestion was already reviewed.");
				const chain = await requiresChain(tx, p.tripId, [p]);
				for (const q of chain)
					await acceptOne(tx, out, q, {
						access,
						user,
						force: input.force === true,
						appliedClientSide: input.appliedClientSide === true,
					});
				out.emit({ keys: ["proposals", "activity"] });
			},
			mutationMeta(access, user),
		);
		return { ok: true, status: "accepted" };
	} catch (e) {
		if (!(e instanceof AcceptConflict)) throw e;
		await withTripTx(
			found.tripId,
			async (tx, out) => {
				await tx.execute(sql`
					update proposals set last_error = ${JSON.stringify(e.conflict)}::jsonb, updated_at = now()
					 where id = any(${sql.param([...new Set([e.proposalId, found.id])])}::uuid[]) and status = 'open'`);
				out.emit({ keys: ["proposals"] });
			},
			mutationMeta(access, user),
		);
		return { ok: false, conflict: e.conflict };
	}
}

/** The proposal wherever it is (the caller's access to its trip is checked next). */
function loadProposalAnywhere(id: string): Promise<ProposalRow | null> {
	return loadProposal(db, id);
}

/** The author withdraws their own open proposal and its dependants. */
export async function withdrawProposalById(
	user: AuthUser,
	proposalId: string,
	requireProposer: (tripId: string) => Promise<TripAccess>,
): Promise<{ ok: true }> {
	const found = await loadProposalAnywhere(proposalId);
	if (!found) return fail("NOT_FOUND");
	const access = await requireProposer(found.tripId);
	if (!(await proposalVisibleTo(db, found.id, access, user.id)))
		return fail("NOT_FOUND");
	if (found.authorUserId !== user.id)
		return fail("FORBIDDEN", "Only its author can withdraw a suggestion.");
	await withTripTx(
		found.tripId,
		async (tx, out) => {
			const p = await loadProposal(tx, found.id, { forUpdate: true });
			if (p?.status !== "open")
				return fail("CONFLICT", "That suggestion was already reviewed.");
			await tx.execute(sql`
				update proposals set status = 'withdrawn', review_note = null, updated_at = now()
				 where id = ${p.id}`);
			await closeDependants(tx, p.tripId, [p.id], "withdrawn");
			out.emit({ keys: ["proposals"] });
		},
		mutationMeta(access, user),
	);
	return { ok: true };
}
