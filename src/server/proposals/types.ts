/**
 * The proposable-mutation contract (EXTENSIONS §3.4). Every proposable server
 * function is ONE def: its input schema, how to find its trip, what entity it
 * touches, and a DB-only `core` that does the work inside the gate's
 * `withTripTx`. The gate (`proposable.run`) decides apply, propose or 403.
 *
 * Core rules:
 * - A core is DB-only and never checks roles (the gate did).
 * - Any other effect (Redis, caches, S3, provider fetches) goes through
 *   `out.job(...)` / `out.emit(...)`: discarded on rollback and by a dry run.
 * - The actor for activity comes from `ctx.actor`; `createdBy` and the
 *   outbox's actor from `ctx.user`.
 * - Guest merges key on `ctx.inputRedacted`, never on `access.isGuest`.
 */
import type { z } from "zod";
import type { Tx } from "@/db/db.server";
import type { Capability, TripAccess } from "@/lib/auth/roles";
import type { EntityKind, Json } from "@/lib/schemas/proposals";
import type { AuthUser } from "@/server/auth.server";
import type { SqlExec } from "@/server/graph.server";
import type { TxOutbox } from "@/server/live/outbox.server";

export type CoreCtx = {
	access: TripAccess;
	user: AuthUser;
	/** Who the activity row names ("Maya (accepted by Dennis)" on accept). */
	actor: { userId: string | null; name: string };
	/** The input went through `def.redact` (a guest author). */
	inputRedacted: boolean;
	/** A proposal's validation run: rolled back, side effects discarded. */
	dryRun: boolean;
};

export type ProposableDef<I extends z.ZodObject, R> = {
	/** The op's input WITHOUT `proposal` (the functions file wraps it with `proposable.input`). */
	input: I;
	/** The trip the input acts on; NOT_FOUND for a missing or deleted row. */
	tripIdOf: (input: z.output<I>, exec: SqlExec) => Promise<string>;
	entityOf: (input: z.output<I>) => { kind: EntityKind; id: string | null };
	/** The fields a proposal would change (default: the keys of `input.patch`). */
	fields?: (input: z.output<I>) => string[];
	/** Suggesters apply directly when this holds (own priority, own list item). Evaluated in the tx. */
	directIf?: (
		input: z.output<I>,
		access: TripAccess,
		tx: Tx,
	) => Promise<boolean>;
	/**
	 * Who else may apply a `directIf` case without being able to propose
	 * (PLACES §1c: a rater's own rating needs `rate`). Their other calls are
	 * FORBIDDEN, never proposals.
	 */
	directCap?: Capability;
	/** Guest strip (booking refs, costs, seats), built on `redactLegDetails`. */
	redact?: (input: z.output<I>) => z.output<I>;
	/** Edits to your own proposed create. */
	amend?: { merge: (createPayload: Json, input: z.output<I>) => Json };
	/** `note.append`: only ever a proposal. */
	proposeOnly?: true;
	core: (tx: Tx, out: TxOutbox, input: z.output<I>, ctx: CoreCtx) => Promise<R>;
};

/** Identity helper that keeps `I` and `R` inferred for a def. */
export function defineProposable<I extends z.ZodObject, R>(
	def: ProposableDef<I, R>,
): ProposableDef<I, R> {
	return def;
}

/** `{ userId, name }` for activity rows. */
export const actorOf = (u: { id: string; name: string }) => ({
	userId: u.id,
	name: u.name,
});
