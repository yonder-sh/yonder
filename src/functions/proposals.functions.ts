/**
 * E7 proposals (EXTENSIONS §3.5), F-owned: list, resolve (accept/reject, one
 * or up to 50), withdraw. The propose path itself is the gate
 * (`proposable.run`, `src/server/proposals/propose.server.ts`); accepting,
 * rejecting and withdrawing live in `src/server/proposals/resolve.server.ts`.
 */
import { createServerFn } from "@tanstack/react-start";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db/db.server";
import { can, mustRedact } from "@/lib/auth/roles";
import type { ProposalDto, ProposalOp } from "@/lib/schemas/proposals";
import { requireTripRole } from "@/server/authz/access.server";
import { errorCode, errorDetail } from "@/server/authz/errors";
import { withNamedUser, withUser } from "@/server/authz/middleware";
import { proposalDto, proposalVisibleSql } from "@/server/proposals/dto.server";
import { requireDirect } from "@/server/proposals/proposable.server";
import {
	type AnyDef,
	loadDef,
	PROPOSAL_COLUMNS,
	toProposalRow,
} from "@/server/proposals/propose.server";
import { REGISTRY } from "@/server/proposals/registry.server";
import {
	resolveProposalById,
	withdrawProposalById,
} from "@/server/proposals/resolve.server";

const TripIdInput = z.object({ tripId: z.uuid() }).strict();

/** Closed proposals kept in the list: the most recent, and the caller's own. */
const RECENT_CLOSED = 50;
const OWN_CLOSED_DAYS = 30;

/**
 * Open proposals, the 50 most recently closed, and the caller's own closed
 * ones from the last 30 days (≤ 50), each with its open dependants. Viewers
 * and guest viewers get `[]`; guests get payloads through `def.redact`, and
 * never a proposal about a hidden attachment or a receipt (`proposalVisibleSql`).
 */
export const listProposals = createServerFn({ method: "GET" })
	.middleware([withUser])
	.validator(TripIdInput)
	.handler(async ({ data, context }): Promise<ProposalDto[]> => {
		const access = await requireTripRole(data.tripId, "viewer", context.user);
		if (!can(access, "propose") && !can(access, "reviewProposals")) return [];
		const me = context.user.id;
		const res = await db.execute(sql`
			with recent as (
				select id from proposals
				 where trip_id = ${data.tripId} and status <> 'open'
				 order by coalesce(reviewed_at, updated_at) desc, id desc
				 limit ${RECENT_CLOSED}
			), mine as (
				select id from proposals
				 where trip_id = ${data.tripId} and status <> 'open' and author_user_id = ${me}
				   and updated_at > now() - make_interval(days => ${OWN_CLOSED_DAYS})
				 order by updated_at desc, id desc
				 limit ${RECENT_CLOSED}
			)
			select ${PROPOSAL_COLUMNS},
			       coalesce((select array_agg(d.id::text order by d.created_at) from proposals d
			                  where d.trip_id = p.trip_id and d.status = 'open' and p.id = any(d.requires)), '{}') as dependants
			  from proposals p
			 where p.trip_id = ${data.tripId}
			   and (p.status = 'open' or p.id in (select id from recent) or p.id in (select id from mine))
			   and ${proposalVisibleSql(access, me)}
			 order by p.created_at, p.id
			 limit 500`);
		const rows = (res.rows as Record<string, unknown>[]).map((r) => ({
			...toProposalRow(r),
			dependants: (r.dependants as string[] | null) ?? [],
		}));
		const defs = new Map<ProposalOp, AnyDef | null>();
		for (const op of new Set(rows.map((r) => r.op)))
			defs.set(op, REGISTRY[op] ? await loadDef(op) : null);
		const redact = mustRedact(access);
		return rows.map((r) => proposalDto(r, defs.get(r.op) ?? null, redact));
	});

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

const ResolveInput = z
	.object({
		proposalId: z.uuid(),
		decision: z.enum(["accept", "reject"]),
		note: z.string().trim().max(200).optional(),
		/** Accept despite a `changed` conflict (never a `gone` one). */
		force: z.boolean().optional(),
		/** `note.append`: the reviewer's editor already inserted the Markdown. */
		appliedClientSide: z.boolean().optional(),
	})
	.strict();

/** Accept or reject one proposal (its open `requires` chain first). `{ direct: 'reviewProposals' }`. Keys: proposals + the op's keys. */
export const resolveProposal = createServerFn({ method: "POST" })
	.middleware([withNamedUser])
	.validator(ResolveInput)
	.handler(
		async ({ data, context }): Promise<ResolveResult> =>
			resolveProposalById(context.user, data, (tripId) =>
				requireDirect("resolveProposal", tripId, context.user),
			),
	);

/** Up to 50 at once, one by one; results per id. `{ direct: 'reviewProposals' }`. */
export const resolveProposals = createServerFn({ method: "POST" })
	.middleware([withNamedUser])
	.validator(
		z
			.object({
				ids: z.array(z.uuid()).min(1).max(50),
				decision: z.enum(["accept", "reject"]),
			})
			.strict(),
	)
	.handler(
		async ({ data, context }): Promise<Record<string, ResolveResult>> => {
			const out: Record<string, ResolveResult> = {};
			const want = data.decision === "accept" ? "accepted" : "rejected";
			for (const id of [...new Set(data.ids)]) {
				try {
					out[id] = await resolveProposalById(
						context.user,
						{ proposalId: id, decision: data.decision },
						(tripId) => requireDirect("resolveProposals", tripId, context.user),
					);
				} catch (e) {
					// Accepted earlier in this batch as part of a chain: that's a success.
					const res = await db.execute(
						sql`select status::text as status from proposals where id = ${id}`,
					);
					const status = (res.rows[0] as { status: string } | undefined)
						?.status;
					const code = errorCode(e);
					if (status === want) out[id] = { ok: true, status: want };
					else if (status && code === "CONFLICT")
						out[id] = {
							ok: false,
							conflict: {
								reason: "invalid",
								message: "That suggestion was already reviewed.",
							},
						};
					// A result for every id (WP-Suggest's "Accept all" counts them):
					// a missing one is `gone`; a refused one stays an error for all.
					// (Or one this caller may not see: same answer, nothing revealed.)
					else if (code === "NOT_FOUND")
						out[id] = {
							ok: false,
							conflict: {
								reason: "gone",
								message: "That suggestion no longer exists.",
							},
						};
					else if (code === "VALIDATION")
						out[id] = {
							ok: false,
							conflict: {
								reason: "invalid",
								message:
									errorDetail(e) ??
									"This one needs a look before it can be accepted.",
							},
						};
					else throw e;
				}
			}
			return out;
		},
	);

/** The author withdraws their own proposal (and its dependants). `{ direct: 'propose' }`. */
export const withdrawProposal = createServerFn({ method: "POST" })
	.middleware([withNamedUser])
	.validator(z.object({ proposalId: z.uuid() }).strict())
	.handler(
		async ({ data, context }): Promise<{ ok: true }> =>
			withdrawProposalById(context.user, data.proposalId, (tripId) =>
				requireDirect("withdrawProposal", tripId, context.user),
			),
	);
