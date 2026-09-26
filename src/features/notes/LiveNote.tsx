/**
 * The live TipTap editor of one note (`NoteEditor` loads it lazily, so the
 * TipTap/ProseMirror chunk isn't part of the workspace's first load; QA
 * VIS3-08 / SPEC §19 PERF-05): Collaboration on the note's Yjs document,
 * named carets in presence colours, the members-only @-mention popup,
 * Markdown shortcuts and Markdown paste. See `NoteEditor` for the rules.
 * While I follow someone, their caret is kept in view (`useFollowCaret`).
 */
import type { HocuspocusProvider } from "@hocuspocus/provider";
import { Extension } from "@tiptap/core";
import Collaboration from "@tiptap/extension-collaboration";
import { Placeholder } from "@tiptap/extensions";
import { type Editor, EditorContent, useEditor } from "@tiptap/react";
import { yCursorPlugin } from "@tiptap/y-tiptap";
import { useEffect, useMemo, useRef, useState } from "react";
import type * as Y from "yjs";
import { presenceColor, useAddPerson } from "@/components/common/member";
import { scrollerOf, visibleBox } from "@/features/shell/cursors/anchors";
import {
	FOLLOW_EVERY_MS,
	followScroll,
} from "@/features/shell/cursors/scroll-rules";
import { useFollowPause } from "@/features/shell/follow-pause";
import { NOTE_FIELD } from "@/lib/notes/extensions.shared";
import { usePeers, useSetEditing } from "@/lib/realtime/presence";
import { useUi } from "@/lib/workspace/ui-store";
import { useWorkspace } from "@/lib/workspace/use-workspace";
import type { MentionCtx } from "./mention-suggestion";
import type { NoteEditorProps } from "./NoteEditor";
import { liveNoteExtensions, YjsCaretOnly } from "./note-extensions";
import { PasteMarkdown } from "./paste-markdown";
import { NOTES_TESTID } from "./testids";

/** DESIGN §2.2 presence colours as hex (y-tiptap only draws 6-digit hex colours). */
const PRESENCE_HEX = [
	"#2F7F86",
	"#B4539A",
	"#C98A1C",
	"#4E7BD3",
	"#6A8F3A",
	"#8C5BD6",
	"#3F8F6B",
	"#A0643A",
] as const;

type CaretUser = { id?: unknown; name?: unknown; color?: unknown };

/**
 * Remote carets (DESIGN §7.4): a 2px caret in the peer's presence colour with
 * a name label that fades after 2 s idle. The collab server rewrites every
 * awareness `user` (colour = a 0–7 index; SPEC §10.4), which the stock
 * CollaborationCaret can't draw, so this wires `yCursorPlugin` itself and maps
 * the index to the theme's `--presence-N` before the plugin reads it. The
 * plugin also publishes our own caret (the `cursor` awareness field).
 */
const NoteCarets = Extension.create<{
	awareness: HocuspocusProvider["awareness"] | null;
	colorOf: (user: CaretUser) => string;
}>({
	name: "noteCarets",
	addOptions() {
		return { awareness: null, colorOf: () => "var(--primary)" };
	},
	addProseMirrorPlugins() {
		const { awareness, colorOf } = this.options;
		if (!awareness) return [];
		return [
			yCursorPlugin(awareness, {
				awarenessStateFilter: (
					me: number,
					them: number,
					state: { user?: CaretUser },
				) => {
					if (me === them) return false;
					const user = state?.user;
					if (user && typeof user.color === "number") {
						// Keep the index for our colour lookup; hand the plugin a hex.
						state.user = {
							...user,
							colorIndex: user.color,
							color: PRESENCE_HEX[user.color % 8] ?? PRESENCE_HEX[0],
						} as CaretUser;
					}
					return true;
				},
				cursorBuilder: (user: CaretUser) => {
					const caret = document.createElement("span");
					caret.classList.add("collaboration-carets__caret");
					caret.style.setProperty("--caret", colorOf(user));
					caret.setAttribute("data-testid", "remote-cursor");
					caret.dataset.userId = String(user.id ?? "");
					const tag = document.createElement("div");
					tag.classList.add("collaboration-carets__label");
					tag.textContent = String(user.name ?? "Someone");
					caret.append(tag);
					return caret;
				},
				selectionBuilder: (user: CaretUser) => ({
					nodeName: "span",
					class: "collaboration-carets__selection",
					style: `background-color: color-mix(in oklab, ${colorOf(user)} 22%, transparent)`,
				}),
			}),
		];
	},
});

/**
 * Follow: the followed person's caret stays in view as they type or move
 * it (at most one smooth scroll per FOLLOW_EVERY_MS; not while I scrolled
 * away myself).
 */
function useFollowCaret(
	editor: Editor | null,
	awareness: HocuspocusProvider["awareness"],
): void {
	const following = useUi((s) => s.following);
	useEffect(() => {
		if (!editor || !awareness || !following) return;
		let raf = 0;
		let lastAt = 0;
		const check = () => {
			raf = 0;
			if (editor.isDestroyed || useFollowPause.getState().scroll) return;
			const caret = editor.view.dom.querySelector(
				`.collaboration-carets__caret[data-user-id="${CSS.escape(following)}"]`,
			);
			const scroller = caret ? scrollerOf(caret) : null;
			if (!caret || !scroller) return;
			const r = caret.getBoundingClientRect();
			const box = visibleBox(scroller);
			const dy = followScroll({
				view: { top: box.top, bottom: box.bottom },
				pointer: (r.top + r.bottom) / 2,
				range: null,
			});
			const now = performance.now();
			if (!dy || now - lastAt < FOLLOW_EVERY_MS) return;
			lastAt = now;
			const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
			scroller.scrollBy({ top: dy, behavior: reduce ? "auto" : "smooth" });
		};
		// The caret is redrawn after the awareness change: look on the next frame.
		const kick = () => {
			if (!raf) raf = requestAnimationFrame(check);
		};
		awareness.on("change", kick);
		editor.on("update", kick);
		kick();
		return () => {
			awareness.off("change", kick);
			editor.off("update", kick);
			if (raf) cancelAnimationFrame(raf);
		};
	}, [editor, awareness, following]);
}

function hashColor(id: string): number {
	let h = 0;
	for (const c of id) h = (h * 31 + c.charCodeAt(0)) | 0;
	return Math.abs(h) % 8;
}

export default function LiveNote({
	doc,
	provider,
	visible,
	writable,
	docName,
	placeholder = "Write something… Markdown works.",
	autoFocus,
	onEditor,
	label,
}: NoteEditorProps & {
	doc: Y.Doc;
	provider: HocuspocusProvider;
	visible: boolean;
	writable: boolean;
}) {
	const ws = useWorkspace();
	const addPerson = useAddPerson();
	const peers = usePeers();
	const setEditing = useSetEditing();

	// Read on every keystroke / caret paint, so the extensions never rebuild.
	const ctx = useRef<MentionCtx>({ members: [], addPerson: null });
	ctx.current = { members: ws.graph.members, addPerson };
	const colors = useRef(new Map<string, number>());
	colors.current = new Map([
		...ws.graph.members.flatMap((m) =>
			m.userId ? [[m.userId, m.color] as const] : [],
		),
		...peers.map((p) => [p.user.id, p.user.color] as const),
	]);
	const colorOf = (user: CaretUser & { colorIndex?: unknown }) => {
		const id = String(user.id ?? "");
		const index =
			typeof user.colorIndex === "number"
				? user.colorIndex
				: colors.current.get(id);
		return presenceColor(index ?? hashColor(id || String(user.name ?? "")));
	};

	// biome-ignore lint/correctness/useExhaustiveDependencies: colorOf reads refs; the extensions are built once per document.
	const extensions = useMemo(
		() => [
			...liveNoteExtensions(() => ctx.current),
			Collaboration.configure({ document: doc, field: NOTE_FIELD }),
			// Carets follow their Yjs positions only (QA RT-10: concurrent new lines).
			YjsCaretOnly,
			NoteCarets.configure({
				awareness: provider.awareness,
				colorOf,
			}),
			Placeholder.configure({ placeholder }),
			PasteMarkdown,
		],
		[doc, provider, placeholder],
	);

	// TipTap re-applies these options on renders (`setOptions`): keep `editable`
	// in step with what the effect below sets, or a re-render locks the editor.
	// Stable option objects matter: when they differ, TipTap calls
	// `setOptions` → `view.updateState` on every render, which redraws the DOM
	// selection from the editor state and eats a click that PM hasn't read yet.
	const canTypeRef = useRef(false);
	const editorProps = useMemo(
		() => ({
			attributes: {
				class: "yonder-note min-h-24 py-1",
				"data-testid": NOTES_TESTID.editor,
				"data-doc": docName,
				"aria-label": label,
				spellcheck: "true",
			},
		}),
		[docName, label],
	);
	const editor = useEditor(
		{
			immediatelyRender: false,
			shouldRerenderOnTransaction: false,
			editable: canTypeRef.current,
			extensions,
			editorProps,
		},
		[extensions],
	);

	// y-prosemirror renders the Yjs content into the view on a timeout(0) after
	// the editor is created; until then the view is an empty paragraph, and a
	// keystroke there would land AHEAD of the saved text. Wait one more tick.
	// A new editor instance (a new lease after a reconnect) starts unbound again.
	const [bound, setBound] = useState<unknown>(null);
	useEffect(() => {
		if (!editor) return;
		const t = setTimeout(() => setBound(editor), 30);
		return () => clearTimeout(t);
	}, [editor]);
	const canType = writable && !!editor && bound === editor;
	canTypeRef.current = canType;
	useEffect(() => {
		if (!editor || editor.isDestroyed) return;
		editor.setEditable(canType);
		editor.view.dom.setAttribute("data-editable", canType ? "true" : "false");
	}, [editor, canType]);

	useEffect(() => {
		onEditor?.(editor ?? null);
		return () => onEditor?.(null);
	}, [editor, onEditor]);
	useFollowCaret(editor, provider.awareness);

	// Once per editor: a reconnect must not throw the caret to the end.
	const autoFocused = useRef<unknown>(null);
	useEffect(() => {
		if (!autoFocus || !canType || !editor || editor.isDestroyed) return;
		if (autoFocused.current === editor) return;
		autoFocused.current = editor;
		editor.commands.focus("end");
	}, [autoFocus, canType, editor]);

	// "Maya is editing" presence while the editor has focus.
	useEffect(() => {
		if (!editor) return;
		const onFocus = () => setEditing({ kind: "note", id: docName.slice(-120) });
		const onBlur = () => setEditing(null);
		editor.on("focus", onFocus);
		editor.on("blur", onBlur);
		return () => {
			editor.off("focus", onFocus);
			editor.off("blur", onBlur);
		};
	}, [editor, docName, setEditing]);

	return (
		// FB-17a: inside the editor the TipTap caret takes over (the mouse cursor hides).
		<div hidden={!visible || bound !== editor} data-cursor-caret="">
			<EditorContent editor={editor} />
		</div>
	);
}
