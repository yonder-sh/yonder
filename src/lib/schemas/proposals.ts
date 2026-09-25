/**
 * E7 suggestion mode: the proposal vocabulary shared by the gate (server), the
 * overlay (`src/lib/engine/proposals.ts`) and the UI (EXTENSIONS §3.2–§3.5).
 * Isomorphic: no server imports.
 */
import { z } from "zod";
import { Id, UserId } from "./common";
import { PROPOSAL_STATUS_VALUES } from "./enums";

/**
 * Every proposable op, 1:1 with a mutation server function (EXTENSIONS §3.3).
 * The registry (`src/server/proposals/registry.server.ts`) must cover every
 * one (a compile-time `Record<ProposalOp, …>` check).
 */
export const PROPOSAL_OPS = [
	// F (src/server/proposals/defs.server.ts)
	"node.create",
	"node.createPath",
	"node.update",
	"node.move",
	"node.delete",
	"node.priority",
	"item.create",
	"item.update",
	"item.move",
	"item.delete",
	"item.assignees",
	"day.update",
	"day.stay",
	"day.insert",
	"day.move",
	"day.delete",
	"trip.dates",
	"trip.shift",
	"leg.set",
	"leg.relink",
	"leg.delete",
	"leg.assignees",
	// WP-Transit (src/features/transit/server/proposable.server.ts)
	"leg.resetEstimate",
	"transit.route.save",
	"transit.route.update",
	"transit.route.delete",
	"transit.details",
	"flight.save",
	"flight.create",
	// WP-Insights
	"node.hours",
	// WP-Lists
	"list.create",
	"list.update",
	"list.move",
	"list.status",
	"list.targets",
	"list.assignees",
	"list.delete",
	// WP-Media
	"attachment.link",
	"attachment.update",
	"attachment.delete",
	// WP-Suggest (propose-only)
	"note.append",
] as const;
export const ProposalOp = z.enum(PROPOSAL_OPS);
export type ProposalOp = z.infer<typeof ProposalOp>;

/** What a proposal targets (`proposals.entity_kind`). */
export const ENTITY_KINDS = [
	"node",
	"item",
	"leg",
	"day",
	"list",
	"att",
	"trip",
	"note",
] as const;
export const EntityKind = z.enum(ENTITY_KINDS);
export type EntityKind = z.infer<typeof EntityKind>;

/**
 * The optional `proposal` key every proposable input accepts: a message for
 * the reviewers. There is no `force` here: that belongs to `resolveProposal`.
 */
export const ProposalFlag = z
	.object({ message: z.string().trim().max(500).optional() })
	.strict();
export type ProposalFlag = z.infer<typeof ProposalFlag>;

/**
 * Adds `proposal?: ProposalFlag` to a proposable function's input. Keeps the
 * schema's strictness (and its refinements, via `safeExtend`).
 */
export function proposableInput<
	Shape extends z.core.$ZodShape,
	Config extends z.core.$ZodObjectConfig,
>(
	schema: z.ZodObject<Shape, Config>,
): z.ZodObject<
	Shape & { proposal: z.ZodOptional<typeof ProposalFlag> },
	Config
> {
	// Typed by hand: on a generic ZodObject, `safeExtend`'s inferred result
	// widens the shape to Record<string, unknown>.
	return (schema as z.ZodObject).safeExtend({
		proposal: ProposalFlag.optional(),
	}) as unknown as z.ZodObject<
		Shape & { proposal: z.ZodOptional<typeof ProposalFlag> },
		Config
	>;
}

/** Why an accept failed (`proposals.last_error`). */
export const ProposalConflict = z.object({
	reason: z.enum(["gone", "changed", "invalid"]),
	fields: z.array(z.string().max(100)).max(50).optional(),
	message: z.string().max(500),
});
export type ProposalConflict = z.infer<typeof ProposalConflict>;

/** JSON value (payloads are the op's input: JSON-safe by construction). */
export type Json =
	| string
	| number
	| boolean
	| null
	| Json[]
	| { [key: string]: Json };
const JsonValue: z.ZodType<Json> = z.lazy(() =>
	z.union([
		z.string(),
		z.number(),
		z.boolean(),
		z.null(),
		z.array(JsonValue),
		z.record(z.string(), JsonValue),
	]),
);

/**
 * A proposal as the client sees it (`listProposals`): the row minus the
 * server-only `base`, plus `before` (the touched fields' values when it was
 * proposed, computed from `base`). Guests get `payload`, `before` and
 * `lastError` redacted (EXTENSIONS §3.5).
 */
export const ProposalDto = z.object({
	id: Id,
	tripId: Id,
	op: ProposalOp,
	payload: z.record(z.string(), JsonValue),
	entityKind: EntityKind,
	entityId: Id.nullable(),
	createdIds: z.array(Id),
	requires: z.array(Id),
	summary: z.string(),
	message: z.string().nullable(),
	status: z.enum(PROPOSAL_STATUS_VALUES),
	author: z.object({
		userId: UserId.nullable(),
		memberId: Id.nullable(),
		name: z.string(),
		color: z.number().int().min(0).max(7),
		isGuest: z.boolean(),
	}),
	fields: z.array(z.string()),
	before: z.record(z.string(), JsonValue),
	reviewedBy: UserId.nullable(),
	reviewedAt: z.string().nullable(),
	reviewNote: z.string().nullable(),
	lastError: ProposalConflict.nullable(),
	/** Open proposals whose `requires` names this one. */
	dependants: z.array(Id),
	createdAt: z.string(),
	updatedAt: z.string(),
});
export type ProposalDto = z.infer<typeof ProposalDto>;

/**
 * What a proposable server function returns when the change became a
 * proposal instead of being applied (`R | Proposed`).
 */
export type Proposed = { proposed: { id: string; summary: string } };

/** True when a mutation's result is a proposal, not the applied result. */
export function isProposed(result: unknown): result is Proposed {
	return (
		typeof result === "object" &&
		result !== null &&
		"proposed" in result &&
		typeof (result as { proposed?: unknown }).proposed === "object" &&
		(result as { proposed: unknown }).proposed !== null
	);
}

/** Header that carries the workspace's suggest mode (EXTENSIONS §2.3). */
export const MODE_HEADER = "x-yonder-mode";
