/**
 * The note document schema (SPEC §17.4): shared by the collab server (deriving
 * JSON and plain text), static rendering, server-side seeding
 * (`markdownToYdoc`) and the browser editor. Everything that shapes the Yjs
 * document must be identical everywhere, so it lives here. No React.
 *
 * The editor ADDS client-only extensions on top (Collaboration,
 * CollaborationCaret, the mention suggestion UI). It must keep StarterKit's
 * `undoRedo` and `trailingNode` off (spikes/collab: Collaboration brings its own
 * undo manager, and TrailingNode makes every client append its own paragraph).
 */
import type { AnyExtension, Mark } from "@tiptap/core";
import Mention from "@tiptap/extension-mention";
import { Markdown } from "@tiptap/markdown";
import StarterKit, { type StarterKitOptions } from "@tiptap/starter-kit";

/** The Y.XmlFragment the Collaboration extension binds to (its default). */
export const NOTE_FIELD = "default";

/** Link protocols a note may contain (SPEC §7.10). */
export const NOTE_LINK_PROTOCOLS = ["http", "https", "mailto"] as const;

/** StarterKit options every side uses. */
export const starterKitOptions: Partial<StarterKitOptions> = {
	undoRedo: false,
	trailingNode: false,
	link: {
		openOnClick: false,
		autolink: true,
		// No `protocols`: http(s) and mailto are linkify's own schemes, and
		// registering them as custom ones on every editor mount logged
		// "linkifyjs: already initialized" whenever a second editor opened.
		// Never let a stored link turn into javascript:/data: (belt and braces:
		// MarkdownText and the static renderer filter URLs too).
		isAllowedUri: (url: string) => /^(https?:|mailto:)/i.test(url),
	},
};

/**
 * Mention nodes: `{ id: memberId, label }`, rendered as "@Label". The label is
 * only a fallback; the UI always shows the member's current name (§7.5).
 */
export const NoteMention = Mention.configure({
	HTMLAttributes: { class: "mention" },
	renderText: ({ node }) =>
		`@${String(node.attrs.label ?? node.attrs.id ?? "")}`,
});

/**
 * NOTE-04: a note's markdown stays CommonMark, so underline can't be made any
 * more (no Ctrl+U, no pasted `<u>`, no `++x++` read from markdown) and exports
 * as plain text. The mark stays in the schema only so notes that already have
 * underlined text keep it: y-prosemirror deletes text whose mark it can't
 * build.
 */
function noUnderline(ext: AnyExtension): AnyExtension {
	if (ext.name !== "underline") return ext;
	return (ext as Mark).extend({
		parseHTML: () => [],
		addKeyboardShortcuts: () => ({
			// Swallowed (Chrome would open view-source), never toggled.
			"Mod-u": () => true,
			"Mod-U": () => true,
		}),
		addInputRules: () => [],
		addPasteRules: () => [],
		// `null`, not `undefined`: undefined falls back to the parent's tokenizer.
		markdownTokenizer: null as never,
		renderMarkdown: (node, helpers) => helpers.renderChildren(node),
	});
}

/** StarterKit with `starterKitOptions` and underline neutralised (`noUnderline`). */
export const NoteStarterKit = StarterKit.extend({
	addExtensions() {
		return (this.parent?.() ?? []).map(noUnderline);
	},
}).configure(starterKitOptions);

/** The schema extensions (no suggestion UI, no collaboration). */
export function noteExtensions(): AnyExtension[] {
	return [
		NoteStarterKit,
		NoteMention,
		Markdown.configure({ indentation: { style: "space", size: 2 } }),
	];
}
