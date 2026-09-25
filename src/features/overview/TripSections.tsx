/**
 * The trip-level sections that moved from the inspector's root overview to
 * the Overview page (docs/OVERVIEW.md §7): upcoming deadlines (each time in
 * its own zone with the zone's label), the people and the latest activity.
 * The visited cities' typical weather is WP-Insights' `ClimateCard`, mounted
 * next to them by the page.
 */
import { useQuery } from "@tanstack/react-query";
import { cn } from "cn";
import { ChevronRight } from "lucide-react";
import { type ReactNode, useMemo, useState } from "react";
import { assignableMembers, MemberAvatar } from "@/components/common/member";
import { selForRefs } from "@/features/shell/activity-sel";
import { timeAgo } from "@/features/shell/inbox-model";
import { TodoText, useOpenTodo } from "@/features/shell/StillToPlan";
import { useShell } from "@/features/shell/shell-store";
import { todoContext, todoTitle } from "@/features/shell/still-to-plan";
import { SHELL_TESTID } from "@/features/shell/testids";
import {
	deadlineChip,
	deadlinesOf,
	dueCtxOf,
	useTripListItems,
} from "@/features/shell/trip-deadlines";
import { plainText } from "@/features/shell/use-trip-go";
import { roleLabel } from "@/lib/auth/roles";
import { activityQuery } from "@/lib/query/trip-queries";
import { useWorkspace } from "@/lib/workspace/use-workspace";

const DAY_MS = 86_400_000;

/** A page section: an overline title and its content. */
export function Section({
	title,
	children,
	className,
	testId,
}: {
	title: string;
	children: ReactNode;
	className?: string;
	testId?: string;
}) {
	return (
		<section data-testid={testId} className={cn("min-w-0", className)}>
			<h3 className="mb-2 text-[11px] font-semibold tracking-[.08em] text-muted-foreground uppercase">
				{title}
			</h3>
			{children}
		</section>
	);
}

export function Deadlines({ now: at }: { now?: number } = {}) {
	const { ix, schedule } = useWorkspace();
	const { items } = useTripListItems();
	const openTodo = useOpenTodo();
	const [clock] = useState(() => Date.now());
	const now = at ?? clock;
	const rows = useMemo(() => {
		if (!items) return [];
		const ctx = dueCtxOf(ix, schedule);
		// Overdue (up to a month back) and upcoming, soonest first.
		return deadlinesOf(items, ix, ctx)
			.filter((d) => d.at >= now - 30 * DAY_MS)
			.slice(0, 5);
	}, [items, ix, schedule, now]);
	if (!rows.length) return null;
	return (
		<Section title="Upcoming deadlines" testId={SHELL_TESTID.deadlines}>
			<ul className="-mx-2">
				{rows.map((d) => {
					const { li, at } = d;
					const days = Math.floor((at - now) / DAY_MS);
					const overdue = at < now;
					const context = todoContext(ix, li.target, li.text);
					return (
						<li key={li.id}>
							{/* The title first, the chip under it (VIS2-13). Opens the
							    to-do's own filtered view, like "Still to plan". */}
							<button
								type="button"
								data-testid={SHELL_TESTID.deadlineRow}
								title={todoTitle(plainText(li.text), context)}
								onClick={() => openTodo(li.target)}
								className="flex min-h-9 w-full items-center gap-2.5 rounded-md px-2 py-1 text-left transition-colors hover:bg-accent"
							>
								<span className="flex min-w-0 flex-1 flex-col items-start gap-0.5">
									<TodoText
										text={li.text}
										context={context}
										className="max-w-full text-[13px]"
									/>
									<span
										data-testid={SHELL_TESTID.deadlineChip}
										className={cn(
											"max-w-full truncate rounded-full px-2 font-mono text-[11px] leading-5 tnum",
											// ADDENDUM §10: due-soon is the neutral/primary tint, never amber.
											overdue || days <= 7
												? "bg-primary/10 text-primary"
												: "bg-muted text-muted-foreground",
										)}
									>
										{deadlineChip(d, now)}
									</span>
								</span>
								<ChevronRight className="size-3.5 shrink-0 text-muted-foreground" />
							</button>
						</li>
					);
				})}
			</ul>
		</Section>
	);
}

export function People() {
	const { graph } = useWorkspace();
	const people = assignableMembers(graph.members);
	if (!people.length) return null;
	return (
		<Section title="People">
			<ul className="grid grid-cols-[minmax(0,1fr)] gap-2 text-sm">
				{people.map((m) => (
					<li key={m.id} className="flex min-w-0 items-center gap-2">
						<MemberAvatar memberId={m.id} size={20} />
						<span className="min-w-0 flex-1 truncate">
							{m.name}
							{m.id === graph.me.memberId ? (
								<span className="text-muted-foreground"> (you)</span>
							) : null}
						</span>
						<span className="shrink-0 text-xs text-muted-foreground">
							{m.status === "active"
								? roleLabel(m.role)
								: m.status === "placeholder"
									? "Not on Yonder yet"
									: "Invited"}
						</span>
					</li>
				))}
			</ul>
		</Section>
	);
}

export function Recent() {
	const { graph, mode, ix, nav } = useWorkspace();
	const setActivityOpen = useShell((s) => s.setActivityOpen);
	const q = useQuery({
		...activityQuery(graph.trip.id),
		enabled: mode === "live",
	});
	const [now] = useState(() => Date.now());
	const rows = q.data?.slice(0, 4) ?? [];
	if (!rows.length) return null;
	return (
		<Section title="Recent">
			<ul
				data-testid={SHELL_TESTID.recentList}
				className="grid grid-cols-[minmax(0,1fr)] gap-1.5"
			>
				{rows.map((a) => {
					const sel = selForRefs(ix, a);
					return (
						<li
							key={a.id}
							className="flex min-w-0 items-baseline gap-2 text-[13px]"
						>
							<button
								type="button"
								disabled={!sel}
								title={`${a.actorName} ${a.summary}`}
								onClick={() => sel && nav.select(sel)}
								className={cn(
									"min-w-0 flex-1 truncate text-left",
									sel && "hover:underline underline-offset-2",
								)}
							>
								<span className="font-medium">{a.actorName}</span>{" "}
								<span className="text-muted-foreground">{a.summary}</span>
							</button>
							<span className="shrink-0 font-mono text-[11px] text-muted-foreground tnum">
								{timeAgo(a.at, now)}
							</span>
						</li>
					);
				})}
			</ul>
			<button
				type="button"
				onClick={() => setActivityOpen(true)}
				className="mt-2 text-xs font-medium text-primary underline-offset-2 hover:underline"
			>
				All activity
			</button>
		</Section>
	);
}
