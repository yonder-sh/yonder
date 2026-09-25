/**
 * ADDENDUM §10 "one inbox": THE bell (TopBar and the mobile pill row). One
 * list and one read state for mentions, suggestions to review, suggestion
 * results, due/opening to-dos, balance-changed-since-settlement and budget
 * notices (EXTENSIONS §9). Data: `inboxQuery(tripId)` → `listInbox` (F);
 * `markInboxRead({ keys } | { all, tripId })`.
 *
 * - The bell carries at most ONE apricot dot (unread exists); rows mark
 *   unread with weight and a small neutral dot, never more glow (DESIGN §1.2).
 * - Rows are grouped by kind (Suggestions, Mentions, To-dos, Money), newest
 *   first; opening a row marks it read (everywhere: the dashboard too) and
 *   deep-links (`InboxItem.link`, re-validated); review rows open the drawer.
 * - A popover (360 × max 480) on desktop, a Drawer on phones (DESIGN §8.6).
 * - Hidden for link guests (they have no inbox).
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { cn } from "cn";
import {
	AtSign,
	Bell,
	CalendarClock,
	GitPullRequestArrow,
	Wallet,
} from "lucide-react";
import { type ReactNode, useId, useState } from "react";
import { toast } from "sonner";
import { EmptyState } from "@/components/common/empty-state";
import { MemberAvatar } from "@/components/common/member";
import { Button } from "@/components/ui/button";
import {
	Drawer,
	DrawerContent,
	DrawerTitle,
	DrawerTrigger,
} from "@/components/ui/drawer";
import {
	Popover,
	PopoverContent,
	PopoverTrigger,
} from "@/components/ui/popover";
import { openReview } from "@/features/suggest/review-store";
import { markInboxRead } from "@/functions/inbox.functions";
import type { GraphIndex } from "@/lib/engine/graph-index";
import { humanError } from "@/lib/errors";
import { meKeys } from "@/lib/query/keys";
import { inboxQuery } from "@/lib/query/trip-queries";
import type { InboxDto, InboxItem, InboxLink } from "@/lib/schemas/inbox";
import { TESTID } from "@/lib/testids";
import { useWorkspaceOptional } from "@/lib/workspace/model-context";
import { parseSel } from "@/lib/workspace/search";
import {
	formatDelta,
	groupInbox,
	INBOX_GROUP_LABEL,
	inboxSearch,
	keepScope,
	timeAgo,
} from "./inbox-model";
import { useShell } from "./shell-store";
import { SHELL_TESTID } from "./testids";
import { useBreakpoint } from "./use-breakpoint";

/** Marks keys read in every cached inbox (the trip's and the dashboard's). */
function markLocally(
	qc: ReturnType<typeof useQueryClient>,
	keys: Set<string> | "all",
) {
	qc.setQueriesData<InboxDto>({ queryKey: meKeys.inbox }, (old) => {
		if (!old) return old;
		const items = old.items.map((i) =>
			keys === "all" || keys.has(i.key) ? { ...i, read: true } : i,
		);
		return { items, unread: items.filter((i) => !i.read).length };
	});
}

export function InboxBell({
	className,
}: {
	/** The phone pills pass `size-11` (a 44px touch target, MOB-07). */
	className?: string;
} = {}) {
	const ws = useWorkspaceOptional();
	const live = !ws || ws.mode === "live";
	const guest = !!ws?.access.isGuest;
	const tripId = ws?.graph.trip.id;
	const q = useQuery({
		...inboxQuery(tripId),
		enabled: live && !guest,
	});
	const open = useShell((s) => s.inboxOpen);
	const setOpen = useShell((s) => s.setInboxOpen);
	const bp = useBreakpoint();
	// The popover is a role=dialog: named by its "Inbox" heading (VIS2-02,
	// axe aria-dialog-name). The phone drawer is named by its DrawerTitle.
	const headingId = useId();
	if (guest) return null;
	const unread = q.data?.unread ?? 0;
	const trigger = (
		<button
			type="button"
			data-testid={TESTID.inboxBell}
			data-unread={unread}
			aria-label={unread ? `Inbox, ${unread} unread` : "Inbox"}
			className={cn(
				"relative flex size-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground",
				className,
			)}
		>
			<Bell className="size-4" strokeWidth={1.75} />
			{unread ? (
				<span
					data-testid={SHELL_TESTID.inboxDot}
					className="absolute top-1.5 right-1.5 size-1.5 rounded-full bg-glow ring-2 ring-background"
				/>
			) : null}
		</button>
	);
	const panel = (
		<InboxPanel
			headingId={headingId}
			data={q.data}
			loading={q.isPending && live}
			error={q.isError}
			tripId={tripId}
			onDone={() => setOpen(false)}
		/>
	);
	if (bp === "sm")
		return (
			<Drawer open={open} onOpenChange={setOpen}>
				<DrawerTrigger asChild>{trigger}</DrawerTrigger>
				<DrawerContent className="max-h-[85svh]">
					<DrawerTitle className="sr-only">Inbox</DrawerTitle>
					{panel}
				</DrawerContent>
			</Drawer>
		);
	return (
		<Popover open={open} onOpenChange={setOpen}>
			<PopoverTrigger asChild>{trigger}</PopoverTrigger>
			<PopoverContent
				align="end"
				sideOffset={8}
				aria-labelledby={headingId}
				className="flex max-h-[min(480px,80svh)] w-[360px] flex-col overflow-hidden p-0"
			>
				{panel}
			</PopoverContent>
		</Popover>
	);
}

function InboxPanel({
	headingId,
	data,
	loading,
	error,
	tripId,
	onDone,
}: {
	headingId?: string;
	data: InboxDto | undefined;
	loading: boolean;
	error: boolean;
	tripId: string | undefined;
	onDone(): void;
}) {
	const qc = useQueryClient();
	const open = useOpenInboxLink();
	const [now] = useState(() => Date.now());
	const mark = useMutation({
		mutationFn: (v: { keys: string[] } | { all: true; tripId?: string }) =>
			markInboxRead({ data: v }),
		onMutate: (v) => markLocally(qc, "all" in v ? "all" : new Set(v.keys)),
		onError: (e) => {
			void qc.invalidateQueries({ queryKey: meKeys.inbox });
			toast.error(humanError(e));
		},
		onSettled: () => qc.invalidateQueries({ queryKey: meKeys.inbox }),
	});
	const items = data?.items ?? [];
	const groups = groupInbox(items);
	const unread = data?.unread ?? 0;
	return (
		<div
			data-testid={SHELL_TESTID.inboxPanel}
			className="flex min-h-0 flex-1 flex-col"
		>
			<div className="flex h-11 shrink-0 items-center justify-between border-b px-4">
				<p id={headingId} className="text-sm font-semibold">
					Inbox
				</p>
				<Button
					variant="ghost"
					size="sm"
					className="-mr-2 h-7 text-xs text-muted-foreground"
					disabled={!unread || mark.isPending}
					onClick={() =>
						mark.mutate(tripId ? { all: true, tripId } : { all: true })
					}
					data-testid={SHELL_TESTID.inboxMarkAll}
				>
					Mark all read
				</Button>
			</div>
			<div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
				{loading ? (
					<div className="grid gap-2 p-4" aria-busy="true">
						{[0, 1, 2].map((i) => (
							<div key={i} className="h-12 animate-pulse rounded-lg bg-muted" />
						))}
					</div>
				) : error && !items.length ? (
					<EmptyState line="Couldn't load your inbox." className="py-8" />
				) : !items.length ? (
					<EmptyState
						line="Nothing new."
						action={
							<p className="-mt-2 max-w-60 text-xs text-muted-foreground text-balance">
								Mentions, suggestions, reminders and money notices land here.
							</p>
						}
						className="py-8"
					/>
				) : (
					groups.map((g) => (
						<section key={g.key} aria-label={INBOX_GROUP_LABEL[g.key]}>
							<h3 className="sticky top-0 z-10 bg-popover/95 px-4 pt-3 pb-1 text-[11px] font-semibold tracking-[.06em] text-muted-foreground uppercase backdrop-blur">
								{INBOX_GROUP_LABEL[g.key]}
							</h3>
							<ul className="pb-1">
								{g.items.map((i) => (
									<li key={i.key}>
										<InboxRow
											item={i}
											now={now}
											onOpen={() => {
												if (!i.read) mark.mutate({ keys: [i.key] });
												onDone();
												open(i.link, i.kind);
											}}
										/>
									</li>
								))}
							</ul>
						</section>
					))
				)}
			</div>
		</div>
	);
}

const KIND_ICON: Record<InboxItem["kind"], ReactNode> = {
	mention: <AtSign className="size-3.5" />,
	review: <GitPullRequestArrow className="size-3.5" />,
	proposal_result: <GitPullRequestArrow className="size-3.5" />,
	due: <CalendarClock className="size-3.5" />,
	balance_changed: <Wallet className="size-3.5" />,
	budget_notice: <Wallet className="size-3.5" />,
};

const DUE_LABEL = {
	overdue: "Overdue",
	open_now: "Open now",
	today: "Today",
	soon: "Soon",
} as const;

function secondary(i: InboxItem): ReactNode {
	switch (i.kind) {
		case "mention":
			return i.excerpt;
		case "proposal_result":
			// The server's title already quotes a rejection note.
			return i.note && !i.title.includes(i.note) ? `“${i.note}”` : null;
		case "due":
			return null;
		case "balance_changed":
			return (
				<>
					<span className="font-mono tnum">
						{formatDelta(i.deltaMinor, i.currency)}
					</span>
					{i.cause ? ` · ${i.cause}` : null}
				</>
			);
		case "budget_notice":
			return null;
		case "review":
			return null;
	}
}

function InboxRow({
	item: i,
	now,
	onOpen,
}: {
	item: InboxItem;
	now: number;
	onOpen(): void;
}) {
	const sub = secondary(i);
	const ws = useWorkspaceOptional();
	// "Maya mentioned you in Shibuya Sky" (DESIGN §8.6): the live name when the
	// place is in this trip's graph (it follows renames), else the feed's.
	const where =
		i.kind === "mention"
			? ((ws && i.tripId === ws.graph.trip.id
					? placeOfLink(ws.ix, i.link)
					: null) ??
				i.where ??
				null)
			: null;
	return (
		<button
			type="button"
			data-testid={SHELL_TESTID.inboxRow}
			data-kind={i.kind}
			data-read={i.read ? "1" : "0"}
			onClick={onOpen}
			className="flex w-full items-start gap-3 px-4 py-2.5 text-left transition-colors hover:bg-accent focus-visible:bg-accent focus-visible:outline-none"
		>
			<span className="mt-0.5 shrink-0">
				{ws && i.actor?.memberId ? (
					<MemberAvatar memberId={i.actor.memberId} size={28} ring={false} />
				) : (
					<span className="flex size-7 items-center justify-center rounded-full bg-muted text-muted-foreground">
						{KIND_ICON[i.kind]}
					</span>
				)}
			</span>
			<span className="min-w-0 flex-1">
				<span
					className={cn(
						"block text-[13px] leading-[18px] text-pretty",
						i.read ? "text-muted-foreground" : "font-medium text-foreground",
					)}
				>
					{i.title}
					{where ? (
						<>
							{" "}
							in <span className="font-semibold">{where}</span>
						</>
					) : null}
				</span>
				{sub ? (
					<span className="mt-0.5 block truncate text-xs text-muted-foreground">
						{sub}
					</span>
				) : null}
				<span className="mt-0.5 flex items-center gap-1.5 text-[11px] text-muted-foreground">
					{i.kind === "due" ? (
						<span
							className={cn(
								"rounded-full px-1.5 leading-4",
								// Due-soon uses the neutral/primary tint (ADDENDUM §10), never amber.
								i.state === "overdue" || i.state === "open_now"
									? "bg-primary/10 text-primary"
									: "bg-muted",
							)}
						>
							{DUE_LABEL[i.state]}
						</span>
					) : null}
					<span className="font-mono tnum">{timeAgo(i.at, now)}</span>
				</span>
			</span>
			{i.read ? null : (
				<span className="mt-1.5 size-1.5 shrink-0 rounded-full bg-primary/60">
					<span className="sr-only">unread</span>
				</span>
			)}
		</button>
	);
}

/** The place a link points at (node, or an item's place / title), for row titles. */
function placeOfLink(ix: GraphIndex, link: InboxLink): string | null {
	const sel = parseSel(link.sel);
	if (sel?.kind === "node") return ix.node(sel.id)?.name ?? null;
	if (sel?.kind === "item") {
		const it = ix.item(sel.id);
		return it ? (it.title ?? ix.node(it.nodeId)?.name ?? null) : null;
	}
	if (sel?.kind === "day") {
		const d = ix.day(sel.id);
		return d ? `Day ${ix.dayNumber(d.id)}` : null;
	}
	return null;
}

/** Opens an inbox link: in this workspace when it's this trip, else the trip's page. */
function useOpenInboxLink(): (
	link: InboxLink,
	kind?: InboxItem["kind"],
) => void {
	const ws = useWorkspaceOptional();
	const navigate = useNavigate();
	return (link, kind) => {
		const here = ws && link.tripSlug === ws.graph.trip.slug;
		if (here && link.review) {
			// WP-Suggest M5b: a result opens "Mine", a review item "Open".
			openReview(kind === "proposal_result" ? "mine" : "open");
			return;
		}
		const search = inboxSearch(link);
		if (here && ws) {
			const keep = keepScope(ws.ix, ws.scope?.id ?? null, link);
			const splat = keep ? ws.scopePath.map((n) => n.slug).join("/") : "";
			const next = keep
				? {
						...ws.search,
						sel: undefined,
						tab: undefined,
						list: undefined,
						...search,
					}
				: search;
			if (splat)
				void navigate({
					to: "/t/$trip/$",
					params: { trip: link.tripSlug, _splat: splat },
					search: next,
				});
			else
				void navigate({
					to: "/t/$trip",
					params: { trip: link.tripSlug },
					search: next,
				});
			return;
		}
		void navigate({
			to: "/t/$trip",
			params: { trip: link.tripSlug },
			search,
		});
	};
}
