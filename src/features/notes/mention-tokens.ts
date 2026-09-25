/**
 * `MentionInput`'s value format (SPEC §12.5, §7.10): Markdown source with
 * `[@Label](mention:<memberId>)` tokens, to and from the field's TipTap
 * document. Plain functions (only a TipTap type), so they load without TipTap.
 */
import type { JSONContent } from "@tiptap/core";
import { MENTION_TOKEN_RE, mentionToken } from "@/lib/notes/mentions";

/** Markdown source with mention tokens → the field's document. */
export function tokensToDoc(value: string, multiline: boolean): JSONContent {
	const lines = multiline
		? value.split("\n")
		: [value.replace(/[\r\n]+/g, " ")];
	return {
		type: "doc",
		content: lines.map((line) => {
			const content: JSONContent[] = [];
			let last = 0;
			for (const m of line.matchAll(
				new RegExp(MENTION_TOKEN_RE.source, "gi"),
			)) {
				const at = m.index ?? 0;
				if (at > last)
					content.push({ type: "text", text: line.slice(last, at) });
				const label = (m[1] ?? "").replace(/\\(.)/g, "$1");
				content.push({
					type: "mention",
					attrs: { id: (m[2] ?? "").toLowerCase(), label },
				});
				last = at + m[0].length;
			}
			if (last < line.length)
				content.push({ type: "text", text: line.slice(last) });
			return content.length
				? { type: "paragraph", content }
				: { type: "paragraph" };
		}),
	};
}

/** The field's document → Markdown source with mention tokens. */
export function docToTokens(doc: JSONContent): string {
	return (doc.content ?? [])
		.map((p) =>
			(p.content ?? [])
				.map((n) => {
					if (n.type === "text") return n.text ?? "";
					if (n.type === "hardBreak") return "\n";
					if (n.type === "mention") {
						const id = String(n.attrs?.id ?? "");
						const label = String(n.attrs?.label ?? "");
						return id ? mentionToken(label || "someone", id) : "";
					}
					return "";
				})
				.join(""),
		)
		.join("\n");
}
