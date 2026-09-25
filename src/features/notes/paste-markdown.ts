/**
 * Pasting Markdown into a note (SPEC §18.3 WP-Lists; copied from
 * spikes/collab/client/src/editor/pasteMarkdown.ts). `@tiptap/markdown` has
 * no paste handling: plain text that looks like Markdown is inserted with
 * `contentType: 'markdown'`; rich HTML (Google Docs, web pages) goes through
 * ProseMirror's own HTML parser, which drops fonts and colours (QA NOTE-04).
 * Underline is styling too and is dropped before that parse: Google Docs
 * underlines every link (`<span style="text-decoration:underline">`), and an
 * underline mark would store `[++the guide++](…)`, which isn't CommonMark.
 */
import { Extension } from "@tiptap/core";
import { Plugin, PluginKey } from "@tiptap/pm/state";

const MD_HINTS = [
	/^#{1,6}\s/m, // heading
	/^\s*[-*+]\s+\S/m, // bullet list
	/^\s*\d+[.)]\s+\S/m, // ordered list
	/^>\s?/m, // blockquote
	/^```/m, // fence
	/\*\*[^*\n]+\*\*/, // bold
	/(^|\s)_[^_\n]+_(\s|$)/, // italic
	/`[^`\n]+`/, // inline code
	/\[[^\]\n]+\]\([^)\s]+\)/, // link
];

export const looksLikeMarkdown = (text: string) =>
	MD_HINTS.some((re) => re.test(text));

/** A `text-decoration(-line)` declaration that underlines (with the `;` before it). */
const UNDERLINE_DECL =
	/(?:^|;)\s*text-decoration(?:-line)?\s*:[^;]*\bunderline\b[^;]*/gi;

/**
 * Pasted HTML without underlines: `<u>` unwrapped and `text-decoration:
 * underline` taken out of inline styles. HTML from our own editors
 * (`data-pm-slice`, a copy inside Yonder) is left as it is. Exported for tests.
 */
export function stripPastedUnderline(html: string): string {
	if (/\bdata-pm-slice=/.test(html)) return html;
	return html
		.replace(/<\/?u(?=[\s>/])[^>]*>/gi, "")
		.replace(
			/(\sstyle\s*=\s*)(["'])(.*?)\2/gis,
			(_m, attr: string, q: string, css: string) =>
				`${attr}${q}${css.replace(UNDERLINE_DECL, "").replace(/^[\s;]+/, "")}${q}`,
		);
}

/** HTML that carries real document structure → ProseMirror's HTML parser handles it. */
const STRUCTURED_HTML =
	/<(p|h[1-6]|ul|ol|li|blockquote|pre|table|strong|em|b|i|a)[\s>]/i;

export const PasteMarkdown = Extension.create({
	name: "pasteMarkdown",
	addProseMirrorPlugins() {
		const editor = this.editor;
		return [
			new Plugin({
				key: new PluginKey("pasteMarkdown"),
				props: {
					transformPastedHTML: stripPastedUnderline,
					handlePaste(view, event) {
						const text = event.clipboardData?.getData("text/plain");
						const html = event.clipboardData?.getData("text/html") ?? "";
						if (!text || !editor.markdown) return false;
						// Raw paste inside code blocks.
						if (view.state.selection.$from.parent.type.spec.code) return false;
						// Rich sources → HTML path; code editors' <div>/<span> soup → plain text.
						if (html && STRUCTURED_HTML.test(html)) return false;
						if (!looksLikeMarkdown(text)) return false;
						return editor.commands.insertContent(text, {
							contentType: "markdown",
						});
					},
				},
			}),
		];
	},
});
