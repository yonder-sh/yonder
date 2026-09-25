/**
 * The TipTap field behind `MentionInput` (loaded lazily with the TipTap
 * chunk, QA VIS3-08). See `MentionInput` for the behaviour.
 */
import { Extension, Node as TiptapNode } from "@tiptap/core";
import { Placeholder } from "@tiptap/extensions";
import { EditorContent, useEditor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import { cn } from "cn";
import { useEffect, useMemo, useRef } from "react";
import { useAddPerson } from "@/components/common/member";
import { TESTID } from "@/lib/testids";
import { useWorkspaceOptional } from "@/lib/workspace/model-context";
import type { MentionInputProps } from "./MentionInput";
import type { MentionCtx } from "./mention-suggestion";
import { docToTokens, tokensToDoc } from "./mention-tokens";
import { liveMention } from "./note-extensions";
import { pendingPersonId } from "./pending-people";

const SingleLineDoc = TiptapNode.create({
	name: "doc",
	topNode: true,
	content: "paragraph",
});
const MultiLineDoc = TiptapNode.create({
	name: "doc",
	topNode: true,
	content: "paragraph+",
});
export default function MentionInputEditor({
	value,
	onChange,
	multiline,
	placeholder,
	disabled,
	onBlur,
	onFocus,
	onSubmit,
	onCancel,
	autoFocus,
	className,
	ariaLabel,
	testId,
}: MentionInputProps) {
	const ws = useWorkspaceOptional();
	const addPerson = useAddPerson();
	const ctx = useRef<MentionCtx>({ members: [], addPerson: null });
	const tripId = ws?.graph.trip.id ?? "";
	ctx.current = {
		members: ws?.graph.members ?? [],
		addPerson,
		// A new person is created when the text is saved, not when picked.
		pendPerson:
			addPerson && tripId ? (name) => pendingPersonId(tripId, name) : null,
	};
	const handlers = useRef({ onChange, onSubmit, onCancel, onBlur, onFocus });
	handlers.current = { onChange, onSubmit, onCancel, onBlur, onFocus };
	/** The last value this field emitted, so echoes don't reset the caret. */
	const emitted = useRef(value);

	const extensions = useMemo(() => {
		const Keys = Extension.create({
			name: "mentionInputKeys",
			// Below Mention (its popup handles Enter/Escape first).
			priority: 50,
			addKeyboardShortcuts() {
				const submit = () => {
					const cb = handlers.current.onSubmit;
					if (!cb) return false;
					cb(docToTokens(this.editor.getJSON()));
					return true;
				};
				const cancel = () => {
					handlers.current.onCancel?.();
					return !!handlers.current.onCancel;
				};
				const keys: Record<string, () => boolean> = { Escape: cancel };
				if (multiline) keys["Mod-Enter"] = submit;
				else {
					keys.Enter = submit;
					keys["Shift-Enter"] = () => true;
				}
				return keys;
			},
		});
		return [
			multiline ? MultiLineDoc : SingleLineDoc,
			StarterKit.configure({
				document: false,
				blockquote: false,
				bold: false,
				bulletList: false,
				code: false,
				codeBlock: false,
				heading: false,
				horizontalRule: false,
				italic: false,
				listItem: false,
				listKeymap: false,
				orderedList: false,
				strike: false,
				underline: false,
				link: false,
				hardBreak: false,
				trailingNode: false,
				dropcursor: false,
				gapcursor: false,
			}),
			liveMention(() => ctx.current),
			Placeholder.configure({ placeholder: placeholder ?? "" }),
			Keys,
		];
	}, [multiline, placeholder]);

	const editor = useEditor(
		{
			immediatelyRender: false,
			editable: !disabled,
			extensions,
			content: tokensToDoc(value, !!multiline),
			editorProps: {
				attributes: {
					"data-testid": testId ?? TESTID.mentionInput,
					"aria-label": ariaLabel ?? placeholder ?? "Text",
					role: "textbox",
					"aria-multiline": multiline ? "true" : "false",
					class: "outline-none",
				},
			},
			onUpdate: ({ editor: e }) => {
				const next = docToTokens(e.getJSON());
				emitted.current = next;
				handlers.current.onChange(next);
			},
			onBlur: () => handlers.current.onBlur?.(),
			onFocus: () => handlers.current.onFocus?.(),
		},
		[extensions],
	);

	// A value set from outside (reset after submit, "Use theirs") replaces the text.
	useEffect(() => {
		if (!editor || editor.isDestroyed) return;
		if (value === emitted.current) return;
		emitted.current = value;
		editor.commands.setContent(tokensToDoc(value, !!multiline), {
			emitUpdate: false,
		});
	}, [editor, value, multiline]);

	useEffect(() => {
		if (!editor || editor.isDestroyed) return;
		editor.setEditable(!disabled);
	}, [editor, disabled]);

	useEffect(() => {
		if (autoFocus && editor && !editor.isDestroyed)
			editor.commands.focus("end");
	}, [autoFocus, editor]);

	return (
		<div
			className={cn(
				"mention-input w-full min-w-0 rounded-md border border-input bg-transparent px-3 py-1.5 text-sm shadow-xs transition-[color,box-shadow] focus-within:border-ring focus-within:ring-[3px] focus-within:ring-ring/50",
				disabled && "cursor-not-allowed opacity-50",
				multiline ? "min-h-16" : "min-h-8",
				className,
			)}
			data-singleline={multiline ? undefined : ""}
		>
			<EditorContent editor={editor} />
		</div>
	);
}
