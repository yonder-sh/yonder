/**
 * Plain text of note JSON (ProseMirror): text, `@Label` for mentions, one line
 * per block. Isomorphic (previews, search, `yjs_documents.plain_text`).
 */
const BLOCKS = new Set([
	"paragraph",
	"heading",
	"codeBlock",
	"blockquote",
	"listItem",
	"taskItem",
	"horizontalRule",
]);

export function notePlainText(json: unknown): string {
	const parts: string[] = [];
	const walk = (node: unknown) => {
		if (!node || typeof node !== "object") return;
		const n = node as {
			type?: unknown;
			text?: unknown;
			attrs?: Record<string, unknown>;
			content?: unknown;
		};
		if (n.type === "text" && typeof n.text === "string") parts.push(n.text);
		else if (n.type === "mention") {
			const label = n.attrs?.label ?? n.attrs?.id;
			if (typeof label === "string") parts.push(`@${label}`);
		} else if (n.type === "hardBreak") parts.push("\n");
		if (Array.isArray(n.content)) for (const c of n.content) walk(c);
		if (typeof n.type === "string" && BLOCKS.has(n.type)) parts.push("\n");
	};
	walk(json);
	return parts
		.join("")
		.replace(/[ \t]+\n/g, "\n")
		.replace(/\n{3,}/g, "\n\n")
		.trim();
}
