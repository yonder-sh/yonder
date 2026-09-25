/**
 * One live note (DESIGN §7.4; SPEC §18.3 WP-Lists "Notes"): TipTap 3 on the
 * note's Yjs document over the shared collab socket, with Collaboration, named
 * carets in presence colours, the members-only @-mention popup (free-text
 * names add a person, ADDENDUM §8), Markdown shortcuts and Markdown paste.
 *
 * - Starts non-editable and becomes editable only when the server granted
 *   write access (spikes/collab gotcha 2), the viewer may edit here (not in
 *   suggest mode for shared notes) and we're online.
 * - Until the document has synced — and whenever it can't (offline, denied) —
 *   the saved copy renders statically; after 1.5 s it says "Saved copy ·
 *   editing paused" (DESIGN §7.4, SPEC §16.4 "offline is read-only").
 * - A short socket drop ("Reconnecting…") is NOT offline: the editor stays
 *   on screen and writable, and Yjs syncs what was typed once it's back
 *   (QA RT-12, `note-live.ts`).
 * - The TipTap editor itself (`LiveNote`) loads lazily with the first live
 *   note (QA VIS3-08, SPEC §19 PERF-05); until then the saved copy shows.
 */
import { cn } from "cn";
import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { useCollabDoc } from "@/lib/realtime/use-collab-doc";
import { useWorkspace } from "@/lib/workspace/use-workspace";
import { type NoteHold, noteLiveState } from "./note-live";
import { StaticNote } from "./StaticNote";
import { NOTES_TESTID } from "./testids";
import "./notes.css";

/** TipTap loads with the first live note, not with the workspace (QA VIS3-08). */
const LiveNote = lazy(() => import("./LiveNote"));

export type NoteEditorProps = {
	docName: string;
	/** The saved copy (ProseMirror JSON from `listTripNotes`), for the static render. */
	savedJson: unknown;
	/** May this viewer write here at all (the server has the last word)? */
	allowWrite: boolean;
	/** Why not, when `allowWrite` is false (shown in a muted line). */
	readOnlyReason?: string | null;
	placeholder?: string;
	autoFocus?: boolean;
	/** The TipTap editor, for WP-Suggest's `NoteSuggestions`. */
	onEditor?: (editor: unknown) => void;
	className?: string;
	/** Accessible name ("Notes for Golden Gai"). */
	label: string;
};

const SAVED_COPY_AFTER_MS = 1_500;

export function NoteEditor(props: NoteEditorProps) {
	const ws = useWorkspace();
	const note = useCollabDoc(ws.mode === "live" ? props.docName : null);
	// Never before the first sync: local edits into an empty doc would land
	// ahead of the saved content when it merges. After it, a reconnect keeps
	// the editor (QA RT-12). Derived during render on purpose: hiding the
	// editor for even one frame would drop the caret and the next keys.
	const hold = useRef<NoteHold>(null);
	const { live, writable, ...next } = noteLiveState({
		docName: props.docName,
		snap: note,
		connection: ws.connection,
		allowWrite: props.allowWrite,
		hold: hold.current,
	});
	hold.current = next.hold;
	// Create the editor only after the first sync, so it binds to the saved
	// content instead of writing an empty paragraph ahead of it (then keep it
	// through reconnects).
	const [ready, setReady] = useState<string | null>(null);
	useEffect(() => {
		if (note.synced) setReady(props.docName);
	}, [note.synced, props.docName]);
	const [paused, setPaused] = useState(false);
	useEffect(() => {
		if (live) {
			setPaused(false);
			return;
		}
		const t = setTimeout(() => setPaused(true), SAVED_COPY_AFTER_MS);
		return () => clearTimeout(t);
	}, [live]);

	return (
		<div className={cn("relative", props.className)}>
			{note.doc && note.provider && ready === props.docName ? (
				// While the editor's code loads, a live note still shows its text.
				<Suspense
					fallback={
						live ? (
							<StaticNote json={props.savedJson} className="min-h-24 py-1" />
						) : null
					}
				>
					<LiveNote
						key={props.docName}
						doc={note.doc}
						provider={note.provider}
						visible={live}
						writable={writable}
						{...props}
					/>
				</Suspense>
			) : null}
			{live ? null : (
				<div data-testid={NOTES_TESTID.savedCopy} aria-busy={!paused}>
					{props.savedJson ? (
						<StaticNote json={props.savedJson} className="min-h-24 py-1" />
					) : (
						<p className="min-h-24 py-1 text-[15px] text-muted-foreground">
							{paused ? "Nothing saved here yet." : ""}
						</p>
					)}
					{note.status === "denied" && note.reason === "gone" ? (
						// QA P1: its day was removed (a private note moved to the
						// owner's private trip note); nothing here can be saved.
						<p
							data-testid={NOTES_TESTID.readOnlyNote}
							className="mt-2 text-xs text-muted-foreground"
						>
							{props.docName.includes("/u/")
								? "This was removed. Your private note moved to the trip's Notes (Only me)."
								: "This was removed, so its note can't change any more."}
						</p>
					) : paused ? (
						<p className="mt-2 text-xs text-muted-foreground">
							Saved copy · editing paused
						</p>
					) : null}
				</div>
			)}
			{live && !writable && props.readOnlyReason ? (
				<p
					data-testid={NOTES_TESTID.readOnlyNote}
					className="mt-2 text-xs text-muted-foreground"
				>
					{props.readOnlyReason}
				</p>
			) : null}
		</div>
	);
}
