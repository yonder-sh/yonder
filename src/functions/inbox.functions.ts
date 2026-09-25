/**
 * ADDENDUM §10 "one inbox" (F): the feed behind WP-Shell's `InboxBell` and
 * the dashboard. One read state (`inbox_reads`, plus `mentions.read_at` for
 * mention items so the two never disagree). Accounts only: link guests have
 * no inbox (they can't be mentioned or assigned).
 *
 * Kinds (`loadInbox` in `src/server/inbox.server.ts`): `mention`, `review`,
 * `proposal_result` (closed proposals), `due` (open todos with
 * `effectiveDue`, relative rules resolved against the schedule),
 * `balance_changed` (`settlements.net_after` vs. today's nets) and
 * `budget_notice` (`budget_lines.default_seen_minor`), with the same privacy
 * filters everywhere (private list items, notes and expenses reach only their
 * author; money only members).
 */
import { createServerFn } from "@tanstack/react-start";
import { sql } from "drizzle-orm";
import { db } from "@/db/db.server";
import {
	type InboxDto,
	ListInboxInput,
	MarkInboxReadInput,
} from "@/lib/schemas/inbox";
import { withAccount } from "@/server/authz/middleware";
import { loadInbox } from "@/server/inbox.server";

/** The caller's inbox (one trip, or all their trips). Guests: `withAccount` refuses. */
export const listInbox = createServerFn({ method: "GET" })
	.middleware([withAccount])
	.validator(ListInboxInput)
	.handler(
		async ({ data, context }): Promise<InboxDto> =>
			loadInbox(context.user.id, data),
	);

/**
 * Marks items read (by key, or all of one trip / all trips). Only keys that
 * are in the caller's current feed are recorded, so nobody can write read
 * state for anything they can't see. Mention items also stamp
 * `mentions.read_at`. Policy `account`.
 */
export const markInboxRead = createServerFn({ method: "POST" })
	.middleware([withAccount])
	.validator(MarkInboxReadInput)
	.handler(async ({ data, context }): Promise<{ updated: number }> => {
		const userId = context.user.id;
		const feed = await loadInbox(userId, {
			tripId: "all" in data ? data.tripId : undefined,
		});
		const wanted = "all" in data ? null : new Set<string>(data.keys);
		const hits = feed.items.filter(
			(i) => !i.read && (wanted === null || wanted.has(i.key)),
		);
		if (!hits.length) return { updated: 0 };
		await db.transaction(async (tx) => {
			for (const i of hits)
				await tx.execute(sql`
					insert into inbox_reads (user_id, item_key, trip_id)
					values (${userId}, ${i.key}, ${i.tripId})
					on conflict (user_id, item_key) do nothing`);
			const mentionIds = hits.flatMap((i) =>
				i.kind === "mention" ? [i.mentionId] : [],
			);
			if (mentionIds.length)
				await tx.execute(sql`
					update mentions mn set read_at = now()
					  from trip_members m
					 where mn.id = any(${sql.param(mentionIds)}::uuid[]) and mn.read_at is null
					   and m.id = mn.member_id and m.user_id = ${userId}`);
		});
		return { updated: hits.length };
	});
