/**
 * Accept, reject and withdraw (EXTENSIONS §3.5) for every WP-Suggest surface:
 * the ReviewDrawer, ProposalBar, ProposalOverview, GhostActions and
 * NoteSuggestions. One place for the calls, the keys they refresh (the
 * mutating tab never gets its own live event), the toasts and the conflict
 * hand-off to the drawer.
 *
 * Errors (offline, FORBIDDEN, …) go through the global MutationCache toast
 * (`humanError`); a `CONFLICT` answer is not an error but `{ ok: false }`,
 * which expands the row ("Itoya was moved to Day 5 since").
 */
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useCallback } from "react";
import { toast } from "sonner";
import {
	type ResolveResult,
	resolveProposal,
	resolveProposals,
	withdrawProposal,
} from "@/functions/proposals.functions";
import { AppError } from "@/lib/errors";
import { meKeys, type TripKey, tripKeys } from "@/lib/query/keys";
import type { ProposalDto, ProposalOp } from "@/lib/schemas/proposals";
import { useUi } from "@/lib/workspace/ui-store";
import { useWorkspace } from "@/lib/workspace/use-workspace";
import { describeProposal } from "./describe-proposal";
import { flashIdFor, selFor } from "./proposal-view";
import { openReview, useReviewStore } from "./review-store";
import { useBaseIndex } from "./use-base-index";

/** What else an accepted op changes, besides `proposals` (EXTENSIONS §3.5 "the op's keys"). */
export function keysForOp(op: ProposalOp): TripKey[] {
	const family = op.split(".")[0];
	switch (family) {
		case "list":
			return ["lists", "counts", "activity"];
		case "attachment":
			return ["media", "counts", "activity"];
		case "note":
			return ["notes", "counts", "activity"];
		default:
			return ["graph", "counts", "activity"];
	}
}

function assertOnline() {
	if (typeof navigator !== "undefined" && navigator.onLine === false)
		throw new AppError("OFFLINE");
}

type AcceptVars = {
	p: ProposalDto;
	force?: boolean;
	/** `note.append`: the reviewer's editor already inserted the Markdown. */
	appliedClientSide?: boolean;
	/** Where the accept came from: the drawer shows conflicts inline, others toast. */
	from?: "drawer" | "inline";
};

export function useProposalActions() {
	const { graph, nav } = useWorkspace();
	const ix = useBaseIndex();
	const tripId = graph.trip.id;
	const qc = useQueryClient();
	const setConflict = useReviewStore((s) => s.setConflict);
	const setPending = useReviewStore((s) => s.setPending);

	const refresh = useCallback(
		(ops: readonly ProposalOp[]) => {
			const keys = new Set<TripKey>(["proposals"]);
			for (const op of ops) for (const k of keysForOp(op)) keys.add(k);
			for (const k of keys)
				void qc.invalidateQueries({ queryKey: tripKeys.byKey(tripId, k) });
			void qc.invalidateQueries({ queryKey: meKeys.inbox });
		},
		[qc, tripId],
	);

	const onConflict = useCallback(
		(
			p: ProposalDto,
			r: Extract<ResolveResult, { ok: false }>,
			from: AcceptVars["from"],
		) => {
			setConflict(p.id, r.conflict);
			if (from !== "drawer")
				toast(`Couldn't accept — ${describeProposal(p, ix)}`, {
					description: r.conflict.message,
					classNames: { description: "!text-muted-foreground" },
					action: { label: "Review", onClick: () => openReview("conflicts") },
				});
		},
		[ix, setConflict],
	);

	const accept = useMutation({
		mutationFn: async (v: AcceptVars) => {
			assertOnline();
			return resolveProposal({
				data: {
					proposalId: v.p.id,
					decision: "accept",
					...(v.force ? { force: true } : {}),
					...(v.appliedClientSide ? { appliedClientSide: true } : {}),
				},
			});
		},
		onMutate: (v) => setPending([v.p.id], "accept"),
		onSuccess: (r, v) => {
			if (r.ok) {
				setConflict(v.p.id, null);
				toast(`Accepted — ${describeProposal(v.p, ix)}`);
			} else onConflict(v.p, r, v.from);
		},
		onSettled: (_r, _e, v) => {
			setPending([v.p.id], null);
			refresh([v.p.op]);
		},
	});

	const reject = useMutation({
		mutationFn: async (v: { p: ProposalDto; note?: string }) => {
			assertOnline();
			const note = v.note?.trim();
			return resolveProposal({
				data: {
					proposalId: v.p.id,
					decision: "reject",
					...(note ? { note: note.slice(0, 200) } : {}),
				},
			});
		},
		onMutate: (v) => setPending([v.p.id], "reject"),
		onSuccess: (_r, v) => {
			setConflict(v.p.id, null);
			toast(`Rejected — ${describeProposal(v.p, ix)}`);
		},
		onSettled: (_r, _e, v) => {
			setPending([v.p.id], null);
			refresh([v.p.op]);
		},
	});

	const withdraw = useMutation({
		mutationFn: async (v: { p: ProposalDto }) => {
			assertOnline();
			return withdrawProposal({ data: { proposalId: v.p.id } });
		},
		onMutate: (v) => setPending([v.p.id], "withdraw"),
		onSuccess: (_r, v) => {
			setConflict(v.p.id, null);
			toast(`Withdrawn — ${describeProposal(v.p, ix)}`);
		},
		onSettled: (_r, _e, v) => {
			setPending([v.p.id], null);
			refresh([v.p.op]);
		},
	});

	const bulk = useMutation({
		mutationFn: async (v: {
			ps: ProposalDto[];
			decision: "accept" | "reject";
		}) => {
			assertOnline();
			return resolveProposals({
				data: { ids: v.ps.map((p) => p.id).slice(0, 50), decision: v.decision },
			});
		},
		onMutate: (v) =>
			setPending(
				v.ps.map((p) => p.id),
				v.decision,
			),
		onSuccess: (results, v) => {
			let ok = 0;
			let conflicts = 0;
			for (const p of v.ps) {
				const r = results[p.id];
				if (!r) continue;
				if (r.ok) {
					ok++;
					setConflict(p.id, null);
				} else {
					conflicts++;
					setConflict(p.id, r.conflict);
				}
			}
			const verb = v.decision === "accept" ? "Accepted" : "Rejected";
			toast(
				conflicts
					? `${verb} ${ok} · ${conflicts} need${conflicts === 1 ? "s" : ""} a look`
					: `${verb} ${ok} suggestion${ok === 1 ? "" : "s"}`,
			);
		},
		onSettled: (_r, _e, v) => {
			setPending(
				v.ps.map((p) => p.id),
				null,
			);
			refresh(v.ps.map((p) => p.op));
		},
	});

	/** Select the thing (or the proposal) and glow it in the author's colour. */
	const show = useCallback(
		(p: ProposalDto) => {
			nav.select(selFor(p, ix));
			const id = flashIdFor(p, ix);
			if (id) useUi.getState().flash(id, p.author);
		},
		[ix, nav],
	);

	return { accept, reject, withdraw, bulk, show };
}
