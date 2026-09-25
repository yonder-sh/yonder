/**
 * The place hierarchy and per-member priorities (SPEC §6.3 nodes.ts, §7.1–§7.4).
 *
 * Arbitrary depth through `parent_id`; type-rank rules are enforced in
 * `nodes.functions.ts`. The custom migration `tree_guards` (§6.4) adds the live
 * sibling-slug unique index and the cycle-prevention trigger, which Drizzle
 * can't express.
 */
import { sql } from "drizzle-orm";
import {
	check,
	doublePrecision,
	foreignKey,
	index,
	integer,
	jsonb,
	pgTable,
	primaryKey,
	text,
	unique,
	uuid,
} from "drizzle-orm/pg-core";
import type { BBox, NodeDetails } from "../../lib/schemas/nodes";
import { createdAt, deletedAt, pk, sortKey, updatedAt } from "./_columns";
import { user } from "./auth";
import {
	ideaStatus,
	nodeStatus,
	nodeType,
	placeCategory,
	priorityLevel,
	shortlistPin,
} from "./enums";
import { tripMembers, tripRef } from "./trips";

export const nodes = pgTable(
	"nodes",
	{
		id: pk(),
		tripId: tripRef(),
		/** Null = a child of the trip root. */
		parentId: uuid(),
		type: nodeType().notNull(),
		/** Only for `place` nodes. */
		category: placeCategory(),
		status: nodeStatus().notNull().default("active"),
		name: text().notNull(),
		/** Name in the local script (東京), rendered with the Noto fallbacks. */
		localName: text(),
		/** Unique among live siblings (custom index `nodes_sibling_slug_uq`). */
		slug: text().notNull(),
		/** One plain line: what it is. */
		description: text(),
		position: sortKey().notNull(),
		lat: doublePrecision(),
		lng: doublePrecision(),
		/** IANA; written by the server from `geo-tz/all` whenever coordinates are set (§7.4). */
		tz: text(),
		/** ISO 3166-1 alpha-2. */
		countryCode: text(),
		address: text(),
		/** The ONLY Google identifier stored permanently (ToS, §14.1). */
		googlePlaceId: text(),
		/** OSM reference from Photon, e.g. `N123456` / `W789` / `R42`. */
		osmRef: text(),
		bbox: jsonb().$type<BBox>(),
		/** Time Needed in minutes (§7.2); null → category/type default. */
		timeNeededMin: integer(),
		/**
		 * docs/PLACES.md §3/§7: the explicit lifecycle decision (Idea, Shortlist,
		 * Dropped; Scheduled is derived). Kept in step with `shortlistPin` and
		 * `status` by `updateNodeCore`.
		 */
		ideaStatus: ideaStatus().notNull().default("idea"),
		/** The shortlist override: `auto` follows the group score. */
		shortlistPin: shortlistPin().notNull().default("auto"),
		details: jsonb().$type<NodeDetails>().notNull().default({}),
		createdBy: text().references(() => user.id, { onDelete: "set null" }),
		createdAt: createdAt(),
		updatedAt: updatedAt(),
		deletedAt: deletedAt(),
	},
	(t) => [
		unique("nodes_trip_id_id_uq").on(t.tripId, t.id),
		foreignKey({
			name: "nodes_parent_fk",
			columns: [t.tripId, t.parentId],
			foreignColumns: [t.tripId, t.id],
		}).onDelete("cascade"),
		index("nodes_trip_live_idx")
			.on(t.tripId)
			.where(sql`${t.deletedAt} is null`),
		index("nodes_parent_pos_idx").on(t.parentId, t.position),
		index("nodes_trip_gpid_idx").on(t.tripId, t.googlePlaceId),
		check(
			"nodes_category_ck",
			sql`${t.category} is null or ${t.type} = 'place'`,
		),
		check("nodes_latlng_ck", sql`(${t.lat} is null) = (${t.lng} is null)`),
		check(
			"nodes_latlng_range_ck",
			sql`${t.lat} is null or (${t.lat} between -90 and 90 and ${t.lng} between -180 and 180)`,
		),
		check(
			"nodes_country_code_ck",
			sql`${t.countryCode} is null or ${t.countryCode} ~ '^[A-Z]{2}$'`,
		),
		check(
			"nodes_time_needed_ck",
			sql`${t.timeNeededMin} is null or ${t.timeNeededMin} between 0 and 4320`,
		),
	],
);

/** One rating per member per node. No row = not rated (never a tier). */
export const nodePriorities = pgTable(
	"node_priorities",
	{
		tripId: uuid().notNull(),
		nodeId: uuid().notNull(),
		memberId: uuid().notNull(),
		priority: priorityLevel().notNull(),
		/**
		 * ADDENDUM §10 rate screen: the member's short comment on their own rating
		 * ("only if we have time after Nishiki"); may carry mention tokens.
		 */
		ratingComment: text(),
		updatedAt: updatedAt(),
	},
	(t) => [
		primaryKey({ columns: [t.nodeId, t.memberId] }),
		// ≤ 280 as read is checked by `RatingComment`; the stored text keeps
		// its mention tokens (PLAN-R3-03: RATING_COMMENT_STORED_MAX).
		check(
			"node_priorities_comment_ck",
			sql`${t.ratingComment} is null or char_length(${t.ratingComment}) <= 8000`,
		),
		foreignKey({
			name: "node_priorities_node_fk",
			columns: [t.tripId, t.nodeId],
			foreignColumns: [nodes.tripId, nodes.id],
		}).onDelete("cascade"),
		foreignKey({
			name: "node_priorities_member_fk",
			columns: [t.tripId, t.memberId],
			foreignColumns: [tripMembers.tripId, tripMembers.id],
		}).onDelete("cascade"),
		index("node_priorities_member_idx").on(t.memberId),
		index("node_priorities_trip_idx").on(t.tripId),
	],
);
