/**
 * The inspector Overview of a day (SPEC §12.5 `DayOverview({ dayId })`,
 * DESIGN §4.4): the summary line, the capacity bar ("Activities 13h / 12h30"),
 * start time and title, the stay picker (places only), sunrise–sunset, the
 * day's issues, its stops, and Add expense. The day's notes and lists are the
 * inspector's own tabs (WP-Shell).
 */
import { cn } from "cn";
import { BedDouble, Wallet } from "lucide-react";
import { EditGuard, useEditGuard } from "@/components/common/edit-guard";
import { TimeInput } from "@/components/common/time";
import { TreePicker } from "@/components/common/tree-picker";
import { useDraftField } from "@/components/common/use-draft-field";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { DaySun } from "@/features/insights/DaySun";
import { can } from "@/lib/auth/roles";
import { formatDayDate, formatDuration, formatTime } from "@/lib/format";
import { TESTID } from "@/lib/testids";
import { useUi } from "@/lib/workspace/ui-store";
import { useWorkspace } from "@/lib/workspace/use-workspace";
import { useDayIssues } from "./DayHeader";
import { dayEnd } from "./plan-rows";
import { PLAN_TESTID } from "./testids";
import {
	itemName,
	PlanActionsProvider,
	usePlanActions,
} from "./use-plan-actions";

export function DayOverview({ dayId }: { dayId: string }) {
	return (
		<PlanActionsProvider>
			<DayOverviewBody dayId={dayId} />
		</PlanActionsProvider>
	);
}

function DayOverviewBody({ dayId }: { dayId: string }) {
	const { ix, schedule, nav, graph, mode } = useWorkspace();
	const actions = usePlanActions();
	const guard = useEditGuard();
	const openAddExpense = useUi((s) => s.openAddExpense);
	const day = ix.day(dayId);
	const s = schedule.days[dayId];
	const issues = useDayIssues(dayId);
	const title = useDraftField({
		value: day?.title ?? "",
		updatedAt: day?.updatedAt ?? "",
		flashId: dayId,
		save: (draft, expectedUpdatedAt) =>
			actions.dayUpdate.mutate({
				dayId,
				title: draft.trim() || null,
				expectedUpdatedAt,
			}),
	});
	if (!day)
		return (
			<p className="text-sm text-muted-foreground">
				This day no longer exists.
			</p>
		);
	const stay = ix.node(day.nightNodeId);
	const morning = ix.node(s?.stay.morning);
	const items = ix.itemsByDay.get(dayId) ?? [];
	const money = mode === "live" && can(graph.me, "manageExpenses");
	const pct = s
		? Math.min(
				100,
				Math.round(
					((s.activitiesMin + s.travelMin) / Math.max(1, s.capacityMin)) * 100,
				),
			)
		: 0;
	const over = (s?.overCapacityMin ?? 0) > 0;
	const end = dayEnd(ix, schedule, dayId);
	return (
		<div data-testid={TESTID.dayOverview} className="grid gap-4 text-sm">
			{s && items.length ? (
				<p className="font-mono text-xs text-muted-foreground tnum">
					Starts {day.startTime} · Activities {formatDuration(s.activitiesMin)}{" "}
					· Travel {formatDuration(s.travelMin)} · ends{" "}
					{formatTime(end?.at ?? s.end, end?.tz ?? s.tz)}
					{end && end.plusDays > 0 ? (
						<sup className="text-[9px]">+{end.plusDays}</sup>
					) : null}
				</p>
			) : (
				<p className="font-display text-[15px] text-muted-foreground">
					A free day.
				</p>
			)}

			{s ? (
				<div
					data-testid={PLAN_TESTID.dayOverviewCapacity}
					className="grid gap-1"
				>
					<div className="flex items-baseline justify-between text-xs">
						<span className="text-muted-foreground">Your day</span>
						<span className="font-mono tnum">
							{formatDuration(s.activitiesMin + s.travelMin, { compact: true })}{" "}
							/ {formatDuration(s.capacityMin, { compact: true })}
						</span>
					</div>
					<div
						aria-hidden
						className="h-1.5 overflow-hidden rounded-full bg-muted"
					>
						<div
							className={cn(
								"h-full rounded-full",
								over ? "bg-warning-hairline" : "bg-primary/70",
							)}
							style={{ width: `${pct}%` }}
						/>
					</div>
					{over ? (
						<p className="text-xs text-muted-foreground">
							Longer than your day by {formatDuration(s.overCapacityMin)}. Trim
							a stop or move one to a lighter day.
						</p>
					) : null}
				</div>
			) : null}

			<dl className="grid grid-cols-[88px_minmax(0,1fr)] items-center gap-x-3 gap-y-2.5">
				<dt className="text-xs text-muted-foreground">Title</dt>
				<dd>
					<Input
						value={title.draft}
						placeholder="Nakano + Shinjuku"
						maxLength={200}
						disabled={guard.disabled}
						title={guard.reason ?? undefined}
						onChange={(e) => title.setDraft(e.target.value)}
						onFocus={title.onFocus}
						onBlur={title.onBlur}
						onKeyDown={(e) =>
							e.key === "Enter" && (e.target as HTMLInputElement).blur()
						}
						className="h-8"
					/>
				</dd>
				<dt className="text-xs text-muted-foreground">Starts</dt>
				<dd>
					<TimeInput
						value={day.startTime}
						disabled={guard.disabled}
						aria-label="Day start"
						onChange={(v) =>
							/^\d{2}:\d{2}$/.test(v) &&
							actions.dayUpdate.mutate({
								dayId,
								startTime: v,
								expectedUpdatedAt: day.updatedAt,
							})
						}
					/>
				</dd>
				<dt className="text-xs text-muted-foreground">Stay</dt>
				<dd
					className="flex min-w-0 items-center gap-2"
					data-testid={PLAN_TESTID.dayOverviewStay}
				>
					<EditGuard>
						<TreePicker
							value={day.nightNodeId}
							placeholder="Where do you sleep?"
							filter={(n) => n.type === "place" || n.id === day.nightNodeId}
							onChange={(nodeId) =>
								actions.dayStay.mutate({ fromDayId: dayId, nodeId })
							}
							trigger={
								<Button
									variant="outline"
									size="sm"
									className="min-w-0 justify-start"
									disabled={guard.disabled}
								>
									<BedDouble
										className="size-4 text-muted-foreground"
										strokeWidth={1.5}
									/>
									<span className="truncate">{stay?.name ?? "Set stay…"}</span>
								</Button>
							}
						/>
					</EditGuard>
					{stay ? (
						<EditGuard>
							<Button
								size="xs"
								variant="ghost"
								className="text-muted-foreground"
								onClick={() =>
									actions.dayStay.mutate({ fromDayId: dayId, nodeId: null })
								}
							>
								Clear
							</Button>
						</EditGuard>
					) : null}
				</dd>
				{morning ? (
					<>
						<dt className="text-xs text-muted-foreground">Last night</dt>
						<dd className="truncate text-[13px]">{morning.name}</dd>
					</>
				) : null}
				<dt className="text-xs text-muted-foreground">Sun</dt>
				<dd className="min-w-0">
					{/* EXTENSIONS §6: the Overview repeats the full line (QA COLLAB-R2-10). */}
					<DaySun dayId={dayId} full />
				</dd>
			</dl>

			{issues.length ? (
				<section className="grid gap-1">
					<h3 className="text-[11px] font-semibold tracking-[.06em] text-muted-foreground uppercase">
						Issues
					</h3>
					<ul className="grid gap-0.5">
						{issues.map((i) => (
							<li
								key={i.key}
								className={cn(
									"text-[13px]",
									i.conflict ? "text-warning" : "text-muted-foreground",
								)}
							>
								{i.text}
							</li>
						))}
					</ul>
				</section>
			) : null}

			{items.length ? (
				<section className="grid gap-1">
					<h3 className="text-[11px] font-semibold tracking-[.06em] text-muted-foreground uppercase">
						Stops · <span className="font-mono tnum">{items.length}</span>
					</h3>
					<ol className="grid">
						{items.map((it) => {
							const t = schedule.items[it.id];
							return (
								<li key={it.id}>
									<button
										type="button"
										onClick={() => nav.select({ kind: "item", id: it.id })}
										className="flex w-full items-center gap-3 rounded-md px-1 py-1 text-left hover:bg-accent/60"
									>
										<span className="w-11 shrink-0 font-mono text-xs text-muted-foreground tnum">
											{t ? formatTime(t.start, t.tz) : "—"}
										</span>
										<span className="truncate text-[13px]">
											{itemName(ix, it)}
										</span>
									</button>
								</li>
							);
						})}
					</ol>
				</section>
			) : null}

			<div className="flex flex-wrap gap-2 border-t pt-3">
				<Button
					size="sm"
					variant="outline"
					onClick={() => nav.setDays({ from: day.date, to: day.date })}
				>
					Show only {formatDayDate(day.date)}
				</Button>
				{money ? (
					<Button
						size="sm"
						variant="outline"
						onClick={() =>
							openAddExpense({
								target: { kind: "day", dayId },
								title: `Day ${ix.dayNumber(dayId)}${day.title ? ` · ${day.title}` : ""}`,
							})
						}
					>
						<Wallet className="size-4" strokeWidth={1.5} /> Add expense
					</Button>
				) : null}
			</div>
		</div>
	);
}
