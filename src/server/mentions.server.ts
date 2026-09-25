/**
 * Mention rows for Markdown fields (SPEC §7.10): item notes (`note_item_id`)
 * and list items (`list_item_id`, text + note). Rich notes (Yjs) are handled by
 * the collab server's notes hook.
 *
 * `syncMentions` diffs the tokens in the new text against the stored rows:
 * new mentions are inserted (and announced with `out.mention`, so those
 * members' bells refetch), removed ones deleted, unchanged ones kept (their
 * read state survives an edit). Ids that are not members of this trip (active,
 * invited or placeholder) are dropped; guests have no member id, so they are
 * never mentionable. A private list item (ADDENDUM §7.2) keeps no mention rows
 * at all: call it after writing `is_private`, and again when the flag flips.
 */
import { sql } from "drizzle-orm";
import type { Tx } from "@/db/db.server";
import { mentions } from "@/db/schema";
import { MENTION_TOKEN_RE, parseMentionIds } from "@/lib/notes/mentions";
import type { TxOutbox } from "./live/outbox.server";
import { tripMemberIds } from "./perms.server";

export type MentionSource =
	| { noteItemId: string }
	| { listItemId: string }
	/** ADDENDUM §10: a member's rating comment on a place. */
	| { ratingComment: { nodeId: string; raterMemberId: string } };

export type MentionTarget = {
	nodeId?: string | null;
	legId?: string | null;
	itemId?: string | null;
	dayId?: string | null;
};

/** A short plain excerpt: tokens become "@Label", Markdown punctuation is dropped. */
export function mentionExcerpt(
	texts: readonly (string | null | undefined)[],
): string {
	return texts
		.filter(Boolean)
		.join(" · ")
		.replace(
			MENTION_TOKEN_RE,
			(_m, label: string) => `@${label.replace(/\\(.)/g, "$1")}`,
		)
		.replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
		.replace(/[*_`~>#]+/g, "")
		.replace(/\s+/g, " ")
		.trim()
		.slice(0, 160);
}

/** Returns the member ids that are newly mentioned. */
export async function syncMentions(
	tx: Tx,
	out: TxOutbox,
	tripId: string,
	source: MentionSource,
	texts: readonly (string | null | undefined)[],
	opts: { createdBy: string | null; target: MentionTarget },
): Promise<string[]> {
	// ADDENDUM §7.2: a PRIVATE list item never notifies anyone (no mention rows,
	// so nothing reaches another member's bell, inbox or digest).
	const isPrivate =
		"listItemId" in source &&
		(
			await tx.execute(
				sql`select 1 from list_items where id = ${source.listItemId} and is_private`,
			)
		).rows.length > 0;
	const wanted = isPrivate
		? []
		: await tripMemberIds(
				tx,
				tripId,
				texts.flatMap((t) => parseMentionIds(t)),
			);
	const where =
		"noteItemId" in source
			? sql`note_item_id = ${source.noteItemId}`
			: "listItemId" in source
				? sql`list_item_id = ${source.listItemId}`
				: sql`node_id = ${source.ratingComment.nodeId} and rater_member_id = ${source.ratingComment.raterMemberId}`;
	const res = await tx.execute(
		sql`select member_id::text as "memberId" from mentions where ${where}`,
	);
	const have = new Set(
		(res.rows as { memberId: string }[]).map((r) => r.memberId),
	);
	const added = wanted.filter((m) => !have.has(m));
	const removed = [...have].filter((m) => !wanted.includes(m));

	if (removed.length) {
		await tx.execute(
			sql`delete from mentions where ${where} and member_id = any(${sql.param(removed)}::uuid[])`,
		);
	}
	if (added.length) {
		const excerpt = mentionExcerpt(texts);
		await tx.insert(mentions).values(
			added.map((memberId) => ({
				tripId,
				memberId,
				...("noteItemId" in source
					? { noteItemId: source.noteItemId }
					: "listItemId" in source
						? { listItemId: source.listItemId }
						: { raterMemberId: source.ratingComment.raterMemberId }),
				nodeId:
					"ratingComment" in source
						? source.ratingComment.nodeId
						: (opts.target.nodeId ?? null),
				legId: opts.target.legId ?? null,
				itemId: opts.target.itemId ?? null,
				dayId: opts.target.dayId ?? null,
				excerpt,
				createdBy: opts.createdBy,
			})),
		);
		out.mention(added);
	}
	return added;
}
