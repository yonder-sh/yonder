/**
 * Days, timeline items, legs and their assignees (SPEC §6.3 timeline.ts, §7.6–§7.9).
 *
 * - `items.day_id IS NULL` = Unscheduled. `items → trip_days` is NO ACTION, so a
 *   day that still has items can't be deleted (§7.7).
 * - The custom migration (§6.4) re-creates `trip_days_trip_date_uq` DEFERRABLE
 *   and adds `trip_days_night_node_fk` with `ON DELETE SET NULL (night_node_id)`.
 * - Pair legs are keyed by `(from_item_id, to_item_id)` (D12); stay legs by
 *   `(stay_day_id, kind)` (D17).
 */
import { sql } from "drizzle-orm";
import {
	boolean,
	check,
	date,
	foreignKey,
	index,
	integer,
	jsonb,
	pgTable,
	primaryKey,
	text,
	timestamp,
	unique,
	uniqueIndex,
	uuid,
} from "drizzle-orm/pg-core";
import type { StoredLegDetails, TransitRoute } from "../../lib/schemas/legs";
import {
	createdAt,
	deletedAt,
	HHMM_PATTERN,
	pk,
	sortKey,
	updatedAt,
} from "./_columns";
import { user } from "./auth";
import { legKind, legMode, legSource } from "./enums";
import { nodes } from "./nodes";
import { tripMembers, tripRef } from "./trips";

export const tripDays = pgTable(
	"trip_days",
	{
		id: pk(),
		tripId: tripRef(),
		date: date({ mode: "string" }).notNull(),
		/** Local `HH:mm` the day starts at (the trip's `defaultDayStart` when created). */
		startTime: text().notNull().default("09:00"),
		/** e.g. "Haneda + Shibuya (arrival)". */
		title: text(),
		/** STAY: where you sleep after this day (D17). FK in the custom migration (SET NULL). */
		nightNodeId: uuid(),
		createdAt: createdAt(),
		updatedAt: updatedAt(),
	},
	(t) => [
		unique("trip_days_trip_id_id_uq").on(t.tripId, t.id),
		// Re-created DEFERRABLE INITIALLY DEFERRED in the custom migration (§6.4).
		unique("trip_days_trip_date_uq").on(t.tripId, t.date),
		index("trip_days_night_node_idx").on(t.nightNodeId),
		check("trip_days_start_ck", sql`${t.startTime} ~ ${HHMM_PATTERN}`),
	],
);

export const items = pgTable(
	"items",
	{
		id: pk(),
		tripId: tripRef(),
		/** Null = Unscheduled (keeps its duration and order, has no times). */
		dayId: uuid(),
		/** Null = an unlocated block ("Lunch"). */
		nodeId: uuid(),
		/** Overrides the node name when set. */
		title: text(),
		/** Markdown (inline + lists) with mention tokens (§7.10). */
		note: text(),
		position: sortKey().notNull(),
		durationMin: integer().notNull().default(60),
		/** `HH:mm` in the item's local zone (§9.2 after-midnight rule). */
		pinnedStart: text(),
		/** E2 "Booked for this date": a date shift lists it under Needs rebooking. */
		fixedDate: boolean().notNull().default(false),
		createdBy: text().references(() => user.id, { onDelete: "set null" }),
		createdAt: createdAt(),
		updatedAt: updatedAt(),
		deletedAt: deletedAt(),
	},
	(t) => [
		unique("items_trip_id_id_uq").on(t.tripId, t.id),
		// NO ACTION: deleting a day with items fails; the day fns move them first.
		foreignKey({
			name: "items_day_fk",
			columns: [t.tripId, t.dayId],
			foreignColumns: [tripDays.tripId, tripDays.id],
		}),
		foreignKey({
			name: "items_node_fk",
			columns: [t.tripId, t.nodeId],
			foreignColumns: [nodes.tripId, nodes.id],
		}).onDelete("cascade"),
		index("items_day_pos_idx")
			.on(t.dayId, t.position)
			.where(sql`${t.deletedAt} is null`),
		// Non-partial: used by the FK checks from trip_days.
		index("items_day_idx").on(t.tripId, t.dayId),
		index("items_node_idx").on(t.nodeId),
		check(
			"items_located_or_titled_ck",
			sql`${t.nodeId} is not null or ${t.title} is not null`,
		),
		check("items_duration_ck", sql`${t.durationMin} between 0 and 4320`),
		check(
			"items_pinned_ck",
			sql`${t.pinnedStart} is null or ${t.pinnedStart} ~ ${HHMM_PATTERN}`,
		),
	],
);

/** Member tags on an item ("who is going"). */
export const itemAssignees = pgTable(
	"item_assignees",
	{
		tripId: uuid().notNull(),
		itemId: uuid().notNull(),
		memberId: uuid().notNull(),
	},
	(t) => [
		primaryKey({ columns: [t.itemId, t.memberId] }),
		foreignKey({
			name: "item_assignees_item_fk",
			columns: [t.tripId, t.itemId],
			foreignColumns: [items.tripId, items.id],
		}).onDelete("cascade"),
		foreignKey({
			name: "item_assignees_member_fk",
			columns: [t.tripId, t.memberId],
			foreignColumns: [tripMembers.tripId, tripMembers.id],
		}).onDelete("cascade"),
		index("item_assignees_member_idx").on(t.memberId),
		index("item_assignees_trip_idx").on(t.tripId),
	],
);

export const legs = pgTable(
	"legs",
	{
		id: pk(),
		tripId: tripRef(),
		kind: legKind().notNull().default("pair"),
		/** kind 'pair'. */
		fromItemId: uuid(),
		toItemId: uuid(),
		/** 'stay_start' (previous night's stay → first stop) | 'stay_end' (last stop → this night's stay). */
		stayDayId: uuid(),
		/** Stay legs: the first/last located item the values were computed for (no FK; stale when it changes). */
		anchorItemId: uuid(),
		/** Null = not chosen (the row exists because content was attached). */
		mode: legMode(),
		/** walk/transit/other; null for timed legs (from dep/arr). */
		durationMin: integer(),
		distanceM: integer(),
		source: legSource().notNull().default("manual"),
		/** Last provider estimate → "Reset to 12m". */
		estimateMin: integer(),
		isEdited: boolean().notNull().default(false),
		/** TIMED legs only: flights, and transit with `details.fixed`. */
		depAt: timestamp({ withTimezone: true }),
		arrAt: timestamp({ withTimezone: true }),
		/** `{}` (the default) reads as `{ kind: 'none' }`; use `readLegDetails`. */
		details: jsonb().$type<StoredLegDetails>().notNull().default({}),
		/** Fetched + manual route options. NOT in the graph payload. */
		alternatives: jsonb().$type<TransitRoute[]>(),
		queriedFor: timestamp({ withTimezone: true }),
		queriedAt: timestamp({ withTimezone: true }),
		createdBy: text().references(() => user.id, { onDelete: "set null" }),
		createdAt: createdAt(),
		updatedAt: updatedAt(),
	},
	(t) => [
		unique("legs_trip_id_id_uq").on(t.tripId, t.id),
		foreignKey({
			name: "legs_from_fk",
			columns: [t.tripId, t.fromItemId],
			foreignColumns: [items.tripId, items.id],
		}).onDelete("cascade"),
		foreignKey({
			name: "legs_to_fk",
			columns: [t.tripId, t.toItemId],
			foreignColumns: [items.tripId, items.id],
		}).onDelete("cascade"),
		foreignKey({
			name: "legs_stay_day_fk",
			columns: [t.tripId, t.stayDayId],
			foreignColumns: [tripDays.tripId, tripDays.id],
		}).onDelete("cascade"),
		uniqueIndex("legs_pair_uq")
			.on(t.fromItemId, t.toItemId)
			.where(sql`${t.kind} = 'pair'`),
		uniqueIndex("legs_stay_uq")
			.on(t.stayDayId, t.kind)
			.where(sql`${t.kind} <> 'pair'`),
		index("legs_trip_idx").on(t.tripId),
		// Non-partial, for the FK checks and cascades (the unique indexes above are partial).
		index("legs_from_idx").on(t.fromItemId),
		index("legs_to_idx").on(t.toItemId),
		index("legs_stay_day_idx").on(t.stayDayId),
		check(
			"legs_shape_ck",
			sql`(${t.kind} = 'pair' and ${t.fromItemId} is not null and ${t.toItemId} is not null
				and ${t.stayDayId} is null and ${t.fromItemId} <> ${t.toItemId})
			or (${t.kind} <> 'pair' and ${t.fromItemId} is null and ${t.toItemId} is null and ${t.stayDayId} is not null)`,
		),
		// A flight joins two stops. Its times are optional (FEEDBACK-3 FB-18:
		// airports and dates first, times later): both instants or neither.
		check(
			"legs_flight_ck",
			sql`${t.mode} is distinct from 'flight' or (${t.kind} = 'pair' and (${t.depAt} is null) = (${t.arrAt} is null))`,
		),
		check(
			"legs_timed_order_ck",
			sql`${t.depAt} is null or ${t.arrAt} is null or ${t.arrAt} > ${t.depAt}`,
		),
		check(
			"legs_minutes_ck",
			sql`(${t.durationMin} is null or ${t.durationMin} >= 0)
			and (${t.estimateMin} is null or ${t.estimateMin} >= 0)
			and (${t.distanceM} is null or ${t.distanceM} >= 0)`,
		),
	],
);

/** Travellers on a leg (defaults from `FlightDetails.seats`). */
export const legAssignees = pgTable(
	"leg_assignees",
	{
		tripId: uuid().notNull(),
		legId: uuid().notNull(),
		memberId: uuid().notNull(),
	},
	(t) => [
		primaryKey({ columns: [t.legId, t.memberId] }),
		foreignKey({
			name: "leg_assignees_leg_fk",
			columns: [t.tripId, t.legId],
			foreignColumns: [legs.tripId, legs.id],
		}).onDelete("cascade"),
		foreignKey({
			name: "leg_assignees_member_fk",
			columns: [t.tripId, t.memberId],
			foreignColumns: [tripMembers.tripId, tripMembers.id],
		}).onDelete("cascade"),
		index("leg_assignees_member_idx").on(t.memberId),
		index("leg_assignees_trip_idx").on(t.tripId),
	],
);
