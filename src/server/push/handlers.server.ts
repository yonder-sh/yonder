/**
 * The `push` queue's handlers (run by the worker, `collab/worker.ts`).
 *
 *   events → per-person buffers (coalescing) → flush → web-push
 *   sync   → reminder jobs (booking windows, due, countdown, today) + the
 *            snapshot diff ("changes that affect you", "assigned to you")
 *   remind → a reminder, re-checked against the trip as it is now
 *   sweep  → hourly sync of every trip that may still plan something
 *
 * Every step is a no-op while push is off (`pushEnabled`). Recipient rules
 * (`src/lib/push/recipients.ts`): never the actor, only people with a
 * device, the per-type switches and per-trip mute, and what each person may
 * see (link guests only hear about suggestions; private to-dos only reach
 * their author). Inbox-backed kinds (mentions, suggestions to review, your
 * suggestions' results) are read from the in-app inbox itself at flush
 * time, so anything already read there is never pushed.
 */
import { sql } from "drizzle-orm";
import { db } from "@/db/db.server";
import {
	can,
	roleLabel,
	type TripAccess,
	type TripRole,
} from "@/lib/auth/roles";
import { indexGraph } from "@/lib/engine/graph-index";
import { computeSchedule } from "@/lib/engine/schedule";
import { diffSnapshots, routeChanges, snapshotOf } from "@/lib/push/changes";
import {
	bufferItem,
	type CoalesceTarget,
	takeItems,
} from "@/lib/push/coalesce";
import type { PushEventsJob } from "@/lib/push/jobs";
import { tripUrl } from "@/lib/push/links";
import { buildPayload, type PayloadTrip } from "@/lib/push/payload";
import { reviewAudience, selectRecipients, wants } from "@/lib/push/recipients";
import {
	computeReminders,
	dueWithin,
	type PushTodo,
	planReminderJobs,
	reminderJobId,
} from "@/lib/push/reminders";
import { type PushGroup, type PushItem, typeOfGroup } from "@/lib/push/types";
import type { InboxLink } from "@/lib/schemas/inbox";
import { loadTripAccess } from "@/server/authz/trip-access.server";
import { loadGraphForServer } from "@/server/graph.server";
import { loadInbox } from "@/server/inbox.server";
import { enqueue, getQueue } from "@/server/live/jobs.server";
import { proposalVisibleTo } from "@/server/proposals/dto.server";
import { pushEnabled } from "./env.server";
import {
	dropSnapshot,
	markPushedOnce,
	noteActor,
	RedisCoalesceStore,
	readSnapshot,
	recentActors,
	recordReminders,
	requestPushSync,
	scheduledReminders,
	writeSnapshot,
} from "./redis-state.server";
import { sendToUser } from "./send.server";
import {
	getSettings,
	settingsFor,
	subscribedUsers,
	tripHasSubscribers,
} from "./store.server";

/** Reminders are scheduled this far ahead; the hourly sweep adds the rest. */
export const REMINDER_HORIZON_MS = 48 * 3600_000;

const store = new RedisCoalesceStore();

const firstWord = (name: string | null | undefined): string | null =>
	(name ?? "").trim().split(/\s+/)[0] || null;

type TripRow = PayloadTrip;

async function tripRow(tripId: string): Promise<TripRow | null> {
	const res = await db.execute(sql`
		select id::text as id, name, slug from trips where id = ${tripId} and deleted_at is null`);
	return (res.rows[0] as TripRow | undefined) ?? null;
}

/**
 * A trip's live list rows (done ones too: reopening a to-do must not look
 * like a new assignment), as the reminder planner and the snapshot read them.
 */
export async function loadPushTodos(tripId: string): Promise<PushTodo[]> {
	const res = await db.execute(sql`
		select li.id::text as id, li.list::text as list, li.text, li.status::text as status,
		       li.due_kind::text as "dueKind", li.due_rule as "dueRule", li.due_date::text as "dueDate",
		       li.due_time as "dueTime", li.due_tz as "dueTz", li.due_day_id::text as "dueDayId",
		       li.is_private as "isPrivate", li.created_by as "createdBy",
		       li.node_id::text as "nodeId", li.item_id::text as "itemId",
		       li.leg_id::text as "legId", li.day_id::text as "dayId",
		       coalesce((select array_agg(a.member_id::text order by a.member_id)
		                   from list_item_assignees a where a.list_item_id = li.id), '{}') as "assigneeIds"
		  from list_items li
		 where li.trip_id = ${tripId} and li.deleted_at is null`);
	return (res.rows as PushTodo[]).map((r) => ({
		...r,
		dueRule: r.dueRule ?? null,
		assigneeIds: r.assigneeIds ?? [],
	}));
}

/** Buffers `item` for each candidate who has a device (never the actors). */
async function bufferFor(
	candidates: readonly string[],
	tripId: string,
	group: PushGroup,
	item: PushItem,
	actorUserIds: readonly (string | null)[],
): Promise<number> {
	const actors = new Set(actorUserIds.filter(Boolean));
	const pool = [...new Set(candidates)].filter((u) => !actors.has(u));
	if (!pool.length) return 0;
	const subscribed = await subscribedUsers(db, pool);
	const prefs = await settingsFor(db, pool);
	const users = selectRecipients(pool, {
		type: typeOfGroup(group),
		tripId,
		subscribed,
		prefs,
	});
	for (const userId of users) {
		const target: CoalesceTarget = { userId, tripId, group };
		await bufferItem(store, target, item, (delay) =>
			enqueue("push", "push.flush", target, { delay, attempts: 2 }),
		);
	}
	return users.length;
}

/** Everyone who can open the trip: active members and live link guests. */
async function tripPeople(
	tripId: string,
): Promise<{ userId: string; access: TripAccess }[]> {
	const res = await db.execute(sql`
		select m.user_id as "userId" from trip_members m
		 where m.trip_id = ${tripId} and m.status = 'active' and m.user_id is not null
		union
		select g.user_id from share_grants g
		  join share_links l on l.id = g.share_link_id and l.trip_id = g.trip_id
		 where g.trip_id = ${tripId} and l.enabled and l.revoked_at is null`);
	const out: { userId: string; access: TripAccess }[] = [];
	for (const { userId } of res.rows as { userId: string }[]) {
		const access = await loadTripAccess(tripId, userId);
		if (access) out.push({ userId, access });
	}
	return out;
}

function membershipItem(
	ev: Extract<PushEventsJob["events"][number], { kind: "membership" }>,
	at: number,
	actor: string | null,
	trip: TripRow,
): PushItem {
	const who = actor ?? "Someone";
	const role = ev.role ? roleLabel(ev.role as TripRole) : null;
	switch (ev.change) {
		case "added":
			return {
				key: `member.added.${at}`,
				at,
				actor,
				headline: `${who} added you to the trip`,
				body: role
					? `You ${role === "Owner" ? "own it" : role.toLowerCase()}.`
					: "",
				url: tripUrl(trip.slug),
			};
		case "removed":
			return {
				key: `member.removed.${at}`,
				at,
				actor,
				headline: "You were removed from the trip",
				body: actor ? `${actor} removed you.` : "",
				url: "/",
			};
		default:
			return {
				key: `member.role.${at}`,
				at,
				actor,
				headline: role ? `Your role is now ${role}` : "Your role changed",
				body: actor ? `${actor} changed it.` : "",
				url: tripUrl(trip.slug),
			};
	}
}

// ---- push.events -------------------------------------------------------------------

export async function handlePushEvents(job: PushEventsJob): Promise<void> {
	if (!pushEnabled()) return;
	const trip = await tripRow(job.tripId);
	if (!trip) return;
	const actorId = job.actor?.userId ?? null;
	const actor = firstWord(job.actor?.name);
	for (const ev of job.events) {
		switch (ev.kind) {
			case "mention": {
				const res = await db.execute(sql`
					select distinct user_id as "userId" from trip_members
					 where trip_id = ${job.tripId} and status = 'active' and user_id is not null
					   and id = any(${sql.param(ev.memberIds)}::uuid[])`);
				const users = (res.rows as { userId: string }[]).map((r) => r.userId);
				// A placeholder: the flush reads the real items from the inbox.
				await bufferFor(
					users,
					job.tripId,
					"mention",
					{
						key: `mention.${job.at}`,
						at: job.at,
						actor,
						headline: "mentioned you",
						url: tripUrl(trip.slug),
					},
					[actorId],
				);
				break;
			}
			case "review": {
				const res = await db.execute(sql`
					select author_user_id as "authorUserId", author_name as "authorName"
					  from proposals where id = ${ev.proposalId} and trip_id = ${job.tripId}`);
				const p = res.rows[0] as
					| { authorUserId: string | null; authorName: string }
					| undefined;
				if (!p) break;
				const reviewers = reviewAudience(
					await tripPeople(job.tripId),
					p.authorUserId,
				);
				await bufferFor(
					reviewers,
					job.tripId,
					"review",
					{
						key: `review.${ev.proposalId}`,
						at: job.at,
						actor: firstWord(p.authorName),
						headline: "suggested a change",
						url: tripUrl(trip.slug, { sel: `p.${ev.proposalId}` }),
						meta: { proposalId: ev.proposalId },
					},
					[actorId, p.authorUserId],
				);
				break;
			}
			case "result": {
				const res = await db.execute(sql`
					select author_user_id as "authorUserId" from proposals
					 where id = ${ev.proposalId} and trip_id = ${job.tripId}`);
				const author = (
					res.rows[0] as { authorUserId: string | null } | undefined
				)?.authorUserId;
				if (!author) break;
				// Its changes are the author's own: the snapshot diff (which runs
				// a few seconds later) must not tell them "your plan moved".
				if (ev.decision === "accepted") await noteActor(job.tripId, author);
				await bufferFor(
					[author],
					job.tripId,
					"result",
					{
						key: `result.${ev.proposalId}`,
						at: job.at,
						actor,
						headline: `${ev.decision} your suggestion`,
						url: tripUrl(trip.slug, { sel: `p.${ev.proposalId}` }),
						meta: { proposalId: ev.proposalId, decision: ev.decision },
					},
					[actorId],
				);
				break;
			}
			case "membership":
				await bufferFor(
					[ev.userId],
					job.tripId,
					"membership",
					membershipItem(ev, job.at, actor, trip),
					[actorId],
				);
				break;
		}
	}
}

// ---- push.flush --------------------------------------------------------------------

type FlushCtx = {
	userId: string;
	access: TripAccess | null;
	trip: TripRow;
	items: PushItem[];
};

const linkPath = (slug: string, link: InboxLink): string => {
	const { tripSlug: _s, review: _r, ...rest } = link;
	return tripUrl(slug, rest);
};

/** Mentions: the inbox's unread mention rows since the window opened. */
async function mentionItems(c: FlushCtx): Promise<PushItem[]> {
	if (!c.access || c.access.isGuest) return [];
	const since = Math.min(...c.items.map((i) => i.at)) - 5 * 60_000;
	const feed = await loadInbox(c.userId, { tripId: c.trip.id });
	const out: PushItem[] = [];
	for (const i of feed.items) {
		if (i.kind !== "mention" || i.read) continue;
		const at = Date.parse(i.at);
		if (!(at >= since)) continue;
		if (!(await markPushedOnce(c.userId, i.key))) continue;
		const who = firstWord(i.actor?.name) ?? "Someone";
		out.push({
			key: i.key,
			at,
			actor: who,
			headline: `${who} mentioned you${i.where ? ` in ${i.where}` : ""}`,
			body: i.excerpt ?? "",
			url: linkPath(c.trip.slug, i.link),
			meta: { label: i.where ?? i.excerpt ?? "" },
		});
	}
	return out;
}

/** Suggestions still open, visible to the reviewer, and not read in their inbox. */
async function reviewItems(c: FlushCtx): Promise<PushItem[]> {
	if (!c.access || !can(c.access, "reviewProposals")) return [];
	const ids = c.items.flatMap((i) =>
		typeof i.meta?.proposalId === "string" ? [i.meta.proposalId] : [],
	);
	if (!ids.length) return [];
	const res = await db.execute(sql`
		select id::text as id, summary, author_name as "authorName", created_at as at
		  from proposals
		 where id = any(${sql.param(ids)}::uuid[]) and trip_id = ${c.trip.id}
		   and status = 'open' and author_user_id is distinct from ${c.userId}`);
	const rows = res.rows as {
		id: string;
		summary: string;
		authorName: string;
		at: string | Date;
	}[];
	if (!rows.length) return [];
	if (!c.access.isGuest) {
		const feed = await loadInbox(c.userId, { tripId: c.trip.id });
		const review = feed.items.find((i) => i.kind === "review");
		// Read in the bell since: nothing new to push.
		if (!review || review.read) return [];
	}
	const out: PushItem[] = [];
	for (const r of rows) {
		if (!(await proposalVisibleTo(db, r.id, c.access, c.userId))) continue;
		const who = firstWord(r.authorName) ?? "Someone";
		out.push({
			key: `review.${r.id}`,
			at: new Date(r.at).getTime(),
			actor: who,
			headline: `${who} suggested a change`,
			body: r.summary,
			url: tripUrl(c.trip.slug, { sel: `p.${r.id}` }),
			meta: { label: r.summary },
		});
	}
	return out;
}

/** My suggestions accepted or rejected, not read in my inbox yet. */
async function resultItems(c: FlushCtx): Promise<PushItem[]> {
	if (!c.access) return [];
	const ids = c.items.flatMap((i) =>
		typeof i.meta?.proposalId === "string" ? [i.meta.proposalId] : [],
	);
	if (!ids.length) return [];
	const res = await db.execute(sql`
		select p.id::text as id, p.status::text as status, p.summary, p.review_note as note,
		       p.reviewed_at as at, u.name as "reviewerName"
		  from proposals p left join "user" u on u.id = p.reviewed_by
		 where p.id = any(${sql.param(ids)}::uuid[]) and p.trip_id = ${c.trip.id}
		   and p.author_user_id = ${c.userId} and p.status in ('accepted', 'rejected')
		   and p.reviewed_by is distinct from ${c.userId}`);
	let rows = res.rows as {
		id: string;
		status: "accepted" | "rejected";
		summary: string;
		note: string | null;
		at: string | Date;
		reviewerName: string | null;
	}[];
	if (!c.access.isGuest) {
		const feed = await loadInbox(c.userId, { tripId: c.trip.id });
		const unread = new Set(
			feed.items.flatMap((i) =>
				i.kind === "proposal_result" && !i.read ? [i.proposalId] : [],
			),
		);
		rows = rows.filter((r) => unread.has(r.id));
	}
	return rows.map((r) => {
		const who = firstWord(r.reviewerName) ?? "Someone";
		return {
			key: `result.${r.id}`,
			at: new Date(r.at).getTime(),
			actor: who,
			headline: `${who} ${r.status} your suggestion`,
			body: r.status === "rejected" && r.note ? `“${r.note}”` : r.summary,
			url: tripUrl(c.trip.slug, { sel: `p.${r.id}` }),
			meta: { decision: r.status, label: r.summary },
		};
	});
}

/** Assignments that still hold (an undo within the window says nothing). */
async function assignedItems(c: FlushCtx): Promise<PushItem[]> {
	const memberId = c.access?.memberId;
	if (!memberId || c.access?.isGuest) return [];
	const out: PushItem[] = [];
	for (const i of c.items) {
		const id = typeof i.meta?.id === "string" ? i.meta.id : null;
		if (!id) continue;
		const res =
			i.meta?.target === "todo"
				? await db.execute(sql`
					select 1 from list_item_assignees a
					  join list_items li on li.id = a.list_item_id
					 where a.list_item_id = ${id} and a.member_id = ${memberId}
					   and li.deleted_at is null and li.status = 'open' and not li.is_private`)
				: await db.execute(sql`
					select 1 from item_assignees a join items it on it.id = a.item_id
					 where a.item_id = ${id} and a.member_id = ${memberId} and it.deleted_at is null`);
		if (res.rows.length) out.push(i);
	}
	return out;
}

async function resolveGroup(
	group: PushGroup,
	c: FlushCtx,
): Promise<PushItem[]> {
	switch (group) {
		case "mention":
			return mentionItems(c);
		case "review":
			return reviewItems(c);
		case "result":
			return resultItems(c);
		case "assigned":
			return assignedItems(c);
		case "membership": {
			const last = c.items.at(-1);
			if (!last) return [];
			const removed = last.key.startsWith("member.removed.");
			// Removed: only while they really have no access (not re-added since).
			if (removed ? c.access : !c.access) return [];
			return [last];
		}
		default:
			// Reminders and changes: members only (guests don't travel or own to-dos).
			return c.access && !c.access.isGuest ? c.items : [];
	}
}

export async function handlePushFlush(data: {
	tripId: string;
	userId: string;
	group: PushGroup;
}): Promise<void> {
	const items = await takeItems(store, data);
	if (!items.length || !pushEnabled()) return;
	const settings = await getSettings(db, data.userId);
	if (!wants(settings, typeOfGroup(data.group), data.tripId)) return;
	const trip = await tripRow(data.tripId);
	if (!trip) return;
	const access = await loadTripAccess(data.tripId, data.userId);
	const final = await resolveGroup(data.group, {
		userId: data.userId,
		access,
		trip,
		items,
	});
	const payload = buildPayload(data.group, final, trip);
	if (payload) await sendToUser(data.userId, payload, data.group);
}

// ---- push.sync / push.remind -------------------------------------------------------

async function cancelReminders(tripId: string): Promise<void> {
	const current = await scheduledReminders(tripId);
	const ids = Object.keys(current);
	for (const id of ids)
		await getQueue("push")
			.remove(id)
			.catch(() => 0);
	if (ids.length) await recordReminders(tripId, [], ids);
}

async function userFirstName(userId: string): Promise<string | null> {
	const res = await db.execute(
		sql`select name from "user" where id = ${userId}`,
	);
	return firstWord((res.rows[0] as { name?: string } | undefined)?.name);
}

export async function handlePushSync(data: { tripId: string }): Promise<void> {
	const { tripId } = data;
	if (!pushEnabled()) return;
	const graph = (await tripRow(tripId))
		? await loadGraphForServer(db, tripId)
		: null;
	if (!graph || !(await tripHasSubscribers(db, tripId))) {
		// Nobody to tell: nothing planned, and the next snapshot is a fresh baseline.
		await cancelReminders(tripId);
		await dropSnapshot(tripId);
		return;
	}
	const todos = await loadPushTodos(tripId);
	const ix = indexGraph(graph);
	const schedule = computeSchedule(ix);

	// 1. Reminder jobs within the horizon (moved instants: new keys).
	const now = Date.now();
	const desired = dueWithin(
		computeReminders(graph, todos, { ix, schedule }),
		now,
		REMINDER_HORIZON_MS,
	).map((r) => ({
		jobId: reminderJobId(tripId, r.key),
		key: r.key,
		fireAt: r.fireAt,
	}));
	const plan = planReminderJobs(await scheduledReminders(tripId), desired);
	for (const id of plan.remove)
		await getQueue("push")
			.remove(id)
			.catch(() => 0);
	const keyOf = new Map(desired.map((d) => [d.jobId, d.key]));
	for (const a of plan.add)
		await enqueue(
			"push",
			"push.remind",
			{ tripId, key: keyOf.get(a.jobId) ?? "", fireAt: a.fireAt },
			{ jobId: a.jobId, delay: Math.max(0, a.fireAt - now), attempts: 2 },
		);
	await recordReminders(tripId, plan.add, plan.remove);

	// 2. The snapshot diff.
	const next = snapshotOf(graph, todos, ix);
	const prev = await readSnapshot(tripId);
	await writeSnapshot(tripId, next);
	if (!prev) return;
	const changes = diffSnapshots(prev, next);
	if (!changes.length) return;
	const actors = await recentActors(tripId);
	const actor =
		actors.length === 1 ? await userFirstName(actors[0] as string) : null;
	for (const r of routeChanges(changes, graph, todos, { actor, ix }))
		await bufferFor(r.userIds, tripId, r.group, r.item, actors);
}

export async function handlePushRemind(data: {
	tripId: string;
	key: string;
	fireAt: number;
}): Promise<void> {
	await recordReminders(
		data.tripId,
		[],
		[reminderJobId(data.tripId, data.key)],
	);
	if (!pushEnabled() || !(await tripRow(data.tripId))) return;
	const graph = await loadGraphForServer(db, data.tripId);
	if (!graph) return;
	const todos = await loadPushTodos(data.tripId);
	// The trip as it is now: a done, deleted or moved to-do no longer matches.
	const r = computeReminders(graph, todos).find((x) => x.key === data.key);
	if (!r || Math.abs(r.fireAt - data.fireAt) > 60_000) return;
	if (Date.now() > r.staleAt) return;
	await bufferFor(r.userIds, data.tripId, r.group, r.item, []);
}

/** Trips that may still plan something and have someone to tell. */
export async function handlePushSweep(): Promise<void> {
	if (!pushEnabled()) return;
	const res = await db.execute(sql`
		select t.id::text as id from trips t
		 where t.deleted_at is null
		   and (t.end_date >= current_date - 1
		        or exists (select 1 from list_items li
		                    where li.trip_id = t.id and li.deleted_at is null and li.status = 'open'
		                      and (li.due_date >= current_date - 1 or li.due_rule is not null or li.due_day_id is not null)))
		   and exists (select 1 from push_subscriptions s
		                 join trip_members m on m.user_id = s.user_id
		                where m.trip_id = t.id and m.status = 'active')`);
	for (const { id } of res.rows as { id: string }[])
		await requestPushSync(id, null);
}
