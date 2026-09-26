/**
 * E1: the amber day-header chip ("Itoya closed Wed" / "Hours · 3"). A closure
 * is a real conflict, so it's amber (ADDENDUM §10); info-only days show
 * nothing. Hover or tap lists every stop with a problem (a row selects it)
 * and, with a Google key, "Hours unknown for 4 stops · Fetch". WP-Plan folds
 * it into the header's single "N issues" chip when other issues exist.
 */
import { useQuery } from "@tanstack/react-query";
import { cn } from "cn";
import { ChevronRight, Clock, Download } from "lucide-react";
import { useEditGuard } from "@/components/common/edit-guard";
import { useTripMutation } from "@/components/common/use-trip-mutation";
import { effectiveHours, hoursApply, worstIssue } from "@/lib/engine/hours";
import { hhmm } from "@/lib/engine/time";
import { tripKeys } from "@/lib/query/keys";
import { capabilitiesQuery } from "@/lib/query/trip-queries";
import { TESTID } from "@/lib/testids";
import { useWorkspace } from "@/lib/workspace/use-workspace";
import { dayChipLabel } from "./hours-format";
import { fetchOpeningHours } from "./insights.functions";
import { INSIGHTS_TESTID } from "./testids";
import { HoverPopover, Overline } from "./ui";
import { useHoursIssues } from "./use-hours-issues";

export function DayHoursBadge({ dayId }: { dayId: string }) {
	const { byItem, byDay } = useHoursIssues();
	const count = byDay[dayId];
	if (!count?.warn) return null;
	return <DayHoursBadgeView dayId={dayId} byItem={byItem} />;
}

function DayHoursBadgeView({
	dayId,
	byItem,
}: {
	dayId: string;
	byItem: ReturnType<typeof useHoursIssues>["byItem"];
}) {
	const { ix, schedule, graph, nav, mode, access } = useWorkspace();
	const caps = useQuery({
		...capabilitiesQuery(),
		enabled: mode === "live",
	}).data;
	const guard = useEditGuard("edit-only", "Suggesters can't fetch hours");
	const tripId = graph.trip.id;
	const fetchHours = useTripMutation(
		(v: { tripId: string; nodeIds: string[] }) =>
			fetchOpeningHours({ data: v }),
		{ keys: [tripKeys.graph(tripId)] },
	);
	const rows = (ix.itemsByDay.get(dayId) ?? [])
		.map((item) => {
			const issue = worstIssue(byItem[item.id]);
			if (issue?.severity !== "warn") return null;
			const node = item.nodeId ? ix.node(item.nodeId) : undefined;
			const s = schedule.items[item.id];
			const tz = node ? ix.tzOf(node.id) : ix.defaultTz;
			return {
				item,
				issue,
				name: item.title ?? node?.name ?? "Untitled",
				time: s ? hhmm(s.start, tz) : null,
			};
		})
		.filter((r) => r !== null);
	if (!rows.length) return null;
	const first = rows[0];
	const label =
		rows.length === 1 && first
			? dayChipLabel(first.name, first.issue)
			: `Hours · ${rows.length}`;
	const unknown = caps?.google
		? (ix.itemsByDay.get(dayId) ?? [])
				.map((i) => (i.nodeId ? ix.node(i.nodeId) : undefined))
				.filter(
					(n): n is NonNullable<typeof n> =>
						hoursApply(n) &&
						n.type === "place" &&
						!!n.googlePlaceId &&
						!effectiveHours(n, graph.trip.settings),
				)
				.filter((n, i, all) => all.findIndex((x) => x.id === n.id) === i)
		: [];
	return (
		<HoverPopover
			align="end"
			testId={INSIGHTS_TESTID.hoursPopover}
			followId={`d.${dayId}`}
			trigger={
				<button
					type="button"
					data-testid={TESTID.dayHoursBadge}
					data-count={rows.length}
					className="inline-flex h-[22px] max-w-[220px] shrink-0 cursor-pointer items-center gap-1 rounded-full border border-warning-hairline/70 bg-warning-wash px-2 text-xs font-medium text-warning transition-colors hover:border-warning-hairline focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
				>
					<Clock className="size-3 shrink-0" strokeWidth={1.75} aria-hidden />
					<span className="truncate">{label}</span>
				</button>
			}
		>
			<div className="px-3.5 pt-3 pb-1.5">
				<Overline>Opening hours</Overline>
			</div>
			<ul className="grid pb-1.5">
				{rows.map((r) => (
					<li key={r.item.id}>
						<button
							type="button"
							data-testid={INSIGHTS_TESTID.dayHoursRow}
							onClick={() => nav.select({ kind: "item", id: r.item.id })}
							className="group grid w-full grid-cols-[auto_1fr_auto] items-center gap-x-2.5 px-3.5 py-1.5 text-left hover:bg-accent focus-visible:bg-accent focus-visible:outline-none"
						>
							<span className="w-10 font-mono text-[12px] text-muted-foreground tnum">
								{r.time ?? "—"}
							</span>
							<span className="min-w-0">
								<span className="block truncate font-medium">{r.name}</span>
								<span className="block truncate text-[12px] text-warning">
									{r.issue.label}
								</span>
							</span>
							<ChevronRight
								className="size-3.5 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100"
								aria-hidden
							/>
						</button>
					</li>
				))}
			</ul>
			{unknown.length ? (
				<div className="flex items-center gap-2 border-t px-3.5 py-2 text-[12px] text-muted-foreground">
					<span className="flex-1">
						Hours unknown for {unknown.length} stop
						{unknown.length === 1 ? "" : "s"}
					</span>
					{/* Viewers get the count but no Fetch (QA HRS-08). */}
					{access.mode === "read" ? null : (
						<button
							type="button"
							data-testid={INSIGHTS_TESTID.hoursFetch}
							disabled={guard.disabled || fetchHours.isPending}
							title={guard.reason ?? undefined}
							onClick={() =>
								fetchHours.mutate({
									tripId,
									nodeIds: unknown.slice(0, 25).map((n) => n.id),
								})
							}
							className={cn(
								"inline-flex items-center gap-1 rounded-sm font-medium text-primary hover:underline disabled:pointer-events-none disabled:opacity-50",
							)}
						>
							<Download className="size-3" strokeWidth={1.75} aria-hidden />
							{fetchHours.isPending ? "Fetching…" : "Fetch"}
						</button>
					)}
				</div>
			) : null}
		</HoverPopover>
	);
}
