/**
 * The Plan (SPEC §12.5 `PlanTab()`, DESIGN §7.1): the timeline of the current
 * scope, lens, day range and person filter.
 *
 * - Place lens: day sections with cards, legs, stays, flights, gaps, folds
 *   and ghosts. Area lens: the same, grouped under area blocks. City, region
 *   and country lenses: visit bands linked by their transitions, each opening
 *   to its days.
 * - A header row with the person filter ("Everyone · Me · Maya ▾") and, with
 *   a day range, "Showing 5–7 Oct · Show all".
 * - How long in each city (`day-split/`): the whole panel above the days
 *   while no day has a city (with no dates too), else one line with Change
 *   in the header row.
 * - Drag and drop inside the workspace's one `WorkspaceDnd`: cards sort within
 *   a day, move across days and to/from Unscheduled; places dropped from the
 *   Outline or Ideas are scheduled at the drop point. Flight blocks move only
 *   within their day ("Flights move with their times — edit the flight").
 */
import "./plan.css";
import { useDndContext } from "@dnd-kit/core";
import { useQuery } from "@tanstack/react-query";
import { ChevronsDownUp, ChevronsUpDown } from "lucide-react";
import {
	type ReactNode,
	useCallback,
	useEffect,
	useLayoutEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import { toast } from "sonner";
import { useDnd } from "@/components/common/dnd/workspace-dnd";
import { EmptyState } from "@/components/common/empty-state";
import { CategoryIcon } from "@/components/common/glyphs";
import { resolveMember } from "@/components/common/member";
import { Chip } from "@/components/kit";
import { Button } from "@/components/ui/button";
import { useMoneyCounts } from "@/features/money/use-money-counts";
import { IdeasBin } from "@/features/outline/IdeasBin";
import { TabPurpose } from "@/features/shell/TabPurpose";
import type { GraphIndex } from "@/lib/engine/graph-index";
import { indexGraph } from "@/lib/engine/graph-index";
import type { DayRange } from "@/lib/engine/types";
import { formatDateRange, formatDuration, formatTime } from "@/lib/format";
import { userPrefsQuery } from "@/lib/query/trip-queries";
import { decodePlanFolds, encodePlanFolds } from "@/lib/realtime/view-protocol";
import { useFollowedUi, usePublishViewUi } from "@/lib/realtime/view-ui";
import { TESTID } from "@/lib/testids";
import { useUi } from "@/lib/workspace/ui-store";
import { useWorkspace } from "@/lib/workspace/use-workspace";
import { cardTone } from "./card-tone";
import { DayRow } from "./DayRow";
import { DaySection } from "./DaySection";
import { PlanSplit, useSplitOpen } from "./day-split/DaySplit";
import { DayStepper, WhoMenu } from "./PlanToolbar";
import {
	DragDayContext,
	type DropIndicator,
	DropIndicatorContext,
	PlanUiContext,
	type PlanUiState,
} from "./plan-context";
import { type PlanDropData, planDrop } from "./plan-drop";
import {
	buildPlanEntries,
	isCoarse,
	nothingFor,
	type PlanContext,
	type PlanEntry,
} from "./plan-rows";
import {
	createPlanWindow,
	estimateDayHeight,
	INITIAL_BUDGET_PX,
	PlanWindowContext,
	revealInPlan,
	scrollParent,
} from "./plan-window";
import { BandCard, BandLink, DaysFoldRow, TripProposalBanner } from "./rows";
import { PLAN_TESTID } from "./testids";
import { UnscheduledSection } from "./Unscheduled";
import {
	FLIGHT_MOVE_MESSAGE,
	itemName,
	PlanActionsProvider,
	slotOf,
	usePlanActions,
} from "./use-plan-actions";

const useIsoLayoutEffect =
	typeof window === "undefined" ? useEffect : useLayoutEffect;

/** Flip one key of a set held in state. */
function toggle(
	set: (f: (s: ReadonlySet<string>) => ReadonlySet<string>) => void,
	key: string,
) {
	set((s) => {
		const n = new Set(s);
		if (n.has(key)) n.delete(key);
		else n.add(key);
		return n;
	});
}

/** "Everyone · Me · Maya ▾" (members only; link guests are never listed). */
/**
 * Where a drop across days would land (a line before the card, or at the end
 * of the day); within one day the sortable animation shows it instead. Reads
 * the drag state from dnd-kit's context, so it also renders without one.
 */
function DropIndicatorProvider({ children }: { children: ReactNode }) {
	const { active, over } = useDndContext();
	const a = active?.data.current as
		| { type?: string; dayId?: string | null }
		| undefined;
	const o = over?.data.current as PlanDropData | undefined;
	const overDay = o ? (o.unscheduled ? null : (o.dayId ?? null)) : undefined;
	const sameList = a?.type === "item" && a.dayId === overDay && !!o?.itemId;
	const key =
		active && o?.panel === "plan" && !sameList
			? `${String(overDay)}|${o.itemId ?? ""}`
			: "";
	const value = useMemo<DropIndicator>(() => {
		if (!key) return null;
		const [day, item] = key.split("|");
		return {
			dayId: day === "null" ? null : (day ?? null),
			itemId: item || null,
			where: "before",
		};
	}, [key]);
	const dragDay = a?.type === "item" ? (a.dayId ?? null) : null;
	return (
		<DragDayContext.Provider value={dragDay}>
			<DropIndicatorContext.Provider value={value}>
				{children}
			</DropIndicatorContext.Provider>
		</DragDayContext.Provider>
	);
}

/** What follows the pointer while a card is dragged: a lifted copy (shadow-float, 1.02). */
function OverlayCard({ itemId }: { itemId: string }) {
	const { ix, schedule } = useWorkspace();
	const item = ix.item(itemId);
	if (!item) return null;
	const s = schedule.items[itemId];
	const node = ix.node(item.nodeId);
	const tone = cardTone(node);
	return (
		<div
			data-family={tone}
			className="plan-card flex w-[min(24rem,85vw)] scale-[1.02] items-center gap-3 rounded-lg border bg-card px-3 py-2 shadow-float"
		>
			<span
				aria-hidden
				className="plan-icon flex size-6 shrink-0 items-center justify-center rounded-full"
			>
				{node?.type === "place" && node.category ? (
					<CategoryIcon category={node.category} className="size-3.5" />
				) : null}
			</span>
			<span className="w-11 shrink-0 text-xs text-muted-foreground tnum">
				{s ? formatTime(s.start, s.tz) : "—"}
			</span>
			<span className="min-w-0 flex-1 truncate text-sm font-medium">
				{itemName(ix, item)}
			</span>
			<Chip className="tnum">
				{formatDuration(item.durationMin, { compact: true })}
			</Chip>
		</div>
	);
}

/** "Plan · 35 days · Sat 2 Oct – Fri 5 Nov · 7 days planned" over the list of days (D02). */
function PlanTitle({ entries }: { entries: readonly PlanEntry[] }) {
	const { ix } = useWorkspace();
	const ids = new Set<string>();
	for (const e of entries) {
		if (e.kind === "day") ids.add(e.dayId);
		if (e.kind === "band") for (const d of e.days) ids.add(d.dayId);
	}
	const dates = [...ids]
		.map((id) => ix.day(id)?.date)
		.filter((d): d is string => !!d)
		.sort();
	const planned = [...ids].filter(
		(id) => (ix.itemsByDay.get(id)?.length ?? 0) > 0,
	).length;
	const first = dates[0];
	const last = dates.at(-1);
	return (
		<div className="min-w-0 py-1">
			<h2 className="font-display text-2xl leading-8 font-semibold">Plan</h2>
			{first && last ? (
				<p
					data-testid={PLAN_TESTID.planMeta}
					className="truncate text-meta text-muted-foreground"
				>
					<span className="tnum">{dates.length}</span>{" "}
					{dates.length === 1 ? "day" : "days"} ·{" "}
					<span className="tnum">{formatDateRange(first, last)}</span> ·{" "}
					<span className="tnum">{planned}</span>{" "}
					{planned === 1 ? "day" : "days"} planned
				</p>
			) : null}
		</div>
	);
}

/**
 * Whose ideas the Plan offers: where the first day in view stays (its city,
 * else its region, like Mt. Fuji), else the scope.
 */
export function planIdeasScope(
	ix: GraphIndex,
	days: DayRange | null,
	scopeId: string | null,
): string | null {
	if (days) {
		const night = ix.days.find((d) => d.date === days.from)?.nightNodeId;
		const up = night ? [...ix.path(night)].reverse() : [];
		const where =
			up.find((n) => n.type === "city") ?? up.find((n) => n.type === "region");
		if (where) return where.id;
	}
	return scopeId;
}

export function PlanTab() {
	return (
		<PlanActionsProvider>
			<PlanTabBody />
		</PlanActionsProvider>
	);
}

function PlanTabBody() {
	const ws = useWorkspace();
	const { ix, graph, scope, days, nav, model, schedule, lens, who, mode } = ws;
	// One Yonder: Days | Cities & nights (D02/D05); without a day in view the
	// coarse lenses list the days as rows (D02), a day in view is its timeline.
	const [nights, setNights] = useSplitOpen();
	const dayRows = !days && isCoarse(lens);
	const actions = usePlanActions();
	const openAddPlace = useUi((s) => s.openAddPlace);
	const dnd = useDnd();
	const prefs = useQuery({ ...userPrefsQuery(), enabled: mode === "live" });
	const compact = prefs.data?.compact ?? ix.settings.compact;
	const money = useMoneyCounts();

	// While suggestions are shown, `ix` simulates them (EXTENSIONS §3.6). The
	// server's own index says which legs are really detached, so a suggested
	// move never draws a real leg as amber "Unlinked transit" with a Discard
	// that would delete it (QA COLLAB-R2-01).
	const simulated = ws.proposals.show && ws.proposals.count > 0;
	const realIx = useMemo(
		() => (simulated ? indexGraph(graph) : null),
		[simulated, graph],
	);
	const realDetached = useMemo(
		() => (realIx ? new Set(realIx.detachedLegs.map((d) => d.legId)) : null),
		[realIx],
	);
	const ctx = useMemo<PlanContext>(
		() => ({
			ix,
			model,
			schedule,
			scopeId: scope?.id ?? null,
			lens,
			days,
			who,
			realDetached,
		}),
		[ix, model, schedule, scope?.id, lens, days, who, realDetached],
	);
	const entries = useMemo(() => buildPlanEntries(ctx), [ctx]);

	// ---- day windowing (plan-window.ts) and following the selection -----------
	const rootRef = useRef<HTMLDivElement>(null);
	const [win] = useState(createPlanWindow);
	const empty = graph.days.length === 0 && graph.items.length === 0;
	useIsoLayoutEffect(() => {
		if (empty) return;
		win.attach(scrollParent(rootRef.current));
		return () => win.detach();
	}, [win, empty]);
	const { sel } = ws;
	const selKey =
		sel?.kind === "item" || sel?.kind === "day" ? `${sel.kind}:${sel.id}` : "";
	useEffect(() => {
		// MAP-07: a selection made elsewhere (a pin, search, the day chips) brings
		// its card into view; one already on screen doesn't move.
		const root = rootRef.current;
		if (!selKey || !root) return;
		const [kind, id] = selKey.split(":");
		const el =
			kind === "item"
				? root.querySelector(
						`[data-testid="${TESTID.timelineItem}"][data-item-id="${id}"]`,
					)
				: root.querySelector(
						`[data-testid="${PLAN_TESTID.daySection}"][data-day-id="${id}"]`,
					);
		if (el) revealInPlan(el, root);
	}, [selKey]);

	// ---- local UI state: folded blocks and bands, opened "elsewhere" folds ----
	const [collapsedBlocks, setCollapsedBlocks] = useState<ReadonlySet<string>>(
		new Set(),
	);
	const [collapsedBands, setCollapsedBands] = useState<ReadonlySet<string>>(
		new Set(),
	);
	const [openFolds, setOpenFolds] = useState<ReadonlySet<string>>(new Set());
	const [openStretch, setOpenStretch] = useState<ReadonlySet<string>>(
		new Set(),
	);
	const ui = useMemo<PlanUiState>(
		() => ({
			collapsedBlocks,
			toggleBlock: (k) => toggle(setCollapsedBlocks, k),
			openStretch,
			toggleStretch: (k) => toggle(setOpenStretch, k),
			compact,
			money,
			realIx,
		}),
		[collapsedBlocks, openStretch, compact, money, realIx],
	);
	const bandKeys = entries.filter((e) => e.kind === "band").map((e) => e.key);
	const allCollapsed = isCoarse(lens)
		? bandKeys.length > 0 && bandKeys.every((k) => collapsedBands.has(k))
		: false;

	// ---- FB-21a: folds travel with my view; a follower mirrors them -----------
	const bandsKey = bandKeys.join(",");
	const folds = useMemo(
		() =>
			encodePlanFolds({
				openFolds,
				collapsedBands,
				collapsedBlocks,
				openStretch,
				bands: bandsKey ? bandsKey.split(",") : [],
			}),
		[openFolds, collapsedBands, collapsedBlocks, openStretch, bandsKey],
	);
	usePublishViewUi("plan", folds);
	const followed = useFollowedUi("plan");
	const followedJson = followed ? JSON.stringify(followed) : null;
	useEffect(() => {
		if (!followedJson) return;
		const next = decodePlanFolds(
			JSON.parse(followedJson),
			bandsKey ? bandsKey.split(",") : [],
		);
		setOpenFolds(next.openFolds);
		setCollapsedBands(next.collapsedBands);
		setCollapsedBlocks(next.collapsedBlocks);
		setOpenStretch(next.openStretch);
	}, [followedJson, bandsKey]);

	// ---- drag and drop ---------------------------------------------------------
	const drop = useCallback(
		(activeItemId: string | null, over: PlanDropData | undefined) =>
			planDrop(ix, activeItemId, over),
		[ix],
	);
	useEffect(
		() =>
			dnd.onDrop("item", (e, data) => {
				if (data.type !== "item") return;
				const plan = drop(
					data.itemId,
					e.over?.data.current as PlanDropData | undefined,
				);
				if (!plan.ok) {
					if (plan.reason === "flight") toast(FLIGHT_MOVE_MESSAGE);
					return;
				}
				actions.move.mutate({
					itemId: data.itemId,
					dayId: plan.dayId,
					...(plan.afterItemId ? { afterItemId: plan.afterItemId } : {}),
					...(plan.beforeItemId ? { beforeItemId: plan.beforeItemId } : {}),
					undo: slotOf(ix, data.itemId),
				});
			}),
		[dnd, drop, actions.move, ix],
	);
	useEffect(
		() =>
			dnd.onDrop("node", (e, data) => {
				if (data.type !== "node") return;
				const over = e.over?.data.current as PlanDropData | undefined;
				if (over?.panel !== "plan") return;
				const plan = drop(null, over);
				if (!plan.ok) {
					if (plan.reason === "flight") toast(FLIGHT_MOVE_MESSAGE);
					return;
				}
				actions.create.mutate({
					dayId: plan.dayId,
					nodeId: data.nodeId,
					...(plan.afterItemId ? { afterItemId: plan.afterItemId } : {}),
					...(plan.beforeItemId ? { beforeItemId: plan.beforeItemId } : {}),
				});
			}),
		[dnd, drop, actions.create],
	);
	useEffect(() => {
		dnd.setOverlay("item", (data) =>
			data.type === "item" ? <OverlayCard itemId={data.itemId} /> : null,
		);
		return () => dnd.setOverlay("item", null);
	}, [dnd]);

	// ---- empty trip: how long in each city (places, no dates), else the way in --
	if (empty) {
		return (
			<div data-testid={TESTID.planTab}>
				<PlanSplit
					className="pt-4"
					open={null}
					onOpenChange={setNights}
					fallback={
						<EmptyState
							lead={<TabPurpose tab="plan" />}
							line={
								graph.nodes.length
									? "Set the trip dates to plan your days."
									: "Where to first?"
							}
							action={
								<Button
									size="sm"
									onClick={() =>
										openAddPlace({
											mode: graph.nodes.length ? "search" : "first",
										})
									}
								>
									Search places
								</Button>
							}
						/>
					}
				/>
			</div>
		);
	}

	// The first screens render before the window observer reports (and on the server).
	let budget = INITIAL_BUDGET_PX;
	const initialNear = (dayId: string) => {
		const near = budget > 0;
		budget -= estimateDayHeight(ix, dayId, compact);
		return near;
	};

	const renderEntry = (e: PlanEntry) => {
		switch (e.kind) {
			case "day":
				return (
					<DaySection
						key={e.key}
						ctx={ctx}
						dayId={e.dayId}
						initialNear={initialNear(e.dayId)}
					/>
				);
			case "days-fold":
				// The days before and after the ones in view: the stepper and All days (One Yonder).
				if (e.reason !== "scope") return null;
				return (
					<div key={e.key}>
						<DaysFoldRow
							dayIds={e.dayIds}
							reason="scope"
							open={openFolds.has(e.key)}
							onClick={() => toggle(setOpenFolds, e.key)}
						/>
						{openFolds.has(e.key)
							? e.dayIds.map((d) => (
									<DaySection
										key={d}
										ctx={{ ...ctx, scopeId: null }}
										dayId={d}
										keySuffix=":fold"
										muted
										initialNear={initialNear(d)}
									/>
								))
							: null}
					</div>
				);
			case "band": {
				const open = !collapsedBands.has(e.key);
				const link = entries.find(
					(x) => x.kind === "band-link" && x.transition.toVisit === e.visit.key,
				);
				const skip =
					link?.kind === "band-link" ? link.transition.toItemId : null;
				return (
					<div key={e.key}>
						<BandCard
							visit={e.visit}
							open={open}
							onToggle={() => toggle(setCollapsedBands, e.key)}
						/>
						{open && dayRows ? (
							<div className="grid gap-1.5 px-4 pb-2">
								{e.days.map((d) => (
									<DayRow key={`${e.key}:${d.dayId}`} dayId={d.dayId} />
								))}
							</div>
						) : open ? (
							e.days.map((d) => (
								<DaySection
									key={`${e.key}:${d.dayId}`}
									ctx={ctx}
									dayId={d.dayId}
									only={d.only}
									skipLeadOf={skip}
									keySuffix={`:${e.visit.key}`}
									initialNear={initialNear(d.dayId)}
									copy={d.copy}
								/>
							))
						) : null}
					</div>
				);
			}
			case "band-link":
				return <BandLink key={e.key} transition={e.transition} />;
		}
	};

	const inScope = entries.some((e) => e.kind === "day" || e.kind === "band");
	const whoEmpty = inScope && nothingFor(ix, entries, model.unscheduled, who);
	return (
		<PlanUiContext.Provider value={ui}>
			<PlanWindowContext.Provider value={win}>
				<DropIndicatorProvider>
					<div
						ref={rootRef}
						data-testid={TESTID.planTab}
						data-lens={lens}
						className="plan-root @container pb-24"
					>
						{/* The header row; the days per city join it once days have cities. */}
						<PlanSplit
							header={(views) => (
								<>
									{days ? <DayStepper /> : <PlanTitle entries={entries} />}
									<span className="order-last ml-auto flex items-center gap-2">
										{views}
										{isCoarse(lens) && bandKeys.length > 1 ? (
											<Button
												variant="ghost"
												size="xs"
												className="text-muted-foreground"
												onClick={() =>
													setCollapsedBands(
														allCollapsed ? new Set() : new Set(bandKeys),
													)
												}
											>
												{allCollapsed ? (
													<ChevronsUpDown className="size-3.5" />
												) : (
													<ChevronsDownUp className="size-3.5" />
												)}
												{allCollapsed ? "Expand all" : "Collapse all"}
											</Button>
										) : null}
										<WhoMenu />
									</span>
								</>
							)}
							// A day in view has its stepper instead of Days | Cities & nights.
							open={days ? null : nights}
							onOpenChange={setNights}
							banner={<TripProposalBanner />}
						/>
						{nights && !days ? null : whoEmpty && who ? (
							<EmptyState
								line={
									<>
										Nothing assigned to{" "}
										{resolveMember(graph.members, who)?.name.split(" ")[0] ??
											"them"}{" "}
										here.
									</>
								}
								action={
									<Button
										size="sm"
										variant="outline"
										onClick={() => nav.setWho(null)}
									>
										Show everyone
									</Button>
								}
							/>
						) : inScope ? (
							entries.map(renderEntry)
						) : (
							<>
								{entries.map(renderEntry)}
								<EmptyState
									line={`Nothing scheduled in ${scope?.name ?? "this trip"} yet.`}
									action={
										<Button
											size="sm"
											variant="outline"
											onClick={() =>
												openAddPlace({
													mode: "schedule",
													...(scope ? { parentId: scope.id } : {}),
												})
											}
										>
											Add a place
										</Button>
									}
								/>
							</>
						)}
						<UnscheduledSection itemIds={model.unscheduled} />
						{/* One Yonder (D03): what's saved but not planned, for the day in view. */}
						<IdeasBin
							plan
							scopeId={planIdeasScope(ix, days, scope?.id ?? null)}
						/>
					</div>
				</DropIndicatorProvider>
			</PlanWindowContext.Provider>
		</PlanUiContext.Provider>
	);
}
