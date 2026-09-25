/**
 * The reviewer's hover ✓/✕ on a ghost (EXTENSIONS §3.7): WP-Suggest's
 * `GhostActions`, handed to `ProposalGhost` through its `actions` prop for
 * reviewers only (suggesters and viewers get the plain ghost).
 */
import { GhostActions } from "@/features/suggest/GhostActions";
import type { ProposalMark } from "@/lib/engine/proposals";
import { useWorkspace } from "@/lib/workspace/use-workspace";

const render = (lead: ProposalMark) => (
	<GhostActions proposalId={lead.proposalId} />
);

export function useGhostActions() {
	const { access } = useWorkspace();
	return access.canReview ? render : undefined;
}
