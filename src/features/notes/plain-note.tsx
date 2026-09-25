/**
 * A saved note (ProseMirror JSON) as plain React, without TipTap: what
 * `StaticNote` shows while its renderer (the TipTap chunk, loaded lazily for
 * QA VIS3-08 / SPEC §19 PERF-05) is on its way. It covers StarterKit's nodes
 * and marks and mentions (the same `NoteMentionChip`, picture included), in
 * the same `.yonder-note` styles, so the swap to the real render doesn't move
 * anything.
 */
import { cn } from "cn";
import type { ReactNode } from "react";
import { safeUrlTransform } from "@/components/common/markdown-text";
import { NoteMentionChip } from "./mention-chip";

type PmNode = {
	type?: string;
	text?: string;
	attrs?: Record<string, unknown>;
	marks?: { type?: string; attrs?: Record<string, unknown> }[];
	content?: PmNode[];
};

function inline(n: PmNode, key: number): ReactNode {
	if (n.type === "hardBreak") return <br key={key} />;
	if (n.type === "mention")
		return (
			<NoteMentionChip
				key={key}
				id={String(n.attrs?.id ?? "")}
				label={String(n.attrs?.label ?? "")}
			/>
		);
	if (n.type !== "text") return null;
	let out: ReactNode = n.text ?? "";
	for (const m of n.marks ?? []) {
		if (m.type === "bold") out = <strong>{out}</strong>;
		else if (m.type === "italic") out = <em>{out}</em>;
		else if (m.type === "strike") out = <s>{out}</s>;
		else if (m.type === "code") out = <code>{out}</code>;
		else if (m.type === "link") {
			const href = safeUrlTransform(String(m.attrs?.href ?? ""));
			out = href ? (
				<a href={href} target="_blank" rel="noopener noreferrer nofollow">
					{out}
				</a>
			) : (
				out
			);
		}
	}
	return <span key={key}>{out}</span>;
}

function block(n: PmNode, key: number): ReactNode {
	const kids = (n.content ?? []).map((c, i) =>
		c.type === "text" || c.type === "mention" || c.type === "hardBreak"
			? inline(c, i)
			: block(c, i),
	);
	switch (n.type) {
		case "paragraph":
			return <p key={key}>{kids}</p>;
		case "heading": {
			const level = Number(n.attrs?.level ?? 1);
			return level <= 1 ? (
				<h1 key={key}>{kids}</h1>
			) : level === 2 ? (
				<h2 key={key}>{kids}</h2>
			) : (
				<h3 key={key}>{kids}</h3>
			);
		}
		case "bulletList":
			return <ul key={key}>{kids}</ul>;
		case "orderedList":
			return <ol key={key}>{kids}</ol>;
		case "listItem":
			return <li key={key}>{kids}</li>;
		case "blockquote":
			return <blockquote key={key}>{kids}</blockquote>;
		case "codeBlock":
			return (
				<pre key={key}>
					<code>{kids}</code>
				</pre>
			);
		case "horizontalRule":
			return <hr key={key} />;
		default:
			return kids.length ? <div key={key}>{kids}</div> : null;
	}
}

export function PlainNote({
	json,
	className,
}: {
	json: unknown;
	className?: string;
}) {
	const doc = json && typeof json === "object" ? (json as PmNode) : null;
	return (
		<div className={cn("yonder-note", className)}>
			{(doc?.content ?? []).map(block)}
		</div>
	);
}
