/**
 * `loadTripGraph` (SPEC §6.6, §13.1): the whole trip as the client's zoom engine
 * reads it — live nodes, days, items, legs and members, plus `trip.version` for
 * the missed-event check (D10). Guests get booking data redacted (§11.3).
 *
 * Raw SQL with explicit aliases, so the payload shape is visible here and
 * matches `TripGraph` in `src/lib/engine/types.ts` field for field.
 */
import { sql } from "drizzle-orm";
import { db } from "@/db/db.server";
import { mustRedact, type TripAccess } from "@/lib/auth/roles";
import type {
	GraphDay,
	GraphGuest,
	GraphItem,
	GraphLeg,
	GraphMember,
	GraphNode,
	GraphTrip,
	TripGraph,
} from "@/lib/engine/types";
import {
	type LegDetails,
	REDACTED_BOOKING_REF,
	readLegDetails,
	type StoredLegDetails,
} from "@/lib/schemas/legs";
import type { NodeDetails } from "@/lib/schemas/nodes";
import type { TripSettings } from "@/lib/schemas/trips";

type Row = Record<string, unknown>;

/** Anything with drizzle's node-postgres `execute`: the pool-backed `db` or a transaction. */
export type SqlExec = Pick<typeof db, "execute">;

/**
 * Runs the loader's queries: in parallel on the pool, one after another on a
 * transaction (a single client; node-postgres deprecates overlapping queries).
 */
async function runAll<T>(
	exec: SqlExec,
	thunks: readonly (() => Promise<T>)[],
): Promise<T[]> {
	if (exec === db) return Promise.all(thunks.map((t) => t()));
	const out: T[] = [];
	for (const t of thunks) out.push(await t());
	return out;
}

/** timestamptz (Date from node-postgres) → ISO string; null stays null. */
function iso(v: unknown): string | null {
	if (v === null || v === undefined) return null;
	if (v instanceof Date) return v.toISOString();
	return new Date(String(v)).toISOString();
}
const isoNN = (v: unknown): string => iso(v) ?? new Date(0).toISOString();
const str = (v: unknown): string | null =>
	v === null || v === undefined ? null : String(v);
const num = (v: unknown): number | null =>
	v === null || v === undefined ? null : Number(v);

/**
 * What a link guest READS: `redactLegDetails`, but a booked flight keeps the
 * fact that it is booked (`REDACTED_BOOKING_REF`), so the date what-if puts
 * it under "Needs rebooking", not "no booking ref" (QA COLLAB-R3-06).
 */
export function guestLegDetails(details: LegDetails): LegDetails {
	const out = redactLegDetails(details);
	if (
		details.kind === "flight" &&
		details.flight.bookingRef &&
		out.kind === "flight"
	)
		return {
			...out,
			flight: { ...out.flight, bookingRef: REDACTED_BOOKING_REF },
		};
	return out;
}

/** SPEC §6.6 guest redaction: refs, costs, points, fees → undefined; seats → '••'. Write paths use it (a guest's payload never carries a ref). */
export function redactLegDetails(details: LegDetails): LegDetails {
	switch (details.kind) {
		case "flight": {
			const {
				bookingRef: _r,
				cost: _c,
				points: _p,
				fees: _f,
				...flight
			} = details.flight;
			return {
				...details,
				flight: {
					...flight,
					seats: flight.seats.map((s) => ({ ...s, seat: "••" })),
				},
			};
		}
		case "transit": {
			if (!details.booking) return details;
			const { ref: _r, ...booking } = details.booking;
			return {
				...details,
				booking: {
					...booking,
					seats: booking.seats.map((s) => ({ ...s, seat: "••" })),
				},
			};
		}
		default:
			return details;
	}
}

/**
 * The trip graph for a caller whose access was already checked
 * (`requireTripRole(tripId, "viewer")`). Returns null when the trip is gone.
 */
export async function loadTripGraph(
	tripId: string,
	access: TripAccess & {
		user: { id: string; name: string; image?: string | null };
	},
	exec: SqlExec = db,
): Promise<TripGraph | null> {
	const rows = async (query: ReturnType<typeof sql>): Promise<Row[]> =>
		(await exec.execute(query)).rows as Row[];
	const [
		tripRows,
		memberRows,
		dayRows,
		nodeRows,
		itemRows,
		legRows,
		guestRows,
	] = await runAll<Row[] | null>(exec, [
		() =>
			rows(sql`
				select t.id, t.slug, t.name, t.start_date::text as "startDate", t.end_date::text as "endDate",
				       t.default_tz as "defaultTz",
				       -- ADDENDUM §9: a cover hidden from guests (or a receipt) is no cover for them.
				       ${
									mustRedact(access)
										? sql`(select a.id from attachments a
				          where a.id = t.cover_attachment_id and a.trip_id = t.id and a.deleted_at is null
				            and a.visibility = 'everyone' and a.expense_id is null)`
										: sql`t.cover_attachment_id`
								} as "coverAttachmentId",
				       t.settings, t.version, t.updated_at as "updatedAt"
				  from trips t where t.id = ${tripId} and t.deleted_at is null`),
		() =>
			rows(sql`
				select m.id, m.user_id as "userId", m.status::text as status, m.role::text as role,
				       m.color, m.display_name as "displayName", split_part(m.email, '@', 1) as "emailName",
				       m.merged_into_id as "mergedIntoId",
				       u.name as "userName", u.first_name as "firstName", u.image
				  from trip_members m
				  left join "user" u on u.id = m.user_id
				 where m.trip_id = ${tripId}
				 order by m.created_at, m.id`),
		() =>
			rows(sql`
				select id, date::text as date, start_time as "startTime", title,
				       night_node_id as "nightNodeId", updated_at as "updatedAt"
				  from trip_days where trip_id = ${tripId}
				 order by date`),
		() =>
			rows(sql`
				select n.id, n.parent_id as "parentId", n.type::text as type, n.category::text as category,
				       n.status::text as status, n.name, n.local_name as "localName", n.slug, n.description,
				       n.position, n.lat, n.lng, n.tz, n.country_code as "countryCode", n.address,
				       n.google_place_id as "googlePlaceId", n.osm_ref as "osmRef", n.bbox, n.time_needed_min as "timeNeededMin",
				       n.idea_status::text as "ideaStatus", n.shortlist_pin::text as "shortlistPin",
				       n.details, n.updated_at as "updatedAt",
				       coalesce((select jsonb_object_agg(p.member_id, p.priority)
				                   from node_priorities p where p.node_id = n.id), '{}'::jsonb) as priorities,
				       coalesce((select jsonb_object_agg(p.member_id, p.rating_comment)
				                   from node_priorities p
				                  where p.node_id = n.id and p.rating_comment is not null), '{}'::jsonb) as "ratingComments"
				  from nodes n
				 where n.trip_id = ${tripId} and n.deleted_at is null
				 order by n.position collate "C", n.id`),
		() =>
			rows(sql`
				select i.id, i.day_id as "dayId", i.node_id as "nodeId", i.title, i.note, i.position,
				       i.duration_min as "durationMin", i.pinned_start as "pinnedStart", i.fixed_date as "fixedDate", i.updated_at as "updatedAt",
				       coalesce((select array_agg(a.member_id::text order by a.member_id)
				                   from item_assignees a where a.item_id = i.id), '{}') as "assigneeIds"
				  from items i
				 where i.trip_id = ${tripId} and i.deleted_at is null
				 order by i.position collate "C", i.id`),
		() =>
			rows(sql`
				select l.id, l.kind::text as kind, l.from_item_id as "fromItemId", l.to_item_id as "toItemId",
				       l.stay_day_id as "stayDayId", l.anchor_item_id as "anchorItemId", l.mode::text as mode,
				       l.duration_min as "durationMin", l.distance_m as "distanceM", l.source::text as source,
				       l.estimate_min as "estimateMin", l.is_edited as "isEdited", l.dep_at as "depAt",
				       l.arr_at as "arrAt", l.details, l.queried_for as "queriedFor", l.updated_at as "updatedAt",
				       coalesce((select array_agg(a.member_id::text order by a.member_id)
				                   from leg_assignees a where a.leg_id = l.id), '{}') as "assigneeIds",
				       (exists (select 1 from attachments x where x.leg_id = l.id and x.deleted_at is null)
				        or exists (select 1 from list_items x where x.leg_id = l.id and x.deleted_at is null)
				        -- Private notes and private list items count too: a leg that holds
				        -- anyone's content is never dropped (it's one bit, never the content).
				        or exists (select 1 from yjs_documents x where x.leg_id = l.id and coalesce(x.plain_text, '') <> '')
				        or exists (select 1 from leg_assignees x where x.leg_id = l.id)) as "hasContent"
				  from legs l
				 where l.trip_id = ${tripId}`),
		() =>
			access.role === "owner" && !access.isGuest
				? rows(sql`
					select g.user_id as "userId", u.name, u.image, g.color, max(g.last_seen_at) as "lastSeenAt"
					  from share_grants g
					  join share_links l on l.id = g.share_link_id
					  join "user" u on u.id = g.user_id
					 where g.trip_id = ${tripId} and l.revoked_at is null
					 group by g.user_id, u.name, u.image, g.color`)
				: Promise.resolve(null),
	]);

	const t = tripRows?.[0];
	if (!t || !memberRows || !dayRows || !nodeRows || !itemRows || !legRows)
		return null;

	const trip: GraphTrip = {
		id: String(t.id),
		slug: String(t.slug),
		name: String(t.name),
		startDate: str(t.startDate),
		endDate: str(t.endDate),
		defaultTz: String(t.defaultTz ?? "UTC"),
		coverAttachmentId: str(t.coverAttachmentId),
		settings: (t.settings ?? {}) as TripSettings,
		version: Number(t.version ?? 0),
		updatedAt: isoNN(t.updatedAt),
	};

	const members: GraphMember[] = memberRows.map((m) => ({
		id: String(m.id),
		userId: str(m.userId),
		status: m.status as GraphMember["status"],
		role: m.role as GraphMember["role"],
		// SPEC §7.5: user.name when active, else displayName, else the email's
		// local part (the full email is only in the owner's getSharing).
		name:
			str(m.userName) ?? str(m.displayName) ?? (str(m.emailName) || "Someone"),
		...(m.firstName ? { firstName: String(m.firstName) } : {}),
		image: str(m.image),
		color: Number(m.color ?? 0),
		...(m.mergedIntoId ? { mergedIntoId: String(m.mergedIntoId) } : {}),
	}));

	const days: GraphDay[] = dayRows.map((d) => ({
		id: String(d.id),
		date: String(d.date),
		startTime: String(d.startTime ?? "09:00"),
		title: str(d.title),
		nightNodeId: str(d.nightNodeId),
		updatedAt: isoNN(d.updatedAt),
	}));

	const nodes: GraphNode[] = nodeRows.map((n) => ({
		id: String(n.id),
		parentId: str(n.parentId),
		type: n.type as GraphNode["type"],
		category: (n.category ?? null) as GraphNode["category"],
		status: n.status as GraphNode["status"],
		name: String(n.name),
		localName: str(n.localName),
		slug: String(n.slug),
		description: str(n.description),
		position: String(n.position),
		lat: num(n.lat),
		lng: num(n.lng),
		tz: str(n.tz),
		countryCode: str(n.countryCode),
		address: str(n.address),
		googlePlaceId: str(n.googlePlaceId),
		osmRef: str(n.osmRef),
		bbox: (n.bbox ?? null) as GraphNode["bbox"],
		timeNeededMin: num(n.timeNeededMin),
		ideaStatus: (n.ideaStatus ?? "idea") as NonNullable<
			GraphNode["ideaStatus"]
		>,
		shortlistPin: (n.shortlistPin ?? "auto") as NonNullable<
			GraphNode["shortlistPin"]
		>,
		details: (n.details ?? {}) as NodeDetails,
		priorities: (n.priorities ?? {}) as GraphNode["priorities"],
		ratingComments: (n.ratingComments ?? {}) as GraphNode["ratingComments"],
		updatedAt: isoNN(n.updatedAt),
	}));

	const items: GraphItem[] = itemRows.map((i) => ({
		id: String(i.id),
		dayId: str(i.dayId),
		nodeId: str(i.nodeId),
		title: str(i.title),
		note: str(i.note),
		position: String(i.position),
		durationMin: Number(i.durationMin ?? 0),
		pinnedStart: str(i.pinnedStart),
		fixedDate: Boolean(i.fixedDate),
		assigneeIds: (i.assigneeIds as string[] | null) ?? [],
		updatedAt: isoNN(i.updatedAt),
	}));

	const redact = access.isGuest;
	const legs: GraphLeg[] = legRows.map((l) => {
		const details = readLegDetails(l.details);
		return {
			id: String(l.id),
			kind: l.kind as GraphLeg["kind"],
			fromItemId: str(l.fromItemId),
			toItemId: str(l.toItemId),
			stayDayId: str(l.stayDayId),
			anchorItemId: str(l.anchorItemId),
			mode: (l.mode ?? null) as GraphLeg["mode"],
			durationMin: num(l.durationMin),
			distanceM: num(l.distanceM),
			source: l.source as GraphLeg["source"],
			estimateMin: num(l.estimateMin),
			isEdited: Boolean(l.isEdited),
			depAt: iso(l.depAt),
			arrAt: iso(l.arrAt),
			details: (redact
				? guestLegDetails(details)
				: (l.details ?? {})) as StoredLegDetails,
			queriedFor: iso(l.queriedFor),
			assigneeIds: (l.assigneeIds as string[] | null) ?? [],
			hasContent: Boolean(l.hasContent),
			updatedAt: isoNN(l.updatedAt),
		};
	});

	const me = members.find((m) => m.id === access.memberId);
	const graph: TripGraph = {
		trip,
		me: {
			userId: access.user.id,
			memberId: access.memberId,
			role: access.role,
			isGuest: access.isGuest,
			name: me?.name ?? access.user.name,
			color: access.color,
			image: me ? (me.image ?? null) : (access.user.image ?? null),
		},
		members,
		days,
		nodes,
		items,
		legs,
	};
	if (guestRows) {
		graph.guests = guestRows.map(
			(g): GraphGuest => ({
				userId: String(g.userId),
				name: String(g.name),
				color: Number(g.color ?? 0),
				image: str(g.image),
				lastSeenAt: isoNN(g.lastSeenAt),
			}),
		);
	}
	return graph;
}

/**
 * The graph as the server's own code sees it (reconcileLegs, day operations,
 * autofill, the fixture writer): nothing redacted, no guests list, and a
 * system `me`. Pass the transaction to read the uncommitted state.
 */
export function loadGraphForServer(
	exec: SqlExec,
	tripId: string,
): Promise<TripGraph | null> {
	return loadTripGraph(
		tripId,
		{
			tripId,
			slug: "",
			role: "editor",
			memberId: null,
			isGuest: false,
			color: 0,
			user: { id: "system", name: "system" },
		},
		exec,
	);
}
