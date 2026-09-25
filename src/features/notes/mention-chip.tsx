/**
 * A note's @mention chip (DESIGN §7.4, owner FB-16), without TipTap, so the
 * static renders (`StaticNoteRender`, and `PlainNote` before the TipTap chunk
 * arrives, QA VIS3-08) draw the same markup as the live editor's
 * `liveMention` renderHTML: the member's CURRENT name, and their profile
 * picture as a round avatar in place of the presence dot when they have one
 * (`.mention-avatar`, `notes.css`). A removed member reads as plain muted
 * text (QA MENT-03); a merged placeholder shows the person it became.
 */
import type { CSSProperties } from "react";
import {
	presenceColor,
	resolveMember,
} from "@/components/common/person-avatar";
import type { GraphMember } from "@/lib/engine/types";
import { avatarSrc } from "@/lib/schemas/avatar";
import { useWorkspaceOptional } from "@/lib/workspace/model-context";
import { pendingPerson } from "./pending-people";

/** The chip's avatar, in CSS px (a 20px pill). */
export const MENTION_AVATAR_PX = 16;

export type MentionView = {
	name: string;
	/** The presence colour: the dot, or the avatar's ground while it loads. */
	color: string;
	former: boolean;
	/** The profile picture URL at chip size, null without one. */
	image: string | null;
};

/** How a mention node shows: the current name, colour, picture, and whether it's a former member. */
export function mentionView(
	members: readonly GraphMember[],
	id: string,
	label: string,
): MentionView {
	// A new person picked in a field that isn't saved yet (ADDENDUM §8).
	const pending = pendingPerson(id);
	const m = resolveMember(members, pending?.memberId ?? id);
	if (!m && pending)
		return {
			name: label || pending.name,
			color: presenceColor(0),
			former: false,
			image: null,
		};
	if (!m || m.status === "removed")
		return {
			name: m?.name ?? (label || "former member"),
			color: "var(--muted-foreground)",
			former: true,
			image: null,
		};
	return {
		name: m.name,
		color: presenceColor(m.color),
		former: false,
		image: m.image ? avatarSrc(m.image, MENTION_AVATAR_PX) : null,
	};
}

/** The chip as React; same markup as `liveMention`'s renderHTML. */
export function NoteMentionChip({ id, label }: { id: string; label: string }) {
	const ws = useWorkspaceOptional();
	const v = mentionView(ws?.graph.members ?? [], id, label);
	return (
		<span
			className="mention"
			data-mention={id}
			data-former={v.former ? "" : undefined}
			data-avatar={v.image ? "" : undefined}
			style={{ "--mention-dot": v.color } as CSSProperties}
		>
			{v.image ? (
				<img
					className="mention-avatar"
					src={v.image}
					alt=""
					draggable={false}
				/>
			) : null}
			@{v.name}
		</span>
	);
}
