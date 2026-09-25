/**
 * `StaticNote`'s renderer (loaded lazily with the TipTap chunk, QA VIS3-08):
 * static React from `@tiptap/static-renderer`, so no editor or socket per
 * section; mentions show current names and profile pictures
 * (`NoteMentionChip`, the live editor's markup), links stay http(s) or mailto
 * (SPEC §7.10), and bad JSON renders nothing rather than throwing.
 */
import { renderToReactElement } from "@tiptap/static-renderer/pm/react";
import { cn } from "cn";
import { memo, type ReactNode } from "react";
import { safeUrlTransform } from "@/components/common/markdown-text";
import { noteExtensions } from "@/lib/notes/extensions.shared";
import { NoteMentionChip } from "./mention-chip";

let cached: ReturnType<typeof noteExtensions> | null = null;
const extensions = () => {
	cached ??= noteExtensions();
	return cached;
};

function StaticNoteImpl({
	json,
	className,
}: {
	json: unknown;
	className?: string;
}) {
	let body: ReactNode = null;
	try {
		if (json && typeof json === "object")
			body = renderToReactElement({
				content: json as Parameters<typeof renderToReactElement>[0]["content"],
				extensions: extensions(),
				options: {
					nodeMapping: {
						mention: ({ node }) => (
							<NoteMentionChip
								id={String(node.attrs.id ?? "")}
								label={String(node.attrs.label ?? "")}
							/>
						),
					},
					markMapping: {
						link: ({ mark, children }) => {
							const href = safeUrlTransform(String(mark.attrs.href ?? ""));
							return href ? (
								<a
									href={href}
									target="_blank"
									rel="noopener noreferrer nofollow"
								>
									{children}
								</a>
							) : (
								<span>{children}</span>
							);
						},
					},
				},
			});
	} catch {
		body = null;
	}
	return <div className={cn("yonder-note", className)}>{body}</div>;
}

export default memo(StaticNoteImpl);
