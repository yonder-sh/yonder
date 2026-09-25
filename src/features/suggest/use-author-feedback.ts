/**
 * Author feedback while online (EXTENSIONS §3.7): when one of MY suggestions
 * is accepted or rejected by someone else, a toast says so ("Dennis rejected
 * your suggestion: 'too far that day'"). The durable record is the one inbox
 * (F, `proposal_result`); this only reacts to the live proposals list, so
 * nothing toasts for changes that happened while the page was closed.
 *
 * Mounted through `SuggestModeControl`, which is always in the TopBar.
 */
import { useEffect, useRef } from "react";
import { toast } from "sonner";
import type { GraphIndex } from "@/lib/engine/graph-index";
import type { TripGraph } from "@/lib/engine/types";
import type { ProposalDto } from "@/lib/schemas/proposals";
import { describeProposal } from "./describe-proposal";
import { isMine } from "./proposal-view";
import { openReview } from "./review-store";

export type Feedback = { id: string; text: string; description?: string };

/**
 * The result toasts for a new list, given the statuses seen before (pure).
 * Only transitions open → accepted / rejected of the caller's own proposals,
 * reviewed by someone else, count.
 */
export function feedbackFor(
	seen: ReadonlyMap<string, ProposalDto["status"]>,
	list: readonly ProposalDto[],
	graph: TripGraph,
	ix: GraphIndex,
): Feedback[] {
	const out: Feedback[] = [];
	for (const p of list) {
		if (!isMine(p, graph.me.userId)) continue;
		if (seen.get(p.id) !== "open") continue;
		if (p.status !== "accepted" && p.status !== "rejected") continue;
		if (p.reviewedBy && p.reviewedBy === graph.me.userId) continue;
		const by =
			graph.members.find((m) => m.userId && m.userId === p.reviewedBy)?.name ??
			"Someone";
		const first = by.split(/\s+/)[0] ?? by;
		const what = describeProposal(p, ix);
		out.push(
			p.status === "accepted"
				? {
						id: p.id,
						text: `${first} accepted your suggestion`,
						description: what,
					}
				: {
						id: p.id,
						text: p.reviewNote
							? `${first} rejected your suggestion: “${p.reviewNote}”`
							: `${first} rejected your suggestion`,
						description: what,
					},
		);
	}
	return out;
}

export function useAuthorFeedback(
	list: readonly ProposalDto[],
	graph: TripGraph,
	ix: GraphIndex,
	enabled: boolean,
) {
	const seen = useRef<Map<string, ProposalDto["status"]> | null>(null);
	useEffect(() => {
		const prev = seen.current;
		seen.current = new Map(list.map((p) => [p.id, p.status]));
		// The first list is the baseline: never toast history on load.
		if (!prev || !enabled) return;
		for (const f of feedbackFor(prev, list, graph, ix))
			toast(f.text, {
				id: `proposal-result:${f.id}`,
				description: f.description,
				classNames: { description: "!text-muted-foreground" },
				action: { label: "Mine", onClick: () => openReview("mine") },
			});
	}, [list, graph, ix, enabled]);
}
