/**
 * The inspector Overview of an item (SPEC §12.5 `ItemOverview({ itemId })`,
 * DESIGN §4.4): title, when (day, times, zone), pinned start, duration,
 * "Booked for this date", place, who (assignees; typing a new name adds a
 * placeholder person, ADDENDUM §8), travel in and out, the note (Markdown
 * with mentions), Add expense, Unschedule / Move to day and Delete.
 * Every control goes through `useEditGuard`; viewers see the same layout,
 * disabled, with the reason.
 */
import { useQuery } from "@tanstack/react-query";
import {
	ArrowDownLeft,
	ArrowUpRight,
	CalendarDays,
	Timer,
	Wallet,
} from "lucide-react";
import { type ReactNode, useEffect, useId, useRef, useState } from "react";
import { EditGuard, useEditGuard } from "@/components/common/edit-guard";
import { CategoryIcon, TypeGlyph } from "@/components/common/glyphs";
import { LegSummary } from "@/components/common/leg-summary";
import { MarkdownText } from "@/components/common/markdown-text";
import {
	MemberAvatar,
	MemberName,
	MemberPicker,
} from "@/components/common/member";
import { DurationInput, TimeInput } from "@/components/common/time";
import { TreePicker } from "@/components/common/tree-picker";
import { useDraftField } from "@/components/common/use-draft-field";
import { Eyebrow, RatingPill } from "@/components/kit";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
	Popover,
	PopoverContent,
	PopoverTrigger,
} from "@/components/ui/popover";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { HoursChip } from "@/features/insights/HoursChip";
import { MentionInput } from "@/features/notes/MentionInput";
import { HoursSummary, hasHours } from "@/features/places/ui/place-facts";
import { LegMapsLink } from "@/features/transit/LegMapsLink";
import { can } from "@/lib/auth/roles";
import { PLACE_CATEGORIES } from "@/lib/domain/taxonomy";
import { pairKey } from "@/lib/engine/graph-index";
import { conflictFixes } from "@/lib/engine/suggest";
import { hhmm, tzLabel } from "@/lib/engine/time";
import {
	formatDayDate,
	formatDayShort,
	formatDuration,
	formatTime,
} from "@/lib/format";
import { activityQuery } from "@/lib/query/trip-queries";
import { useFormPresence } from "@/lib/realtime/form-presence";
import { useSetEditing } from "@/lib/realtime/presence";
import type { LegTarget } from "@/lib/schemas/targets";
import { TESTID } from "@/lib/testids";
import { cn } from "@/lib/utils";
import { ratingOf } from "@/lib/workspace/filter-match";
import { useUi } from "@/lib/workspace/ui-store";
import { useWorkspace } from "@/lib/workspace/use-workspace";
import { cardTone } from "./card-tone";
import { DURATION_PRESETS, ItemMenu, isBooked } from "./ItemCard";
import { PLAN_TESTID } from "./testids";
import {
	itemName,
	PlanActionsProvider,
	usePlanActions,
} from "./use-plan-actions";

function Row({
	label,
	children,
	className,
}: {
	label: string;
	children: ReactNode;
	className?: string;
}) {
	return (
		<>
			<dt className="pt-1.5 text-xs text-muted-foreground">{label}</dt>
			<dd className={cn("min-w-0 text-meta", className)}>{children}</dd>
		</>
	);
}

const UNSCHEDULED = "__unscheduled";

/**
 * A Travel line: the arrow, then the leg and "to Gotokuji Temple" in a
 * wrapping column, so a long route moves the destination to its own line
 * instead of painting over it (QA PLAN-R2-09).
 */
const TRAVEL_ROW =
	"grid min-w-0 grid-cols-[auto_minmax(0,1fr)] items-start gap-x-1.5 text-left hover:text-primary";
const TRAVEL_LINE = "flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-0.5";
const TRAVEL_END = "min-w-0 max-w-full truncate text-xs text-muted-foreground";

/**
 * A leg in one line; "Overnight" across a night with no travel. In the
 * narrow inspector a route with three line chips wraps (QA PLAN-R2-09): its
 * parts join the Travel line's own wrapping row (`contents`), so each chip,
 * the minutes and the distance stay whole and move to the next line rather
 * than being squeezed under the destination.
 */
function TravelSummary({ legKey }: { legKey: string }) {
	const { ix, schedule } = useWorkspace();
	const s = schedule.legs[legKey];
	if (s?.kind === "overnight")
		return (
			<span className="text-xs text-muted-foreground italic">Overnight</span>
		);
	return (
		<LegSummary
			leg={ix.legByPair.get(legKey) ?? null}
			schedule={s ?? null}
			className="contents [&>*]:whitespace-nowrap"
		/>
	);
}

/**
 * A Travel row: the leg (a click opens it) and, for every non-flight leg
 * with two located ends, "Google Maps ↗" in the leg's own travel mode
 * (ADDENDUM §5, FB-03; QA GMAPS2). The link sits beside the row's button,
 * never inside it.
 */
function TravelRow({
	target,
	children,
}: {
	target: Extract<LegTarget, { kind: "pair" }>;
	children: ReactNode;
}) {
	const { nav } = useWorkspace();
	return (
		<div className="flex min-w-0 items-start gap-2">
			<button
				type="button"
				className={cn(TRAVEL_ROW, "flex-1")}
				onClick={() => nav.select({ kind: "leg", target })}
			>
				{children}
			</button>
			<LegMapsLink target={target} compact className="mt-px" />
		</div>
	);
}

/**
 * The Day select's closed value: "D6 Thu 7 Oct · Mt. Fuji · Shinjuku →
 * Kawaguchiko", cut with an ellipsis at the panel's edge (QA COLLAB-R2-11).
 */
function DayValue({ dayId }: { dayId: string | null }) {
	const { ix } = useWorkspace();
	const d = ix.day(dayId);
	return (
		<span className="block min-w-0 truncate text-left">
			{d ? (
				<>
					<span className="text-xs text-muted-foreground tnum">
						D{ix.dayNumber(d.id)}
					</span>{" "}
					{formatDayDate(d.date)}
					{d.title ? ` · ${d.title}` : ""}
				</>
			) : (
				"Unscheduled"
			)}
		</span>
	);
}

/**
 * The details header's ⋯ for a stop (One Yonder D03): the card's own menu
 * (move, pin, expense, unschedule, delete). "Pin start time…" opens the
 * overview's "Set a time".
 */
export function ItemDetailsMenu({ itemId }: { itemId: string }) {
	const { ix } = useWorkspace();
	const item = ix.item(itemId);
	if (!item) return null;
	return (
		<PlanActionsProvider>
			<ItemMenu
				item={item}
				onPin={() =>
					document
						.querySelector<HTMLElement>(
							`[data-testid="${PLAN_TESTID.overviewPin}"] button:last-of-type`,
						)
						?.click()
				}
				className="-mt-0.5"
			/>
		</PlanActionsProvider>
	);
}

/** A stop's icon in its family colour (as its card and pin) and "Food & Drink · Shinjuku, Tokyo". */
export function ItemHeadline({
	itemId,
	children,
}: {
	itemId: string;
	/** The title and its chips. */
	children: ReactNode;
}) {
	const { ix, schedule } = useWorkspace();
	const item = ix.item(itemId);
	const node = ix.node(item?.nodeId);
	const day = ix.day(item?.dayId);
	const s = schedule.items[itemId];
	// The group's best rating, as the ideas show it.
	const top = node ? ratingOf(node, "max") : null;
	const cat =
		node?.type === "place" && node.category
			? PLACE_CATEGORIES[node.category].label
			: null;
	const up = node
		? ix
				.path(node.id)
				.slice(0, -1)
				.reverse()
				.slice(0, 2)
				.map((n) => n.name)
		: [];
	const line = [cat, up.join(", ")].filter(Boolean).join(" · ");
	return (
		<div
			className="plan-card flex min-w-0 items-start gap-3"
			data-family={cardTone(node)}
		>
			<span
				aria-hidden
				className="plan-icon mt-0.5 flex size-10 shrink-0 items-center justify-center rounded-full"
			>
				{node?.type === "place" && node.category ? (
					<CategoryIcon category={node.category} className="size-5" />
				) : node ? (
					<TypeGlyph
						type={node.type}
						tinted={false}
						className="size-5 text-current"
					/>
				) : (
					<Timer className="size-5" strokeWidth={1.5} />
				)}
			</span>
			<div className="min-w-0 flex-1">
				{children}
				{line ? (
					<p className="mt-0.5 truncate text-meta text-muted-foreground">
						{line}
					</p>
				) : null}
				{/* D03's chips: when, the group's rating, who. */}
				<div
					className="mt-2 flex flex-wrap items-center gap-1.5"
					data-testid={PLAN_TESTID.overviewChips}
				>
					<span className="inline-flex h-6 items-center gap-1 rounded-full bg-muted px-2 text-xs font-medium tnum">
						<CalendarDays className="size-3.5 text-muted-foreground" />
						{day
							? `${formatDayShort(day.date)}${s ? ` · ${hhmm(s.start, s.tz)}` : ""}`
							: "Not on a day"}
					</span>
					{top ? <RatingPill level={top} size="sm" /> : null}
					{item?.assigneeIds.length ? (
						<span className="inline-flex items-center -space-x-1">
							{item.assigneeIds.map((id) => (
								<MemberAvatar key={id} memberId={id} size={20} />
							))}
						</span>
					) : null}
				</div>
			</div>
		</div>
	);
}

/**
 * QA RT-06: the selected item was deleted (by someone else, or in another
 * tab). Say who did it, from the activity log, and offer the way out.
 */
function DeletedItem({ itemId }: { itemId: string }) {
	const { graph, mode, nav } = useWorkspace();
	const q = useQuery({
		...activityQuery(graph.trip.id, { itemId }),
		enabled: mode === "live",
	});
	const del = q.data?.find((a) => a.summary.startsWith("deleted "));
	return (
		<div
			data-testid={PLAN_TESTID.overviewDeleted}
			className="grid justify-items-start gap-3 text-sm"
		>
			<p className="text-muted-foreground">
				{del ? (
					<>
						This item was deleted by{" "}
						<span className="font-medium text-foreground">{del.actorName}</span>
						{del.summary.length > "deleted ".length ? (
							<> ({del.summary.slice("deleted ".length)})</>
						) : null}
						.
					</>
				) : (
					"This item was deleted."
				)}
			</p>
			<Button size="sm" variant="outline" onClick={() => nav.select(null)}>
				Close
			</Button>
		</div>
	);
}

export function ItemOverview({ itemId }: { itemId: string }) {
	return (
		<PlanActionsProvider>
			<ItemOverviewBody itemId={itemId} />
		</PlanActionsProvider>
	);
}

function ItemOverviewBody({ itemId }: { itemId: string }) {
	const { ix, schedule, nav, graph, mode } = useWorkspace();
	const actions = usePlanActions();
	const guard = useEditGuard();
	const setEditing = useSetEditing();
	const openAddExpense = useUi((s) => s.openAddExpense);
	const item = ix.item(itemId);
	const s = item ? schedule.items[item.id] : undefined;
	const [pin, setPin] = useState(item?.pinnedStart ?? "");
	// FB-24: while I'm in one of its fields, others see "Dennis is editing
	// Shibuya Sky · Title" on the card and in its inspector.
	const rootRef = useRef<HTMLDivElement>(null);
	useFormPresence(
		item ? { k: "item", m: "edit", t: `item:${item.id}` } : null,
		rootRef,
		{ whileFocused: true },
	);
	useEffect(
		() => setPin(item?.pinnedStart ?? (s ? hhmm(s.start, s.tz) : "")),
		[item?.pinnedStart, s],
	);

	const title = useDraftField({
		value: item?.title ?? "",
		updatedAt: item?.updatedAt ?? "",
		flashId: itemId,
		save: (draft, expectedUpdatedAt) =>
			actions.update.mutate({
				itemId,
				patch: { title: draft.trim() || null },
				expectedUpdatedAt,
			}),
	});
	const note = useDraftField({
		value: item?.note ?? "",
		updatedAt: item?.updatedAt ?? "",
		flashId: itemId,
		save: (draft, expectedUpdatedAt) =>
			actions.update.mutate({
				itemId,
				patch: { note: draft.trim() ? draft : null },
				expectedUpdatedAt,
			}),
	});
	const [editingNote, setEditingNote] = useState(false);
	const bookedId = useId();

	if (!item) return <DeletedItem itemId={itemId} />;

	const day = ix.day(item.dayId);
	const node = ix.node(item.nodeId);
	const prev = item.nodeId ? ix.prevLocated(item.id) : null;
	const next = item.nodeId ? ix.nextLocated(item.id) : null;
	const inLeg =
		prev && prev.nodeId !== item.nodeId ? pairKey(prev.id, item.id) : null;
	const outLeg =
		next && next.nodeId !== item.nodeId ? pairKey(item.id, next.id) : null;
	const money = mode === "live" && can(graph.me, "manageExpenses");
	const fixes = s?.late
		? conflictFixes(ix, schedule, { kind: "item", itemId: item.id })
		: [];
	const booked = isBooked(item);

	return (
		<div
			ref={rootRef}
			data-testid={TESTID.itemOverview}
			className="grid gap-4 text-sm"
		>
			{s?.late ? (
				<div className="rounded-lg border border-warning-hairline bg-warning-wash px-3 py-2 text-xs">
					<p
						className="font-semibold text-warning"
						data-testid={TESTID.conflictBadge}
					>
						Starts {formatDuration(s.late.minutes)} late — pinned at{" "}
						{item.pinnedStart}.
					</p>
					{fixes.length ? (
						<div className="mt-2 flex flex-wrap gap-1.5">
							{fixes.map((f) => (
								<Button
									key={`${f.kind}:${"itemId" in f ? f.itemId : f.legId}`}
									size="xs"
									variant="outline"
									disabled={guard.disabled}
									onClick={() =>
										f.kind === "shorten"
											? actions.update.mutate({
													itemId: f.itemId,
													patch: { durationMin: f.durationMin },
												})
											: f.kind === "unpin"
												? actions.update.mutate({
														itemId: f.itemId,
														patch: { pinnedStart: null },
													})
												: undefined
									}
								>
									{f.kind === "shorten"
										? `Shorten ${itemName(ix, ix.item(f.itemId))} to ${formatDuration(f.durationMin, { compact: true })}`
										: f.kind === "unpin"
											? `Unpin ${item.pinnedStart}`
											: "Use fastest"}
								</Button>
							))}
						</div>
					) : null}
				</div>
			) : null}

			{/* One Yonder (D03): read first; each fact is one click to change. */}
			<section className="grid gap-2" data-section="when">
				<Eyebrow as="h3">When & travel</Eyebrow>
				<dl className="grid grid-cols-[88px_minmax(0,1fr)] items-start gap-x-3 gap-y-2.5">
					{/* A block of time (or a stop with its own name) keeps its title here;
					    a place's is the place's own. */}
					{!node || item.title ? (
						<Row label="Title">
							<Input
								data-testid={PLAN_TESTID.overviewTitle}
								value={title.draft}
								placeholder={node?.name ?? "Untitled"}
								disabled={guard.disabled}
								title={guard.reason ?? undefined}
								maxLength={200}
								onChange={(e) => title.setDraft(e.target.value)}
								onFocus={() => {
									title.onFocus();
									setEditing({ kind: "item", id: item.id, field: "title" });
								}}
								onBlur={() => {
									title.onBlur();
									setEditing(null);
								}}
								onKeyDown={(e) =>
									e.key === "Enter" && (e.target as HTMLInputElement).blur()
								}
							/>
							{title.remoteChanged ? (
								<p className="mt-1 text-xs text-muted-foreground">
									{title.remoteChanged.name} changed this ·{" "}
									<button
										type="button"
										className="text-primary hover:underline"
										onClick={title.useTheirs}
									>
										Use theirs
									</button>
								</p>
							) : null}
						</Row>
					) : null}

					<Row label="When">
						<span className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-1 pt-1">
							<span className="tnum">
								{day && s
									? `${formatDayDate(day.date)} · ${formatTime(s.start, s.tz)}–${formatTime(s.end, s.tz)}${s.endsNextDay ? "⁺¹" : ""} ${tzLabel(s.tz, s.start)}`
									: "Unscheduled"}
							</span>
							<span aria-hidden className="text-muted-foreground">
								·
							</span>
							<DurationInput
								value={item.durationMin}
								presets={DURATION_PRESETS}
								disabled={guard.disabled}
								onChange={(m) =>
									actions.update.mutate({
										itemId: item.id,
										patch: { durationMin: m },
									})
								}
								className="-mx-1 h-5 rounded-md border-0 bg-transparent px-1 text-meta font-normal shadow-none hover:bg-accent dark:bg-transparent"
							/>
							<HoursChip itemId={item.id} />
						</span>
					</Row>

					{item.dayId ? (
						<Row label="Start">
							<div
								className="flex flex-wrap items-center gap-2"
								data-testid={PLAN_TESTID.overviewPin}
							>
								{item.pinnedStart ? (
									<>
										<span className="tnum">
											<span className="text-primary" aria-hidden>
												◆
											</span>{" "}
											Pinned at {item.pinnedStart}
										</span>
										<Button
											size="xs"
											variant="ghost"
											disabled={guard.disabled}
											onClick={() =>
												actions.update.mutate({
													itemId: item.id,
													patch: { pinnedStart: null },
												})
											}
										>
											Unpin
										</Button>
									</>
								) : (
									<span className="text-muted-foreground">
										Flows from the stop before
									</span>
								)}
								<Popover>
									<PopoverTrigger asChild>
										<Button
											size="xs"
											variant="outline"
											className="ml-auto"
											disabled={guard.disabled}
										>
											{item.pinnedStart ? "Change" : "Set a time"}
										</Button>
									</PopoverTrigger>
									<PopoverContent align="end" className="w-60 p-3">
										<form
											className="flex gap-2"
											onSubmit={(e) => {
												e.preventDefault();
												if (!/^\d{2}:\d{2}$/.test(pin)) return;
												actions.update.mutate({
													itemId: item.id,
													patch: { pinnedStart: pin },
												});
											}}
										>
											<TimeInput
												value={pin}
												onChange={setPin}
												aria-label="Pinned start"
											/>
											<Button
												type="submit"
												size="sm"
												disabled={!/^\d{2}:\d{2}$/.test(pin)}
											>
												Pin
											</Button>
										</form>
									</PopoverContent>
								</Popover>
							</div>
						</Row>
					) : null}

					{inLeg && prev ? (
						<Row label="Before">
							<TravelRow
								target={{
									kind: "pair",
									fromItemId: prev.id,
									toItemId: item.id,
								}}
							>
								<ArrowDownLeft
									className="mt-0.5 size-3.5 shrink-0 text-muted-foreground"
									strokeWidth={1.5}
									aria-label="In"
								/>
								<span className={TRAVEL_LINE}>
									<TravelSummary legKey={inLeg} />
									<span className={TRAVEL_END}>from {itemName(ix, prev)}</span>
								</span>
							</TravelRow>
						</Row>
					) : null}
					{outLeg && next ? (
						<Row label="After">
							<TravelRow
								target={{
									kind: "pair",
									fromItemId: item.id,
									toItemId: next.id,
								}}
							>
								<ArrowUpRight
									className="mt-0.5 size-3.5 shrink-0 text-muted-foreground"
									strokeWidth={1.5}
									aria-label="Out"
								/>
								<span className={TRAVEL_LINE}>
									<TravelSummary legKey={outLeg} />
									<span className={TRAVEL_END}>to {itemName(ix, next)}</span>
								</span>
							</TravelRow>
						</Row>
					) : null}

					{item.dayId ? (
						<Row label="Booked">
							<div className="flex items-center gap-2 pt-1 text-meta">
								<Switch
									id={bookedId}
									data-testid={PLAN_TESTID.overviewBooked}
									checked={booked}
									disabled={guard.disabled}
									onCheckedChange={(v) =>
										actions.update.mutate({
											itemId: item.id,
											patch: { fixedDate: v },
										})
									}
								/>
								<label htmlFor={bookedId} className="text-muted-foreground">
									Booked for this date
								</label>
							</div>
						</Row>
					) : null}

					<Row label="Who">
						<div
							className="flex min-w-0 flex-wrap items-center gap-1.5"
							data-testid={PLAN_TESTID.overviewAssignees}
						>
							{item.assigneeIds.length ? (
								item.assigneeIds.map((id) => (
									<span
										key={id}
										className="inline-flex items-center gap-1 rounded-full bg-muted py-0.5 pr-2 pl-0.5 text-xs"
									>
										<MemberAvatar memberId={id} size={16} ring={false} />
										<MemberName memberId={id} />
									</span>
								))
							) : (
								<span className="text-muted-foreground">Everyone</span>
							)}
							<MemberPicker
								value={item.assigneeIds}
								disabled={guard.disabled}
								onChange={(memberIds) =>
									actions.assign.mutate({ itemId: item.id, memberIds })
								}
								trigger={
									<Button
										size="xs"
										variant="ghost"
										className="text-muted-foreground"
										disabled={guard.disabled}
									>
										{item.assigneeIds.length ? "Edit" : "Assign"}
									</Button>
								}
							/>
						</div>
					</Row>

					<Row label="Place">
						<div className="flex min-w-0 items-center gap-2">
							{node ? (
								<button
									type="button"
									className="flex min-w-0 items-center gap-1.5 text-primary hover:underline"
									onClick={() => nav.select({ kind: "node", id: node.id })}
								>
									<TypeGlyph type={node.type} category={node.category} />
									<span className="truncate">{node.name}</span>
								</button>
							) : (
								<span className="text-muted-foreground">
									No place — a block of time
								</span>
							)}
							<EditGuard>
								<TreePicker
									value={item.nodeId}
									onChange={(nodeId) =>
										actions.update.mutate({
											itemId: item.id,
											patch: { nodeId },
										})
									}
									filter={(n) => n.status === "active"}
									trigger={
										<Button
											size="xs"
											variant="ghost"
											className="ml-auto shrink-0 text-muted-foreground"
											disabled={guard.disabled}
										>
											{node ? "Change" : "Link a place"}
										</Button>
									}
								/>
							</EditGuard>
						</div>
					</Row>
				</dl>
				<div className="flex min-w-0 flex-wrap items-center gap-2 pt-1">
					<Select
						value={item.dayId ?? UNSCHEDULED}
						disabled={guard.disabled}
						onValueChange={(v) =>
							v === UNSCHEDULED
								? actions.unschedule(item.id)
								: actions.moveToDay(item.id, v)
						}
					>
						<SelectTrigger
							data-testid={PLAN_TESTID.overviewDay}
							size="sm"
							className="w-auto max-w-full min-w-0"
							aria-label="Day"
						>
							<CalendarDays className="size-4 text-muted-foreground" />
							<SelectValue>
								{item.dayId ? "Change day" : <DayValue dayId={item.dayId} />}
							</SelectValue>
						</SelectTrigger>
						<SelectContent className="max-h-72">
							{ix.days.map((d) => (
								<SelectItem key={d.id} value={d.id}>
									<span className="text-xs text-muted-foreground tnum">
										D{ix.dayNumber(d.id)}
									</span>{" "}
									{formatDayDate(d.date)}
									{d.title ? ` · ${d.title}` : ""}
								</SelectItem>
							))}
							<SelectItem value={UNSCHEDULED}>Unscheduled</SelectItem>
						</SelectContent>
					</Select>
					{money ? (
						<Button
							size="sm"
							variant="outline"
							onClick={() =>
								openAddExpense({
									target: { kind: "item", itemId: item.id },
									title: itemName(ix, item),
								})
							}
						>
							<Wallet className="size-4" strokeWidth={1.5} /> Add expense
						</Button>
					) : null}
				</div>
			</section>

			{node &&
			(node.description || node.timeNeededMin || hasHours(node, ix)) ? (
				<section
					className="grid gap-2"
					data-section="about"
					data-testid={PLAN_TESTID.overviewAbout}
				>
					<Eyebrow as="h3">About</Eyebrow>
					{node.description ? (
						<p className="text-meta text-foreground/90">{node.description}</p>
					) : null}
					<dl className="grid grid-cols-[88px_minmax(0,1fr)] items-start gap-x-3 gap-y-2">
						{hasHours(node, ix) ? (
							<Row label="Hours">
								<HoursSummary node={node} ix={ix} className="pt-1" />
							</Row>
						) : null}
						{node.timeNeededMin ? (
							<Row label="Takes" className="pt-1 tnum">
								{formatDuration(node.timeNeededMin)}
							</Row>
						) : null}
					</dl>
				</section>
			) : null}

			<section className="grid gap-1.5" data-testid={PLAN_TESTID.overviewNote}>
				<Eyebrow as="h3">Note</Eyebrow>
				{editingNote ? (
					<MentionInput
						multiline
						value={note.draft}
						placeholder="Pens on the 3rd floor; tax refund with passport…"
						disabled={guard.disabled}
						onChange={note.setDraft}
						onFocus={() => {
							note.onFocus();
							setEditing({ kind: "item", id: item.id, field: "note" });
						}}
						onBlur={() => {
							note.onBlur();
							setEditing(null);
							setEditingNote(false);
						}}
					/>
				) : (
					<button
						type="button"
						disabled={guard.disabled && !item.note}
						onClick={() => !guard.disabled && setEditingNote(true)}
						title={guard.reason ?? undefined}
						className="min-h-9 rounded-md border border-transparent px-2 py-1.5 text-left text-meta hover:border-border disabled:cursor-default"
					>
						{item.note ? (
							<MarkdownText md={item.note} />
						) : (
							<span className="text-muted-foreground">Add a note…</span>
						)}
					</button>
				)}
			</section>
		</div>
	);
}
