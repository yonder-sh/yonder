/**
 * Per-member ratings of one node (DESIGN §4.4 "Priority: one chip row per
 * member"; ADDENDUM §10 rating comments). Everyone sees every member's
 * rating and comment; you set your own when your role may rate (PLACES §1c:
 * raters and up, never plain viewers), and editors may also set a
 * placeholder's (an imported friend without an account, like Audrey).
 * Comments are editable only by their author (placeholders: by editors), are
 * ≤ 280 characters as read (a mention counts as its "@Name", PLAN-R3-03) and
 * may hold @mentions (`MentionInput`, WP-Lists).
 */
import { cn } from "cn";
import { MessageSquare, Pencil } from "lucide-react";
import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { EditGuard, useEditGuard } from "@/components/common/edit-guard";
import { MarkdownText } from "@/components/common/markdown-text";
import { MemberAvatar } from "@/components/common/member";
import { Button } from "@/components/ui/button";
import { can, canRateOwn } from "@/lib/auth/roles";
import type { GraphMember, GraphNode } from "@/lib/engine/types";
import { humanError } from "@/lib/errors";
import type { Priority } from "@/lib/schemas/enums";
import { useWorkspace } from "@/lib/workspace/use-workspace";
import {
	COMMENT_MAX,
	commentLength,
	ratingMembers,
	ratingsCount,
} from "../lib/rate";
import { useSetPriority } from "../mutations";
import { PLACES_TESTID } from "../testids";
import { PriorityBadge, PriorityPicker } from "./priority";

/**
 * The comment field (WP-Lists' TipTap `MentionInput`) loads when a comment is
 * first edited, not with the workspace's place overview (QA VIS3-08 /
 * PERF-05: the TipTap chunk was ~226 kB gzip of the JS before the map).
 */
const MentionInput = lazy(() =>
	import("@/features/notes/MentionInput").then((m) => ({
		default: m.MentionInput,
	})),
);

/** Who may change `member`'s rating (UI side; the gate enforces the same). */
export function mayRate(
	access: {
		memberId: string | null;
		role: GraphMember["role"];
		isGuest: boolean;
	},
	member: GraphMember,
): boolean {
	if (access.memberId === member.id) return canRateOwn(access);
	const placeholder =
		member.status === "placeholder" || member.status === "invited";
	return placeholder && can(access, "edit");
}

export function RatingCommentEditor({
	node,
	memberId,
	priority,
	onDone,
	autoFocus,
}: {
	node: GraphNode;
	memberId: string;
	priority: Priority;
	onDone: () => void;
	autoFocus?: boolean;
}) {
	const { graph } = useWorkspace();
	const set = useSetPriority(graph.trip.id);
	const [draft, setDraft] = useState(node.ratingComments[memberId] ?? "");
	// Counts what you see: a mention is its "@Name", not its stored token.
	const length = commentLength(draft);
	const over = length.over !== null;
	const box = useRef<HTMLDivElement>(null);
	useEffect(() => {
		if (!autoFocus) return;
		box.current
			?.querySelector<HTMLElement>("input,textarea,[contenteditable=true]")
			?.focus();
	}, [autoFocus]);
	const save = (value = draft) => {
		if (commentLength(value).over) return;
		const next = value.trim() ? value.trim() : null;
		if (next !== (node.ratingComments[memberId] ?? null))
			set.mutate(
				{ nodeId: node.id, memberId, priority, comment: next },
				{ onError: (e) => toast.error(humanError(e)) },
			);
		onDone();
	};
	// WP-Lists' editor takes these (Enter submits unless its mention popup is
	// open; Escape cancels); the plain field ignores them and the form's own
	// key handling below covers it.
	const editorKeys = {
		onSubmit: (v: string) => save(v),
		onCancel: onDone,
		autoFocus,
		ariaLabel: "Your comment",
	} as object;
	return (
		<form
			className="grid gap-1.5"
			data-testid={PLACES_TESTID.ratingComment}
			onSubmit={(e) => {
				e.preventDefault();
				save();
			}}
			onKeyDown={(e) => {
				// Keep the rate screen's single-key shortcuts out of the editor.
				e.stopPropagation();
				// Already handled by the editor (a mention picked, submitted, closed).
				if (e.defaultPrevented) return;
				if (e.key === "Enter" && !e.shiftKey) {
					e.preventDefault();
					save();
				}
				if (e.key === "Escape") onDone();
			}}
		>
			<div ref={box}>
				<Suspense
					fallback={
						<div
							aria-hidden="true"
							className="h-8 rounded-md border bg-background"
						/>
					}
				>
					<MentionInput
						{...editorKeys}
						value={draft}
						onChange={setDraft}
						placeholder="Why? “only if we have time after Nishiki”"
					/>
				</Suspense>
			</div>
			<div className="flex items-center gap-2">
				<span
					data-testid={PLACES_TESTID.ratingCommentCount}
					className={cn(
						"font-mono text-[11px] tnum text-muted-foreground",
						over && "text-destructive",
					)}
				>
					{length.shown}/{COMMENT_MAX}
				</span>
				<Button
					type="button"
					size="xs"
					variant="ghost"
					className="ml-auto"
					onClick={onDone}
				>
					Cancel
				</Button>
				<Button size="xs" type="submit" disabled={over}>
					Save
				</Button>
			</div>
		</form>
	);
}

function MemberRow({
	node,
	member,
	compact,
}: {
	node: GraphNode;
	member: GraphMember;
	compact?: boolean;
}) {
	const { graph, access } = useWorkspace();
	// Your own rating: `rate` (raters too); a placeholder's: the edit guard.
	const own = member.id === access.memberId;
	const guard = useEditGuard(own ? "rate" : "propose-ok");
	const set = useSetPriority(graph.trip.id);
	const [editing, setEditing] = useState(false);
	const priority = node.priorities[member.id] ?? null;
	const comment = node.ratingComments[member.id];
	const allowed = mayRate(
		{ memberId: access.memberId, role: access.role, isGuest: access.isGuest },
		member,
	);
	const disabled = guard.disabled || !allowed;
	const who = member.id === access.memberId ? "your" : `${member.name}'s`;
	const counted = ratingsCount(member);
	return (
		<li
			className="grid gap-1 py-1"
			data-testid={PLACES_TESTID.priorityRow}
			data-member={member.id}
			data-counted={counted}
		>
			<div
				className={cn(
					"flex min-w-0 items-center gap-2",
					!counted && "opacity-60",
				)}
				title={
					counted
						? undefined
						: `Not counted: ${member.firstName ?? member.name}'s ratings are left out of the score`
				}
			>
				<MemberAvatar memberId={member.id} size={16} />
				<span className="min-w-0 flex-1 truncate text-[13px]">
					{member.name}
					{member.id === access.memberId ? (
						<span className="text-muted-foreground"> (you)</span>
					) : null}
					{counted ? null : (
						<span className="text-muted-foreground"> · not counted</span>
					)}
				</span>
				{allowed ? (
					<EditGuard kind={own ? "rate" : "propose-ok"}>
						<span data-testid={PLACES_TESTID.priorityPicker}>
							<PriorityPicker
								value={priority}
								disabled={disabled}
								align="end"
								label={`Change ${who} rating for ${node.name}`}
								onChange={(p) =>
									set.mutate(
										{ nodeId: node.id, memberId: member.id, priority: p },
										{ onError: (e) => toast.error(humanError(e)) },
									)
								}
							/>
						</span>
					</EditGuard>
				) : (
					<PriorityBadge priority={priority} />
				)}
			</div>
			{editing && priority ? (
				<div className="pl-6">
					<RatingCommentEditor
						node={node}
						memberId={member.id}
						priority={priority}
						onDone={() => setEditing(false)}
						autoFocus
					/>
				</div>
			) : comment ? (
				<div className="flex items-start gap-1.5 pl-6 text-[13px] text-muted-foreground">
					<MessageSquare className="mt-0.5 size-3 shrink-0" strokeWidth={1.5} />
					<MarkdownText
						md={comment}
						inline
						className="min-w-0 flex-1 break-words"
					/>
					{allowed && !disabled ? (
						<button
							type="button"
							className="shrink-0 rounded p-0.5 hover:bg-accent"
							aria-label={`Edit ${who} comment`}
							onClick={() => setEditing(true)}
						>
							<Pencil className="size-3" strokeWidth={1.5} />
						</button>
					) : null}
				</div>
			) : allowed && priority && !disabled && !compact ? (
				<button
					type="button"
					onClick={() => setEditing(true)}
					className="w-fit pl-6 text-left text-xs text-muted-foreground hover:text-foreground"
				>
					Add a comment
				</button>
			) : null}
		</li>
	);
}

/** One row per rater: avatar, name, badge (a picker when you may change it), comment. */
export function MemberRatings({
	node,
	compact,
	className,
}: {
	node: GraphNode;
	compact?: boolean;
	className?: string;
}) {
	const { graph, access } = useWorkspace();
	// Left-out ratings still show, dimmed ("not counted").
	const members = ratingMembers(graph.members, [node]);
	// You first, then the others in member order.
	members.sort(
		(a, b) =>
			Number(b.id === access.memberId) - Number(a.id === access.memberId),
	);
	if (!members.length) return null;
	return (
		<ul className={cn("grid", className)}>
			{members.map((m) => (
				<MemberRow key={m.id} node={node} member={m} compact={compact} />
			))}
		</ul>
	);
}
