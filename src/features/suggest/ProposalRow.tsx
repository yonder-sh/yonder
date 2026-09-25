/**
 * The building blocks every suggestion surface shares (EXTENSIONS §3.7):
 * the Accept / Reject / Withdraw buttons (reviewers vs the author, behind
 * `EditGuard`), the Reject popover with its optional note (≤ 200), the
 * conflict line with "Accept anyway", the closed status, and the
 * ReviewDrawer row itself.
 */
import { cn } from "cn";
import {
	Check,
	CircleCheck,
	CircleX,
	Info,
	LocateFixed,
	NotebookPen,
	TriangleAlert,
	Undo2,
	X,
} from "lucide-react";
import { type CSSProperties, type ReactNode, useId, useState } from "react";
import { Crumbs } from "@/components/common/crumbs";
import { EditGuard } from "@/components/common/edit-guard";
import { presenceColor } from "@/components/common/member";
import { Button } from "@/components/ui/button";
import {
	Popover,
	PopoverContent,
	PopoverTrigger,
} from "@/components/ui/popover";
import { Spinner } from "@/components/ui/spinner";
import { Textarea } from "@/components/ui/textarea";
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@/components/ui/tooltip";
import type { ProposalConflict, ProposalDto } from "@/lib/schemas/proposals";
import { useWorkspace } from "@/lib/workspace/use-workspace";
import { describeProposal } from "./describe-proposal";
import {
	conflictLine,
	forceable,
	isMine,
	scopeOf,
	timeAgo,
} from "./proposal-view";
import { useReviewStore } from "./review-store";
import { SUGGEST_TESTID } from "./testids";
import { useBaseIndex } from "./use-base-index";
import { useProposalActions } from "./use-proposal-actions";

/** The conflict to show: one an accept just returned, else the stored `lastError`. */
export function useConflictOf(
	p: ProposalDto | null | undefined,
): ProposalConflict | null {
	const local = useReviewStore((s) => (p ? s.conflicts[p.id] : undefined));
	if (p?.status !== "open") return null;
	return local ?? p.lastError ?? null;
}

export function usePendingOf(p: ProposalDto | null | undefined) {
	return useReviewStore((s) => (p ? s.pending[p.id] : undefined)) ?? null;
}

type Size = "xs" | "sm";

/** Reject with an optional note (≤ 200), in a small popover. */
export function RejectButton({
	p,
	size = "xs",
	label = "Reject",
	iconOnly = false,
}: {
	p: ProposalDto;
	size?: Size;
	label?: string;
	iconOnly?: boolean;
}) {
	const { reject } = useProposalActions();
	const pending = usePendingOf(p);
	const [open, setOpen] = useState(false);
	const [note, setNote] = useState("");
	const id = useId();
	const submit = () => {
		reject.mutate({ p, note });
		setOpen(false);
		setNote("");
	};
	return (
		<Popover open={open} onOpenChange={setOpen}>
			<EditGuard>
				<PopoverTrigger asChild>
					<Button
						variant="ghost"
						size={iconOnly ? (size === "xs" ? "icon-xs" : "icon-sm") : size}
						data-testid={SUGGEST_TESTID.reject}
						disabled={pending !== null}
						aria-label={iconOnly ? label : undefined}
						className="text-muted-foreground hover:text-foreground"
					>
						{pending === "reject" ? <Spinner /> : <X />}
						{iconOnly ? null : label}
					</Button>
				</PopoverTrigger>
			</EditGuard>
			<PopoverContent align="end" className="w-72 p-3">
				<form
					onSubmit={(e) => {
						e.preventDefault();
						submit();
					}}
				>
					<label htmlFor={id} className="text-sm font-medium">
						Reject this suggestion?
					</label>
					<Textarea
						id={id}
						data-testid={SUGGEST_TESTID.rejectNote}
						value={note}
						onChange={(e) => setNote(e.target.value.slice(0, 200))}
						placeholder={`A note for ${p.author.name} (optional)`}
						maxLength={200}
						rows={2}
						className="mt-2 min-h-14 resize-none text-sm"
						onKeyDown={(e) => {
							if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
								e.preventDefault();
								submit();
							}
						}}
					/>
					<div className="mt-2 flex items-center justify-between gap-2">
						<span className="font-mono text-[11px] text-muted-foreground tnum">
							{note.length}/200
						</span>
						<div className="flex gap-1.5">
							<Button
								type="button"
								variant="ghost"
								size="sm"
								onClick={() => setOpen(false)}
							>
								Cancel
							</Button>
							<Button
								type="submit"
								variant="outline"
								size="sm"
								data-testid={SUGGEST_TESTID.rejectConfirm}
							>
								Reject
							</Button>
						</div>
					</div>
				</form>
			</PopoverContent>
		</Popover>
	);
}

export function AcceptButton({
	p,
	size = "xs",
	force = false,
	iconOnly = false,
	from = "drawer",
	label,
	tone = "soft",
}: {
	p: ProposalDto;
	size?: Size;
	force?: boolean;
	iconOnly?: boolean;
	from?: "drawer" | "inline";
	label?: string;
	/** `solid` for the one primary action of a view; `soft` in lists (calmer). */
	tone?: "solid" | "soft";
}) {
	const { accept } = useProposalActions();
	const pending = usePendingOf(p);
	const text = label ?? (force ? "Accept anyway" : "Accept");
	const solid = tone === "solid" && !force;
	return (
		<EditGuard>
			<Button
				variant={solid ? "default" : "outline"}
				className={
					solid
						? undefined
						: "border-primary/35 text-primary hover:border-primary hover:bg-primary hover:text-primary-foreground"
				}
				size={iconOnly ? (size === "xs" ? "icon-xs" : "icon-sm") : size}
				data-testid={
					force ? SUGGEST_TESTID.acceptAnyway : SUGGEST_TESTID.accept
				}
				disabled={pending !== null}
				aria-label={iconOnly ? text : undefined}
				onClick={() => accept.mutate({ p, force, from })}
			>
				{pending === "accept" ? <Spinner /> : <Check />}
				{iconOnly ? null : text}
			</Button>
		</EditGuard>
	);
}

export function WithdrawButton({
	p,
	size = "xs",
}: {
	p: ProposalDto;
	size?: Size;
}) {
	const { withdraw } = useProposalActions();
	const pending = usePendingOf(p);
	return (
		<EditGuard>
			<Button
				variant="ghost"
				size={size}
				data-testid={SUGGEST_TESTID.withdraw}
				disabled={pending !== null}
				onClick={() => withdraw.mutate({ p })}
				className="text-muted-foreground hover:text-foreground"
			>
				{pending === "withdraw" ? <Spinner /> : <Undo2 />}
				Withdraw
			</Button>
		</EditGuard>
	);
}

/** "Itoya Ginza was moved to Day 5 since." with Accept anyway / Reject. */
export function ConflictNote({
	p,
	conflict,
	actions = true,
	leading,
}: {
	p: ProposalDto;
	conflict: ProposalConflict;
	actions?: boolean;
	/** Left of the actions (the drawer's Show). */
	leading?: ReactNode;
}) {
	const { access, graph } = useWorkspace();
	const ix = useBaseIndex();
	const mine = isMine(p, graph.me.userId);
	const hasActions = actions && (access.canReview || mine);
	return (
		<div
			data-testid={SUGGEST_TESTID.conflict}
			data-reason={conflict.reason}
			className="mt-2 rounded-md border border-warning-hairline bg-warning-wash px-2.5 py-2"
		>
			<p className="flex items-start gap-1.5 text-[13px] leading-[18px] text-warning">
				<TriangleAlert className="mt-px size-3.5 shrink-0" strokeWidth={1.75} />
				<span>{conflictLine(p, conflict, ix)}</span>
			</p>
			{hasActions || leading ? (
				<div className="mt-2 flex items-center gap-1.5">
					{leading}
					<span className="flex-1" />
					{hasActions ? (
						<>
							{/* Your own suggestion: withdraw it rather than reject it. */}
							{mine ? <WithdrawButton p={p} /> : <RejectButton p={p} />}
							{access.canReview && forceable(conflict) ? (
								<AcceptButton p={p} force />
							) : null}
						</>
					) : null}
				</div>
			) : null}
		</div>
	);
}

/** Accepted / Rejected / Withdrawn (+ the review note) for closed proposals. */
export function StatusLine({ p }: { p: ProposalDto }) {
	const { graph } = useWorkspace();
	if (p.status === "open") return null;
	const by = p.reviewedBy
		? graph.members.find((m) => m.userId === p.reviewedBy)?.name
		: null;
	const Icon =
		p.status === "accepted"
			? CircleCheck
			: p.status === "rejected"
				? CircleX
				: Undo2;
	const word =
		p.status === "accepted"
			? "Accepted"
			: p.status === "rejected"
				? "Rejected"
				: "Withdrawn";
	return (
		<p
			data-testid={SUGGEST_TESTID.status}
			data-status={p.status}
			className="mt-1 flex items-start gap-1.5 text-xs text-muted-foreground"
		>
			<Icon className="mt-px size-3.5 shrink-0" strokeWidth={1.5} />
			<span>
				{word}
				{by && p.status !== "withdrawn" ? ` by ${by}` : ""}
				{p.reviewedAt ? ` · ${timeAgo(p.reviewedAt)}` : ""}
				{p.reviewNote ? (
					<span className="text-foreground/80 italic"> · “{p.reviewNote}”</span>
				) : null}
			</span>
		</p>
	);
}

/** Where the entity lives: "Japan › Tokyo · Day 3 · Sun 5 Oct". */
export function ScopeCrumb({
	p,
	className,
}: {
	p: ProposalDto;
	className?: string;
}) {
	const ix = useBaseIndex();
	const { nodeIds, day } = scopeOf(p, ix);
	if (!nodeIds.length && !day) return null;
	return (
		<span
			className={cn(
				"flex min-w-0 items-center gap-1 text-xs text-muted-foreground",
				className,
			)}
		>
			{nodeIds.length ? <Crumbs nodeIds={nodeIds} className="min-w-0" /> : null}
			{nodeIds.length && day ? <span aria-hidden>·</span> : null}
			{day ? <span className="shrink-0">{day}</span> : null}
		</span>
	);
}

/** One suggestion in the ReviewDrawer. */
export function ProposalRow({
	p,
	stacked = false,
	onShow,
	onDetails,
	showAuthor = false,
}: {
	p: ProposalDto;
	/** A later alternative on the same thing (not drawn as the ghost). */
	stacked?: boolean;
	onShow: (p: ProposalDto) => void;
	onDetails: (p: ProposalDto) => void;
	/** Mine is flat, so rows name no author; grouped rows don't need it either. */
	showAuthor?: boolean;
}) {
	const { access, graph } = useWorkspace();
	const ix = useBaseIndex();
	const conflict = useConflictOf(p);
	const mine = isMine(p, graph.me.userId);
	const text = describeProposal(p, ix);
	const open = p.status === "open";
	const isNote = p.op === "note.append";
	// Trip-wide changes have nothing to point at: their details (what moves).
	// A reviewer's note addition has "Open note", which does the same as Show.
	const showButton =
		isNote && access.canReview ? null : p.entityKind === "trip" ? (
			<Button
				variant="ghost"
				size="xs"
				data-testid={SUGGEST_TESTID.show}
				onClick={() => onDetails(p)}
				className="-ml-2 text-muted-foreground hover:text-foreground"
			>
				<Info />
				Details
			</Button>
		) : (
			<Button
				variant="ghost"
				size="xs"
				data-testid={SUGGEST_TESTID.show}
				onClick={() => onShow(p)}
				className="-ml-2 text-muted-foreground hover:text-foreground"
			>
				<LocateFixed />
				Show
			</Button>
		);
	return (
		<li
			data-testid={SUGGEST_TESTID.row}
			data-proposal-id={p.id}
			data-status={p.status}
			className={cn(
				"my-2 mr-4 ml-4 border-l-[1.5px] border-dashed py-0.5 pl-3",
				!open && "opacity-80",
			)}
			style={
				{
					borderLeftColor: conflict
						? "var(--warning-hairline)"
						: presenceColor(p.author.color),
				} as CSSProperties
			}
		>
			<button
				type="button"
				data-testid={SUGGEST_TESTID.rowSummary}
				onClick={() => onDetails(p)}
				className="block w-full rounded-sm text-left text-sm leading-5 font-medium text-foreground hover:underline hover:decoration-dotted hover:underline-offset-4 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
			>
				{showAuthor ? (
					<span className="font-normal text-muted-foreground">
						{p.author.name}:{" "}
					</span>
				) : null}
				{text}
			</button>
			{stacked && open ? (
				<p className="mt-0.5 text-xs text-muted-foreground">
					An alternative — another suggestion changes the same thing
				</p>
			) : null}
			{p.message ? (
				<p className="mt-1 text-[13px] leading-[18px] text-muted-foreground italic">
					“{p.message}”
				</p>
			) : null}
			<ScopeCrumb p={p} className="mt-1" />
			<StatusLine p={p} />
			{open && conflict ? (
				<ConflictNote p={p} conflict={conflict} leading={showButton} />
			) : null}
			{open && !conflict ? (
				<div className="mt-2 flex items-center gap-1.5">
					{showButton}
					<span className="flex-1" />
					{mine ? <WithdrawButton p={p} /> : null}
					{access.canReview ? (
						<>
							{/* Your own suggestion: Withdraw, not Reject. */}
							{mine ? null : <RejectButton p={p} />}
							{isNote ? (
								<Tooltip>
									<TooltipTrigger asChild>
										<Button
											variant="outline"
											size="xs"
											onClick={() => onShow(p)}
										>
											<NotebookPen />
											Open note
										</Button>
									</TooltipTrigger>
									<TooltipContent>
										Insert it from the note’s Notes tab
									</TooltipContent>
								</Tooltip>
							) : (
								<AcceptButton p={p} />
							)}
						</>
					) : null}
				</div>
			) : null}
			{open ? (
				<span className="sr-only">
					Suggested by {p.author.name} {timeAgo(p.createdAt)}
				</span>
			) : null}
		</li>
	);
}
