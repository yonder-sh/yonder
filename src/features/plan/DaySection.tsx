/**
 * One day of the timeline: the sticky header, the day's rows from
 * `buildDaySection`, one sortable container for its cards (inside the
 * workspace's single `WorkspaceDnd`), the now line, the person-filter
 * footer ("3 hidden · Everyone"), E7 origin rows and the add row.
 */
import { useDroppable } from "@dnd-kit/core";
import {
	SortableContext,
	useSortable,
	verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { cn } from "cn";
import {
	type ReactNode,
	useCallback,
	useContext,
	useEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import { useEditGuard } from "@/components/common/edit-guard";
import { pairKey } from "@/lib/engine/graph-index";
import { localDateOf } from "@/lib/engine/time";
import { formatTime } from "@/lib/format";
import { copyAnchorId } from "@/lib/realtime/cursor-protocol";
import { useProposalMarks } from "@/lib/workspace/use-proposals";
import { useWorkspace } from "@/lib/workspace/use-workspace";
import { AddMenu } from "./AddMenu";
import { DayHeader, DayHeaderLite } from "./DayHeader";
import {
	FlightContinued,
	FlightRows,
	isFlightLeg,
	LayoverRow,
} from "./FlightRows";
import { DragGrip, ItemCard } from "./ItemCard";
import { LegRow, OvernightRow, TimedLegRow } from "./LegRow";
import {
	DragDayContext,
	DropIndicatorContext,
	PlanUiContext,
} from "./plan-context";
import {
	buildDaySection,
	type LeadRow,
	ORIGIN_START,
	originAnchors,
	type PlanContext,
	type PlanRow,
} from "./plan-rows";
import { estimateDayHeight, PlanWindowContext } from "./plan-window";
import {
	BlockHeader,
	DayProposalBanner,
	FoldedItemLine,
	GapRow,
	GhostRow,
	OriginRow,
	OriginRows,
	StretchFoldRow,
	UnlinkedRow,
} from "./rows";
import { PLAN_TESTID } from "./testids";
import { useNow } from "./use-media";
import { itemName } from "./use-plan-actions";

function Indicator() {
	return (
		<div
			data-testid={PLAN_TESTID.dropIndicator}
			aria-hidden
			className="pointer-events-none relative h-0"
		>
			<span className="absolute right-3 left-[var(--plan-rail-col)] -top-px h-0.5 rounded-full bg-primary" />
		</div>
	);
}

/** A stable React key for a lead row. */
export function leadKey(l: LeadRow): string {
	switch (l.kind) {
		case "gap":
			return `gap:${l.itemId}`;
		case "ghost":
			return `ghost:${l.ghost.dir}:${l.ghost.pairKey}`;
		default:
			return `${l.kind}:${l.key}`;
	}
}

function Lead({ lead, dayId }: { lead: LeadRow; dayId: string }) {
	const { ix } = useWorkspace();
	switch (lead.kind) {
		case "stay": {
			const plan = ix.morningStay(dayId);
			return (
				<LegRow
					legKey={lead.key}
					target={{ kind: "stay", dayId, end: "start" }}
					stay={{ end: "start", nodeId: plan?.stayNodeId ?? null }}
				/>
			);
		}
		case "leg":
			return isFlightLeg(ix, lead.fromItemId, lead.toItemId) ? (
				<FlightRows fromItemId={lead.fromItemId} toItemId={lead.toItemId} />
			) : (
				<LegRow
					legKey={lead.key}
					target={{
						kind: "pair",
						fromItemId: lead.fromItemId,
						toItemId: lead.toItemId,
					}}
				/>
			);
		case "continued":
			return isFlightLeg(ix, lead.fromItemId, lead.toItemId) ? (
				<FlightContinued
					fromItemId={lead.fromItemId}
					toItemId={lead.toItemId}
				/>
			) : (
				<TimedLegRow
					legKey={lead.key}
					fromItemId={lead.fromItemId}
					toItemId={lead.toItemId}
					continued
				/>
			);
		case "ghost":
			return <GhostRow ghost={lead.ghost} />;
		case "gap":
			return <GapRow minutes={lead.minutes} />;
	}
}

function SortableItemRow({
	row,
	dayId,
	crumbNodeId,
	addAfter,
	nowBefore,
}: {
	row: Extract<PlanRow, { kind: "item" }>;
	dayId: string | null;
	crumbNodeId: string | null;
	/** The "+" on the rail above this card inserts after this item (else before this card). */
	addAfter: string | null;
	nowBefore: ReactNode;
}) {
	const { ix } = useWorkspace();
	const guard = useEditGuard();
	const ui = useContext(PlanUiContext);
	const indicator = useContext(DropIndicatorContext);
	const item = ix.item(row.itemId);
	const {
		attributes,
		listeners,
		setNodeRef,
		transform,
		transition,
		isDragging,
	} = useSortable({
		id: row.itemId,
		data: {
			type: "item",
			itemId: row.itemId,
			panel: "plan",
			dayId,
			unscheduled: dayId === null,
			label: item ? itemName(ix, item) : "item",
		},
		disabled: guard.disabled,
	});
	if (!item) return null;
	const { onKeyDown, ...pointer } = (listeners ?? {}) as Record<
		string,
		(e: unknown) => void
	>;
	const showIndicator = indicator?.itemId === row.itemId;
	return (
		<li
			ref={setNodeRef}
			data-row="item"
			style={{ transform: CSS.Translate.toString(transform), transition }}
			className={cn("group/row relative", isDragging && "z-10")}
		>
			{showIndicator && indicator?.where === "before" ? <Indicator /> : null}
			{isDragging
				? null
				: row.lead.map((l) => (
						<Lead key={leadKey(l)} lead={l} dayId={dayId ?? ""} />
					))}
			{nowBefore}
			{dayId && !isDragging ? (
				<span className="absolute top-0 left-[calc(var(--plan-rail-x)-9px)] z-10 -translate-y-1/2 opacity-0 transition-opacity group-hover/row:opacity-100 focus-within:opacity-100">
					<AddMenu
						dayId={dayId}
						{...(addAfter
							? { afterItemId: addAfter }
							: { beforeItemId: row.itemId })}
					/>
				</span>
			) : null}
			{row.layover ? (
				<LayoverRow itemId={row.itemId} />
			) : (
				<ItemCard
					item={item}
					crumbNodeId={crumbNodeId}
					compact={ui.compact}
					dragListeners={pointer}
					dragging={isDragging}
					grip={
						<DragGrip
							label={itemName(ix, item)}
							attributes={attributes as unknown as Record<string, unknown>}
							onKeyDown={
								onKeyDown as ((e: React.KeyboardEvent) => void) | undefined
							}
							disabled={guard.disabled}
						/>
					}
				/>
			)}
			{showIndicator && indicator?.where === "after" ? <Indicator /> : null}
		</li>
	);
}

function NowLine({ at, tz }: { at: number; tz: string }) {
	return (
		<div
			data-testid={PLAN_TESTID.nowLine}
			className="plan-now"
			aria-label={`Now ${formatTime(at, tz)}`}
			role="img"
		>
			<span className="plan-now-dot" />
			<span className="absolute top-0 left-[calc(var(--plan-rail-x)-44px)] -translate-y-1/2 rounded-full bg-glow px-1.5 font-mono text-[11px] leading-4 text-glow-foreground tnum">
				{formatTime(at, tz)}
			</span>
		</div>
	);
}

/** The day the current selection lives on (so its section always renders). */
function selectedDayId(ws: ReturnType<typeof useWorkspace>): string | null {
	const { sel, ix } = ws;
	if (!sel) return null;
	if (sel.kind === "day") return sel.id;
	if (sel.kind === "item") return ix.item(sel.id)?.dayId ?? null;
	if (sel.kind === "leg")
		return sel.target.kind === "stay"
			? sel.target.dayId
			: (ix.item(sel.target.fromItemId)?.dayId ?? null);
	return null;
}

export type DaySectionProps = {
	ctx: PlanContext;
	dayId: string;
	only?: ReadonlySet<string> | null;
	skipLeadOf?: string | null;
	keySuffix?: string;
	/** Days opened from an "elsewhere" fold. */
	muted?: boolean;
	/** Render the rows before the window observer reports (the first screens, SSR). */
	initialNear?: boolean;
	/** Which drawing of a day drawn in several bands this is (`BandDay.copy`). */
	copy?: string;
};

/**
 * A day of the timeline, windowed (`plan-window.ts`): its rows render while
 * the day is within about two screens of the viewport, holds the selection,
 * or holds the card being dragged; otherwise a light header over a spacer
 * of the day's height. The section stays a drop target either way.
 */
export function DaySection(props: DaySectionProps) {
	const { dayId, keySuffix = "", muted, initialNear = true, copy } = props;
	const ws = useWorkspace();
	const { ix } = ws;
	const win = useContext(PlanWindowContext);
	const dragDay = useContext(DragDayContext);
	const ui = useContext(PlanUiContext);
	const key = `${dayId}${keySuffix}`;
	const [near, setNear] = useState(initialNear || !win);
	const ref = useRef<HTMLElement | null>(null);
	const day = ix.day(dayId);
	const { setNodeRef, isOver } = useDroppable({
		id: `plan-day:${key}`,
		data: {
			panel: "plan",
			dayId,
			kbSkip: true,
			label: day ? `Day ${ix.dayNumber(dayId)}` : "day",
		},
	});
	useEffect(() => {
		const el = ref.current;
		if (!win || !el) return;
		if (!win.supported) {
			setNear(true);
			return;
		}
		return win.observe(el, (n) => {
			// Measure on the way out, while the rows are still there.
			if (!n && el.offsetHeight > 0) win.heights.set(key, el.offsetHeight);
			setNear(n);
		});
	}, [win, key]);
	const setRefs = useCallback(
		(el: HTMLElement | null) => {
			ref.current = el;
			setNodeRef(el);
		},
		[setNodeRef],
	);
	if (!day) return null;
	const live = near || dragDay === dayId || selectedDayId(ws) === dayId;
	const spacer = live
		? undefined
		: (win?.heights.get(key) ?? estimateDayHeight(ix, dayId, ui.compact));
	return (
		<section
			ref={setRefs}
			data-testid={PLAN_TESTID.daySection}
			data-day-id={dayId}
			data-cursor-anchor={copyAnchorId(`day:${dayId}`, copy)}
			data-windowed={live ? undefined : ""}
			aria-label={`Day ${ix.dayNumber(dayId)}`}
			style={spacer ? { minHeight: spacer } : undefined}
			className={cn(
				// A little air after each day, so a day reads as one unit.
				"relative pb-4 transition-colors",
				isOver && "bg-primary/[0.03]",
				muted && "opacity-75",
			)}
		>
			{live ? <DayBody {...props} /> : <DayHeaderLite day={day} copy={copy} />}
		</section>
	);
}

function DayBody({
	ctx,
	dayId,
	only,
	skipLeadOf,
	keySuffix = "",
	copy,
}: DaySectionProps) {
	const ws = useWorkspace();
	const { ix, schedule, nav, who, scope } = ws;
	const ui = useContext(PlanUiContext);
	const indicator = useContext(DropIndicatorContext);
	const day = ix.day(dayId);
	const section = useMemo(
		() =>
			buildDaySection(ctx, dayId, {
				only: only ?? null,
				skipLeadOf: skipLeadOf ?? null,
			}),
		[ctx, dayId, only, skipLeadOf],
	);
	const now = useNow();
	const originMarks = useProposalMarks(`from:day:${dayId}`);
	const sd = schedule.days[dayId];
	if (!day) return null;

	// The now line: only on today's day, before the first card that hasn't started.
	const isToday = now > 0 && !!sd && localDateOf(now, sd.tz) === day.date;
	let nowAt: string | "end" | null = null;
	if (isToday) {
		const next = section.itemIds.find(
			(id) => (schedule.items[id]?.start.getTime() ?? 0) > now,
		);
		nowAt = next ?? (sd && now < sd.end.getTime() ? "end" : null);
	}

	// Rows hidden inside collapsed area blocks.
	const collapsed = (r: PlanRow) =>
		r.kind === "item" &&
		r.blockKey !== null &&
		ui.collapsedBlocks.has(r.blockKey);
	const sortable = section.rows
		.filter(
			(r): r is Extract<PlanRow, { kind: "item" }> =>
				r.kind === "item" && !collapsed(r),
		)
		.map((r) => r.itemId);

	// E7 origin rows sit at the moved item's old slot (QA COLLAB-R3-02).
	const origins = originAnchors(ui.realIx ?? ix, dayId, sortable, originMarks);
	const originLi = (anchor: string) =>
		(origins.at.get(anchor) ?? []).map((m) => (
			<li key={`origin:${m.proposalId}`}>
				<OriginRow mark={m} />
			</li>
		));

	let prevParent: string | null | undefined;
	let prevItem: string | null = null;
	const rendered: ReactNode[] = [...originLi(ORIGIN_START)];
	for (const [i, row] of section.rows.entries()) {
		const k = `${row.kind}:${i}`;
		switch (row.kind) {
			case "item": {
				if (collapsed(row)) {
					prevItem = row.itemId;
					continue;
				}
				const item = ix.item(row.itemId);
				const parent = item?.nodeId
					? (ix.node(item.nodeId)?.parentId ?? null)
					: prevParent;
				const crumb =
					ws.lens === "place" &&
					item?.nodeId &&
					parent &&
					parent !== prevParent &&
					parent !== scope?.id
						? parent
						: null;
				prevParent = parent;
				rendered.push(
					<SortableItemRow
						key={row.itemId}
						row={row}
						dayId={dayId}
						crumbNodeId={crumb}
						addAfter={prevItem}
						nowBefore={
							nowAt === row.itemId && sd ? (
								<NowLine at={now} tz={sd.tz} />
							) : null
						}
					/>,
					...originLi(row.itemId),
				);
				prevItem = row.itemId;
				continue;
			}
			case "block": {
				const open = !ui.collapsedBlocks.has(row.key);
				rendered.push(
					<li key={row.key} className="relative">
						{row.lead.map((l) => (
							<Lead key={leadKey(l)} lead={l} dayId={dayId} />
						))}
						<BlockHeader
							repId={row.repId}
							itemIds={row.itemIds}
							open={open}
							onToggle={() => ui.toggleBlock(row.key)}
						/>
					</li>,
				);
				prevParent = undefined;
				continue;
			}
			case "overnight":
				rendered.push(
					<li key={k}>
						<OvernightRow fromItemId={row.fromItemId} toItemId={row.toItemId} />
					</li>,
				);
				continue;
			case "stay-end": {
				const plan = ix.eveningStay(dayId);
				rendered.push(
					<li key={k}>
						<LegRow
							legKey={row.key}
							target={{ kind: "stay", dayId, end: "end" }}
							stay={{ end: "end", nodeId: plan?.stayNodeId ?? null }}
						/>
					</li>,
				);
				continue;
			}
			case "leg-out":
				rendered.push(
					<li key={k}>
						{isFlightLeg(ix, row.fromItemId, row.toItemId) ? (
							<FlightRows fromItemId={row.fromItemId} toItemId={row.toItemId} />
						) : (
							<TimedLegRow
								legKey={pairKey(row.fromItemId, row.toItemId)}
								fromItemId={row.fromItemId}
								toItemId={row.toItemId}
							/>
						)}
					</li>,
				);
				continue;
			case "ghost":
				rendered.push(
					<li key={k}>
						<GhostRow ghost={row.ghost} />
					</li>,
				);
				continue;
			case "fold": {
				const fk = `${dayId}${keySuffix}|${row.itemIds[0] ?? k}`;
				const open = ui.openStretch.has(fk);
				rendered.push(
					<li key={`fold:${fk}`}>
						<StretchFoldRow
							itemIds={row.itemIds}
							labelNodeId={row.labelNodeId}
							open={open}
							onToggle={() => ui.toggleStretch(fk)}
						/>
						{open
							? row.itemIds.map((id) => <FoldedItemLine key={id} itemId={id} />)
							: null}
					</li>,
				);
				prevParent = undefined;
				continue;
			}
			case "unlinked":
				rendered.push(
					<li key={`unlinked:${row.legId}`}>
						<UnlinkedRow
							legId={row.legId}
							fromItemId={row.fromItemId}
							toItemId={row.toItemId}
						/>
					</li>,
				);
				continue;
		}
	}

	const empty = section.rows.length === 0;
	const dayIndicator =
		indicator && indicator.dayId === dayId && indicator.itemId === null;
	return (
		<>
			<DayHeader day={day} copy={copy} />
			<DayProposalBanner dayId={dayId} />
			<SortableContext
				id={`plan-day:${dayId}${keySuffix}`}
				items={sortable}
				strategy={verticalListSortingStrategy}
			>
				<ol className="py-1">{rendered}</ol>
			</SortableContext>
			{dayIndicator ? <Indicator /> : null}
			{nowAt === "end" && sd ? <NowLine at={now} tz={sd.tz} /> : null}
			{empty && section.hidden === 0 ? (
				<p className="px-4 pt-1 pb-3 pl-[var(--plan-rail-col)] font-display text-[15px] text-muted-foreground">
					A free day.
				</p>
			) : null}
			{section.hidden > 0 && who ? (
				<p className="flex items-center gap-1 pb-2 pl-[var(--plan-rail-col)] text-xs text-muted-foreground">
					<span className="font-mono tnum">{section.hidden}</span> hidden ·
					<button
						type="button"
						data-testid={PLAN_TESTID.dayHidden}
						onClick={() => nav.setWho(null)}
						className="text-primary hover:underline"
					>
						Everyone
					</button>
				</p>
			) : null}
			<OriginRows marks={origins.rest} />
			<DayEndDrop dayId={dayId} dropKey={`${dayId}${keySuffix}`}>
				{!only ? (
					<div className="flex pb-2 pl-[calc(var(--plan-rail-col)-0.5rem)]">
						<AddMenu
							dayId={dayId}
							variant="row"
							label="Add to this day"
							{...(prevItem ? { afterItemId: prevItem } : {})}
						/>
					</div>
				) : null}
			</DayEndDrop>
		</>
	);
}

/**
 * Below a day's last card: a drop here goes at the END of the day. A drop on
 * a card lands before it, and the whole-day droppable loses to the last
 * card's centre, so without this zone nothing could go after the last card.
 */
function DayEndDrop({
	dayId,
	dropKey,
	children,
}: {
	dayId: string;
	dropKey: string;
	children: ReactNode;
}) {
	const { ix } = useWorkspace();
	const { setNodeRef } = useDroppable({
		id: `plan-day-end:${dropKey}`,
		data: {
			panel: "plan",
			dayId,
			kbSkip: true,
			label: `the end of Day ${ix.dayNumber(dayId)}`,
		},
	});
	return (
		<div ref={setNodeRef} className="min-h-6">
			{children}
		</div>
	);
}
