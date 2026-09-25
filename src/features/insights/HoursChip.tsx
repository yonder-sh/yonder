/**
 * E1: the hours chip on a plan card (mounted by WP-Plan before the duration
 * chip). Nothing when there is no issue. Info → a 12px muted clock glyph;
 * warn → an amber chip with the label (a closure is a real conflict,
 * ADDENDUM §10). Hover or tap shows every issue with its reason, the source
 * line ("From the sheet: '~10–17, many closed Sun' · Check hours"; OSM hours
 * link their OpenStreetMap object, with the attribution) and up to two
 * fixes (EXTENSIONS §4.3).
 */
import { cn } from "cn";
import { Clock, MoonStar, PencilLine } from "lucide-react";
import { useEditGuard } from "@/components/common/edit-guard";
import { undoToast } from "@/components/common/undo-toast";
import { useTripMutation } from "@/components/common/use-trip-mutation";
import { Button } from "@/components/ui/button";
import { moveItem } from "@/functions/items.functions";
import {
	effectiveHours,
	type HoursFix,
	type HoursIssue,
	hoursFixes,
	weekdayOf,
	worstIssue,
} from "@/lib/engine/hours";
import { hhmm, localDateOf } from "@/lib/engine/time";
import { tripKeys } from "@/lib/query/keys";
import { TESTID } from "@/lib/testids";
import { useUi } from "@/lib/workspace/ui-store";
import { useWorkspace } from "@/lib/workspace/use-workspace";
import { issueSentence, sourceLabel, WEEKDAY_LONG } from "./hours-format";
import { OsmHoursSource } from "./OsmHoursSource";
import { INSIGHTS_TESTID } from "./testids";
import { HoverPopover } from "./ui";
import { useHoursIssues } from "./use-hours-issues";

type MoveVars = {
	itemId: string;
	dayId: string | null;
	afterItemId?: string;
	beforeItemId?: string;
};

/** Where an item sits now, so a move can be undone to the same spot. */
function anchorOf(
	items: readonly { id: string }[] | undefined,
	itemId: string,
): { afterItemId?: string; beforeItemId?: string } {
	const list = items ?? [];
	const at = list.findIndex((i) => i.id === itemId);
	const prev = at > 0 ? list[at - 1] : undefined;
	const next = at >= 0 ? list[at + 1] : undefined;
	if (prev) return { afterItemId: prev.id };
	if (next) return { beforeItemId: next.id };
	return {};
}

export function HoursChip({ itemId }: { itemId: string }) {
	const { byItem } = useHoursIssues();
	const issues = byItem[itemId];
	if (!issues?.length) return null;
	return <HoursChipView itemId={itemId} issues={issues} />;
}

function HoursChipView({
	itemId,
	issues,
}: {
	itemId: string;
	issues: HoursIssue[];
}) {
	const { ix, schedule, graph, access } = useWorkspace();
	const worst = worstIssue(issues) as HoursIssue;
	const warn = worst.severity === "warn";
	const warnCount = issues.filter((i) => i.severity === "warn").length;
	const item = ix.item(itemId);
	const node = item?.nodeId ? ix.node(item.nodeId) : undefined;
	const place = item?.title ?? node?.name ?? "This place";
	const label = warn ? worst.label : issues.map((i) => i.label).join(" · ");
	const Glyph = !warn && worst.kind === "after_dark" ? MoonStar : Clock;
	return (
		<HoverPopover
			testId={INSIGHTS_TESTID.hoursPopover}
			trigger={
				<button
					type="button"
					data-testid={TESTID.hoursChip}
					data-severity={worst.severity}
					data-kind={worst.kind}
					aria-label={`Hours: ${label}`}
					className={cn(
						"inline-flex shrink-0 cursor-pointer items-center rounded-full transition-colors focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none",
						warn
							? "h-[22px] max-w-[190px] gap-1 border border-warning-hairline/70 bg-warning-wash px-2 text-xs font-medium text-warning hover:border-warning-hairline"
							: "size-[22px] justify-center text-muted-foreground hover:bg-muted hover:text-foreground",
					)}
				>
					<Glyph className="size-3 shrink-0" strokeWidth={1.75} aria-hidden />
					{warn ? (
						<span className="truncate">
							{worst.label.split(" · ")[0]}
							{worst.label.includes(" · ") ? (
								<span className="max-sm:hidden">
									{" · "}
									{worst.label.split(" · ").slice(1).join(" · ")}
								</span>
							) : null}
							{warnCount > 1 ? (
								<span className="ml-1 font-mono tnum opacity-80">
									+{warnCount - 1}
								</span>
							) : null}
						</span>
					) : null}
				</button>
			}
		>
			<IssueDetails
				itemId={itemId}
				issues={issues}
				place={place}
				nodeId={node?.id ?? null}
				ctx={{ ix, schedule, graph, access }}
			/>
		</HoverPopover>
	);
}

function IssueDetails({
	itemId,
	issues,
	place,
	nodeId,
	ctx,
}: {
	itemId: string;
	issues: HoursIssue[];
	place: string;
	nodeId: string | null;
	ctx: Pick<
		ReturnType<typeof useWorkspace>,
		"ix" | "schedule" | "graph" | "access"
	>;
}) {
	const { ix, schedule, graph, access } = ctx;
	const openHoursEditor = useUi((s) => s.openHoursEditor);
	const guard = useEditGuard();
	// Viewers get the explanation but no fixes and no edit (QA HRS-08).
	const readOnly = access.mode === "read";
	const tripId = graph.trip.id;
	const move = useTripMutation((v: MoveVars) => moveItem({ data: v }), {
		keys: [tripKeys.graph(tripId)],
		tripId,
	});
	const node = nodeId ? ix.node(nodeId) : undefined;
	const eh = node ? effectiveHours(node, graph.trip.settings) : null;
	const s = schedule.items[itemId];
	const tz = nodeId ? ix.tzOf(nodeId) : ix.defaultTz;
	const start = s ? hhmm(s.start, tz) : undefined;
	const end = s ? hhmm(s.end, tz) : undefined;
	const weekday = s
		? WEEKDAY_LONG[weekdayOf(localDateOf(s.start, tz))]
		: undefined;
	const worst = worstIssue(issues);
	const fixes: HoursFix[] =
		worst?.severity === "warn" && !readOnly
			? hoursFixes(ix, schedule, itemId, worst)
			: [];

	const applyFix = (fix: HoursFix) => {
		const item = ix.item(itemId);
		if (!item) return;
		const from: MoveVars = {
			itemId,
			dayId: item.dayId,
			...anchorOf(
				item.dayId ? ix.itemsByDay.get(item.dayId) : undefined,
				itemId,
			),
		};
		const to: MoveVars =
			fix.kind === "move"
				? {
						itemId,
						dayId: fix.dayId,
						...(fix.afterItemId ? { afterItemId: fix.afterItemId } : {}),
						...(fix.beforeItemId ? { beforeItemId: fix.beforeItemId } : {}),
					}
				: { itemId, dayId: null };
		move.mutate(to, {
			onSuccess: (r) => {
				if (r && typeof r === "object" && "proposed" in r) return;
				const where =
					fix.kind === "move" ? fix.label.replace(/^Move to /, "") : null;
				undoToast(
					where
						? `${place} moved to ${where}`
						: `${place} moved to Unscheduled`,
					() => move.mutate(from),
				);
			},
		});
	};

	return (
		<div className="grid">
			<ul className="grid gap-3 px-3.5 pt-3 pb-3">
				{issues.map((issue) => (
					<li
						key={`${issue.kind}:${issue.label}`}
						data-testid={INSIGHTS_TESTID.hoursIssueRow}
						data-kind={issue.kind}
						className="grid gap-0.5"
					>
						<p
							className={cn(
								"flex items-center gap-1.5 font-medium",
								issue.severity === "warn" ? "text-warning" : "text-foreground",
							)}
						>
							{issue.kind === "after_dark" ? (
								<MoonStar className="size-3.5" strokeWidth={1.75} aria-hidden />
							) : (
								<Clock className="size-3.5" strokeWidth={1.75} aria-hidden />
							)}
							{issue.label}
						</p>
						<p className="text-[12px] leading-4 text-muted-foreground">
							{issueSentence(issue, { place, start, end, weekday })}
						</p>
					</li>
				))}
			</ul>
			{fixes.length ? (
				<div className="flex flex-wrap gap-1.5 px-3.5 pb-3">
					{fixes.map((fix) => (
						<Button
							key={fix.kind}
							size="sm"
							variant={fix.kind === "move" ? "outline" : "ghost"}
							data-testid={INSIGHTS_TESTID.hoursFix}
							data-fix={fix.kind}
							disabled={guard.disabled || move.isPending}
							title={guard.reason ?? undefined}
							className="h-7 rounded-full px-2.5 text-xs"
							onClick={() => applyFix(fix)}
						>
							{fix.label}
						</Button>
					))}
				</div>
			) : null}
			{eh || node ? (
				<div className="flex items-center gap-2 border-t px-3.5 py-2 text-[11px] leading-4 text-muted-foreground">
					<span
						className="min-w-0 flex-1"
						data-testid={INSIGHTS_TESTID.hoursSource}
					>
						{eh?.source === "osm" && node ? (
							<OsmHoursSource node={node} updatedAt={eh.hours.updatedAt} />
						) : eh ? (
							sourceLabel(eh)
						) : (
							"No hours"
						)}
						{eh?.raw ? (
							<span className="text-muted-foreground/90">
								: “<span className="italic">{eh.raw}</span>”
							</span>
						) : null}
					</span>
					{node && !readOnly ? (
						<button
							type="button"
							data-testid={INSIGHTS_TESTID.hoursEditHours}
							disabled={guard.disabled}
							title={guard.reason ?? undefined}
							onClick={() => openHoursEditor({ nodeId: node.id })}
							className="inline-flex shrink-0 items-center gap-1 rounded-sm font-medium text-primary hover:underline disabled:pointer-events-none disabled:opacity-50"
						>
							<PencilLine className="size-3" strokeWidth={1.75} aria-hidden />
							{eh?.source === "sheet" ? "Check hours" : "Edit hours"}
						</button>
					) : null}
				</div>
			) : null}
		</div>
	);
}
