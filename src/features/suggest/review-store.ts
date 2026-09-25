/**
 * WP-Suggest's own UI state (never a second source of truth for the URL):
 * the ReviewDrawer's filter, conflicts from accepts that just failed (shown
 * at once, before the refetched `lastError` arrives), and which proposals
 * have a request in flight. Opening the drawer itself is `useUi().reviewOpen`.
 */
import { create } from "zustand";
import type { ProposalConflict } from "@/lib/schemas/proposals";
import { useUi } from "@/lib/workspace/ui-store";

export type ReviewFilter = "open" | "mine" | "conflicts";

export type Pending = "accept" | "reject" | "withdraw";

type ReviewState = {
	filter: ReviewFilter;
	setFilter(f: ReviewFilter): void;
	/** proposalId → the conflict an accept just returned. */
	conflicts: Record<string, ProposalConflict>;
	setConflict(id: string, c: ProposalConflict | null): void;
	pending: Record<string, Pending>;
	setPending(ids: readonly string[], what: Pending | null): void;
	reset(): void;
};

export const useReviewStore = create<ReviewState>()((set) => ({
	filter: "open",
	setFilter: (filter) => set({ filter }),
	conflicts: {},
	setConflict: (id, c) =>
		set((s) => {
			const next = { ...s.conflicts };
			if (c) next[id] = c;
			else delete next[id];
			return { conflicts: next };
		}),
	pending: {},
	setPending: (ids, what) =>
		set((s) => {
			const next = { ...s.pending };
			for (const id of ids) {
				if (what) next[id] = what;
				else delete next[id];
			}
			return { pending: next };
		}),
	reset: () => set({ filter: "open", conflicts: {}, pending: {} }),
}));

/** Opens the ReviewDrawer, optionally on one filter. */
export function openReview(filter?: ReviewFilter) {
	if (filter) useReviewStore.getState().setFilter(filter);
	useUi.getState().setReviewOpen(true);
}
