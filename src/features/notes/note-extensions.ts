/**
 * Client-side note schema: the shared `noteExtensions()` (identical document
 * shape everywhere, SPEC §17.4) with the Mention node given the live
 * suggestion popup and a renderer that always shows the member's CURRENT
 * name (DESIGN §7.4) and their profile picture as a round avatar when they
 * have one (owner FB-16). A removed member reads as plain muted text (QA
 * MENT-03); a merged placeholder shows the person it became.
 */
import {
	type AnyExtension,
	Extension,
	InputRule,
	mergeAttributes,
} from "@tiptap/core";
import { Markdown } from "@tiptap/markdown";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { ySyncPluginKey } from "@tiptap/y-tiptap";
import { NoteMention, NoteStarterKit } from "@/lib/notes/extensions.shared";
import { mentionView } from "./mention-chip";
import { type MentionCtx, mentionSuggestion } from "./mention-suggestion";

export { mentionView } from "./mention-chip";

/**
 * The Mention node with the popup and current-name rendering. The markup
 * matches `NoteMentionChip` (the static renders): a member with a picture
 * gets `<img class="mention-avatar">` (round, `notes.css`) instead of the dot.
 */
export function liveMention(getCtx: () => MentionCtx): AnyExtension {
	return NoteMention.configure({
		suggestion: mentionSuggestion(getCtx),
		renderHTML: ({ node, options }) => {
			const id = String(node.attrs.id ?? "");
			const v = mentionView(
				getCtx().members,
				id,
				String(node.attrs.label ?? ""),
			);
			const attrs = mergeAttributes(options.HTMLAttributes, {
				"data-mention": id,
				"data-former": v.former ? "" : undefined,
				"data-avatar": v.image ? "" : undefined,
				style: `--mention-dot: ${v.color}`,
			});
			return v.image
				? [
						"span",
						attrs,
						[
							"img",
							{
								class: "mention-avatar",
								src: v.image,
								alt: "",
								draggable: "false",
							},
						],
						`@${v.name}`,
					]
				: ["span", attrs, `@${v.name}`];
		},
	});
}

/**
 * `[text](url)` typed at the end of a line → a link "text" (QA NOTE-01),
 * like the other Markdown shortcuts. Fires on the closing `)`. Only the
 * protocols a note may hold (`NOTE_LINK_PROTOCOLS`); a `www.` address gets
 * https. The rule sits on the client editor only; the schema is unchanged.
 */
export const MARKDOWN_LINK_INPUT =
	/(?<![!\\[])\[([^[\]\n]+)\]\(((?:https?:\/\/|mailto:|www\.)[^\s()<>]+)\)$/;

export function markdownLinkHref(raw: string): string | null {
	const href = /^www\./i.test(raw) ? `https://${raw}` : raw;
	return /^(https?:\/\/[^\s]+|mailto:[^\s]+)$/i.test(href) ? href : null;
}

export const MarkdownLinkInput = Extension.create({
	name: "markdownLinkInput",
	addInputRules() {
		return [
			new InputRule({
				find: MARKDOWN_LINK_INPUT,
				handler: ({ state, range, match }) => {
					const link = state.schema.marks.link;
					const [full, text, raw] = match;
					const href = raw ? markdownLinkHref(raw) : null;
					if (!link || !full?.startsWith("[") || !text?.trim() || !href)
						return null;
					const open = range.from;
					const textEnd = open + 1 + text.length;
					const { tr } = state;
					// `](url` (the `)` being typed never lands), then the `[`.
					tr.delete(textEnd, range.to);
					tr.delete(open, open + 1);
					tr.addMark(open, open + text.length, link.create({ href }));
					tr.removeStoredMark(link);
				},
			}),
		];
	},
});

/** The part of y-tiptap's `ProsemirrorBinding` this touches. */
type SyncBinding = { beforeTransactionSelection: unknown };

const guarded = new WeakSet<object>();

/**
 * Remote edits restore the local caret from its Yjs relative position only
 * (QA RT-10, RT-01/02). y-tiptap 3.0.9 adds a content-based "recovery" on
 * top (`recoverSelectionEndpoint`): when the caret sits at the start of an
 * empty paragraph, it looks for "the Nth empty paragraph" in the new
 * document — which is the OTHER person's new line when both pressed Enter
 * at the end of the note at once. Both carets then share one paragraph and
 * the two sentences interleave ("Beta … four.lpha … two.A"). The recovery
 * only runs when the saved selection carries its absolute positions
 * (`absAnchor`/`absHead`), so they are dropped whenever the binding saves
 * one and the relative positions decide, as in upstream y-prosemirror. (The
 * recovery targets block drag-and-drop, which notes don't have.)
 */
export function yjsCaretOnly(binding: SyncBinding): void {
	if (guarded.has(binding)) return;
	guarded.add(binding);
	const strip = (sel: unknown) =>
		sel && typeof sel === "object"
			? { ...sel, absAnchor: undefined, absHead: undefined }
			: sel;
	let saved = strip(binding.beforeTransactionSelection);
	Object.defineProperty(binding, "beforeTransactionSelection", {
		configurable: true,
		enumerable: true,
		get: () => saved,
		set: (v: unknown) => {
			saved = strip(v);
		},
	});
}

/** Put AFTER Collaboration: applies `yjsCaretOnly` to the editor's y-sync binding. */
export const YjsCaretOnly = Extension.create({
	name: "yjsCaretOnly",
	addProseMirrorPlugins() {
		return [
			new Plugin({
				key: new PluginKey("yjsCaretOnly"),
				view: (view) => {
					const binding = (
						ySyncPluginKey.getState(view.state) as
							| { binding?: SyncBinding }
							| undefined
					)?.binding;
					if (binding && "beforeTransactionSelection" in binding)
						yjsCaretOnly(binding);
					return {};
				},
			}),
		];
	},
});

/** The full schema for an editor (same nodes and marks as `noteExtensions()`). */
export function liveNoteExtensions(getCtx: () => MentionCtx): AnyExtension[] {
	return [
		// NOTE-04: underline can't be typed and exports as plain text.
		NoteStarterKit,
		liveMention(getCtx),
		Markdown.configure({ indentation: { style: "space", size: 2 } }),
		MarkdownLinkInput,
	];
}
