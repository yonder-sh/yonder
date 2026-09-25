/**
 * Mention tokens in Markdown fields (SPEC §7.10): `[@Label](mention:<memberId>)`,
 * a valid Markdown link. Isomorphic; the server parses tokens to diff the
 * `mentions` rows, `MentionInput` writes them, `MarkdownText` renders them.
 */

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";

/** Matches one token; group 1 = label, group 2 = memberId. */
export const MENTION_TOKEN_RE = new RegExp(
	`\\[@((?:[^\\[\\]\\\\]|\\\\.){1,80})\\]\\(mention:(${UUID})\\)`,
	"gi",
);

/** Distinct member ids mentioned in `md`, in order of first appearance. */
export function parseMentionIds(md: string | null | undefined): string[] {
	if (!md) return [];
	const out: string[] = [];
	for (const m of md.matchAll(MENTION_TOKEN_RE)) {
		const id = m[2]?.toLowerCase();
		if (id && !out.includes(id)) out.push(id);
	}
	return out;
}

/**
 * `md` as it reads: every mention token as its "@Label" (a comment's
 * "ask [@Audrey Tester](mention:<uuid>)" reads "ask @Audrey Tester").
 */
export function mentionsAsText(md: string): string {
	return md.replace(
		new RegExp(MENTION_TOKEN_RE.source, "gi"),
		(_, label: string) => `@${label.replace(/\\(.)/g, "$1")}`,
	);
}

/** Escapes `[`, `]` and `\` in a label so the token stays one link. */
function escapeLabel(label: string): string {
	return label
		.replace(/[\r\n]+/g, " ")
		.trim()
		.slice(0, 80)
		.replace(/[\\[\]]/g, (c) => `\\${c}`);
}

/** A mention token for `memberId`, labelled with the member's current name. */
export function mentionToken(label: string, memberId: string): string {
	return `[@${escapeLabel(label)}](mention:${memberId})`;
}

/** The `href` of a mention link (what `MarkdownText`'s url transform lets through). */
export function isMentionHref(href: string | null | undefined): boolean {
	return !!href && new RegExp(`^mention:${UUID}$`, "i").test(href);
}

/** The member id of a mention href, or null. */
export function mentionIdOf(href: string | null | undefined): string | null {
	return isMentionHref(href) ? (href as string).slice(8).toLowerCase() : null;
}
