/**
 * The gate (EXTENSIONS §3.4). Every proposable mutation keeps a LITERAL
 * `createServerFn(...)` (TanStack Start ids server functions by call site):
 *
 *   export const moveItem = createServerFn({ method: "POST" })
 *     .middleware([withNamedUser])
 *     .validator(proposable.input(MoveItemInput))   // + optional `proposal`
 *     .handler(proposable.run("item.move"));        // → R | Proposed
 *
 * Order (EXTENSIONS §3.4): 0. ghost lookup (ids that open proposals will
 * create: someone else's → CONFLICT "Suggested by Maya — review it first",
 * mine → propose, amending or chaining my proposal); 1. mode: APPLY when the
 * caller has the op's capability and isn't suggesting (or it's a `directIf`
 * case, evaluated in the transaction), PROPOSE when they may propose, else
 * FORBIDDEN. Apply is the usual `withTripTx` recipe; propose is
 * `proposeChange` (`./propose.server`) in the same transaction: one lock, one
 * version bump.
 *
 * Direct functions use `requireDirect(name, tripId, user)`, which reads their
 * capability from MUTATION_POLICY.
 */
import { getRequestHeaders } from "@tanstack/react-start/server";
import type { z } from "zod";
import { db } from "@/db/db.server";
import { type Capability, can, type TripAccess } from "@/lib/auth/roles";
import {
	MODE_HEADER,
	type ProposalFlag,
	type ProposalOp,
	type Proposed,
	proposableInput,
} from "@/lib/schemas/proposals";
import type { AuthUser } from "@/server/auth.server";
import {
	getTripAccess,
	requireTripCapability,
} from "@/server/authz/access.server";
import { errorCode } from "@/server/authz/errors";
import { fail } from "@/server/authz/session.server";
import { mutationMeta, withTripTx } from "@/server/tx.server";
import { MUTATION_POLICY, type MutationFnName } from "./policy";
import {
	firstName,
	openGhosts,
	proposeChange,
	uuidsIn,
} from "./propose.server";
import { type DefOf, REGISTRY } from "./registry.server";
import { actorOf, type ProposableDef } from "./types";

/** The validated input a proposable function receives (`proposal` included). */
export type ProposableInput<Op extends ProposalOp> = z.output<
	DefOf<Op>["input"]
> & { proposal?: ProposalFlag };

/** What the applied core returns. */
export type ProposableResult<Op extends ProposalOp> = Awaited<
	ReturnType<DefOf<Op>["core"]>
>;

/** `x-yonder-mode: suggest` from the calling tab (it can only downgrade edit → propose). */
function suggestModeRequested(): boolean {
	try {
		return getRequestHeaders().get(MODE_HEADER) === "suggest";
	} catch {
		return false; // scripts and tests: no request
	}
}

/**
 * What the gate decides for one call (exported for tests).
 * `apply-if-direct`: apply when `directIf` holds, else propose;
 * `direct-only`: apply when `directIf` holds, else FORBIDDEN (a rater, who
 * can't propose, setting their own rating: PLACES §1c).
 */
export type GateDecision =
	| "apply"
	| "apply-if-direct"
	| "direct-only"
	| "propose"
	| "forbid";

export function decide(
	access: Pick<TripAccess, "role" | "isGuest">,
	capability: Capability,
	def: { proposeOnly?: true; directIf?: unknown; directCap?: Capability },
	suggesting: boolean,
): GateDecision {
	if (can(access, capability) && !def.proposeOnly && !suggesting)
		return "apply";
	if (can(access, "propose") && def.directIf && !def.proposeOnly)
		return "apply-if-direct";
	if (can(access, "propose")) return "propose";
	if (
		def.directIf &&
		def.directCap &&
		!def.proposeOnly &&
		can(access, def.directCap)
	)
		return "direct-only";
	return "forbid";
}

export const proposable = {
	/** Adds `proposal?: { message }` to the op's input (keeps `.strict()`). */
	input: proposableInput,

	/** The handler for op `op` (see the file comment). */
	run<Op extends ProposalOp>(op: Op) {
		return async ({
			data,
			context,
		}: {
			data: ProposableInput<Op>;
			context: { user: AuthUser };
		}): Promise<ProposableResult<Op> | Proposed> => {
			const entry = REGISTRY[op] as {
				capability: Capability;
				// biome-ignore lint/suspicious/noExplicitAny: one code path for every op's def.
				load: () => Promise<ProposableDef<any, any>>;
			};
			const def = await entry.load();
			const { proposal: flag, ...input } = data as Record<string, unknown> & {
				proposal?: ProposalFlag;
			};
			const user = context.user;

			// 0. Ghost lookup: ids that open proposals will create. The trip
			// comes from the live rows when they exist (and only that trip's
			// proposals count); a target that doesn't exist yet takes it from the
			// proposal that will create it.
			const ids = [...uuidsIn(input)];
			let tripId: string | null = null;
			let missing: unknown = null;
			try {
				tripId = await def.tripIdOf(input, db);
			} catch (e) {
				if (errorCode(e) !== "NOT_FOUND") throw e;
				missing = e;
			}
			const ghosts = await openGhosts(db, ids, tripId ?? undefined);
			if (tripId === null) {
				const first = ghosts[0];
				if (!first) throw missing;
				tripId = first.tripId;
				if (ghosts.some((g) => g.tripId !== tripId)) return fail("NOT_FOUND");
			}
			const access = await getTripAccess(tripId, user);
			if (!access) return fail("NOT_FOUND");

			let decision: GateDecision;
			if (ghosts.length) {
				const other = ghosts.find((g) => g.authorUserId !== user.id);
				if (other)
					return fail(
						"CONFLICT",
						`Suggested by ${firstName(other.authorName)} — review it first.`,
					);
				// Editing my own ghost amends or chains my proposal.
				decision = can(access, "propose") ? "propose" : "forbid";
			} else
				decision = decide(
					access,
					entry.capability,
					def,
					suggestModeRequested(),
				);
			if (decision === "forbid")
				return fail("FORBIDDEN", `not allowed: ${entry.capability}`);
			const trip = tripId;
			const result: unknown = await withTripTx(
				trip,
				async (tx, out) => {
					const apply =
						decision === "apply" ||
						((decision === "apply-if-direct" || decision === "direct-only") &&
							(await def.directIf?.(input, access, tx)));
					if (!apply && decision === "direct-only")
						return fail("FORBIDDEN", `not allowed: ${entry.capability}`);
					if (!apply)
						return proposeChange(tx, out, {
							op,
							def,
							input,
							flag,
							access,
							user,
							tripId: trip,
						});
					return def.core(tx, out, input, {
						access,
						user,
						actor: actorOf(user),
						inputRedacted: access.isGuest && !!def.redact,
						dryRun: false,
					});
				},
				mutationMeta(access, user),
			);
			return result as ProposableResult<Op> | Proposed;
		};
	},
};

/**
 * For direct functions: the access, if the caller has the capability that
 * MUTATION_POLICY names for `name` (401 / 404 / 403 with the real status).
 */
export async function requireDirect(
	name: MutationFnName,
	tripId: string,
	user: AuthUser,
): Promise<TripAccess & { user: AuthUser }> {
	const policy = MUTATION_POLICY[name];
	if (typeof policy !== "object")
		throw new Error(
			`requireDirect: ${name} is ${policy}, not a direct function`,
		);
	return requireTripCapability(tripId, policy.direct, user);
}

/** For edit-only functions (uploads, restores, provider fetches). */
export async function requireEditOnly(
	name: MutationFnName,
	tripId: string,
	user: AuthUser,
): Promise<TripAccess & { user: AuthUser }> {
	if (MUTATION_POLICY[name] !== "edit-only")
		throw new Error(`requireEditOnly: ${name} is not edit-only`);
	return requireTripCapability(tripId, "edit", user);
}

export { withdrawAuthorProposals } from "./withdraw.server";
