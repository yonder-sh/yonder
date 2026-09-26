/**
 * The day header (DESIGN §7.1, 48px sticky, blurred ground): the date in
 * Parkinsans, "Day 4 · Tokyo · JST" (the zone only when it changes), the
 * title, the start time, the stay chip, sunrise–sunset (WP-Insights `DaySun`),
 * the summary "Activities 13h · Travel 1h20 · ends 23:35", at most ONE issues
 * chip (ADDENDUM §10: amber only for real conflicts; hours-only days show
 * WP-Insights' `DayHoursBadge`), and the ⋯ menu with the day operations.
 *
 * FB-08 (owner feedback, overrides DESIGN §7.1 "clicking the header sets
 * `days`"): a click on the header never changes the day filter; the owner
 * clicks there to dismiss menus. The date selects the day (the inspector
 * shows its Overview); the empty header does nothing. Filtering is explicit:
 * the header's "Show only this day" toggle (shift-click extends the range),
 * the ⋯ menu, the day Overview's "Show only …", the phone's day chips and
 * the `d` key.
 */
import { cn } from "cn";
import {
	BedDouble,
	ChevronDown,
	EllipsisVertical,
	ListFilter,
	TriangleAlert,
	Wallet,
} from "lucide-react";
import { useState } from "react";
import { useEditGuard } from "@/components/common/edit-guard";
import { TimeInput } from "@/components/common/time";
import { TreePicker } from "@/components/common/tree-picker";
import { useDraftField } from "@/components/common/use-draft-field";
import { Button } from "@/components/ui/button";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuSeparator,
	DropdownMenuSub,
	DropdownMenuSubContent,
	DropdownMenuSubTrigger,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import {
	Popover,
	PopoverContent,
	PopoverTrigger,
} from "@/components/ui/popover";
import { DayHoursBadge } from "@/features/insights/DayHoursBadge";
import { DaySun } from "@/features/insights/DaySun";
import { useHoursIssues } from "@/features/insights/use-hours-issues";
import { can } from "@/lib/auth/roles";
import { tzLabel } from "@/lib/engine/time";
import type { GraphDay } from "@/lib/engine/types";
import { formatDayDate, formatDuration, formatTime } from "@/lib/format";
import { copyAnchorId } from "@/lib/realtime/cursor-protocol";
import { useFormPresence } from "@/lib/realtime/form-presence";
import { useFollowToggle } from "@/lib/realtime/view-ui";
import { TESTID } from "@/lib/testids";
import { useUi } from "@/lib/workspace/ui-store";
import { useProposalMarks } from "@/lib/workspace/use-proposals";
import { useWorkspace } from "@/lib/workspace/use-workspace";
import { DISABLED_SUB_TRIGGER } from "./ItemCard";
import { useMenuHandoff } from "./menu-handoff";
import { dayEnd } from "./plan-rows";
import { PLAN_TESTID } from "./testids";
import { useMediaQuery } from "./use-media";
import { itemName, usePlanActions } from "./use-plan-actions";

/** The city (else the coarsest place below the country) most of the day happens in. */
export function dayCity(
	ix: ReturnType<typeof useWorkspace>["ix"],
	dayId: string,
): string | null {
	const tally = new Map<string, number>();
	for (const it of ix.itemsByDay.get(dayId) ?? []) {
		const eff = ix.effectiveNodeId(it.id);
		if (!eff) continue;
		const city =
			ix.hierarchy.nearestOfType(eff, "city") ??
			ix.hierarchy.collapseTo(eff, "region");
		if (!city) continue;
		tally.set(city.id, (tally.get(city.id) ?? 0) + it.durationMin + 1);
	}
	let best: string | null = null;
	let max = -1;
	for (const [id, n] of tally)
		if (n > max) {
			best = id;
			max = n;
		}
	return best ? (ix.node(best)?.name ?? null) : null;
}

/** "JST" when the day's zone changed; "ICT → CST" when it changes mid-day. */
function zoneLabel(
	ws: ReturnType<typeof useWorkspace>,
	dayId: string,
): string | null {
	const sd = ws.schedule.days[dayId];
	if (!sd?.tzChanged) return null;
	const items = (ws.ix.itemsByDay.get(dayId) ?? [])
		.map((it) => ws.schedule.items[it.id])
		.filter((s) => s !== undefined);
	const first = items[0];
	const last = items.at(-1);
	const a = tzLabel(first?.tz ?? sd.tz, sd.start);
	const b = last ? tzLabel(last.tz, last.start) : a;
	return a === b ? a : `${a} → ${b}`;
}

type Issue = { key: string; text: string; conflict: boolean; itemId?: string };

/** Everything that's wrong with a day, for the ONE chip (and its list). */
export function useDayIssues(dayId: string): Issue[] {
	const { ix, schedule } = useWorkspace();
	const hours = useHoursIssues();
	const sd = schedule.days[dayId];
	const out: Issue[] = [];
	for (const it of ix.itemsByDay.get(dayId) ?? []) {
		const late = schedule.items[it.id]?.late;
		if (late)
			out.push({
				key: `late:${it.id}`,
				text: `${itemName(ix, it)} starts ${formatDuration(late.minutes)} late`,
				conflict: true,
				itemId: it.id,
			});
		for (const h of hours.byItem[it.id] ?? [])
			if (h.severity === "warn")
				out.push({
					key: `hours:${it.id}:${h.kind}`,
					text: `${itemName(ix, it)}: ${h.label}`,
					conflict: true,
					itemId: it.id,
				});
	}
	for (const [key, l] of Object.entries(schedule.legs)) {
		if (!l.late) continue;
		const [from] = key.startsWith("stay:") ? [null] : key.split(">");
		const fromItem = from ? ix.item(from) : null;
		const dayOfLeg = key.startsWith("stay:")
			? key.split(":")[1]
			: fromItem?.dayId;
		if (dayOfLeg === dayId)
			out.push({
				key: `leg:${key}`,
				text: l.late.label || `Late ${l.late.minutes} min`,
				conflict: true,
			});
	}
	if (sd && sd.overCapacityMin > 0)
		out.push({
			key: "capacity",
			text: `Longer than your ${formatDuration(sd.capacityMin, { compact: true })} day by ${formatDuration(sd.overCapacityMin)}`,
			conflict: false,
		});
	return out;
}

function IssuesChip({ dayId }: { dayId: string }) {
	const { nav, schedule } = useWorkspace();
	const hours = useHoursIssues();
	const issues = useDayIssues(dayId);
	// The list being open travels with my view.
	const [open, setOpen] = useFollowToggle("plan.issues", dayId);
	const hoursOnly =
		issues.length > 0 && issues.every((i) => i.key.startsWith("hours:"));
	if (!issues.length) return null;
	// Hours alone: WP-Insights' own chip ("Itoya closed Wed" / "Hours · 3").
	if (hoursOnly && (hours.byDay[dayId]?.warn ?? 0) > 0)
		return <DayHoursBadge dayId={dayId} />;
	const conflict = issues.some((i) => i.conflict);
	const sd = schedule.days[dayId];
	const label =
		issues.length > 1
			? `${issues.length} issues`
			: issues[0]?.key === "capacity" && sd
				? `over ${formatDuration(sd.overCapacityMin, { compact: true })}`
				: sd && sd.conflicts === 1
					? "1 conflict"
					: "1 issue";
	return (
		<Popover open={open} onOpenChange={setOpen}>
			<PopoverTrigger asChild>
				<button
					type="button"
					data-testid={conflict ? TESTID.conflictBadge : PLAN_TESTID.dayIssues}
					data-issues={issues.length}
					onClick={(e) => e.stopPropagation()}
					className={cn(
						"inline-flex h-[22px] shrink-0 items-center gap-1 rounded-full border px-2 text-xs font-medium",
						conflict
							? "border-warning-hairline bg-warning-wash text-warning"
							: "border-border bg-muted text-muted-foreground",
					)}
				>
					{conflict ? (
						<TriangleAlert className="size-3" strokeWidth={1.75} aria-hidden />
					) : null}
					{label}
				</button>
			</PopoverTrigger>
			<PopoverContent
				align="end"
				className="w-80 p-2"
				onClick={(e) => e.stopPropagation()}
			>
				<ul className="grid">
					{issues.map((i) => (
						<li key={i.key}>
							<button
								type="button"
								disabled={!i.itemId}
								onClick={() =>
									i.itemId && nav.select({ kind: "item", id: i.itemId })
								}
								className="flex w-full items-start gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-accent disabled:hover:bg-transparent"
							>
								<TriangleAlert
									className={cn(
										"mt-0.5 size-3.5 shrink-0",
										i.conflict ? "text-warning" : "text-muted-foreground",
									)}
									strokeWidth={1.5}
									aria-hidden
								/>
								{i.text}
							</button>
						</li>
					))}
				</ul>
			</PopoverContent>
		</Popover>
	);
}

/** "09:00 ▾" → a TimeInput popover (15-minute steps or typed). */
function StartTime({ day }: { day: GraphDay }) {
	const actions = usePlanActions();
	const guard = useEditGuard();
	const [open, setOpen] = useState(false);
	const [value, setValue] = useState(day.startTime);
	return (
		<Popover
			open={open}
			onOpenChange={(v) => {
				if (v) setValue(day.startTime);
				setOpen(v);
			}}
		>
			<PopoverTrigger asChild>
				<button
					type="button"
					data-testid={PLAN_TESTID.dayStart}
					disabled={guard.disabled}
					title={guard.reason ?? "Day start"}
					onClick={(e) => e.stopPropagation()}
					className="inline-flex h-6 items-center gap-0.5 rounded-md px-1 font-mono text-xs text-foreground tnum hover:bg-accent disabled:cursor-default disabled:text-muted-foreground disabled:hover:bg-transparent"
				>
					{day.startTime}
					<ChevronDown
						className="size-3 text-muted-foreground"
						strokeWidth={1.5}
						aria-hidden
					/>
				</button>
			</PopoverTrigger>
			{open ? (
				<PopoverContent
					align="start"
					className="w-60 p-3"
					onClick={(e) => e.stopPropagation()}
				>
					<form
						className="grid gap-2"
						onSubmit={(e) => {
							e.preventDefault();
							if (!/^\d{2}:\d{2}$/.test(value)) return;
							actions.dayUpdate.mutate({
								dayId: day.id,
								startTime: value,
								expectedUpdatedAt: day.updatedAt,
							});
							setOpen(false);
						}}
					>
						<label
							className="text-xs text-muted-foreground"
							htmlFor={`start-${day.id}`}
						>
							The day starts at
						</label>
						<div className="flex gap-2">
							<TimeInput
								value={value}
								onChange={setValue}
								aria-label="Day start"
							/>
							<Button type="submit" size="sm">
								Set
							</Button>
						</div>
					</form>
				</PopoverContent>
			) : null}
		</Popover>
	);
}

/**
 * The night's stay chip; opens the stay picker (places only). The ⋯ menu's
 * "Set stay…" opens it directly (`open`), so a day without a stay shows the
 * chip only while the picker is open.
 */
export function StayPicker({
	day,
	open,
	onOpenChange,
}: {
	day: GraphDay;
	open?: boolean;
	onOpenChange?: (v: boolean) => void;
}) {
	const { ix } = useWorkspace();
	const actions = usePlanActions();
	const guard = useEditGuard();
	const stay = ix.node(day.nightNodeId);
	// The picker (every place in the trip) mounts on first open.
	const [armed, setArmed] = useState(false);
	const [innerOpen, setInnerOpen] = useState(false);
	const isOpen = open ?? innerOpen;
	// FB-24: others see "Dennis is editing a stay" on this day.
	useFormPresence(
		isOpen ? { k: "stay", m: "edit", t: `dayh:${day.id}` } : null,
	);
	const setOpen = (v: boolean) => {
		if (v) setArmed(true);
		if (open === undefined) setInnerOpen(v);
		onOpenChange?.(v);
	};
	const chip = (
		<button
			type="button"
			data-testid={PLAN_TESTID.dayStay}
			disabled={guard.disabled}
			title={guard.reason ?? `Night of ${formatDayDate(day.date)}`}
			onClick={(e) => {
				e.stopPropagation();
				if (!armed) setOpen(true);
			}}
			className="inline-flex h-6 min-w-0 items-center gap-1 rounded-md px-1 text-xs text-muted-foreground hover:bg-accent hover:text-foreground disabled:cursor-default disabled:hover:bg-transparent disabled:hover:text-muted-foreground"
		>
			<BedDouble
				className="size-3 shrink-0"
				strokeWidth={1.5}
				aria-label="Stay"
			/>
			<span className="truncate">{stay?.name ?? "No stay yet"}</span>
		</button>
	);
	if (!armed && !isOpen) return chip;
	return (
		<TreePicker
			value={day.nightNodeId}
			placeholder="Where do you sleep?"
			filter={(n) => n.type === "place" || n.id === day.nightNodeId}
			onChange={(nodeId) =>
				actions.dayStay.mutate({ fromDayId: day.id, nodeId })
			}
			open={isOpen}
			onOpenChange={setOpen}
			trigger={chip}
		/>
	);
}

/** The inline day title (`useDraftField`, so a peer's change never clobbers a draft). */
function DayTitle({
	day,
	editing,
	setEditing,
}: {
	day: GraphDay;
	editing: boolean;
	setEditing: (v: boolean) => void;
}) {
	const actions = usePlanActions();
	const field = useDraftField({
		value: day.title ?? "",
		updatedAt: day.updatedAt,
		flashId: day.id,
		save: (draft, expectedUpdatedAt) =>
			actions.dayUpdate.mutate({
				dayId: day.id,
				title: draft.trim() || null,
				expectedUpdatedAt,
			}),
	});
	if (!editing)
		return day.title ? (
			<span
				data-testid={PLAN_TESTID.dayTitle}
				className="truncate text-[13px] text-muted-foreground"
			>
				{day.title}
			</span>
		) : null;
	return (
		<Input
			autoFocus
			value={field.draft}
			onChange={(e) => field.setDraft(e.target.value)}
			onFocus={field.onFocus}
			onBlur={() => {
				field.onBlur();
				setEditing(false);
			}}
			onClick={(e) => e.stopPropagation()}
			onKeyDown={(e) => {
				if (e.key === "Enter") (e.target as HTMLInputElement).blur();
				if (e.key === "Escape") {
					field.setDraft(day.title ?? "");
					setEditing(false);
				}
				e.stopPropagation();
			}}
			placeholder="A title for the day"
			aria-label="Day title"
			maxLength={200}
			className="h-7 w-56 max-w-full text-[13px]"
		/>
	);
}

/** Is the day filter exactly this one day? */
function onlyThisDay(
	days: ReturnType<typeof useWorkspace>["days"],
	date: string,
): boolean {
	return days?.from === date && days.to === date;
}

/**
 * The explicit day filter (FB-08), a toggle: "Show only Sat 2 Oct", pressed
 * while only this day is shown (a click then shows all days). Shift-click
 * extends the range to this day (DESIGN §7.1's shift-click, moved off the
 * header). Where there is a hover it appears on hovering the header, and
 * stays while this day is in the range; touch tablets always show it. Phones
 * have the day chips instead (and the ⋯ menu's "Show only this day").
 */
function DayFilterButton({ day }: { day: GraphDay }) {
	const { days, nav } = useWorkspace();
	const only = onlyThisDay(days, day.date);
	const inRange = days !== null && day.date >= days.from && day.date <= days.to;
	const label = `Show only ${formatDayDate(day.date)}`;
	return (
		<Button
			variant="ghost"
			size="icon-xs"
			data-testid={PLAN_TESTID.dayFilter}
			aria-pressed={only}
			aria-label={label}
			title={
				only
					? "Showing only this day · click to show all days"
					: `${label} · shift-click to extend the range`
			}
			onClick={(e) => {
				if (e.shiftKey && days && !only) nav.extendDays(day.date);
				else nav.setDays(only ? null : { from: day.date, to: day.date });
			}}
			className={cn(
				"transition-opacity max-md:hidden",
				only
					? "bg-primary/10 text-primary hover:bg-primary/15 hover:text-primary"
					: "text-muted-foreground",
				!inRange &&
					"[@media(hover:hover)]:opacity-0 [@media(hover:hover)]:group-hover/day:opacity-100 [@media(hover:hover)]:focus-visible:opacity-100",
			)}
		>
			<ListFilter />
		</Button>
	);
}

function DayMenu({
	day,
	onRename,
	onStay,
	onDelete,
}: {
	day: GraphDay;
	onRename: () => void;
	onStay: () => void;
	onDelete: () => void;
}) {
	// The content (with its list of days) mounts on first open (QA PERF-05).
	const [armed, setArmed] = useState(false);
	const [open, setOpen] = useState(false);
	return (
		<DropdownMenu
			open={open}
			onOpenChange={(v) => {
				if (v) setArmed(true);
				setOpen(v);
			}}
		>
			<DropdownMenuTrigger asChild>
				<Button
					variant="ghost"
					size="icon-xs"
					aria-label={`More for ${formatDayDate(day.date)}`}
					data-testid={PLAN_TESTID.dayMenu}
					onClick={(e) => e.stopPropagation()}
					className="text-muted-foreground"
				>
					<EllipsisVertical />
				</Button>
			</DropdownMenuTrigger>
			{armed ? (
				<DayMenuContent
					day={day}
					onRename={onRename}
					onStay={onStay}
					onDelete={onDelete}
				/>
			) : null}
		</DropdownMenu>
	);
}

function DayMenuContent({
	day,
	onRename,
	onStay,
	onDelete,
}: {
	day: GraphDay;
	onRename: () => void;
	onStay: () => void;
	onDelete: () => void;
}) {
	const { ix, nav, graph, mode, days } = useWorkspace();
	const actions = usePlanActions();
	const guard = useEditGuard();
	const openAddExpense = useUi((s) => s.openAddExpense);
	const money = mode === "live" && can(graph.me, "manageExpenses");
	// An item that opens another surface (a popover, an input, the confirm
	// row) opens it once the menu has gone and keeps the focus there (FB-07).
	const { handOff, onCloseAutoFocus } = useMenuHandoff();
	return (
		<DropdownMenuContent
			onCloseAutoFocus={onCloseAutoFocus}
			align="end"
			className="w-56"
			onClick={(e) => e.stopPropagation()}
		>
			<DropdownMenuItem
				onSelect={() => nav.select({ kind: "day", id: day.id })}
			>
				Day notes &amp; lists
			</DropdownMenuItem>
			<DropdownMenuItem
				data-testid={PLAN_TESTID.dayMenuFilter}
				onSelect={() =>
					nav.setDays(
						onlyThisDay(days, day.date)
							? null
							: { from: day.date, to: day.date },
					)
				}
			>
				{onlyThisDay(days, day.date) ? "Show all days" : "Show only this day"}
			</DropdownMenuItem>
			<DropdownMenuItem disabled={guard.disabled} onSelect={handOff(onRename)}>
				{day.title ? "Rename day…" : "Add a title…"}
			</DropdownMenuItem>
			<DropdownMenuItem disabled={guard.disabled} onSelect={handOff(onStay)}>
				Set stay…
			</DropdownMenuItem>
			{money ? (
				<DropdownMenuItem
					onSelect={() =>
						openAddExpense({
							target: { kind: "day", dayId: day.id },
							title: `Day ${ix.dayNumber(day.id)}${day.title ? ` · ${day.title}` : ""}`,
						})
					}
				>
					<Wallet className="size-4" strokeWidth={1.5} /> Add expense
				</DropdownMenuItem>
			) : null}
			<DropdownMenuSeparator />
			<DropdownMenuItem
				disabled={guard.disabled}
				onSelect={() =>
					actions.dayInsert.mutate({ dayId: day.id, where: "before" })
				}
			>
				Insert day before
			</DropdownMenuItem>
			<DropdownMenuItem
				disabled={guard.disabled}
				onSelect={() =>
					actions.dayInsert.mutate({ dayId: day.id, where: "after" })
				}
			>
				Insert day after
			</DropdownMenuItem>
			<DropdownMenuSub>
				<DropdownMenuSubTrigger
					disabled={guard.disabled}
					className={DISABLED_SUB_TRIGGER}
				>
					Move day to…
				</DropdownMenuSubTrigger>
				<DropdownMenuSubContent className="max-h-72 overflow-y-auto">
					{ix.days.map((d) => (
						<DropdownMenuItem
							key={d.id}
							disabled={d.id === day.id}
							onSelect={() =>
								actions.dayMove.mutate({
									dayId: day.id,
									toDate: d.date,
									fromDate: day.date,
								})
							}
						>
							<span className="font-mono text-xs text-muted-foreground tnum">
								D{ix.dayNumber(d.id)}
							</span>
							{formatDayDate(d.date)}
						</DropdownMenuItem>
					))}
				</DropdownMenuSubContent>
			</DropdownMenuSub>
			<DropdownMenuSeparator />
			<DropdownMenuItem
				variant="destructive"
				disabled={guard.disabled}
				onSelect={handOff(onDelete)}
			>
				Delete day…
			</DropdownMenuItem>
		</DropdownMenuContent>
	);
}

/** "Its 6 items move to Unscheduled." Delete day · Cancel (inline, under the header). */
function DeleteConfirm({ day, onDone }: { day: GraphDay; onDone: () => void }) {
	const { ix } = useWorkspace();
	const actions = usePlanActions();
	const n = ix.itemsByDay.get(day.id)?.length ?? 0;
	return (
		<div
			data-testid={PLAN_TESTID.dayDeleteConfirm}
			className="flex flex-wrap items-center gap-2 border-b bg-muted/60 px-4 py-2 text-sm"
		>
			<span className="flex-1">
				Delete {formatDayDate(day.date)}?{" "}
				<span className="text-muted-foreground">
					{n
						? `Its ${n} ${n === 1 ? "item moves" : "items move"} to Unscheduled; later days move back one.`
						: "Later days move back one."}
				</span>
			</span>
			<Button
				size="sm"
				variant="destructive"
				onClick={() => {
					actions.dayDelete.mutate({ dayId: day.id });
					onDone();
				}}
			>
				Delete day
			</Button>
			<Button size="sm" variant="ghost" onClick={onDone}>
				Cancel
			</Button>
		</div>
	);
}

export function DayHeader({
	day,
	copy,
}: {
	day: GraphDay;
	/** Which drawing of a day drawn in several bands this is (FB-17 anchors). */
	copy?: string;
}) {
	const ws = useWorkspace();
	const { ix, schedule, sel, nav, days } = ws;
	const sd = schedule.days[day.id];
	const narrow = useMediaQuery("(max-width: 639px)");
	const [renaming, setRenaming] = useState(false);
	const [stayOpen, setStayOpen] = useState(false);
	const [confirmDelete, setConfirmDelete] = useState(false);
	const marks = useProposalMarks(`day:${day.id}`);
	const focused = sel?.kind === "day" && sel.id === day.id;
	const inRange = days !== null && day.date >= days.from && day.date <= days.to;
	const city = dayCity(ix, day.id);
	const zone = zoneLabel(ws, day.id);
	const hasItems = (ix.itemsByDay.get(day.id)?.length ?? 0) > 0;
	const estimate = (sd?.unsetLegs ?? 0) > 0;
	return (
		<>
			<header
				data-testid={PLAN_TESTID.dayHeader}
				data-day-id={day.id}
				data-cursor-anchor={copyAnchorId(`dayh:${day.id}`, copy)}
				data-in-range={inRange || undefined}
				className={cn(
					"group/day sticky top-0 z-20 border-b border-l-2 border-l-transparent bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/85",
					focused && "border-l-primary",
					marks.length > 0 && "border-b-dashed",
				)}
			>
				{/* QA A11Y-01: the header holds its own buttons (date, filter, start,
				    stay, issues, ⋯), so it is no role=button. FB-08: the empty
				    header is not clickable at all (the owner clicks there to
				    dismiss menus); the date selects the day. */}
				<div className="flex min-h-12 flex-col justify-center gap-0.5 px-4 py-1.5 has-[[data-day-main]:focus-visible]:ring-2 has-[[data-day-main]:focus-visible]:ring-ring has-[[data-day-main]:focus-visible]:ring-inset">
					<div className="flex min-w-0 items-center gap-x-2">
						<h3 className="shrink-0 font-display text-[19px] leading-6 font-semibold whitespace-nowrap">
							<button
								type="button"
								data-day-main=""
								aria-label={`${formatDayDate(day.date)}, Day ${ix.dayNumber(day.id)}${focused ? " (selected)" : ""}`}
								title="Show this day's overview"
								onClick={() => nav.select({ kind: "day", id: day.id })}
								className="cursor-pointer rounded-sm outline-none"
							>
								{formatDayDate(day.date)}
							</button>
						</h3>
						<span className="min-w-0 truncate text-[13px] text-muted-foreground">
							Day {ix.dayNumber(day.id)}
							{city ? ` · ${city}` : ""}
							{zone ? ` · ${zone}` : ""}
						</span>
						<span className="ml-auto flex shrink-0 items-center gap-1.5">
							<IssuesChip dayId={day.id} />
							<DayFilterButton day={day} />
							<DayMenu
								day={day}
								onRename={() => setRenaming(true)}
								onStay={() => setStayOpen(true)}
								onDelete={() => setConfirmDelete(true)}
							/>
						</span>
					</div>
					{day.title || renaming ? (
						<div className="flex min-w-0">
							<DayTitle day={day} editing={renaming} setEditing={setRenaming} />
						</div>
					) : null}
					<div className="flex min-w-0 flex-wrap items-center gap-x-2 text-xs text-muted-foreground">
						<StartTime day={day} />
						{day.nightNodeId || stayOpen ? (
							<StayPicker
								day={day}
								open={stayOpen}
								onOpenChange={setStayOpen}
							/>
						) : null}
						<DaySun dayId={day.id} compact={narrow} />
						{sd && hasItems ? (
							<span
								data-testid={PLAN_TESTID.daySummary}
								className="ml-auto min-w-0 truncate"
							>
								<Summary dayId={day.id} estimate={estimate} />
							</span>
						) : null}
					</div>
				</div>
			</header>
			{confirmDelete ? (
				<DeleteConfirm day={day} onDone={() => setConfirmDelete(false)} />
			) : null}
		</>
	);
}

/**
 * The header of a day outside the render window (`plan-window.ts`): the same
 * sticky frame, date, "Day 4 · Tokyo", start, stay and summary as text, with
 * none of the controls, so scrolling fast past it reads the same.
 */
export function DayHeaderLite({ day, copy }: { day: GraphDay; copy?: string }) {
	const ws = useWorkspace();
	const { ix, schedule, nav } = ws;
	const sd = schedule.days[day.id];
	const city = dayCity(ix, day.id);
	const stay = ix.node(day.nightNodeId);
	const hasItems = (ix.itemsByDay.get(day.id)?.length ?? 0) > 0;
	return (
		<header
			data-testid={PLAN_TESTID.dayHeader}
			data-day-id={day.id}
			data-cursor-anchor={copyAnchorId(`dayh:${day.id}`, copy)}
			data-lite=""
			className="sticky top-0 z-20 border-b border-l-2 border-l-transparent bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/85"
		>
			{/* biome-ignore lint/a11y/useSemanticElements: mirrors the full header */}
			<div
				role="button"
				tabIndex={0}
				aria-label={`${formatDayDate(day.date)}, Day ${ix.dayNumber(day.id)}`}
				// FB-08: like the full header's date, it selects the day; it never filters.
				onClick={() => nav.select({ kind: "day", id: day.id })}
				onKeyDown={(e) => {
					if (e.key === "Enter" || e.key === " ") {
						e.preventDefault();
						nav.select({ kind: "day", id: day.id });
					}
				}}
				className="flex min-h-12 cursor-pointer flex-col justify-center gap-0.5 px-4 py-1.5 outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
			>
				<div className="flex min-w-0 items-center gap-x-2">
					<h3 className="shrink-0 font-display text-[19px] leading-6 font-semibold whitespace-nowrap">
						{formatDayDate(day.date)}
					</h3>
					<span className="min-w-0 truncate text-[13px] text-muted-foreground">
						Day {ix.dayNumber(day.id)}
						{city ? ` · ${city}` : ""}
					</span>
				</div>
				{day.title ? (
					<span className="truncate text-[13px] text-muted-foreground">
						{day.title}
					</span>
				) : null}
				<div className="flex min-h-6 min-w-0 items-center gap-x-2 text-xs text-muted-foreground">
					<span className="px-1 font-mono text-foreground tnum">
						{day.startTime}
					</span>
					{stay ? (
						<span className="inline-flex min-w-0 items-center gap-1 px-1">
							<BedDouble
								className="size-3 shrink-0"
								strokeWidth={1.5}
								aria-hidden
							/>
							<span className="truncate">{stay.name}</span>
						</span>
					) : null}
					{sd && hasItems ? (
						<span className="ml-auto min-w-0 truncate">
							<Summary dayId={day.id} estimate={(sd.unsetLegs ?? 0) > 0} />
						</span>
					) : null}
				</div>
			</div>
		</header>
	);
}

/** "Activities 13h · Travel 1h20 · ends 23:35" (+ "· 11.3 km on foot · 3 rides" when wide). */
function Summary({ dayId, estimate }: { dayId: string; estimate: boolean }) {
	const { schedule, ix } = useWorkspace();
	const sd = schedule.days[dayId];
	if (!sd) return null;
	// ADDENDUM §7.2: the end in the local zone of the last stop (a day that
	// flies Hanoi → Taipei ends at 19:00 CST, not 18:00 ICT); a day that
	// leaves on a flight or night train ends with its arrival (QA VIS2-06).
	const end = dayEnd(ix, schedule, dayId);
	return (
		<>
			Activities{" "}
			<span className="font-mono tnum">
				{formatDuration(sd.activitiesMin, { compact: true })}
			</span>{" "}
			· Travel{" "}
			<span className="font-mono tnum">
				{estimate ? "~" : ""}
				{formatDuration(sd.travelMin, { compact: true })}
			</span>
			{estimate ? " est." : ""} · ends{" "}
			<span className="font-mono tnum">
				{formatTime(end?.at ?? sd.end, end?.tz ?? sd.tz)}
				{end && end.plusDays > 0 ? (
					<sup className="text-[9px]">+{end.plusDays}</sup>
				) : null}
			</span>
			{sd.walkKm >= 0.1 ? (
				<span className="hidden @2xl:inline">
					{" "}
					· <span className="font-mono tnum">{sd.walkKm.toFixed(1)}</span> km on
					foot
				</span>
			) : null}
			{sd.rides > 0 ? (
				<span className="hidden @2xl:inline">
					{" "}
					· <span className="font-mono tnum">{sd.rides}</span>{" "}
					{sd.rides === 1 ? "ride" : "rides"}
				</span>
			) : null}
		</>
	);
}
