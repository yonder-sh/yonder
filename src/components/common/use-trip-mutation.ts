/**
 * The one mutation hook features use (SPEC §12.6; EXTENSIONS §2.3):
 * optimistic `setQueryData` in `onMutate`, rollback on error, invalidation of
 * the given keys when it settles, a friendly no-op while offline (edits are
 * paused, DESIGN §6), and the suggest-mode branch.
 *
 *   const move = useTripMutation((v: MoveVars) => moveItem({ data: v }), {
 *     keys: [tripKeys.graph(tripId)],
 *     optimistic: (qc, v) => qc.setQueryData(tripKeys.graph(tripId), (g) => …),
 *     onSuccess: (r, v) => undoToast(…),
 *   })
 *
 * The tab that makes a mutation never receives its own live `invalidate`
 * event (`x-tab-id`), so `keys` MUST list every query the change affects:
 * this hook is how the mutating tab refreshes itself.
 *
 * Suggest mode (`isProposed(result)`): `optimistic` is skipped (the change
 * didn't happen), the proposal is upserted into `tripKeys.proposals`,
 * `onSuccess` is skipped, `onProposed` runs, and "Suggested — {summary}"
 * toasts with Undo (→ `withdrawProposal`).
 */
import {
	type QueryClient,
	type QueryKey,
	type UseMutationResult,
	useMutation,
	useQueryClient,
} from "@tanstack/react-query";
import { toast } from "sonner";
import {
	createPendingPeople,
	swapPendingPeople,
} from "@/features/notes/pending-people";
import { AppError, humanError } from "@/lib/errors";
import { tripKeys } from "@/lib/query/keys";
import { isProposed, type Proposed } from "@/lib/schemas/proposals";
import { useUi } from "@/lib/workspace/ui-store";

export type TripMutationOptions<TVars, TData = unknown> = {
	/** Apply the change to cached data before the server answers (skipped in suggest mode). */
	optimistic?: (qc: QueryClient, vars: TVars) => void;
	/** Query keys to snapshot (for rollback) and invalidate when settled. */
	keys: readonly QueryKey[];
	/** Called after an APPLIED success (e.g. an undo toast with the server's result). */
	onSuccess?: (data: Exclude<TData, Proposed>, vars: TVars) => void;
	/** Called when the change became a proposal instead. */
	onProposed?: (proposed: Proposed["proposed"], vars: TVars) => void;
	/** The trip, for the proposals cache (required for proposable mutations). */
	tripId?: string;
	/** Undo of a proposal ("Suggested — … · Undo"); defaults to `withdrawProposal`. */
	withdraw?: (proposalId: string) => Promise<unknown>;
	/**
	 * After a failure a retry could fix, or once the person signs in again
	 * (QA ERR-03/ERR-07): `"retry"` (default) offers Retry and re-runs the
	 * mutation after re-auth; `"manual"` does neither, because the UI hands the
	 * input back (e.g. the add row's text) and the person resubmits.
	 */
	resubmit?: "retry" | "manual";
};

type Snapshot = [QueryKey, unknown][];

/** `withdrawProposal`, loaded on first use (the Undo of "Suggested — …"). */
const defaultWithdraw = (proposalId: string) =>
	import("@/functions/proposals.functions").then((m) =>
		m.withdrawProposal({ data: { proposalId } }),
	);

export function useTripMutation<TVars, TData>(
	fn: (vars: TVars) => Promise<TData>,
	opts: TripMutationOptions<TVars, TData>,
): UseMutationResult<TData, Error, TVars, Snapshot> {
	const qc = useQueryClient();
	return useMutation<TData, Error, TVars, Snapshot>({
		mutationFn: async (vars) => {
			// The global MutationCache error handler shows "You're offline…" once
			// (humanError maps OFFLINE); no extra toast here.
			if (typeof navigator !== "undefined" && navigator.onLine === false)
				throw new AppError("OFFLINE");
			// ADDENDUM §8: people added from a mention field exist from here on.
			return fn(swapPendingPeople(vars));
		},
		meta: { silent: false, manualResubmit: opts.resubmit === "manual" },
		onMutate: async (vars) => {
			// A new person chosen in a mention field is created only when a save
			// carries it (ADDENDUM §8, QA PLAN-R2-08; WP-Lists `pending-people`).
			await createPendingPeople(vars, qc);
			await Promise.all(
				opts.keys.map((k) => qc.cancelQueries({ queryKey: k })),
			);
			const snapshot: Snapshot = opts.keys.map((k) => [k, qc.getQueryData(k)]);
			// A suggestion changes nothing yet: no optimistic write.
			if (!useUi.getState().suggesting)
				opts.optimistic?.(qc, swapPendingPeople(vars));
			return snapshot;
		},
		onError: (_e, _vars, snapshot) => {
			for (const [k, data] of snapshot ?? []) qc.setQueryData(k, data);
		},
		onSuccess: (data, vars, snapshot) => {
			if (isProposed(data)) {
				// Roll back anything optimistic, then show the ghost instead.
				for (const [k, prev] of snapshot ?? []) qc.setQueryData(k, prev);
				if (opts.tripId)
					void qc.invalidateQueries({
						queryKey: tripKeys.proposals(opts.tripId),
					});
				opts.onProposed?.(data.proposed, vars);
				const tripId = opts.tripId;
				const withdraw = opts.withdraw ?? defaultWithdraw;
				toast(`Suggested — ${data.proposed.summary}`, {
					action: {
						label: "Undo",
						onClick: () =>
							void withdraw(data.proposed.id).then(
								() => {
									if (tripId)
										void qc.invalidateQueries({
											queryKey: tripKeys.proposals(tripId),
										});
								},
								(e: unknown) => {
									toast.error(humanError(e));
								},
							),
					},
				});
				return;
			}
			opts.onSuccess?.(data as Exclude<TData, Proposed>, vars);
		},
		onSettled: () =>
			Promise.all(opts.keys.map((k) => qc.invalidateQueries({ queryKey: k }))),
	});
}
