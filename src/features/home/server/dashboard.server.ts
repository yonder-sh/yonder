/**
 * Dashboard reads (SPEC §13.6; EXTENSIONS §1.4, §7 "Dashboard", §9
 * "Dashboard"): my trips with their card extras, and my upcoming deadlines.
 * Server-only; `dashboard.functions.ts` wraps them.
 *
 * Privacy (CONTRACTS §1 rule 11): another member's PRIVATE list items never
 * reach my deadlines or counts; guests (link access only) never see money
 * activity in "N changes"; private-note mentions never count as unread.
 */
import { sql } from "drizzle-orm";
import { db } from "@/db/db.server";
import type { TripRole } from "@/lib/auth/roles";
import { addDays, safeTimeZone, zonedEpoch } from "@/lib/engine/time";
import { mediaUrl } from "@/lib/media-url";
import type { DueKind } from "@/lib/schemas/enums";
import type { DueRule } from "@/lib/schemas/lists";
import { MEMBER_ONLY_VERB_PREFIXES } from "@/server/activity.server";
import type { MyDeadline, MyTrip, MyTripMember } from "../types";

const ROLE_RANK_SQL = sql`case role when 'owner' then 0 when 'editor' then 1 when 'suggester' then 2 when 'rater' then 3 else 4 end`;

/** Trips where I'm an active member or hold a live grant, with the card extras. */
export async function loadMyTrips(userId: string): Promise<MyTrip[]> {
	const res = await db.execute(sql`
		with mine as (
			select m.trip_id, m.role::text as role, false as via_link, m.id as member_id
			  from trip_members m where m.user_id = ${userId} and m.status = 'active'
			union all
			select g.trip_id, l.role::text, true, null::uuid
			  from share_grants g join share_links l on l.id = g.share_link_id
			 where g.user_id = ${userId} and l.enabled and l.revoked_at is null
			   and (l.expires_at is null or l.expires_at > now())
		), best as (
			select distinct on (trip_id) trip_id, role, via_link, member_id from mine
			 order by trip_id, via_link, ${ROLE_RANK_SQL}
		)
		select t.id, t.slug, t.name, t.start_date::text as "startDate", t.end_date::text as "endDate",
		       b.role, b.via_link as "viaLink", b.member_id::text as "memberId", t.updated_at as "updatedAt",
		       (select count(*)::int from trip_members m where m.trip_id = t.id and m.status = 'active') as "memberCount",
		       coalesce((select json_agg(x) from (
		           select m.id, coalesce(u.name, m.display_name, 'Someone') as name, m.color, u.image
		             from trip_members m left join "user" u on u.id = m.user_id
		            where m.trip_id = t.id and m.status = 'active'
		            order by (m.role = 'owner') desc, m.created_at limit 5) x), '[]') as members,
		       (select coalesce(u.name, m.display_name) from trip_members m left join "user" u on u.id = m.user_id
		         where m.trip_id = t.id and m.role = 'owner' limit 1) as "ownerName",
		       coalesce((select array_agg(x.cc order by x.pos) from (
		                   select n.country_code as cc, min(n.position) as pos from nodes n
		                    where n.trip_id = t.id and n.deleted_at is null and n.country_code is not null
		                      and n.type = 'country' and n.status = 'active'
		                    group by n.country_code) x), '{}') as "countryNodes",
		       coalesce((select array_agg(distinct n.country_code) from nodes n
		                  where n.trip_id = t.id and n.deleted_at is null and n.country_code is not null), '{}') as "countryCodes",
		       (select a.id::text from attachments a
		         where a.id = t.cover_attachment_id and a.trip_id = t.id and a.deleted_at is null
		           and a.kind in ('photo', 'video') and a.expense_id is null
		           and (not b.via_link or a.visibility = 'everyone')) as "coverId",
		       (select count(*)::int from mentions mn
		          left join list_items li on li.id = mn.list_item_id
		         where mn.trip_id = t.id and mn.member_id = b.member_id and mn.read_at is null
		           and (mn.doc_name is null or mn.doc_name not like '%/u/%')
		           and (li.id is null or (li.deleted_at is null and (not li.is_private or li.created_by = ${userId})))
		           and not exists (select 1 from inbox_reads r where r.user_id = ${userId}
		                            and r.item_key = 'mention:' || mn.id::text)) as "unreadMentions",
		       (select least(count(*), 100)::int from (
		           select 1 from activity_log a, trip_seen s
		            where s.trip_id = t.id and s.user_id = ${userId}
		              and a.trip_id = t.id and a.version > s.seen_version
		              and a.actor_user_id is distinct from ${userId}
		              and (not b.via_link or not (a.verb like any (${sql.param(MEMBER_ONLY_VERB_PREFIXES.map((p) => `${p}%`))}::text[])))
		            limit 100) c) as "changesSince",
		       case when b.role in ('owner', 'editor') and not b.via_link then
		         (select count(*)::int from proposals p
		           where p.trip_id = t.id and p.status = 'open' and p.author_user_id is distinct from ${userId})
		       else 0 end as "openProposals"
		  from best b join trips t on t.id = b.trip_id and t.deleted_at is null
		 order by t.start_date nulls last, t.name`);
	const rows = res.rows as Record<string, unknown>[];
	const ids = rows.map((r) => String(r.id));
	const [points, deadlines] = await Promise.all([
		routePointsFor(ids),
		loadDeadlineRows(userId, ids),
	]);
	const now = Date.now();
	const overdue = new Map<string, number>();
	for (const d of deadlines)
		if (
			d.mine !== undefined &&
			d.at !== undefined &&
			d.at < now &&
			d.dueKind !== "opens"
		)
			overdue.set(d.tripId, (overdue.get(d.tripId) ?? 0) + 1);
	return rows.map((r) => {
		const start = (r.startDate as string | null) ?? null;
		const end = (r.endDate as string | null) ?? null;
		const countries = (r.countryNodes as string[] | null)?.length
			? (r.countryNodes as string[])
			: ((r.countryCodes as string[]) ?? []);
		return {
			id: String(r.id),
			slug: String(r.slug),
			name: String(r.name),
			startDate: start,
			endDate: end,
			role: r.role as TripRole,
			viaLink: Boolean(r.viaLink),
			members: ((r.members as MyTripMember[]) ?? []).map((m) => ({
				...m,
				color: Number(m.color),
			})),
			memberCount: Number(r.memberCount ?? 0),
			countryCodes: countries,
			coverUrl: r.coverId ? mediaUrl(String(r.coverId), "display") : null,
			routePoints: points.get(String(r.id)) ?? [],
			unreadMentions: Number(r.unreadMentions ?? 0),
			updatedAt: new Date(r.updatedAt as string | Date).toISOString(),
			changesSince: Number(r.changesSince ?? 0),
			openProposals: Number(r.openProposals ?? 0),
			overdue: overdue.get(String(r.id)) ?? 0,
			ownerName: (r.ownerName as string | null) ?? null,
			dayCount:
				start && end
					? Math.round(
							(Date.parse(`${end}T00:00:00Z`) -
								Date.parse(`${start}T00:00:00Z`)) /
								86_400_000,
						) + 1
					: null,
		};
	});
}

/** Max points per sketch: enough for a 35-day, 4-country trip. */
const MAX_ROUTE_POINTS = 40;

/**
 * City-level route points per trip, in trip order: each scheduled item's
 * nearest `city` ancestor (with coordinates), by day then position, with
 * consecutive repeats collapsed. Trips with nothing scheduled fall back to
 * their cities (then countries) in tree order.
 */
export async function routePointsFor(
	tripIds: string[],
): Promise<Map<string, [number, number][]>> {
	const out = new Map<string, [number, number][]>();
	if (!tripIds.length) return out;
	const ids = sql.param(tripIds);
	const visits = await db.execute(sql`
		with recursive anc as (
			select n.trip_id, n.id as start_id, n.id, n.parent_id, n.type::text as type, n.lat, n.lng, 0 as depth
			  from nodes n
			 where n.trip_id = any(${ids}::uuid[]) and n.deleted_at is null
			union all
			select a.trip_id, a.start_id, p.id, p.parent_id, p.type::text, p.lat, p.lng, a.depth + 1
			  from anc a join nodes p on p.id = a.parent_id and p.deleted_at is null
			 where a.depth < 12
		), city_of as (
			select distinct on (start_id) start_id, id as city_id, lat, lng
			  from anc where type = 'city' and lat is not null and lng is not null
			 order by start_id, depth
		)
		select i.trip_id::text as "tripId", c.city_id::text as "cityId", c.lat, c.lng
		  from items i
		  join trip_days d on d.id = i.day_id
		  join city_of c on c.start_id = i.node_id
		 where i.trip_id = any(${ids}::uuid[]) and i.deleted_at is null
		 order by i.trip_id, d.date, i.position`);
	for (const r of visits.rows as {
		tripId: string;
		cityId: string;
		lat: number;
		lng: number;
	}[]) {
		const list = out.get(r.tripId) ?? [];
		const last = list.at(-1);
		const p: [number, number] = [Number(r.lng), Number(r.lat)];
		if (!last || last[0] !== p[0] || last[1] !== p[1]) list.push(p);
		out.set(r.tripId, list);
	}
	const missing = tripIds.filter((id) => !out.get(id)?.length);
	if (missing.length) {
		const fallback = await db.execute(sql`
			select trip_id::text as "tripId", lat, lng, type::text as type from nodes
			 where trip_id = any(${sql.param(missing)}::uuid[]) and deleted_at is null
			   and type in ('city', 'country') and lat is not null and lng is not null
			 order by trip_id, (type = 'city') desc, position`);
		const byTrip = new Map<string, { type: string; p: [number, number] }[]>();
		for (const r of fallback.rows as {
			tripId: string;
			lat: number;
			lng: number;
			type: string;
		}[]) {
			const list = byTrip.get(r.tripId) ?? [];
			list.push({ type: r.type, p: [Number(r.lng), Number(r.lat)] });
			byTrip.set(r.tripId, list);
		}
		for (const [tripId, list] of byTrip) {
			const cities = list.filter((x) => x.type === "city");
			out.set(
				tripId,
				(cities.length ? cities : list).map((x) => x.p),
			);
		}
	}
	for (const [k, v] of out)
		if (v.length > MAX_ROUTE_POINTS) {
			const step = v.length / MAX_ROUTE_POINTS;
			out.set(
				k,
				Array.from(
					{ length: MAX_ROUTE_POINTS },
					(_, i) => v[Math.floor(i * step)] as [number, number],
				),
			);
		}
	return out;
}

type DeadlineRow = {
	id: string;
	tripId: string;
	tripSlug: string;
	tripName: string;
	tripTz: string;
	text: string;
	dueKind: DueKind;
	dueDate: string | null;
	dueTime: string | null;
	dueTz: string | null;
	dueDayDate: string | null;
	dueDayStart: string | null;
	dueRule: DueRule | null;
	anchorDate: string | null;
	nodeId: string | null;
	itemId: string | null;
	dayId: string | null;
	legId: string | null;
	assignedToMe: boolean;
	assigneeCount: number;
	canEdit: boolean;
};

/** "2027-10-05" minus `months` calendar months, on `dayOfMonth` (clamped). */
function minusMonths(
	date: string,
	months: number,
	dayOfMonth?: number,
): string {
	const [y, m, d] = date.split("-").map(Number) as [number, number, number];
	const total = y * 12 + (m - 1) - months;
	const ty = Math.floor(total / 12);
	const tm = total % 12;
	const last = new Date(Date.UTC(ty, tm + 1, 0)).getUTCDate();
	const day = Math.min(dayOfMonth ?? d, last);
	return `${ty}-${String(tm + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

/**
 * The effective due instant of a row (EXTENSIONS §7, ADDENDUM §10), the same
 * rules as WP-Lists' `effectiveDue`: a relative rule wins (its anchor item's
 * day; nothing when the item is unscheduled); else the earlier of the
 * absolute date (+ time in its zone; a bare date is 23:59, or 00:00 for
 * `opens`, in the trip zone) and "by Day N" (that day's start).
 */
export function deadlineAt(r: {
	dueKind: DueKind;
	dueDate: string | null;
	dueTime: string | null;
	dueTz: string | null;
	dueDayDate: string | null;
	dueDayStart: string | null;
	dueRule: DueRule | null;
	anchorDate: string | null;
	tripTz: string;
}): { at: number; date: string; time: string | null; tz: string } | null {
	const tripTz = safeTimeZone(r.tripTz);
	if (r.dueRule) {
		if (!r.anchorDate) return null;
		const rule = r.dueRule;
		const date =
			rule.kind === "days"
				? addDays(r.anchorDate, -rule.days)
				: minusMonths(r.anchorDate, rule.months, rule.dayOfMonth);
		const tz = safeTimeZone(rule.tz);
		return { at: zonedEpoch(date, rule.time, tz), date, time: rule.time, tz };
	}
	const cands: { at: number; date: string; time: string | null; tz: string }[] =
		[];
	if (r.dueDate) {
		const tz = safeTimeZone(r.dueTz ?? tripTz);
		const time = r.dueTime ?? (r.dueKind === "opens" ? "00:00" : "23:59");
		cands.push({
			at: zonedEpoch(r.dueDate, time, tz),
			date: r.dueDate,
			time: r.dueTime,
			tz,
		});
	}
	if (r.dueDayDate) {
		const time = r.dueDayStart ?? "09:00";
		cands.push({
			at: zonedEpoch(r.dueDayDate, time, tripTz),
			date: r.dueDayDate,
			time: null,
			tz: tripTz,
		});
	}
	cands.sort((a, b) => a.at - b.at);
	return cands[0] ?? null;
}

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

export function deadlineState(
	kind: DueKind,
	at: number,
	now: number,
): "overdue" | "open_now" | "soon" | "later" {
	if (kind === "opens" && at <= now)
		return now - at <= 72 * HOUR ? "open_now" : "overdue";
	if (at < now) return "overdue";
	return at - now <= 7 * DAY ? "soon" : "later";
}

/**
 * Every open, dated todo across `tripIds` I may see (never someone else's
 * private item), with its effective instant. `mine` is undefined for rows
 * assigned only to others ("Everyone's").
 */
async function loadDeadlineRows(
	userId: string,
	tripIds: string[],
): Promise<(MyDeadline & { mine?: boolean })[]> {
	if (!tripIds.length) return [];
	const res = await db.execute(sql`
		with me as (
			select m.trip_id, m.id as member_id, m.role::text as role from trip_members m
			 where m.user_id = ${userId} and m.status = 'active'
		)
		select li.id::text as id, li.trip_id::text as "tripId", t.slug as "tripSlug", t.name as "tripName",
		       t.default_tz as "tripTz", li.text, li.due_kind::text as "dueKind",
		       li.due_date::text as "dueDate", li.due_time as "dueTime", li.due_tz as "dueTz",
		       dd.date::text as "dueDayDate", dd.start_time as "dueDayStart", li.due_rule as "dueRule",
		       (select ad.date::text from items ai join trip_days ad on ad.id = ai.day_id
		         where ai.id = (li.due_rule->>'itemId')::uuid and ai.trip_id = li.trip_id
		           and ai.deleted_at is null) as "anchorDate",
		       li.node_id::text as "nodeId", li.item_id::text as "itemId", li.day_id::text as "dayId",
		       li.leg_id::text as "legId",
		       exists (select 1 from list_item_assignees a where a.list_item_id = li.id and a.member_id = me.member_id) as "assignedToMe",
		       (select count(*)::int from list_item_assignees a where a.list_item_id = li.id) as "assigneeCount",
		       (me.role in ('owner', 'editor')) as "canEdit"
		  from list_items li
		  join trips t on t.id = li.trip_id and t.deleted_at is null
		  join me on me.trip_id = li.trip_id
		  left join trip_days dd on dd.id = li.due_day_id
		 where li.trip_id = any(${sql.param(tripIds)}::uuid[])
		   and li.deleted_at is null and li.status = 'open' and li.list = 'todo'
		   and (not li.is_private or li.created_by = ${userId})
		   and (li.due_date is not null or li.due_day_id is not null or li.due_rule is not null)`);
	const out: (MyDeadline & { mine?: boolean })[] = [];
	const now = Date.now();
	for (const r of res.rows as DeadlineRow[]) {
		const due = deadlineAt(r);
		if (!due) continue;
		const mine = r.assignedToMe
			? true
			: Number(r.assigneeCount) === 0
				? false
				: undefined;
		const sel = r.itemId
			? `i.${r.itemId}`
			: r.nodeId
				? `n.${r.nodeId}`
				: r.dayId
					? `d.${r.dayId}`
					: null;
		out.push({
			listItemId: r.id,
			tripId: r.tripId,
			tripSlug: r.tripSlug,
			tripName: r.tripName,
			text: r.text,
			dueDate: due.date,
			dueTime: due.time,
			dueTz: due.tz,
			sel,
			dueKind: r.dueKind,
			at: due.at,
			state: deadlineState(r.dueKind, due.at, now),
			mine,
			canComplete: Boolean(r.canEdit) || r.assignedToMe,
		});
	}
	return out;
}

/** DASHBOARD_DEADLINES cap (EXTENSIONS §7: the server caps at 20). */
export const DEADLINES_MAX = 20;

/**
 * Open todos overdue, open now or due within 30 days, where I'm assigned or
 * nobody is (`everyone` adds the rest), overdue first, then by instant.
 */
export async function loadMyDeadlines(
	userId: string,
	opts: { everyone?: boolean } = {},
): Promise<MyDeadline[]> {
	const trips = await db.execute(sql`
		select m.trip_id::text as id from trip_members m join trips t on t.id = m.trip_id and t.deleted_at is null
		 where m.user_id = ${userId} and m.status = 'active'`);
	const ids = (trips.rows as { id: string }[]).map((r) => r.id);
	const now = Date.now();
	const horizon = now + 30 * DAY;
	const rows = (await loadDeadlineRows(userId, ids)).filter(
		(d) =>
			(opts.everyone || d.mine !== undefined) &&
			d.at !== undefined &&
			(d.state === "overdue" || d.state === "open_now" || d.at <= horizon),
	);
	const rank = (s: MyDeadline["state"]) =>
		s === "overdue" ? 0 : s === "open_now" ? 1 : 2;
	rows.sort(
		(a, b) => rank(a.state) - rank(b.state) || (a.at ?? 0) - (b.at ?? 0),
	);
	return rows.slice(0, DEADLINES_MAX);
}
