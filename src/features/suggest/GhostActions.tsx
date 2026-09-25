/**
 * E7 the reviewer's hover ✓/✕ beside a ghost's avatar (EXTENSIONS §3.7): 24px
 * icon buttons that call `resolveProposal` directly (a reject here carries no
 * note; the drawer and the bar have the note). `ProposalGhost` renders it
 * through its `actions` prop and shows it on hover or focus; on touch a tap
 * selects the ghost and the sheet shows `ProposalBar` instead.
 *
 * Renders nothing for anyone who can't review, for `note.append` (accepted
 * from the note itself) and for a proposal that is gone or closed.
 */
import { Check, X } from "lucide-react";
import type { MouseEvent, PointerEvent } from "react";
import { useEditGuard } from "@/components/common/edit-guard";
import { Spinner } from "@/components/ui/spinner";
import { useWorkspace } from "@/lib/workspace/use-workspace";
import { describeProposal } from "./describe-proposal";
import { usePendingOf } from "./ProposalRow";
import { SUGGEST_TESTID } from "./testids";
import { useBaseIndex } from "./use-base-index";
import { useProposalActions } from "./use-proposal-actions";

const BTN =
	"flex size-6 items-center justify-center rounded-full border bg-card text-muted-foreground shadow-float transition-colors focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:outline-none disabled:opacity-50";

/** Keeps the click from selecting (or starting a drag on) the card underneath. */
const stop = (e: MouseEvent | PointerEvent) => e.stopPropagation();

export function GhostActions({ proposalId }: { proposalId: string }) {
	const { access, proposals } = useWorkspace();
	const ix = useBaseIndex();
	const { accept, reject } = useProposalActions();
	const guard = useEditGuard();
	const p = proposals.list.find((x) => x.id === proposalId);
	const pending = usePendingOf(p ?? null);
	if (!access.canReview || !p || p.status !== "open" || p.op === "note.append")
		return null;
	const text = describeProposal(p, ix);
	const disabled = guard.disabled || pending !== null;
	const title = guard.disabled ? (guard.reason ?? undefined) : undefined;
	return (
		<>
			<button
				type="button"
				data-testid={SUGGEST_TESTID.ghostReject}
				aria-label={`Reject: ${text}`}
				title={title ?? "Reject"}
				disabled={disabled}
				onPointerDown={stop}
				onClick={(e) => {
					stop(e);
					reject.mutate({ p });
				}}
				className={`${BTN} hover:border-foreground/30 hover:text-foreground`}
			>
				{pending === "reject" ? (
					<Spinner className="size-3" />
				) : (
					<X className="size-3.5" strokeWidth={2} />
				)}
			</button>
			<button
				type="button"
				data-testid={SUGGEST_TESTID.ghostAccept}
				aria-label={`Accept: ${text}`}
				title={title ?? "Accept"}
				disabled={disabled}
				onPointerDown={stop}
				onClick={(e) => {
					stop(e);
					accept.mutate({ p, from: "inline" });
				}}
				className={`${BTN} border-primary/40 text-primary hover:bg-primary hover:text-primary-foreground`}
			>
				{pending === "accept" ? (
					<Spinner className="size-3" />
				) : (
					<Check className="size-3.5" strokeWidth={2} />
				)}
			</button>
		</>
	);
}
