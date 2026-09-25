/**
 * Safe Markdown for short prose fields (SPEC D20, §7.10): react-markdown +
 * remark-gfm, **no raw HTML** (`skipHtml`, no rehype-raw), and a
 * `urlTransform` that keeps only http(s), mailto and `mention:` links. Mention
 * tokens `[@Label](mention:<memberId>)` render as `MentionChip`s showing the
 * member's CURRENT name and profile picture (owner FB-16). Images in the text
 * are never rendered (no tracking pixels); a chip's picture comes from the
 * trip's member list, never from the Markdown.
 */
import { cn } from "cn";
import { memo } from "react";
import Markdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import type { GraphMember } from "@/lib/engine/types";
import { avatarSrc } from "@/lib/schemas/avatar";
import { useWorkspaceOptional } from "@/lib/workspace/model-context";
import { presenceColor } from "./person-avatar";

const SAFE_URL = /^(https?:|mailto:)/i;
const MENTION = /^mention:([0-9a-f-]{36})$/i;

/** Keeps http(s), mailto and mention: URLs; everything else (javascript:, data:, relative) becomes ''. */
export function safeUrlTransform(url: string): string {
	const u = url.trim();
	if (MENTION.test(u) || SAFE_URL.test(u)) return u;
	return "";
}

/** `resolveMember` (member.tsx) without its imports: follows merges (≤ 4 hops). */
function followMerges(
	members: readonly GraphMember[],
	memberId: string,
): GraphMember | undefined {
	let m = members.find((x) => x.id === memberId);
	for (let hops = 0; m?.mergedIntoId && hops < 4; hops++) {
		const next = members.find((x) => x.id === m?.mergedIntoId);
		if (!next) break;
		m = next;
	}
	return m;
}

/**
 * `@Name` chip; the name is the member's CURRENT one (the token label is a
 * fallback outside a trip), led by their profile picture as a round avatar
 * when they have one (owner FB-16). A merged placeholder shows as the member
 * it became (`resolveMember`); a removed member reads as plain muted text, no
 * chip (ADDENDUM §10, QA MENT-03).
 */
export function MentionChip({
	memberId,
	label,
	className,
}: {
	memberId: string;
	label: string;
	className?: string;
}) {
	const ws = useWorkspaceOptional();
	const member = ws ? followMerges(ws.graph.members, memberId) : undefined;
	if (member?.status === "removed")
		return (
			<span
				data-mention={memberId}
				data-removed=""
				className={cn("text-muted-foreground", className)}
			>
				{member.name}
			</span>
		);
	const name = member?.name ?? (ws ? "former member" : label.replace(/^@/, ""));
	const image = member?.image ? avatarSrc(member.image, 16) : null;
	return (
		<span
			data-mention={memberId}
			data-avatar={image ? "" : undefined}
			className={cn(
				"inline-flex items-baseline gap-1 rounded-sm bg-primary/10 px-1 font-medium text-primary",
				image && "pl-0.5",
				!member && ws && "bg-muted text-muted-foreground italic",
				className,
			)}
		>
			{image ? (
				// Round, cover-cropped; the presence colour shows while it loads, and
				// the ::after (drawn only for a broken image) hides the broken icon.
				<img
					src={image}
					alt=""
					draggable={false}
					data-mention-avatar=""
					className="pointer-events-none relative aspect-square size-[1.15em] shrink-0 self-center overflow-hidden rounded-full object-cover select-none after:absolute after:inset-0 after:rounded-full after:bg-inherit"
					style={{ backgroundColor: presenceColor(member?.color) }}
				/>
			) : null}
			@{name}
		</span>
	);
}

const inlineComponents: Components = {
	p: ({ children }) => <>{children}</>,
};

const components: Components = {
	a: ({ href, children }) => {
		const m = href ? MENTION.exec(href) : null;
		if (m?.[1]) return <MentionChip memberId={m[1]} label={String(children)} />;
		if (!href) return <span>{children}</span>;
		return (
			<a
				href={href}
				target="_blank"
				rel="noopener noreferrer nofollow"
				className="text-primary underline underline-offset-2"
			>
				{children}
			</a>
		);
	},
	img: () => null,
	ul: ({ children }) => <ul className="ml-4 list-disc">{children}</ul>,
	ol: ({ children }) => <ol className="ml-4 list-decimal">{children}</ol>,
	code: ({ children }) => (
		<code className="rounded bg-muted px-1 font-mono text-[0.9em]">
			{children}
		</code>
	),
};

function MarkdownTextImpl({
	md,
	inline,
	className,
}: {
	md: string;
	inline?: boolean;
	className?: string;
}) {
	const Tag = inline ? "span" : "div";
	return (
		<Tag className={cn(!inline && "space-y-1.5", className)}>
			<Markdown
				remarkPlugins={[remarkGfm]}
				skipHtml
				urlTransform={safeUrlTransform}
				components={
					inline ? { ...components, ...inlineComponents } : components
				}
			>
				{md}
			</Markdown>
		</Tag>
	);
}

/** Memoized on `md`. `inline` drops paragraph wrappers (one-line fields). */
export const MarkdownText = memo(MarkdownTextImpl);
