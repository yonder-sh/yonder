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
import { cn } from "cn";
import { ArrowDownLeft, ArrowUpRight, Wallet } from "lucide-react";
import { type ReactNode, useEffect, useId, useRef, useState } from "react";
import { EditGuard, useEditGuard } from "@/components/common/edit-guard";
import { TypeGlyph } from "@/components/common/glyphs";
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
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
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
import { LegMapsLink } from "@/features/transit/LegMapsLink";
import { can } from "@/lib/auth/roles";
import { pairKey } from "@/lib/engine/graph-index";
import { conflictFixes } from "@/lib/engine/suggest";
import { hhmm, tzLabel } from "@/lib/engine/time";
import { formatDayDate, formatDuration, formatTime } from "@/lib/format";
import { activityQuery } from "@/lib/query/trip-queries";
import { useFormPresence } from "@/lib/realtime/form-presence";
import { useSetEditing } from "@/lib/realtime/presence";
import type { LegTarget } from "@/lib/schemas/targets";
import { TESTID } from "@/lib/testids";
import { useUi } from "@/lib/workspace/ui-store";
import { useWorkspace } from "@/lib/workspace/use-workspace";
import {
	DURATION_PRESETS,
	focusAfterLeaving,
	focusWhenReady,
	isBooked,
} from "./ItemCard";
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
			<dd className={cn("min-w-0 text-[13px]", className)}>{children}</dd>
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
					<span className="font-mono text-xs text-muted-foreground tnum">
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

			<dl className="grid grid-cols-[88px_minmax(0,1fr)] items-start gap-x-3 gap-y-2.5">
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
						className="h-8"
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

				<Row label="When">
					{/* One shrinkable column: an auto column would grow to the select's
					    longest day label and push it past the panel's edge. */}
					<div className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-1.5">
						<span className="font-mono tnum">
							{day && s
								? `${formatDayDate(day.date)} · ${formatTime(s.start, s.tz)}–${formatTime(s.end, s.tz)}${s.endsNextDay ? "⁺¹" : ""} ${tzLabel(s.tz, s.start)}`
								: "Unscheduled — no times"}
						</span>
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
								className="w-full min-w-0 max-w-full"
								aria-label="Day"
							>
								<SelectValue>
									<DayValue dayId={item.dayId} />
								</SelectValue>
							</SelectTrigger>
							<SelectContent className="max-h-72">
								{ix.days.map((d) => (
									<SelectItem key={d.id} value={d.id}>
										<span className="font-mono text-xs text-muted-foreground tnum">
											D{ix.dayNumber(d.id)}
										</span>{" "}
										{formatDayDate(d.date)}
										{d.title ? ` · ${d.title}` : ""}
									</SelectItem>
								))}
								<SelectItem value={UNSCHEDULED}>Unscheduled</SelectItem>
							</SelectContent>
						</Select>
					</div>
				</Row>

				{item.dayId ? (
					<Row label="Start">
						<div
							className="flex flex-wrap items-center gap-2"
							data-testid={PLAN_TESTID.overviewPin}
						>
							<TimeInput
								value={pin}
								onChange={setPin}
								disabled={guard.disabled}
								aria-label="Pinned start"
							/>
							<Button
								size="sm"
								variant={item.pinnedStart === pin ? "secondary" : "outline"}
								disabled={
									guard.disabled ||
									!/^\d{2}:\d{2}$/.test(pin) ||
									item.pinnedStart === pin
								}
								onClick={() =>
									actions.update.mutate({
										itemId: item.id,
										patch: { pinnedStart: pin },
									})
								}
							>
								{item.pinnedStart
									? item.pinnedStart === pin
										? "◆ Pinned"
										: "Update pin"
									: "Pin"}
							</Button>
							{item.pinnedStart ? (
								<Button
									size="sm"
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
							) : (
								<span className="text-xs text-muted-foreground">
									Flows from the previous stop
								</span>
							)}
						</div>
					</Row>
				) : null}

				<Row label="Duration">
					<div className="flex items-center gap-2">
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
						/>
						<HoursChip itemId={item.id} />
					</div>
				</Row>

				{item.dayId ? (
					<Row label="Booked">
						<div className="flex items-center gap-2 pt-1 text-[13px]">
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
									actions.update.mutate({ itemId: item.id, patch: { nodeId } })
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

				{inLeg || outLeg ? (
					<Row label="Travel">
						<div className="grid gap-1">
							{inLeg && prev ? (
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
										<span className={TRAVEL_END}>
											from {itemName(ix, prev)}
										</span>
									</span>
								</TravelRow>
							) : null}
							{outLeg && next ? (
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
							) : null}
						</div>
					</Row>
				) : null}
			</dl>

			<section className="grid gap-1.5" data-testid={PLAN_TESTID.overviewNote}>
				<h3 className="text-[11px] font-semibold tracking-[.06em] text-muted-foreground uppercase">
					Note
				</h3>
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
						className="min-h-9 rounded-md border border-transparent px-2 py-1.5 text-left text-[13px] hover:border-border disabled:cursor-default"
					>
						{item.note ? (
							<MarkdownText md={item.note} />
						) : (
							<span className="text-muted-foreground">Add a note…</span>
						)}
					</button>
				)}
			</section>

			<div className="flex flex-wrap items-center gap-2 border-t pt-3">
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
				{item.dayId ? (
					<EditGuard>
						<Button
							size="sm"
							variant="ghost"
							data-testid={PLAN_TESTID.overviewUnschedule}
							onClick={() => actions.unschedule(item.id)}
						>
							Unschedule
						</Button>
					</EditGuard>
				) : null}
				<EditGuard>
					<Button
						size="sm"
						variant="ghost"
						data-testid={PLAN_TESTID.overviewDelete}
						className="ml-auto text-destructive hover:text-destructive"
						onClick={() => {
							// QA A11Y-02: the focus goes to the next card, not <body>.
							const find = focusAfterLeaving(item.id);
							actions.deleteItem(item.id);
							nav.select(null);
							focusWhenReady(find);
						}}
					>
						Delete
					</Button>
				</EditGuard>
			</div>
		</div>
	);
}
