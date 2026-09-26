/**
 * E7 review (EXTENSIONS §3.7): a 420px Sheet (a Drawer on mobile) with
 * Open · Mine · Conflicts. Open and Conflicts are grouped by author ×
 * 10-minute batch with Accept all / Reject all; Mine lists the caller's own,
 * closed ones included (status + review note). Rows: summary, italic
 * message, scope crumb, Accept / Reject (reviewers) or Withdraw (the author)
 * and Show (select + flash). Opened with `useUi().setReviewOpen(true)` or
 * `openReview(filter)`.
 *
 * Viewers never see it (their proposal list is empty and they can't open it).
 */
import { type ReactNode, useMemo } from "react";
import { EditGuard } from "@/components/common/edit-guard";
import { EmptyState } from "@/components/common/empty-state";
import { MemberAvatar } from "@/components/common/member";
import { Button } from "@/components/ui/button";
import {
	Drawer,
	DrawerContent,
	DrawerDescription,
	DrawerHeader,
	DrawerTitle,
} from "@/components/ui/drawer";
import {
	Sheet,
	SheetContent,
	SheetDescription,
	SheetHeader,
	SheetTitle,
} from "@/components/ui/sheet";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useIsMobile } from "@/hooks/use-mobile";
import { bool, oneOf, useFollowValue } from "@/lib/realtime/view-ui";
import type { ProposalDto } from "@/lib/schemas/proposals";
import { TESTID } from "@/lib/testids";
import { useUi } from "@/lib/workspace/ui-store";
import { useWorkspace } from "@/lib/workspace/use-workspace";
import { ProposalRow } from "./ProposalRow";
import {
	type Batch,
	batches,
	isMine,
	joinNames,
	reviewerFirstNames,
	reviewersLine,
	timeAgo,
} from "./proposal-view";
import { type ReviewFilter, useReviewStore } from "./review-store";

/** A review tab a follower may take. */
const isFilter = oneOf<ReviewFilter>(["open", "mine", "conflicts"]);

import { SUGGEST_TESTID } from "./testids";
import { useProposalActions } from "./use-proposal-actions";

const FILTERS: { value: ReviewFilter; label: string }[] = [
	{ value: "open", label: "Open" },
	{ value: "mine", label: "Mine" },
	{ value: "conflicts", label: "Conflicts" },
];

const EMPTY: Record<ReviewFilter, string> = {
	open: "Nothing to review.",
	mine: "You haven't suggested anything yet.",
	conflicts: "No conflicts.",
};

function byNewest(a: ProposalDto, b: ProposalDto) {
	const at = a.reviewedAt ?? a.updatedAt;
	const bt = b.reviewedAt ?? b.updatedAt;
	return bt.localeCompare(at);
}

/** The drawer's lists, derived once per proposals change. */
function useReviewLists() {
	const { proposals, graph } = useWorkspace();
	const local = useReviewStore((s) => s.conflicts);
	return useMemo(() => {
		const me = graph.me.userId;
		const open = proposals.list.filter((p) => p.status === "open");
		const conflicted = open.filter((p) => local[p.id] ?? p.lastError);
		const mine = proposals.list
			.filter((p) => isMine(p, me))
			.sort((a, b) =>
				a.status === "open" && b.status !== "open"
					? -1
					: b.status === "open" && a.status !== "open"
						? 1
						: byNewest(a, b),
			);
		// Which open proposals are stacked alternatives (not drawn as the ghost).
		const stacked = new Set<string>();
		for (const marks of proposals.marks.values())
			for (const m of marks) if (m.stacked) stacked.add(m.proposalId);
		return { open, conflicted, mine, stacked };
	}, [proposals.list, proposals.marks, graph.me.userId, local]);
}

function GroupHeader({ batch }: { batch: Batch }) {
	const { access, graph } = useWorkspace();
	// Your own batch: withdraw one by one, never "reject" yourself.
	const own = !!graph.me.userId && batch.author.userId === graph.me.userId;
	const { bulk } = useProposalActions();
	const open = batch.proposals.filter((p) => p.status === "open");
	const acceptable = open.filter((p) => p.op !== "note.append");
	const n = batch.proposals.length;
	return (
		<div className="flex items-center gap-2 px-4 pt-3 pb-1">
			<MemberAvatar
				size={20}
				user={{
					name: batch.author.name,
					color: batch.author.color,
					memberId: batch.author.memberId,
					guest: batch.author.isGuest,
				}}
			/>
			<p className="min-w-0 flex-1 truncate text-[13px] leading-[18px]">
				<span className="font-medium">{batch.author.name}</span>
				<span className="text-muted-foreground">
					{" "}
					· {n} suggestion{n === 1 ? "" : "s"} · {timeAgo(batch.startedAt)}
				</span>
			</p>
			{access.canReview && open.length > 1 ? (
				<div className="flex shrink-0 gap-1">
					{own ? null : (
						<EditGuard>
							<Button
								variant="ghost"
								size="xs"
								data-testid={SUGGEST_TESTID.groupRejectAll}
								className="text-muted-foreground hover:text-foreground"
								onClick={() => bulk.mutate({ ps: open, decision: "reject" })}
							>
								Reject all
							</Button>
						</EditGuard>
					)}
					{acceptable.length > 1 ? (
						<EditGuard>
							<Button
								variant="outline"
								size="xs"
								data-testid={SUGGEST_TESTID.groupAcceptAll}
								onClick={() =>
									bulk.mutate({ ps: acceptable, decision: "accept" })
								}
							>
								Accept all
							</Button>
						</EditGuard>
					) : null}
				</div>
			) : null}
		</div>
	);
}

function ReviewBody({ onAfterShow }: { onAfterShow: () => void }) {
	const { proposals, graph, access, nav } = useWorkspace();
	const filter = useReviewStore((s) => s.filter);
	const setFilter = useReviewStore((s) => s.setFilter);
	useFollowValue("suggest.filter", filter, setFilter, isFilter);
	const { show } = useProposalActions();
	const lists = useReviewLists();

	const onShow = (p: ProposalDto) => {
		show(p);
		onAfterShow();
	};
	const onDetails = (p: ProposalDto) => {
		nav.select({ kind: "proposal", id: p.id });
		onAfterShow();
	};

	const count: Record<ReviewFilter, number> = {
		open: lists.open.length,
		mine: lists.mine.filter((p) => p.status === "open").length,
		conflicts: lists.conflicted.length,
	};

	let body: ReactNode;
	if (filter === "mine") {
		body = lists.mine.length ? (
			<ul className="divide-y">
				{lists.mine.map((p) => (
					<ProposalRow
						key={p.id}
						p={p}
						stacked={lists.stacked.has(p.id)}
						onShow={onShow}
						onDetails={onDetails}
					/>
				))}
			</ul>
		) : null;
	} else {
		const source = filter === "open" ? lists.open : lists.conflicted;
		const groups = batches(source);
		body = groups.length ? (
			<div className="divide-y">
				{groups.map((b) => (
					<section
						key={b.key}
						data-testid={SUGGEST_TESTID.group}
						aria-label={`${b.author.name}'s suggestions`}
					>
						<GroupHeader batch={b} />
						<ul>
							{b.proposals.map((p) => (
								<ProposalRow
									key={p.id}
									p={p}
									stacked={lists.stacked.has(p.id)}
									onShow={onShow}
									onDetails={onDetails}
								/>
							))}
						</ul>
					</section>
				))}
			</div>
		) : null;
	}

	const names = reviewerFirstNames(graph);
	const authors = [...new Set(lists.open.map((p) => p.author.name))];

	return (
		<>
			<p className="px-4 text-[13px] leading-[18px] text-muted-foreground">
				{access.canReview
					? proposals.count
						? `${proposals.count} open from ${joinNames(authors.slice(0, 3))}${authors.length > 3 ? " and others" : ""}.`
						: "Nothing waiting for you."
					: reviewersLine(names)}
			</p>
			<Tabs
				value={filter}
				onValueChange={(v) => setFilter(v as ReviewFilter)}
				className="px-4"
			>
				<TabsList className="h-8 w-full" data-testid={SUGGEST_TESTID.filter}>
					{FILTERS.map((f) => (
						<TabsTrigger
							key={f.value}
							value={f.value}
							data-filter={f.value}
							className="gap-1.5 text-xs"
						>
							{f.label}
							{count[f.value] ? (
								<span className="font-mono text-[11px] text-muted-foreground tnum">
									{count[f.value]}
								</span>
							) : null}
						</TabsTrigger>
					))}
				</TabsList>
			</Tabs>
			<div className="min-h-0 flex-1 overflow-y-auto border-t pb-6">
				{body ?? <EmptyState line={EMPTY[filter]} />}
			</div>
		</>
	);
}

export function ReviewDrawer() {
	const open = useUi((s) => s.reviewOpen);
	const setOpen = useUi((s) => s.setReviewOpen);
	// Open or closed travels with my view.
	useFollowValue("suggest.review", open, setOpen, bool);
	const { access } = useWorkspace();
	const mobile = useIsMobile();
	const allowed = access.canReview || access.canPropose;
	const visible = open && allowed;
	const title = access.canReview ? "Suggestions" : "Your suggestions";

	if (mobile)
		return (
			<Drawer open={visible} onOpenChange={setOpen}>
				<DrawerContent
					data-testid={TESTID.reviewDrawer}
					className="flex h-[92svh] max-h-[92svh] flex-col gap-3 data-[vaul-drawer-direction=bottom]:max-h-[92svh]"
				>
					<DrawerHeader className="px-4 pt-2 pb-0 group-data-[vaul-drawer-direction=bottom]/drawer-content:text-left">
						<DrawerTitle className="text-[17px] leading-6 font-semibold">
							{title}
						</DrawerTitle>
						<DrawerDescription className="sr-only">
							Review, accept or reject suggested changes.
						</DrawerDescription>
					</DrawerHeader>
					{visible ? <ReviewBody onAfterShow={() => setOpen(false)} /> : null}
				</DrawerContent>
			</Drawer>
		);

	return (
		<Sheet open={visible} onOpenChange={setOpen}>
			<SheetContent
				data-testid={TESTID.reviewDrawer}
				className="flex w-full flex-col gap-3 p-0 sm:max-w-[420px]"
			>
				<SheetHeader className="px-4 pt-4 pb-0">
					<SheetTitle className="text-[17px] leading-6">{title}</SheetTitle>
					<SheetDescription className="sr-only">
						Review, accept or reject suggested changes.
					</SheetDescription>
				</SheetHeader>
				{visible ? <ReviewBody onAfterShow={() => setOpen(false)} /> : null}
			</SheetContent>
		</Sheet>
	);
}
