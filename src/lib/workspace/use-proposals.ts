/**
 * E7 marks for one entity (EXTENSIONS §2.3). Every WP renders ghosts from
 * these: `ProposalGhost` wraps rows/cards, WP-Map styles pins with
 * `proposalStyle(marks)`. Empty for viewers and guest viewers, and when
 * "Show suggestions" is off.
 */
import type { MarkKey, ProposalMark } from "@/lib/engine/proposals";
import { useWorkspaceOptional } from "./model-context";

const NONE: ProposalMark[] = [];

export function useProposalMarks(
	key: MarkKey | null | undefined,
): ProposalMark[] {
	const ws = useWorkspaceOptional();
	if (!ws || !key) return NONE;
	return ws.proposals.marks.get(key) ?? NONE;
}
