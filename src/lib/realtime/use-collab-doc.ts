import type { HocuspocusProvider } from "@hocuspocus/provider";
import { useEffect, useState, useSyncExternalStore } from "react";
import type { Awareness } from "y-protocols/awareness";
import type * as Y from "yjs";
import type { DocLease, DocSnapshot } from "./collab-client";
import { parseDocName } from "./protocol";
import { useCollabClient } from "./trip-channel";

/**
 * One note document for an editor (SPEC §10.2; spikes/collab):
 *
 *   const note = useCollabDoc(noteDocName(tripId, target))
 *   const editor = useEditor({
 *     editable: false,                       // enable only when note.canWrite
 *     extensions: [...noteExtensions,        // StarterKit({ undoRedo: false, trailingNode: false })
 *       Collaboration.configure({ document: note.doc }),
 *       CollaborationCaret.configure({ provider: note.provider, render: presenceCaret })],
 *   }, [note.doc])
 *   useEffect(() => editor?.setEditable(note.canWrite), [editor, note.canWrite])
 *
 * The provider lives outside React (ref-counted on the shared socket), so
 * StrictMode double-mounts never open extra documents. `doc`/`provider` are null
 * until mounted in the browser, and change only when `docName` changes.
 *
 * Read-only is enforced by the server (viewers' writes are dropped); `canWrite`
 * lets the editor stay non-editable so a viewer never holds unsynced local edits
 * (spikes/collab VERIFY: start editors with `editable: false`).
 */
export type CollabDocState = DocSnapshot & {
	doc: Y.Doc | null;
	provider: HocuspocusProvider | null;
	awareness: Awareness | null;
	/** Authenticated with write access. */
	canWrite: boolean;
};

const PENDING: DocSnapshot = {
	status: "connecting",
	synced: false,
	readOnly: true,
	reason: null,
};
const noopSubscribe = () => () => {};
const pending = () => PENDING;

export function useCollabDoc(
	docName: string | null | undefined,
): CollabDocState {
	const client = useCollabClient();
	const [lease, setLease] = useState<DocLease | null>(null);

	useEffect(() => {
		if (!client || !docName) return;
		if (parseDocName(docName)?.kind !== "note") {
			console.error(`useCollabDoc: "${docName}" is not a note document name`);
			return;
		}
		const l = client.acquire(docName);
		setLease(l);
		return () => {
			l.release();
			setLease(null);
		};
	}, [client, docName]);

	const snap = useSyncExternalStore(
		lease?.subscribe ?? noopSubscribe,
		lease?.getSnapshot ?? pending,
		pending,
	);
	return {
		...snap,
		doc: lease?.doc ?? null,
		provider: lease?.provider ?? null,
		awareness: lease?.awareness ?? null,
		canWrite: snap.status === "authenticated" && !snap.readOnly,
	};
}
