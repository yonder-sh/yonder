import { Database } from "@hocuspocus/extension-database";
import { yXmlFragmentToProsemirrorJSON } from "@tiptap/y-tiptap";
import { sql } from "drizzle-orm";
import type pg from "pg";
import * as Y from "yjs";
import {
	NOTE_FRAGMENT,
	type NoteTarget,
	parseDocName,
} from "@/lib/realtime/protocol";
import type { CollabContext } from "./auth";
import type { CollabDb } from "./db";
import type { NotesHooks } from "./notes-hooks";

/**
 * Postgres `bytea` persistence of note documents (SPEC §10.6; spikes/collab).
 *
 * - `fetch` returns the stored Yjs state (`Y.encodeStateAsUpdate`) of a note.
 * - `store` (debounced by Hocuspocus) runs inside `withTripTx`: it upserts
 *   `yjs_documents`, derives `json` + `plain_text` for static rendering, previews
 *   and search, runs the WP-Lists hook, and — after COMMIT — publishes
 *   `invalidate ['notes', 'counts']` at the trip's CURRENT `trips.version`
 *   (`bumpVersion: false`: a note body is not structured data, so typing never
 *   makes a reviewed `expectedVersion` stale). A private note's event goes to
 *   its owner's connections only.
 * - The channel document `trip/<id>` is never loaded from or written to the DB.
 */

/** Plain text of ProseMirror JSON: text, `@Label` for mentions, one line per block. */
export function plainTextOf(json: unknown): string {
	const parts: string[] = [];
	const BLOCKS = new Set([
		"paragraph",
		"heading",
		"codeBlock",
		"blockquote",
		"listItem",
		"taskItem",
		"horizontalRule",
	]);
	const walk = (node: unknown) => {
		if (!node || typeof node !== "object") return;
		const n = node as {
			type?: unknown;
			text?: unknown;
			attrs?: Record<string, unknown>;
			content?: unknown;
		};
		if (n.type === "text" && typeof n.text === "string") parts.push(n.text);
		else if (n.type === "mention") {
			const label = n.attrs?.label ?? n.attrs?.id;
			if (typeof label === "string") parts.push(`@${label}`);
		} else if (n.type === "hardBreak") parts.push("\n");
		if (Array.isArray(n.content)) for (const c of n.content) walk(c);
		if (typeof n.type === "string" && BLOCKS.has(n.type)) parts.push("\n");
	};
	walk(json);
	return parts
		.join("")
		.replace(/[ \t]+\n/g, "\n")
		.replace(/\n{3,}/g, "\n\n")
		.trim();
}

/** ProseMirror JSON of a note document's TipTap fragment. */
export function noteJson(document: Y.Doc): Record<string, unknown> {
	return yXmlFragmentToProsemirrorJSON(document.getXmlFragment(NOTE_FRAGMENT));
}

function targetColumns(target: NoteTarget) {
	return {
		nodeId: target.kind === "node" ? target.id : null,
		legId: target.kind === "leg" ? target.id : null,
		itemId: target.kind === "item" ? target.id : null,
		dayId: target.kind === "day" ? target.id : null,
	};
}

export async function fetchNoteState(
	pool: pg.Pool,
	documentName: string,
): Promise<Uint8Array | null> {
	const doc = parseDocName(documentName);
	if (!doc || doc.kind === "channel") return null;
	const { rows } = await pool.query<{ state: Buffer }>(
		"select state from yjs_documents where name = $1 and trip_id = $2",
		[doc.name, doc.tripId],
	);
	const state = rows[0]?.state;
	return state
		? new Uint8Array(state.buffer, state.byteOffset, state.byteLength)
		: null;
}

/** The note's target row is gone (a removed day): the store can never succeed. */
export class NoteTargetGone extends Error {
	constructor(readonly documentName: string) {
		super(`note target gone: ${documentName}`);
		this.name = "NoteTargetGone";
	}
}

/** Origin of the database state folded into a live document while storing. */
export const STORED_STATE_ORIGIN = "yonder:stored-state";

const asBytes = (b: Buffer): Uint8Array =>
	new Uint8Array(b.buffer, b.byteOffset, b.byteLength);

export async function storeNoteState(
	deps: { db: CollabDb; hooks: NotesHooks },
	input: {
		documentName: string;
		state: Uint8Array;
		document: Y.Doc;
		context: CollabContext | null;
	},
): Promise<void> {
	const doc = parseDocName(input.documentName);
	if (!doc || doc.kind === "channel") return;
	const cols = targetColumns(doc.target);
	const ctx = input.context;
	try {
		await deps.db.withTripTx(
			doc.tripId,
			async (tx, out) => {
				// QA P1: the stored state may hold text merged in behind this
				// document's back (a removed day's private note moved into the
				// owner's private trip note). Fold it into the live document
				// first (connected editors receive it), so a store never drops it.
				const cur = await tx.execute(
					sql`select state from yjs_documents where name = ${doc.name} for update`,
				);
				const stored = (cur.rows[0] as { state: Buffer } | undefined)?.state;
				if (stored?.byteLength)
					Y.applyUpdate(input.document, asBytes(stored), STORED_STATE_ORIGIN);
				const json = noteJson(input.document);
				const plainText = plainTextOf(json);
				const encoded = Y.encodeStateAsUpdate(input.document);
				const state = Buffer.from(
					encoded.buffer,
					encoded.byteOffset,
					encoded.byteLength,
				);
				await tx.execute(sql`
				insert into yjs_documents
					(name, trip_id, node_id, leg_id, item_id, day_id, owner_user_id, state, json, plain_text, updated_by, updated_at)
				values
					(${doc.name}, ${doc.tripId}, ${cols.nodeId}, ${cols.legId}, ${cols.itemId}, ${cols.dayId},
					 ${doc.ownerUserId}, ${state}, ${JSON.stringify(json)}::jsonb, ${plainText}, ${ctx?.userId ?? null}, now())
				on conflict (name) do update set
					state = excluded.state,
					json = excluded.json,
					plain_text = excluded.plain_text,
					updated_by = excluded.updated_by,
					updated_at = now()`);
				// A private note (ADDENDUM §7.2) never creates mentions, activity or
				// anything another member could see: the WP-Lists hook skips it.
				if (!doc.ownerUserId)
					await deps.hooks.afterStore({
						tx,
						out,
						documentName: doc.name,
						tripId: doc.tripId,
						target: doc.target,
						json,
						plainText,
						context: ctx,
					});
				out.emit({ keys: ["notes", "counts"] });
			},
			{
				actor: ctx
					? { userId: ctx.userId, name: ctx.name, color: ctx.color }
					: null,
				// A note body is not structured data (SPEC D10): typing locks the
				// trip but never moves `trips.version`, so it can't turn someone's
				// reviewed date change into a CONFLICT (QA NOTE-VERSION-CONFLICT).
				bumpVersion: false,
				// A private note refreshes only its owner's tabs: nobody else gets
				// a hint that it changed (ADDENDUM §7.2).
				...(doc.ownerUserId ? { audience: [doc.ownerUserId] } : {}),
			},
		);
	} catch (e) {
		// 23503: the day/leg/item/node row the note hangs on is gone.
		if ((e as { code?: string }).code === "23503")
			throw new NoteTargetGone(doc.name);
		throw e;
	}
}

/** The Hocuspocus Database extension wired to the functions above. */
export function createPersistence(deps: {
	db: CollabDb;
	hooks: NotesHooks;
	onStored?: (documentName: string, bytes: number) => void;
	/** A document whose target was removed: never stored again (it unloads). */
	isGone?: (documentName: string) => boolean;
	/** Its target turned out to be gone while storing (no `notes` event seen). */
	onTargetGone?: (documentName: string, document: Y.Doc) => Promise<void>;
}): Database {
	return new Database({
		fetch: ({ documentName }) => fetchNoteState(deps.db.pool, documentName),
		store: async ({ documentName, state, document, lastContext }) => {
			if (parseDocName(documentName)?.kind !== "note") return;
			if (deps.isGone?.(documentName)) return;
			try {
				await storeNoteState(deps, {
					documentName,
					state,
					document,
					context: (lastContext as CollabContext | undefined)?.userId
						? (lastContext as CollabContext)
						: null,
				});
			} catch (e) {
				if (!(e instanceof NoteTargetGone) || !deps.onTargetGone) throw e;
				// Handled (closed, any private text kept): let the document unload
				// instead of "staying in memory" and failing on every keystroke.
				await deps.onTargetGone(documentName, document);
				return;
			}
			deps.onStored?.(documentName, state.byteLength);
		},
	});
}
