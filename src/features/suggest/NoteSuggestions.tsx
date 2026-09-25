/**
 * E7 notes for suggesters (EXTENSIONS §3.7, X4): while suggesting, the note is
 * read-only (`NotesPanel` sets `editable=false`; collab enforces it) and
 * "Suggest an addition" opens a Markdown textarea (≤ 4,000) that sends
 * `proposeNoteAppend`. Open additions for this note show as dashed blocks in
 * the author's colour, rendered with `MarkdownText` only (never raw HTML).
 * Reviewers get "Insert at end", which inserts the Markdown into `editor`
 * and accepts with `appliedClientSide` (undone again if the accept fails);
 * the author gets Withdraw. Mounted by WP-Lists' NotesPanel under the note.
 */
import { MessageSquarePlus, TextCursorInput } from "lucide-react";
import { type CSSProperties, useId, useState } from "react";
import { EditGuard, useEditGuard } from "@/components/common/edit-guard";
import { MarkdownText } from "@/components/common/markdown-text";
import { MemberAvatar, presenceColor } from "@/components/common/member";
import { useTripMutation } from "@/components/common/use-trip-mutation";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { Textarea } from "@/components/ui/textarea";
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@/components/ui/tooltip";
import { withdrawProposal } from "@/functions/proposals.functions";
import { tripKeys } from "@/lib/query/keys";
import type { Json, ProposalDto } from "@/lib/schemas/proposals";
import type { BundleTarget } from "@/lib/schemas/targets";
import { TESTID } from "@/lib/testids";
import { useWorkspace } from "@/lib/workspace/use-workspace";
import { RejectButton, usePendingOf, WithdrawButton } from "./ProposalRow";
import { isMine, pObj, pStr, timeAgo } from "./proposal-view";
import { proposeNoteAppend } from "./suggest.functions";
import { SUGGEST_TESTID } from "./testids";
import { useProposalActions } from "./use-proposal-actions";

export const NOTE_APPEND_MAX = 4000;

/** The part of a TipTap 3 editor this needs (the prop is typed `unknown`). */
type EditorLike = {
	isDestroyed?: boolean;
	state: { doc: { content: { size: number } } };
	commands: {
		insertContentAt: (
			position: number,
			content: string,
			options?: { contentType?: "markdown" | "json" | "html" },
		) => boolean;
		undo?: () => boolean;
	};
};

export function asEditor(editor: unknown): EditorLike | null {
	if (!editor || typeof editor !== "object") return null;
	const e = editor as Partial<EditorLike>;
	if (e.isDestroyed) return null;
	if (typeof e.commands?.insertContentAt !== "function") return null;
	if (typeof e.state?.doc?.content?.size !== "number") return null;
	return e as EditorLike;
}

/** Same bundle target (kind + id)? */
export function sameTarget(a: Record<string, Json> | null, b: BundleTarget) {
	if (!a || a.kind !== b.kind) return false;
	switch (b.kind) {
		case "trip":
			return true;
		case "node":
			return a.nodeId === b.nodeId;
		case "item":
			return a.itemId === b.itemId;
		case "day":
			return a.dayId === b.dayId;
		case "leg":
			return a.legId === b.legId;
	}
}

function Composer({
	target,
	onDone,
}: {
	target: BundleTarget;
	onDone: () => void;
}) {
	const { graph } = useWorkspace();
	const tripId = graph.trip.id;
	const [md, setMd] = useState("");
	const id = useId();
	const propose = useTripMutation(
		(v: { markdown: string }) =>
			proposeNoteAppend({ data: { tripId, target, markdown: v.markdown } }),
		{
			keys: [tripKeys.proposals(tripId)],
			tripId,
			withdraw: (proposalId) => withdrawProposal({ data: { proposalId } }),
			onProposed: () => {
				setMd("");
				onDone();
			},
		},
	);
	const text = md.trim();
	const send = () => {
		if (text && !propose.isPending) propose.mutate({ markdown: text });
	};
	return (
		<form
			className="grid gap-2"
			onSubmit={(e) => {
				e.preventDefault();
				send();
			}}
		>
			<label htmlFor={id} className="sr-only">
				Your addition (Markdown)
			</label>
			<Textarea
				id={id}
				data-testid={SUGGEST_TESTID.noteTextarea}
				autoFocus
				value={md}
				maxLength={NOTE_APPEND_MAX}
				onChange={(e) => setMd(e.target.value.slice(0, NOTE_APPEND_MAX))}
				onKeyDown={(e) => {
					if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
						e.preventDefault();
						send();
					}
					if (e.key === "Escape") {
						e.stopPropagation();
						onDone();
					}
				}}
				placeholder="Add a line, a list or a link — Markdown works"
				rows={4}
				className="min-h-24 resize-y text-sm"
			/>
			<div className="flex items-center gap-2">
				<span className="font-mono text-[11px] text-muted-foreground tnum">
					{md.length > NOTE_APPEND_MAX - 400
						? `${md.length}/${NOTE_APPEND_MAX}`
						: null}
				</span>
				<span className="flex-1" />
				<Button type="button" variant="ghost" size="sm" onClick={onDone}>
					Cancel
				</Button>
				<Button
					type="submit"
					size="sm"
					data-testid={SUGGEST_TESTID.noteSend}
					disabled={!text || propose.isPending}
				>
					{propose.isPending ? <Spinner /> : null}
					Suggest
				</Button>
			</div>
		</form>
	);
}

function SuggestionBlock({
	p,
	editor,
}: {
	p: ProposalDto;
	editor: EditorLike | null;
}) {
	const { access, graph } = useWorkspace();
	const { accept } = useProposalActions();
	const pending = usePendingOf(p);
	const md = pStr(p.payload, "markdown") ?? "";
	const color = presenceColor(p.author.color);
	const mine = isMine(p, graph.me.userId);

	const insert = () => {
		if (!editor || !md) return;
		const inserted = editor.commands.insertContentAt(
			editor.state.doc.content.size,
			md,
			{ contentType: "markdown" },
		);
		if (!inserted) return;
		const undo = () => editor.commands.undo?.();
		accept.mutate(
			{ p, appliedClientSide: true, from: "inline" },
			{
				onSuccess: (r) => {
					if (!r.ok) undo();
				},
				onError: undo,
			},
		);
	};

	const insertButton = (
		<Button
			size="xs"
			data-testid={SUGGEST_TESTID.noteInsert}
			disabled={!editor || pending !== null}
			onClick={insert}
		>
			{pending === "accept" ? <Spinner /> : <TextCursorInput />}
			Insert at end
		</Button>
	);

	return (
		<li
			data-testid={SUGGEST_TESTID.noteBlock}
			data-proposal-id={p.id}
			className="rounded-md px-3 py-2.5 outline-[1.5px] outline-dashed"
			style={
				{
					outlineColor: color,
					backgroundColor: `color-mix(in oklab, ${color} 5%, transparent)`,
				} as CSSProperties
			}
		>
			<div className="flex items-center gap-1.5 text-xs text-muted-foreground">
				<MemberAvatar
					size={16}
					user={{
						name: p.author.name,
						color: p.author.color,
						memberId: p.author.memberId,
						guest: p.author.isGuest,
					}}
				/>
				<span>
					<span className="font-medium text-foreground">{p.author.name}</span>{" "}
					suggests adding · {timeAgo(p.createdAt)}
				</span>
			</div>
			<MarkdownText md={md} className="mt-2 text-sm leading-5" />
			<div className="mt-2 flex items-center justify-end gap-1.5">
				{mine ? <WithdrawButton p={p} /> : null}
				{access.canReview ? (
					<>
						{mine ? null : <RejectButton p={p} />}
						{editor ? (
							<EditGuard>{insertButton}</EditGuard>
						) : (
							<Tooltip>
								<TooltipTrigger asChild>
									<span className="inline-flex">{insertButton}</span>
								</TooltipTrigger>
								<TooltipContent>Open the note to insert it</TooltipContent>
							</Tooltip>
						)}
					</>
				) : null}
			</div>
		</li>
	);
}

export function NoteSuggestions({
	target,
	editor,
}: {
	target: BundleTarget;
	/** The TipTap editor of the note (null until it mounts). */
	editor: unknown;
}) {
	const { access, proposals } = useWorkspace();
	const guard = useEditGuard();
	const [composing, setComposing] = useState(false);
	if (!access.canReview && !access.canPropose) return null;
	const open = proposals.list.filter(
		(p) =>
			p.status === "open" &&
			p.op === "note.append" &&
			sameTarget(pObj(p.payload, "target"), target),
	);
	const canSuggest = access.mode === "suggest";
	if (!open.length && !canSuggest) return null;
	const ed = asEditor(editor);

	return (
		<section
			data-testid={TESTID.noteSuggestions}
			aria-label="Suggested additions"
			className="mt-4 grid gap-3"
		>
			{open.length ? (
				<ul className="grid gap-3">
					{open.map((p) => (
						<SuggestionBlock key={p.id} p={p} editor={ed} />
					))}
				</ul>
			) : null}
			{canSuggest ? (
				composing && !guard.disabled ? (
					<Composer target={target} onDone={() => setComposing(false)} />
				) : (
					<div>
						<EditGuard>
							<Button
								variant="outline"
								size="sm"
								data-testid={SUGGEST_TESTID.noteSuggestButton}
								onClick={() => setComposing(true)}
							>
								<MessageSquarePlus strokeWidth={1.5} />
								Suggest an addition
							</Button>
						</EditGuard>
					</div>
				)
			) : null}
		</section>
	);
}
