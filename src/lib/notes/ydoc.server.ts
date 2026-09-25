/**
 * Headless conversions between Markdown and note Yjs documents (SPEC §17.4,
 * from spikes/collab/shared/markdown.ts). Runs in plain Node: the seed, the
 * Asia 2027 import and server-side exports.
 */
import { getSchema, type JSONContent } from "@tiptap/core";
import { MarkdownManager } from "@tiptap/markdown";
import {
	prosemirrorJSONToYXmlFragment,
	yXmlFragmentToProsemirrorJSON,
} from "@tiptap/y-tiptap";
import * as Y from "yjs";
import { NOTE_FIELD, noteExtensions } from "./extensions.shared";
import { notePlainText } from "./plain-text";

let cached: {
	schema: ReturnType<typeof getSchema>;
	mdm: MarkdownManager;
} | null = null;
function tools() {
	if (!cached) {
		const extensions = noteExtensions();
		cached = {
			schema: getSchema(extensions),
			mdm: new MarkdownManager({ extensions }),
		};
	}
	return cached;
}

export type NoteSnapshot = {
	/** `Y.encodeStateAsUpdate` of the new document: store in `yjs_documents.state`. */
	state: Uint8Array;
	json: JSONContent;
	markdown: string;
	plainText: string;
};

/**
 * A NEW note document from Markdown. Only for EMPTY documents: applying it to a
 * document that already has content appends a second copy (a CRDT merge, not a
 * replace).
 */
export function markdownToYdoc(md: string): NoteSnapshot {
	const { schema, mdm } = tools();
	const doc = new Y.Doc();
	prosemirrorJSONToYXmlFragment(
		schema,
		mdm.parse(md),
		doc.getXmlFragment(NOTE_FIELD),
	);
	// Read the JSON back from the document, so it is exactly what the collab
	// server derives from the same state later.
	const json = ydocToJSON(doc);
	return {
		state: Y.encodeStateAsUpdate(doc),
		json,
		markdown: md,
		plainText: notePlainText(json),
	};
}

/** The ProseMirror JSON of a note document. */
export function ydocToJSON(doc: Y.Doc): JSONContent {
	return yXmlFragmentToProsemirrorJSON(
		doc.getXmlFragment(NOTE_FIELD),
	) as JSONContent;
}

/** Markdown of note JSON (mentions as the lossless `[@ id=".." label=".."]` shortcode). */
export function jsonToMarkdown(json: JSONContent): string {
	return tools().mdm.serialize(json);
}

/** Loads a stored state into a fresh document. */
export function ydocFromState(state: Uint8Array): Y.Doc {
	const doc = new Y.Doc();
	Y.applyUpdate(doc, state);
	return doc;
}
