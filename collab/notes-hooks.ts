import { sql } from "drizzle-orm";
import { v7 as uuidv7 } from "uuid";
import { jsonToMarkdown } from "@/lib/notes/ydoc.server";
import { isUuid, type NoteTarget } from "@/lib/realtime/protocol";
import {
	rowsOf,
	type SqlExecutor,
	type TxOutbox,
} from "@/server/live/outbox.server";
import type { CollabContext } from "./auth";

/**
 * Hook points for note documents, owned by WP-Lists (SPEC §4.1, §10.6).
 *
 * `afterStore` runs inside the note's `withTripTx` transaction, right after
 * `yjs_documents` was upserted, with the derived ProseMirror JSON. WP-Lists uses it
 * to sync `mentions` rows (`out.mention(newMemberIds)`) and to write the markdown
 * export column. Throwing rolls the store back (the Y.Doc stays in memory and is
 * retried on the next change), so only throw for real invariants.
 *
 * Private notes (ADDENDUM §7.2) never reach this hook (persistence skips it), so
 * they never create mention rows, activity or anything another member sees.
 */
export type NotesAfterStoreInput = {
	tx: SqlExecutor;
	out: TxOutbox;
	documentName: string;
	tripId: string;
	target: NoteTarget;
	/** `yXmlFragmentToProsemirrorJSON(doc.getXmlFragment('default'))`. Untrusted content. */
	json: Record<string, unknown>;
	plainText: string;
	/** The context of the last connection that changed the doc (null for server writes). */
	context: CollabContext | null;
};

export type NotesHooks = {
	afterStore(input: NotesAfterStoreInput): Promise<void>;
};

/** At most this many distinct people are tracked per note (the rest are ignored). */
const MAX_MENTIONS = 200;
const EXCERPT_MAX = 160;

type PmNode = {
	type?: unknown;
	text?: unknown;
	attrs?: Record<string, unknown>;
	content?: unknown;
};

const BLOCKS = new Set([
	"paragraph",
	"heading",
	"codeBlock",
	"blockquote",
	"listItem",
	"taskItem",
]);

function blockText(node: PmNode): string {
	const parts: string[] = [];
	const walk = (n: unknown) => {
		if (!n || typeof n !== "object") return;
		const x = n as PmNode;
		if (x.type === "text" && typeof x.text === "string") parts.push(x.text);
		else if (x.type === "mention") {
			const label = x.attrs?.label ?? x.attrs?.id;
			if (typeof label === "string") parts.push(`@${label}`);
		}
		if (Array.isArray(x.content)) for (const c of x.content) walk(c);
	};
	walk(node);
	return parts.join("").replace(/\s+/g, " ").trim();
}

/**
 * The member ids mentioned in note JSON (valid UUIDs only, in order of first
 * appearance) with the text of the block each first appears in.
 */
export function mentionsInNote(json: unknown): Map<string, string> {
	const found = new Map<string, string>();
	const walk = (node: unknown, block: PmNode | null) => {
		if (!node || typeof node !== "object" || found.size >= MAX_MENTIONS) return;
		const n = node as PmNode;
		const here =
			typeof n.type === "string" && BLOCKS.has(n.type) && n.type !== "listItem"
				? n
				: block;
		if (n.type === "mention") {
			const id = n.attrs?.id;
			if (isUuid(id) && !found.has(id)) {
				const text = here ? blockText(here) : "";
				found.set(id, text.slice(0, EXCERPT_MAX));
			}
		}
		if (Array.isArray(n.content)) for (const c of n.content) walk(c, here);
	};
	walk(json, null);
	return found;
}

function targetColumns(target: NoteTarget) {
	return {
		nodeId: target.kind === "node" ? target.id : null,
		legId: target.kind === "leg" ? target.id : null,
		itemId: target.kind === "item" ? target.id : null,
		dayId: target.kind === "day" ? target.id : null,
	};
}

/** Markdown export of the note, or null when the JSON can't be serialised. */
function markdownOf(json: Record<string, unknown>): string | null {
	try {
		return jsonToMarkdown(json);
	} catch {
		return null;
	}
}

export const notesHooks: NotesHooks = {
	async afterStore({ tx, out, documentName, tripId, target, json, context }) {
		const mentioned = mentionsInNote(json);
		const ids = [...mentioned.keys()];
		// Only members of THIS trip (active, invited or placeholder); guests have
		// no member id and removed members are never notified.
		const members = ids.length
			? rowsOf(
					await tx.execute(sql`
						select id::text as id from trip_members
						 where trip_id = ${tripId} and status::text <> 'removed'
						   and id = any(${sql.param(ids)}::uuid[])`),
				).map((r) => String(r.id))
			: [];
		const wanted = ids.filter((id) => members.includes(id));
		const have = new Set(
			rowsOf(
				await tx.execute(sql`
					select member_id::text as "memberId" from mentions
					 where doc_name = ${documentName} and trip_id = ${tripId}`),
			).map((r) => String(r.memberId)),
		);
		const added = wanted.filter((m) => !have.has(m));
		const removed = [...have].filter((m) => !wanted.includes(m));
		if (removed.length)
			await tx.execute(sql`
				delete from mentions
				 where doc_name = ${documentName} and trip_id = ${tripId}
				   and member_id = any(${sql.param(removed)}::uuid[])`);
		const cols = targetColumns(target);
		for (const memberId of added) {
			await tx.execute(sql`
				insert into mentions
					(id, trip_id, member_id, doc_name, node_id, leg_id, item_id, day_id, excerpt, created_by)
				values
					(${uuidv7()}, ${tripId}, ${memberId}, ${documentName}, ${cols.nodeId}, ${cols.legId},
					 ${cols.itemId}, ${cols.dayId}, ${mentioned.get(memberId) || null}, ${context?.userId ?? null})
				on conflict do nothing`);
		}
		// Never ring your own bell.
		const notify = added.filter((m) => m !== context?.memberId);
		if (notify.length) out.mention(notify);
		await tx.execute(sql`
			update yjs_documents set markdown = ${markdownOf(json)}
			 where name = ${documentName} and trip_id = ${tripId}`);
	},
};
