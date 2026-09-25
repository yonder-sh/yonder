/**
 * When a live note shows, and when it takes typing (QA RT-12; SPEC §10.7).
 * Only OFFLINE is read-only (QA D-11, SPEC §16.4): a collab socket that drops
 * for a moment ("Reconnecting…", ≤ 10 s) keeps the editor on screen and
 * writable, because Yjs holds the keystrokes and syncs them exactly once
 * when the provider reconnects. Before that, any drop hid the editor at once
 * (a stale saved copy replaced it) and swallowed what was typed.
 *
 * `hold` remembers, per document, that it synced (and whether we could
 * write): it's what lets the editor ride out the gap, whichever way it
 * started (a restarting server closes each document before its socket, so
 * a document close and a socket drop look alike). It is dropped when the
 * server refuses the document (a removed member: the saved copy shows), and
 * a read-only answer (a downgrade) stops the typing; the server drops any
 * write it no longer accepts either way.
 */
import type { DocSnapshot } from "@/lib/realtime/collab-client";
import type { ConnectionState } from "@/lib/workspace/model-context";

export type NoteHold = {
	doc: string;
	/** Synced with write access. */
	write: boolean;
} | null;

export type NoteLiveState = {
	/** Show the live editor (else the saved copy). */
	live: boolean;
	/** The editor takes typing. */
	writable: boolean;
	hold: NoteHold;
};

export function noteLiveState({
	docName,
	snap,
	connection,
	allowWrite,
	hold: previous,
}: {
	docName: string;
	snap: DocSnapshot & { canWrite: boolean };
	connection: ConnectionState;
	allowWrite: boolean;
	hold: NoteHold;
}): NoteLiveState {
	const offline = connection === "offline";
	let hold = previous?.doc === docName ? previous : null;
	if (snap.status === "denied") hold = null;
	else if (snap.synced)
		hold =
			hold?.write === snap.canWrite
				? hold
				: { doc: docName, write: snap.canWrite };
	else if (hold?.write && snap.status === "authenticated" && snap.readOnly)
		hold = { ...hold, write: false };
	// Synced before, not yet again: the reconnect is in progress.
	const resuming = !offline && !snap.synced && hold !== null;
	const live = !offline && (snap.synced || resuming);
	const writable =
		allowWrite && live && (snap.synced ? snap.canWrite : !!hold?.write);
	return { live, writable, hold };
}
