/**
 * Text with @mentions (SPEC §12.5 `MentionInput({ value, onChange, multiline?,
 * placeholder? })`, §7.10): a small TipTap field that edits one line (or a
 * few, when `multiline`) of Markdown SOURCE and shows mentions as chips. The
 * value round-trips as text with `[@Label](mention:<memberId>)` tokens, so
 * the server's `syncMentions` sees exactly what was typed. Markdown isn't
 * interpreted while editing (`**bold**` stays as typed; `MarkdownText`
 * renders it). The popup offers members only; typing a new name offers
 * "Add “Name” as a new person" (ADDENDUM §8): the chip is pending until the
 * value is saved (`pending-people.ts`), so a cancelled edit adds nobody.
 *
 * Keys: Enter submits (`onSubmit`) in single-line mode, ⌘/Ctrl+Enter in
 * multi-line; Escape calls `onCancel` (when no popup is open).
 *
 * The editor (`MentionInputEditor`) loads lazily with the TipTap chunk (QA
 * VIS3-08, SPEC §19 PERF-05); a stand-in with the same box shows until then.
 */
import { cn } from "cn";
import { lazy, Suspense, useState } from "react";
import { MENTION_TOKEN_RE } from "@/lib/notes/mentions";
import "./notes.css";

export { docToTokens, tokensToDoc } from "./mention-tokens";

export type MentionInputProps = {
	value: string;
	onChange: (value: string) => void;
	multiline?: boolean;
	placeholder?: string;
	disabled?: boolean;
	onBlur?: () => void;
	onFocus?: () => void;
	/** Enter (single-line) or ⌘/Ctrl+Enter (multi-line). */
	onSubmit?: (value: string) => void;
	/** Escape, when the mention popup isn't open. */
	onCancel?: () => void;
	autoFocus?: boolean;
	className?: string;
	ariaLabel?: string;
	/** Overrides the shared `mention-input` test id. */
	testId?: string;
};

/** TipTap loads with the first field on screen, not with the workspace (QA VIS3-08). */
const Editor = lazy(() => import("./MentionInputEditor"));

export function MentionInput(props: MentionInputProps) {
	// A click or tap on the stand-in focuses the field once it's there.
	const [wantsFocus, setWantsFocus] = useState(false);
	return (
		<Suspense
			fallback={
				<MentionInputStandIn
					{...props}
					onWantFocus={() => setWantsFocus(true)}
				/>
			}
		>
			<Editor {...props} autoFocus={props.autoFocus || wantsFocus} />
		</Suspense>
	);
}

/**
 * The field's box and text, for the moment its editor loads: same classes,
 * the value with mentions as "@Name" (or the placeholder). Hidden from
 * assistive tech and tests: the real field (with its test id) replaces it.
 */
function MentionInputStandIn({
	value,
	multiline,
	placeholder,
	disabled,
	className,
	onWantFocus,
}: MentionInputProps & { onWantFocus: () => void }) {
	const text = value.replace(
		new RegExp(MENTION_TOKEN_RE.source, "gi"),
		(_m, label: string) => `@${label.replace(/\\(.)/g, "$1")}`,
	);
	return (
		<div
			aria-hidden
			onPointerDown={disabled ? undefined : onWantFocus}
			className={cn(
				"mention-input w-full min-w-0 cursor-text rounded-md border border-input bg-transparent px-3 py-1.5 text-sm shadow-xs",
				disabled && "cursor-not-allowed opacity-50",
				multiline ? "min-h-16" : "min-h-8",
				className,
			)}
			data-singleline={multiline ? undefined : ""}
		>
			<p
				className={cn(
					multiline ? "whitespace-pre-wrap" : "truncate",
					!text && "text-muted-foreground",
				)}
			>
				{text || placeholder || "\u00a0"}
			</p>
		</div>
	);
}
