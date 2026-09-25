/**
 * Trip reads (SPEC §13.1): the graph, bundle counts, activity and the
 * capability flags.
 */
import { createServerFn } from "@tanstack/react-start";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db/db.server";
import { can, mustRedact } from "@/lib/auth/roles";
import type {
	Counts,
	GraphNode,
	TripCounts,
	TripGraph,
} from "@/lib/engine/types";
import {
	actorDisplayName,
	actorIsGuestSql,
	memberOnlyVerbsGuard,
} from "@/server/activity.server";
import { requireTripRole } from "@/server/authz/access.server";
import { withSession, withUser } from "@/server/authz/middleware";
import { fail } from "@/server/authz/session.server";
import { autofillSweep } from "@/server/autofill-sweep.server";
import { getEnv } from "@/server/env.server";
import { loadTripGraph } from "@/server/graph.server";
import { jpRailAvailable } from "@/server/jp-rail.server";

const TripIdInput = z.object({ tripId: z.uuid() }).strict();

/** A JSON value (what `jsonb` columns hold). */
export type Json =
	| string
	| number
	| boolean
	| null
	| Json[]
	| { [key: string]: Json };

/**
 * `TripGraph` as it travels. Identical at runtime; only `nodes[].details`
 * (a loose zod object whose index signature is `unknown`, which Start's
 * serializability check rejects) is typed as JSON. `tripGraphQuery` casts it
 * back to `TripGraph`.
 */
export type TripGraphWire = Omit<TripGraph, "nodes"> & {
	nodes: (Omit<GraphNode, "details"> & { details: { [key: string]: Json } })[];
};

/**
 * The whole trip for the zoom engine (§6.6), redacted for guests, with
 * `trip.version` for the live missed-event check.
 */
export const getTripGraph = createServerFn({ method: "GET" })
	.middleware([withUser])
	.validator(TripIdInput)
	.handler(async ({ data, context }): Promise<TripGraphWire> => {
		const access = await requireTripRole(data.tripId, "viewer", context.user);
		const graph = await loadTripGraph(data.tripId, access);
		if (!graph) return fail("NOT_FOUND");
		if (access.isGuest) {
			// Owners see when guests were last around; throttled to one write per 5 min.
			await db.execute(sql`
				update share_grants set last_seen_at = now()
				 where trip_id = ${data.tripId} and user_id = ${context.user.id}
				   and last_seen_at < now() - interval '5 minutes'`);
		}
		// §10.9: at most once an hour per trip, an editor's load re-queues autofill
		// for unset legs (heals jobs lost between a commit and its enqueue).
		if (can(access, "edit")) void autofillSweep(graph);
		return graph as TripGraphWire;
	});

const EMPTY: Counts = {
	media: 0,
	links: 0,
	todoOpen: 0,
	todo: 0,
	shopOpen: 0,
	shop: 0,
	hasNote: false,
	docs: 0,
};

type TargetRow = {
	nodeId: string | null;
	legId: string | null;
	itemId: string | null;
	dayId: string | null;
};

/**
 * Bundle counts per target (§6.6): media, links, todos, shopping, notes.
 * Privacy (ADDENDUM §7.2, EXTENSIONS §8.3): other people's private list items
 * and private notes never count; receipts (attachments on an expense) are
 * money, counted by WP-Money, never here.
 */
export const getTripCounts = createServerFn({ method: "GET" })
	.middleware([withUser])
	.validator(TripIdInput)
	.handler(async ({ data, context }): Promise<TripCounts> => {
		const access = await requireTripRole(data.tripId, "viewer", context.user);
		const me = context.user.id;
		// ADDENDUM §9: link guests never count `members`-only attachments.
		const guest = mustRedact(access);
		const res = await db.execute(sql`
			with t as (
				select node_id, leg_id, item_id, day_id,
				       count(*) filter (where kind in ('photo', 'video')) as media,
				       count(*) filter (where kind in ('link', 'embed')) as links,
				       count(*) filter (where kind = 'pdf') as docs,
				       0 as todo_open, 0 as todo, 0 as shop_open, 0 as shop, false as has_note
				  from attachments
				 where trip_id = ${data.tripId} and deleted_at is null and status <> 'failed'
				   and expense_id is null
				   ${guest ? sql`and visibility = 'everyone'` : sql``}
				 group by 1, 2, 3, 4
				union all
				select node_id, leg_id, item_id, day_id, 0, 0, 0,
				       count(*) filter (where list = 'todo' and status = 'open'),
				       count(*) filter (where list = 'todo'),
				       count(*) filter (where list = 'shopping' and status = 'open'),
				       count(*) filter (where list = 'shopping'),
				       false
				  from list_items
				 where trip_id = ${data.tripId} and deleted_at is null
				   and (not is_private or created_by = ${me})
				 group by 1, 2, 3, 4
				union all
				select node_id, leg_id, item_id, day_id, 0, 0, 0, 0, 0, 0, 0,
				       bool_or(coalesce(plain_text, '') <> '')
				  from yjs_documents
				 where trip_id = ${data.tripId}
				   and (owner_user_id is null or owner_user_id = ${me})
				 group by 1, 2, 3, 4
			)
			select node_id as "nodeId", leg_id as "legId", item_id as "itemId", day_id as "dayId",
			       sum(media)::int as media, sum(links)::int as links, sum(docs)::int as docs,
			       sum(todo_open)::int as "todoOpen", sum(todo)::int as todo,
			       sum(shop_open)::int as "shopOpen", sum(shop)::int as shop,
			       bool_or(has_note) as "hasNote"
			  from t group by 1, 2, 3, 4`);
		const out: TripCounts = {
			root: { ...EMPTY },
			byNode: {},
			byLeg: {},
			byItem: {},
			byDay: {},
		};
		for (const r of res.rows as unknown as (TargetRow & Counts)[]) {
			const c: Counts = {
				media: Number(r.media),
				links: Number(r.links),
				docs: Number(r.docs),
				todoOpen: Number(r.todoOpen),
				todo: Number(r.todo),
				shopOpen: Number(r.shopOpen),
				shop: Number(r.shop),
				hasNote: Boolean(r.hasNote),
			};
			if (r.nodeId) out.byNode[r.nodeId] = c;
			else if (r.legId) out.byLeg[r.legId] = c;
			else if (r.itemId) out.byItem[r.itemId] = c;
			else if (r.dayId) out.byDay[r.dayId] = c;
			else out.root = c;
		}
		return out;
	});

export type ActivityEntry = {
	id: string;
	at: string;
	/** A link guest's name always ends in "(guest)" (SECURITY §2). */
	actorName: string;
	actorColor: number | null;
	/** A link guest did it (a mark the guest can't fake or drop). */
	actorIsGuest: boolean;
	/** "moved Itoya to Day 4". */
	summary: string;
	nodeId: string | null;
	legId: string | null;
	itemId: string | null;
	dayId: string | null;
};

/**
 * Recent activity for the inspector footer (WP-Shell) and the trip overview.
 * Guests never see money rows (`expense.*`, EXTENSIONS §8.5).
 */
export const listActivity = createServerFn({ method: "GET" })
	.middleware([withUser])
	.validator(
		z
			.object({
				tripId: z.uuid(),
				nodeId: z.uuid().optional(),
				legId: z.uuid().optional(),
				itemId: z.uuid().optional(),
				dayId: z.uuid().optional(),
				limit: z.number().int().min(1).max(100).default(20),
			})
			.strict(),
	)
	.handler(async ({ data, context }): Promise<ActivityEntry[]> => {
		const access = await requireTripRole(data.tripId, "viewer", context.user);
		const res = await db.execute(sql`
			select a.id::text as id, a.created_at as at, a.actor_name as "actorName",
			       coalesce(
			         (select m.color from trip_members m where m.trip_id = a.trip_id and m.user_id = a.actor_user_id limit 1),
			         (select g.color from share_grants g where g.trip_id = a.trip_id and g.user_id = a.actor_user_id limit 1)
			       ) as "actorColor",
			       ${actorIsGuestSql()} as "actorIsGuest",
			       a.summary, a.node_id::text as "nodeId", a.leg_id::text as "legId",
			       a.item_id::text as "itemId", a.day_id::text as "dayId"
			  from activity_log a
			 where a.trip_id = ${data.tripId}
			   ${memberOnlyVerbsGuard(sql`a.verb`, mustRedact(access))}
			   ${data.nodeId ? sql`and a.node_id = ${data.nodeId}` : sql``}
			   ${data.legId ? sql`and a.leg_id = ${data.legId}` : sql``}
			   ${data.itemId ? sql`and a.item_id = ${data.itemId}` : sql``}
			   ${data.dayId ? sql`and a.day_id = ${data.dayId}` : sql``}
			 order by a.created_at desc, a.id desc
			 limit ${data.limit}`);
		return (res.rows as Record<string, unknown>[]).map((r) => ({
			id: String(r.id),
			at: new Date(r.at as string | Date).toISOString(),
			actorName: actorDisplayName(String(r.actorName), r.actorIsGuest === true),
			actorIsGuest: r.actorIsGuest === true,
			actorColor:
				r.actorColor === null || r.actorColor === undefined
					? null
					: Number(r.actorColor),
			summary: String(r.summary),
			nodeId: (r.nodeId as string | null) ?? null,
			legId: (r.legId as string | null) ?? null,
			itemId: (r.itemId as string | null) ?? null,
			dayId: (r.dayId as string | null) ?? null,
		}));
	});

export type Capabilities = {
	google: boolean;
	navitime: boolean;
	/**
	 * The offline Japan rail estimate (ADDENDUM §5): true once `pnpm data:jp`
	 * has written `src/data/jp-rail/manifest.json`.
	 */
	jpRail: boolean;
	/** E3 climate normals (CLIMATE_ENABLED, default on). */
	climate: boolean;
	/** E5 FX conversion (FX_URL set). */
	fx: boolean;
	email: "resend" | "smtp" | "console";
};

/** Which optional integrations are configured (no secrets, just flags). */
export const getCapabilities = createServerFn({ method: "GET" })
	.middleware([withSession])
	.handler(async (): Promise<Capabilities> => {
		const env = getEnv();
		return {
			google: Boolean(env.GOOGLE_MAPS_API_KEY),
			navitime: Boolean(env.NAVITIME_RAPIDAPI_KEY),
			jpRail: await jpRailAvailable(),
			climate: env.CLIMATE_ENABLED,
			fx: Boolean(env.FX_URL),
			email: process.env.RESEND_API_KEY
				? "resend"
				: process.env.SMTP_HOST
					? "smtp"
					: "console",
		};
	});
