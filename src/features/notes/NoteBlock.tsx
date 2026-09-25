/**
 * A target's note with its two layers (ADDENDUM §7.2): the SHARED note
 * everyone on the trip reads, and an optional PRIVATE note ("Only me", a
 * separate Yjs doc `…/u/<userId>` that collab opens for its owner only). Any
 * member keeps a private note, viewers included; link guests don't. Shared
 * notes follow the role rules: editors write, suggesters propose additions
 * (WP-Suggest's `NoteSuggestions`), viewers read.
 */
import { useQuery } from "@tanstack/react-query";
import { cn } from "cn";
import { Lock, Users } from "lucide-react";
import { type ReactNode, useCallback, useEffect, useState } from "react";
import { NoteSuggestions } from "@/features/suggest/NoteSuggestions";
import { can } from "@/lib/auth/roles";
import { noteDocName } from "@/lib/realtime/protocol";
import type { BundleTarget } from "@/lib/schemas/targets";
import { useWorkspace } from "@/lib/workspace/use-workspace";
import { NoteEditor } from "./NoteEditor";
import { hasText, noteFor, tripNotesQuery } from "./queries";
import { NOTES_TESTID } from "./testids";

const PRIVATE_KEY = "yonder:notes:layer";

/** Who may write which layer, and why not. */
export function useNoteAccess() {
	const { access, mode, graph } = useWorkspace();
	const sharedWrite =
		access.mode === "edit" && can(access, "editNotes") && mode === "live";
	const sharedReason = sharedWrite
		? null
		: access.mode === "suggest"
			? "You're suggesting: propose an addition below."
			: access.mode === "read"
				? "View only."
				: null;
	const canPrivate =
		mode === "live" &&
		!access.isGuest &&
		!!access.memberId &&
		!!graph.me.userId;
	return { sharedWrite, sharedReason, canPrivate };
}

function readLayer(): "shared" | "private" {
	try {
		return localStorage.getItem(PRIVATE_KEY) === "private"
			? "private"
			: "shared";
	} catch {
		return "shared";
	}
}

export function NoteBlock({
	target,
	label,
	autoFocus,
	className,
	toolbar,
}: {
	target: BundleTarget;
	/** "Notes for Golden Gai". */
	label: string;
	autoFocus?: boolean;
	className?: string;
	/** Controls that share the switch's row (the inspector's place/visit switch). */
	toolbar?: ReactNode;
}) {
	const { graph, mode } = useWorkspace();
	const q = useQuery({
		...tripNotesQuery(graph.trip.id),
		enabled: mode === "live",
	});
	const { sharedWrite, sharedReason, canPrivate } = useNoteAccess();
	const [layer, setLayer] = useState<"shared" | "private">("shared");
	useEffect(() => setLayer(readLayer()), []);
	const pick = (l: "shared" | "private") => {
		setLayer(l);
		try {
			localStorage.setItem(PRIVATE_KEY, l);
		} catch {
			// private mode / blocked storage: the choice lasts this session
		}
	};
	const showPrivate = canPrivate && layer === "private";
	const shared = noteFor(q.data, target);
	const mine = canPrivate
		? noteFor(q.data, target, graph.me.userId)
		: undefined;
	const [editor, setEditor] = useState<unknown>(null);
	const onEditor = useCallback((e: unknown) => setEditor(e), []);

	return (
		<div className={className}>
			{toolbar || canPrivate ? (
				<div className="mb-3 flex flex-wrap items-center gap-2">
					{toolbar}
					{canPrivate ? (
						<fieldset
							aria-label="Which note"
							data-testid={NOTES_TESTID.privateToggle}
							className="inline-flex min-w-0 h-7 items-center rounded-full border p-0.5 text-xs"
						>
							<button
								type="button"
								aria-pressed={!showPrivate}
								onClick={() => pick("shared")}
								className={cn(
									"inline-flex h-6 items-center gap-1.5 rounded-full px-2.5 transition-colors",
									!showPrivate
										? "bg-foreground text-background"
										: "text-muted-foreground hover:text-foreground",
								)}
							>
								<Users className="size-3.5" strokeWidth={1.5} />
								Shared
								{showPrivate && hasText(shared) ? (
									<span
										role="img"
										aria-label="has a shared note"
										className="size-1.5 rounded-full bg-muted-foreground/70"
									/>
								) : null}
							</button>
							<button
								type="button"
								aria-pressed={showPrivate}
								onClick={() => pick("private")}
								className={cn(
									"inline-flex h-6 items-center gap-1.5 rounded-full px-2.5 transition-colors",
									showPrivate
										? "bg-foreground text-background"
										: "text-muted-foreground hover:text-foreground",
								)}
							>
								<Lock className="size-3.5" strokeWidth={1.5} />
								Only me
								{!showPrivate && hasText(mine) ? (
									<span
										role="img"
										aria-label="has a private note"
										className="size-1.5 rounded-full bg-muted-foreground/70"
									/>
								) : null}
							</button>
						</fieldset>
					) : null}
				</div>
			) : null}
			{showPrivate ? (
				// FB-17: my private note is mine alone: no cursor anywhere near it.
				<div data-cursor-vis="private">
					<NoteEditor
						key={`private:${noteDocName(graph.trip.id, target, graph.me.userId)}`}
						docName={noteDocName(graph.trip.id, target, graph.me.userId)}
						savedJson={mine?.json ?? null}
						allowWrite
						placeholder="Only you can see this note."
						label={`Your private note: ${label}`}
						autoFocus={autoFocus}
					/>
					<p className="mt-2 inline-flex items-center gap-1.5 text-xs text-muted-foreground">
						<Lock className="size-3" strokeWidth={1.5} /> Only you can see this.
						It never shows in anyone else's lists, counts or activity.
					</p>
				</div>
			) : (
				<>
					<NoteEditor
						key={`shared:${noteDocName(graph.trip.id, target)}`}
						docName={noteDocName(graph.trip.id, target)}
						savedJson={shared?.json ?? null}
						allowWrite={sharedWrite}
						readOnlyReason={sharedReason}
						label={label}
						autoFocus={autoFocus}
						onEditor={onEditor}
					/>
					<NoteSuggestions target={target} editor={editor} />
				</>
			)}
		</div>
	);
}
