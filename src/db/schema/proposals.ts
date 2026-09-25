/**
 * E7 proposals (EXTENSIONS §3.2): a suggested change = an op (a registry key,
 * 1:1 with a mutation server function) + that function's input as `payload` +
 * a server-only `base` snapshot of the rows it touches.
 *
 * Enum literals added by ALTER TYPE in the same migration transaction
 * (`suggester`, `removed`) never appear here.
 */
import { sql } from "drizzle-orm";
import {
	boolean,
	check,
	index,
	jsonb,
	pgTable,
	smallint,
	text,
	timestamp,
	unique,
	uuid,
} from "drizzle-orm/pg-core";
import type { Json, ProposalConflict } from "../../lib/schemas/proposals";
import { createdAt, pk, updatedAt } from "./_columns";
import { user } from "./auth";
import { proposalStatus } from "./enums";
import { tripRef } from "./trips";

/** Server-only snapshot of what a proposal touches. NEVER sent to clients. */
export type ProposalBase = {
	tripVersion: number;
	refs: {
		kind: string;
		id: string;
		updatedAt: string | null;
		fields: Record<string, Json>;
	}[];
};

export const proposals = pgTable(
	"proposals",
	{
		id: pk(),
		tripId: tripRef(),
		/** Registry key (`ProposalOp`). */
		op: text().notNull(),
		/** The op's input minus `proposal`, `expectedVersion`, `expectedUpdatedAt`; guest fields stripped. */
		payload: jsonb().$type<Record<string, Json>>().notNull(),
		/** Server-only (see ProposalBase). */
		base: jsonb().$type<ProposalBase>().notNull(),
		/** 'node'|'item'|'leg'|'day'|'list'|'att'|'trip'|'note' */
		entityKind: text().notNull(),
		/** The target id, or `payload.id` for a create; null for trip ops. */
		entityId: uuid(),
		/** Every id this proposal creates (`id` / `ids`). */
		createdIds: uuid().array().notNull().default(sql`'{}'::uuid[]`),
		/** Open proposals whose createdIds the payload references. */
		requires: uuid().array().notNull().default(sql`'{}'::uuid[]`),
		summary: text().notNull(),
		message: text(),
		status: proposalStatus().notNull().default("open"),
		authorUserId: text().references(() => user.id, { onDelete: "set null" }),
		/** Snapshots of the author when proposed. */
		authorMemberId: uuid(),
		authorName: text().notNull(),
		authorColor: smallint().notNull(),
		/** The payload was redacted at creation (guest author). */
		authorIsGuest: boolean().notNull(),
		reviewedBy: text().references(() => user.id, { onDelete: "set null" }),
		reviewedAt: timestamp({ withTimezone: true }),
		/** ≤ 200: the reject note, or the cascade reason. */
		reviewNote: text(),
		lastError: jsonb().$type<ProposalConflict>(),
		createdAt: createdAt(),
		updatedAt: updatedAt(),
	},
	(t) => [
		unique("proposals_trip_id_id_uq").on(t.tripId, t.id),
		index("proposals_trip_open_idx")
			.on(t.tripId, t.createdAt)
			.where(sql`${t.status} = 'open'`),
		index("proposals_entity_idx").on(t.tripId, t.entityKind, t.entityId),
		index("proposals_created_ids_gin")
			.using("gin", t.createdIds)
			.where(sql`${t.status} = 'open'`),
		index("proposals_author_idx").on(t.authorUserId),
		check(
			"proposals_payload_size_ck",
			sql`pg_column_size(${t.payload}) <= 32768`,
		),
		check(
			"proposals_message_ck",
			sql`${t.message} is null or char_length(${t.message}) <= 500`,
		),
		check(
			"proposals_note_ck",
			sql`${t.reviewNote} is null or char_length(${t.reviewNote}) <= 200`,
		),
		check("proposals_color_ck", sql`${t.authorColor} between 0 and 7`),
	],
);
