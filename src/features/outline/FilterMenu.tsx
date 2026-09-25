/**
 * The shared place filter's controls (ADDENDUM §10 "Filters"): category group,
 * a minimum priority (by the max of all members or one member), "not rated
 * yet by" me or a member, and "not on the plan yet". One filter for the
 * Outline, Ideas and the map, kept in the URL (`?f=`), so each change is a
 * `replace` navigation and every view stays a deep link.
 *
 * `PlaceFilterButton` is the trigger + popover (the Outline header mounts it;
 * WP-Map can mount the same one over the map). `PlaceFilterSummary` is the
 * one quiet line under a header while a filter is on (fewer badges: no chip
 * per criterion).
 */
import { cn } from "cn";
import { Filter, X } from "lucide-react";
import { useId } from "react";
import { assignableMembers } from "@/components/common/member";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import {
	Popover,
	PopoverContent,
	PopoverTrigger,
} from "@/components/ui/popover";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectSeparator,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import {
	PIN_FAMILIES,
	PLACE_CATEGORIES,
	PLACE_GROUPS,
	type PlaceGroup,
	PRIORITIES,
	PRIORITY_ORDER,
} from "@/lib/domain/taxonomy";
import type { Priority } from "@/lib/engine/types";
import type { WorkspaceFilter } from "@/lib/workspace/filter";
import { describeFilter } from "@/lib/workspace/filter-match";
import { useWorkspace } from "@/lib/workspace/use-workspace";
import { keepEscape } from "./OutlineRows";
import { OUTLINE_TESTID } from "./testids";
import { usePlaceFilter } from "./use-place-filter";

/** The family colour of a group (its first category's family). */
const GROUP_HEX = Object.fromEntries(
	(Object.keys(PLACE_GROUPS) as PlaceGroup[]).map((g) => {
		const cat = Object.values(PLACE_CATEGORIES).find((c) => c.group === g);
		return [g, cat ? PIN_FAMILIES[cat.family].hex : "#808080"];
	}),
) as Record<PlaceGroup, string>;

const floorLabel = (p: Priority) =>
	p === "must"
		? "Must"
		: p === "nah"
			? "Any rating"
			: `${PRIORITIES[p].label} or higher`;

function Section({
	title,
	children,
	htmlFor,
}: {
	title: string;
	children: React.ReactNode;
	htmlFor?: string;
}) {
	return (
		<div className="grid gap-2">
			{htmlFor ? (
				<Label
					htmlFor={htmlFor}
					className="text-[11px] font-semibold tracking-[.06em] text-muted-foreground uppercase"
				>
					{title}
				</Label>
			) : (
				<div className="text-[11px] font-semibold tracking-[.06em] text-muted-foreground uppercase">
					{title}
				</div>
			)}
			{children}
		</div>
	);
}

export function PlaceFilterPanel() {
	const { graph, access } = useWorkspace();
	const { filter, active, setFilter, clear } = usePlaceFilter();
	const members = assignableMembers(graph.members);
	const me = access.memberId;
	const ids = {
		min: useId(),
		by: useId(),
		unrated: useId(),
		ns: useId(),
	};
	const patch = (p: Partial<WorkspaceFilter>) => setFilter({ ...filter, ...p });
	const toggleGroup = (g: PlaceGroup) =>
		patch({
			groups: filter.groups.includes(g)
				? filter.groups.filter((x) => x !== g)
				: [...filter.groups, g],
		});

	return (
		<div data-testid={OUTLINE_TESTID.filterPanel} className="grid gap-4">
			<div className="flex items-center justify-between">
				<span className="font-display text-[15px] font-medium">
					Filter places
				</span>
				<Button
					variant="link"
					size="xs"
					className="h-6 px-0"
					disabled={!active}
					onClick={clear}
					data-testid={OUTLINE_TESTID.filterClear}
				>
					Clear
				</Button>
			</div>

			<Section title="Category">
				<div className="flex flex-wrap gap-1.5">
					{(Object.keys(PLACE_GROUPS) as PlaceGroup[]).map((g) => {
						const on = filter.groups.includes(g);
						return (
							<button
								key={g}
								type="button"
								aria-pressed={on}
								data-testid={OUTLINE_TESTID.filterGroup}
								data-group={g}
								onClick={() => toggleGroup(g)}
								className={cn(
									"inline-flex h-7 items-center gap-1.5 rounded-full border px-2.5 text-xs transition-colors",
									"focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none",
									on
										? "border-primary/50 bg-primary/10 text-foreground"
										: "border-border text-muted-foreground hover:bg-accent hover:text-foreground",
								)}
							>
								<span
									aria-hidden
									className="size-1.5 rounded-full dark:ring-1 dark:ring-background"
									style={{ backgroundColor: GROUP_HEX[g] }}
								/>
								{PLACE_GROUPS[g]}
							</button>
						);
					})}
				</div>
			</Section>

			<Section title="Priority" htmlFor={ids.min}>
				<div className="grid gap-2">
					<Select
						value={filter.minPriority ?? "any"}
						onValueChange={(v) =>
							patch({
								minPriority: v === "any" ? null : (v as Priority),
								...(v === "any" ? { priorityOf: "max" } : {}),
							})
						}
					>
						<SelectTrigger
							id={ids.min}
							size="sm"
							className="w-full"
							data-testid={OUTLINE_TESTID.filterMinPriority}
						>
							<SelectValue />
						</SelectTrigger>
						<SelectContent onEscapeKeyDown={keepEscape}>
							<SelectItem value="any">Any priority</SelectItem>
							<SelectSeparator />
							{PRIORITY_ORDER.map((p) => (
								<SelectItem key={p} value={p}>
									{floorLabel(p)}
								</SelectItem>
							))}
						</SelectContent>
					</Select>
					{filter.minPriority ? (
						<div className="flex items-center gap-2">
							<Label
								htmlFor={ids.by}
								className="shrink-0 text-xs font-normal text-muted-foreground"
							>
								Rated by
							</Label>
							<Select
								value={filter.priorityOf}
								onValueChange={(v) => patch({ priorityOf: v })}
							>
								<SelectTrigger
									id={ids.by}
									size="sm"
									className="min-w-0 flex-1"
									data-testid={OUTLINE_TESTID.filterPriorityOf}
								>
									<SelectValue />
								</SelectTrigger>
								<SelectContent onEscapeKeyDown={keepEscape}>
									<SelectItem value="max">Anyone (highest rating)</SelectItem>
									<SelectSeparator />
									{members.map((m) => (
										<SelectItem key={m.id} value={m.id}>
											{m.id === me ? `${m.name} (me)` : m.name}
										</SelectItem>
									))}
								</SelectContent>
							</Select>
						</div>
					) : null}
				</div>
			</Section>

			<Section title="Not rated yet by" htmlFor={ids.unrated}>
				<Select
					value={filter.unratedBy ?? "none"}
					onValueChange={(v) => patch({ unratedBy: v === "none" ? null : v })}
				>
					<SelectTrigger
						id={ids.unrated}
						size="sm"
						className="w-full"
						data-testid={OUTLINE_TESTID.filterUnratedBy}
					>
						<SelectValue />
					</SelectTrigger>
					<SelectContent onEscapeKeyDown={keepEscape}>
						<SelectItem value="none">Anyone — don’t filter</SelectItem>
						<SelectSeparator />
						{me ? <SelectItem value="me">Me</SelectItem> : null}
						{members
							.filter((m) => m.id !== me)
							.map((m) => (
								<SelectItem key={m.id} value={m.id}>
									{m.name}
								</SelectItem>
							))}
					</SelectContent>
				</Select>
			</Section>

			<div className="flex items-center justify-between gap-3">
				<Label htmlFor={ids.ns} className="text-sm font-normal">
					Not on the plan yet
				</Label>
				<Switch
					id={ids.ns}
					checked={filter.notScheduled}
					onCheckedChange={(v) => patch({ notScheduled: v })}
					data-testid={OUTLINE_TESTID.filterNotScheduled}
				/>
			</div>
		</div>
	);
}

/** The funnel button + popover; a small primary dot while a filter is on. */
export function PlaceFilterButton({
	align = "start",
	className,
}: {
	align?: "start" | "center" | "end";
	className?: string;
}) {
	const { active } = usePlaceFilter();
	return (
		<Popover>
			<PopoverTrigger asChild>
				<Button
					variant="ghost"
					size="icon"
					className={cn("relative size-7", className)}
					aria-label={active ? "Filter places (on)" : "Filter places"}
					data-active={active || undefined}
					data-testid={OUTLINE_TESTID.filterButton}
				>
					<Filter className="size-4" strokeWidth={1.5} />
					{active ? (
						<span
							aria-hidden
							className="absolute top-1 right-1 size-1.5 rounded-full bg-primary"
						/>
					) : null}
				</Button>
			</PopoverTrigger>
			<PopoverContent
				align={align}
				className="w-[300px] max-w-[calc(100vw-24px)]"
				// Esc closes the popover only, not the workspace's Esc chain.
				onEscapeKeyDown={(e) => e.stopPropagation()}
			>
				<PlaceFilterPanel />
			</PopoverContent>
		</Popover>
	);
}

/** "Food/Drink · Want or higher — 12 places · ✕" while a filter is on. */
export function PlaceFilterSummary({
	count,
	noun = "places",
	className,
}: {
	count?: number;
	noun?: string;
	className?: string;
}) {
	const { graph, access } = useWorkspace();
	const { filter, active, clear } = usePlaceFilter();
	if (!active) return null;
	const text = describeFilter(filter, {
		meMemberId: access.memberId,
		members: graph.members,
	});
	return (
		<div
			data-testid={OUTLINE_TESTID.filterSummary}
			className={cn(
				"flex h-7 shrink-0 items-center gap-1.5 border-y border-primary/15 bg-primary/5 pr-1 pl-4 text-xs",
				className,
			)}
		>
			<Filter
				className="size-3 shrink-0 text-primary"
				strokeWidth={1.5}
				aria-hidden
			/>
			<span className="min-w-0 flex-1 truncate" title={text ?? undefined}>
				{text}
				{count !== undefined ? (
					<span className="text-muted-foreground">
						{" "}
						— <span className="font-mono tnum">{count}</span>{" "}
						{count === 1 ? noun.replace(/s$/, "") : noun}
					</span>
				) : null}
			</span>
			<Button
				variant="ghost"
				size="icon-xs"
				className="size-6 shrink-0"
				aria-label="Clear filter"
				onClick={clear}
			>
				<X className="size-3.5" />
			</Button>
		</div>
	);
}
