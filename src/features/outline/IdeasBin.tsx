/**
 * The Ideas bin (SPEC §12.5 `IdeasBin()`, DESIGN §4.2): places in the scope
 * that aren't on the plan yet, pinned to the bottom of the Outline (at most
 * 40% of its height). Rows show one rating as dot + label (the max over
 * members; PLACES §1c: dense lists use dots, not pills) and sort by the
 * owner's rule (SPEC §7.3) by default, or by name or recency. The
 * shared filter (ADDENDUM §10, `?f=`) narrows them. Drag a row onto a Plan day
 * to schedule it, or press **A** on a focused row to add it to the focused
 * day. Proposed places (E7) sort in like any other, drawn as ghosts.
 *
 * `plan` (One Yonder, D03/P10): a dock at the foot of the Plan, "Ideas in
 * Kyoto" for the day in view, the ideas as cards in a row that scrolls
 * sideways, each with + to add it to that day; folded on a phone at first.
 */
import { useDndMonitor, useDraggable, useDroppable } from "@dnd-kit/core";
import {
	ArrowDownUp,
	ArrowRight,
	ChevronDown,
	ChevronRight,
	ChevronUp,
	Lightbulb,
	Plus,
} from "lucide-react";
import {
	type KeyboardEvent,
	type MouseEvent,
	useCallback,
	useEffect,
	useId,
	useMemo,
	useRef,
	useState,
} from "react";
import { useDnd, WorkspaceDnd } from "@/components/common/dnd/workspace-dnd";
import { useEditGuard } from "@/components/common/edit-guard";
import { TypeGlyph } from "@/components/common/glyphs";
import {
	describeMark,
	leadMark,
	ProposalGhost,
} from "@/components/common/proposal-ghost";
import { RatingDot, RatingPill } from "@/components/kit";
import { Button } from "@/components/ui/button";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuLabel,
	DropdownMenuRadioGroup,
	DropdownMenuRadioItem,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { isRateable } from "@/features/places/lib/rate";
import { cardTone } from "@/features/plan/card-tone";
import { DockStop } from "@/features/plan/DockStop";
import { hiddenByWho } from "@/features/plan/plan-rows";
import { PLAN_TESTID } from "@/features/plan/testids";
import type { GraphNode } from "@/lib/engine/types";
import { formatDuration } from "@/lib/format";
import { bool, oneOf, useFollowValue } from "@/lib/realtime/view-ui";
import { TESTID } from "@/lib/testids";
import { cn } from "@/lib/utils";
import { ratingOf } from "@/lib/workspace/filter-match";
import { useUi } from "@/lib/workspace/ui-store";
import { useWorkspace } from "@/lib/workspace/use-workspace";
import { useGhostActions } from "./ghost-actions";
import { ghostNodes } from "./ghosts";
import {
	IDEAS_SORT_LABEL,
	IDEAS_SORTS,
	type IdeaEntry,
	type IdeasSort,
	ideasFor,
} from "./ideas";
import { OUTLINE_TESTID } from "./testids";
import { useOutlineActions } from "./use-outline-actions";
import { type OutlineDragData, renderDragOverlay } from "./use-outline-dnd";
import { usePlaceFilter } from "./use-place-filter";

const SORT_KEY = "yonder:ideas:sort";
const OPEN_KEY = "yonder:ideas:open";
/** The Plan's dock folds on its own (open on a desktop, folded on a phone at first). */
const PLAN_OPEN_KEY = "yonder:plan-ideas:open";
const narrow = () =>
	typeof window !== "undefined" &&
	!!window.matchMedia?.("(max-width: 639px)").matches;
const isIdeasSort = oneOf<IdeasSort>(IDEAS_SORTS);

function readPref<T extends string>(
	key: string,
	allowed: readonly T[],
	d: T,
): T {
	try {
		const v = globalThis.localStorage?.getItem(key);
		return v && (allowed as readonly string[]).includes(v) ? (v as T) : d;
	} catch {
		return d;
	}
}
function writePref(key: string, v: string) {
	try {
		globalThis.localStorage?.setItem(key, v);
	} catch {
		// ignore (private mode)
	}
}

function IdeaRow({
	entry,
	instance,
	scopeId,
	tabbable,
	onFocusRow,
	onKey,
	registerRef,
	onAdd,
	card = false,
	stopMin = null,
}: {
	entry: IdeaEntry;
	instance: string;
	scopeId: string | null;
	tabbable: boolean;
	onFocusRow(id: string): void;
	onKey(e: KeyboardEvent<HTMLElement>, node: GraphNode): void;
	registerRef(id: string, el: HTMLElement | null): void;
	/** The Plan's +: add it to the day in view. */
	onAdd?: (nodeId: string) => void;
	/** The Plan's dock: a card in a row (icon, name, rating and where). */
	card?: boolean;
	/** Its stop off a day, waiting here: that stop's minutes. */
	stopMin?: number | null;
}) {
	const { nav, sel, ix, proposals } = useWorkspace();
	const guard = useEditGuard();
	const { node, proposalId } = entry;
	const ghost = !!proposalId;
	const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
		id: `idea:${instance}:${node.id}`,
		disabled: guard.disabled || ghost,
		data: {
			type: "node",
			nodeId: node.id,
			label: node.name,
			panel: "ideas",
			origin: `ideas:${instance}`,
		} satisfies OutlineDragData,
	});
	const { onKeyDown: _sensorKey, ...pointer } = listeners ?? {};
	// A listbox option, not a pressed "draggable" button (A schedules instead).
	const {
		"aria-disabled": _disabled,
		"aria-pressed": _pressed,
		"aria-roledescription": _roleDescription,
		"aria-describedby": _describedBy,
		...ariaAttributes
	} = attributes;
	const selected = sel?.kind === "node" && sel.id === node.id;
	const parent = node.parentId ? ix.node(node.parentId) : null;
	const top = ratingOf(node, "max");
	const marks = proposals.marks.get(`node:${node.id}`) ?? [];
	const lead = leadMark(marks);
	const ghostActions = useGhostActions();
	// A proposed place (applied by the overlay or not) isn't real yet.
	const proposed = ghost || marks.some((m) => m.kind === "create");
	const row = (
		<div
			{...ariaAttributes}
			{...pointer}
			ref={(el) => {
				setNodeRef(el);
				registerRef(node.id, el);
			}}
			role="option"
			aria-selected={selected}
			tabIndex={tabbable ? 0 : -1}
			aria-label={`${node.name}${top ? `, ${top.replace(/_/g, " ")}` : ", not rated"}${proposed ? ", suggested" : ""}`}
			// On the option: a listbox may own only options (axe).
			aria-description={lead ? describeMark(lead) : undefined}
			data-testid={OUTLINE_TESTID.ideaRow}
			data-node-id={node.id}
			data-cursor-anchor={`idea:${node.id}`}
			data-ghost={ghost || undefined}
			onFocus={(e) => e.target === e.currentTarget && onFocusRow(node.id)}
			onClick={() =>
				proposalId
					? nav.select({ kind: "proposal", id: proposalId })
					: nav.select({ kind: "node", id: node.id })
			}
			onKeyDown={(e) => onKey(e, node)}
			data-family={card ? cardTone(node) : undefined}
			className={cn(
				"group/idea relative flex cursor-pointer touch-manipulation items-center text-sm outline-none select-none",
				card
					? "plan-card h-14 w-56 shrink-0 gap-2 rounded-lg border bg-card px-2 hover:border-foreground/20 focus-visible:ring-2 focus-visible:ring-ring"
					: "h-7 gap-1.5 pr-2 pl-4 hover:bg-sidebar-accent focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset max-md:h-11",
				selected &&
					(card
						? "outline-2 outline-primary outline-solid"
						: "bg-card before:absolute before:inset-y-0 before:left-0 before:w-0.5 before:bg-primary"),
				isDragging && "opacity-40",
				proposed && "text-muted-foreground",
			)}
		>
			{card ? (
				<>
					<span
						aria-hidden
						className="plan-icon flex size-8 shrink-0 items-center justify-center rounded-full"
					>
						<TypeGlyph
							type={node.type}
							category={node.category}
							tinted={false}
							className="size-4 text-current"
						/>
					</span>
					<span className="flex min-w-0 flex-1 flex-col">
						<span className="truncate font-medium">{node.name}</span>
						<span className="flex min-w-0 items-center gap-1 text-meta text-muted-foreground">
							{top && !ghost ? <RatingPill level={top} size="sm" /> : null}
							{ghost ? <span>suggested</span> : null}
							{stopMin ? (
								<span className="shrink-0 tnum">{formatDuration(stopMin)}</span>
							) : null}
							{parent && parent.id !== scopeId ? (
								<span className="truncate">{parent.name}</span>
							) : null}
						</span>
					</span>
				</>
			) : (
				<>
					<TypeGlyph type={node.type} category={node.category} />
					<span className="min-w-0 truncate">{node.name}</span>
					{parent && parent.id !== scopeId ? (
						<span className="min-w-0 shrink-[100] truncate text-xs text-muted-foreground">
							{parent.name}
						</span>
					) : null}
				</>
			)}
			<span
				className={cn(
					"flex shrink-0 items-center gap-1",
					card ? "self-start pt-1" : "ml-auto pl-1",
				)}
			>
				{card ? null : ghost ? (
					<span className="sr-only">suggested</span>
				) : (
					<RatingDot level={top} />
				)}
				{onAdd && !ghost ? (
					<Button
						variant="ghost"
						size="icon-sm"
						data-testid={OUTLINE_TESTID.ideaAdd}
						aria-label={`Add ${node.name} to the day`}
						disabled={guard.disabled}
						onClick={(e) => {
							e.stopPropagation();
							onAdd(node.id);
						}}
						onPointerDown={(e) => e.stopPropagation()}
					>
						<Plus />
					</Button>
				) : null}
			</span>
		</div>
	);
	return lead ? (
		<ProposalGhost
			marks={marks}
			actions={ghostActions}
			describe="item"
			className="mt-2 mr-3 mb-0.5 ml-1 rounded-sm"
		>
			{row}
		</ProposalGhost>
	) : (
		row
	);
}

/**
 * "Open in Places →" (docs/PLACES.md §5): the bin is a compact shortcut
 * into the Places tab, on its Ideas pill in this scope with the same shared
 * filter (the URL keeps `f`). A plain anchor the router takes over.
 * `offerRate` says when it shows.
 */
function RateIdeasLink({
	where,
	plan = false,
}: {
	where: string | undefined;
	/** The Plan's dock says "See all in Places" (D03). */
	plan?: boolean;
}) {
	const { nav } = useWorkspace();
	const opts = { patch: { pst: "idea" as const, pv: undefined } };
	const onClick = (e: MouseEvent<HTMLAnchorElement>) => {
		if (e.button !== 0) return;
		if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
		e.preventDefault();
		nav.openPlaces(opts);
	};
	return (
		<a
			href={nav.hrefPlaces(opts)}
			onClick={onClick}
			data-testid={OUTLINE_TESTID.rateIdeas}
			aria-label={
				where ? `Open the ideas in ${where} in Places` : "Open in Places"
			}
			title="See, rate and decide on these ideas in the Places tab"
			className="inline-flex h-7 shrink-0 cursor-pointer items-center gap-1 rounded-md px-1.5 text-xs whitespace-nowrap max-md:h-11 text-primary underline-offset-2 hover:underline focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
		>
			{plan ? "See all in Places" : "Open in Places"}
			<ArrowRight className="size-3" aria-hidden />
		</a>
	);
}

function IdeasBinInner({
	embedded = false,
	scopeId: scopeIdProp,
	plan = false,
}: {
	embedded?: boolean;
	scopeId?: string | null;
	plan?: boolean;
}) {
	const { ix, scope, proposals, access, mode, graph, who, sel, days } =
		useWorkspace();
	const { filter, ctx, active: filtering, clear } = usePlaceFilter();
	const openAddPlace = useUi((s) => s.openAddPlace);
	const actions = useOutlineActions();
	const guard = useEditGuard();
	const dnd = useDnd();
	const instance = useId();
	const openKey = plan ? PLAN_OPEN_KEY : OPEN_KEY;
	const [open, setOpenState] = useState(
		() =>
			readPref(openKey, ["1", "0"] as const, plan && narrow() ? "0" : "1") ===
			"1",
	);
	const setOpen = (v: boolean) => {
		setOpenState(v);
		writePref(openKey, v ? "1" : "0");
	};
	const [sort, setSortState] = useState<IdeasSort>(() =>
		readPref(SORT_KEY, IDEAS_SORTS, "priority"),
	);
	const setSort = (s: IdeasSort) => {
		setSortState(s);
		writePref(SORT_KEY, s);
	};
	// FB-21d: the bin's fold and sort travel with my view (not saved as a follower's).
	useFollowValue("outline.ideas", open, setOpenState, bool);
	useFollowValue("outline.isort", sort, setSortState, isIdeasSort);
	// The Plan's dock: the phone's + and Rate pill float above it (--plan-dock-h).
	const dock = useRef<HTMLElement>(null);
	useEffect(() => {
		const el = dock.current;
		if (!plan || !el || typeof ResizeObserver === "undefined") return;
		const root = document.documentElement;
		const ro = new ResizeObserver(() =>
			root.style.setProperty("--plan-dock-h", `${el.offsetHeight}px`),
		);
		ro.observe(el);
		return () => {
			ro.disconnect();
			root.style.removeProperty("--plan-dock-h");
		};
	}, [plan]);
	const scopeId = scopeIdProp !== undefined ? scopeIdProp : (scope?.id ?? null);
	const ghosts = useMemo(
		() => (proposals.show ? ghostNodes(ix, proposals.list) : []),
		[proposals.show, proposals.list, ix],
	);
	const { ideas, total } = useMemo(
		() => ideasFor({ ix, scopeId, filter, ctx, sort, ghosts }),
		[ix, scopeId, filter, ctx, sort, ghosts],
	);
	// The Plan's dock also holds the stops off their day (One Yonder: anything
	// without a day is an idea): a place's stop on its card, the rest on their own.
	const { stopMin, loose } = useMemo(() => {
		const min = new Map<string, number>();
		const rest: string[] = [];
		if (!plan) return { stopMin: min, loose: rest };
		const shown = new Set(ideas.map((e) => e.node.id));
		for (const it of ix.unscheduled) {
			if (hiddenByWho(it, who)) continue;
			if (it.nodeId && shown.has(it.nodeId)) {
				if (!min.has(it.nodeId)) min.set(it.nodeId, it.durationMin);
			} else if (!it.nodeId || !scopeId || ix.isWithin(it.nodeId, scopeId))
				rest.push(it.id);
		}
		return { stopMin: min, loose: rest };
	}, [plan, ideas, ix, who, scopeId]);
	// The day + adds a stop to: the selected day or stop's, else the first in view.
	const addDayId =
		sel?.kind === "day"
			? sel.id
			: sel?.kind === "item"
				? (ix.item(sel.id)?.dayId ?? null)
				: days
					? (ix.dayOfDate(days.from)?.id ?? null)
					: null;
	// A card dropped on the dock comes off its day (it waits here).
	const { setNodeRef: setDropRef, isOver } = useDroppable({
		id: `ideas-dock:${instance}`,
		disabled: !plan,
		data: {
			panel: "plan",
			dayId: null,
			unscheduled: true,
			kbSkip: true,
			dock: true,
			label: "Ideas",
		},
	});

	// The lifted row in the shared DragOverlay while an idea is dragged.
	useDndMonitor({
		onDragStart(e) {
			const d = e.active.data.current as OutlineDragData | undefined;
			if (d?.origin === `ideas:${instance}`)
				dnd.setOverlay("node", renderDragOverlay);
		},
		onDragEnd(e) {
			const d = e.active.data.current as OutlineDragData | undefined;
			if (d?.origin === `ideas:${instance}`) dnd.setOverlay("node", null);
		},
		onDragCancel(e) {
			const d = e.active.data.current as OutlineDragData | undefined;
			if (d?.origin === `ideas:${instance}`) dnd.setOverlay("node", null);
		},
	});

	// Roving focus over the list (↑/↓, Home/End), A to schedule, Enter to select.
	const refs = useRef(new Map<string, HTMLElement>());
	const registerRef = useCallback((id: string, el: HTMLElement | null) => {
		if (el) refs.current.set(id, el);
		else refs.current.delete(id);
	}, []);
	const [focusedId, setFocusedId] = useState<string | null>(null);
	const tabbableId =
		focusedId && ideas.some((e) => e.node.id === focusedId)
			? focusedId
			: (ideas[0]?.node.id ?? null);
	const onKey = (e: KeyboardEvent<HTMLElement>, node: GraphNode) => {
		const i = ideas.findIndex((x) => x.node.id === node.id);
		const focus = (k: number) => {
			const id = ideas[k]?.node.id;
			if (id) refs.current.get(id)?.focus();
		};
		const plain = !e.metaKey && !e.ctrlKey && !e.altKey;
		// The dock's cards run sideways: ← → as well as ↑ ↓.
		if (e.key === "ArrowDown" || e.key === "ArrowRight")
			focus(Math.min(ideas.length - 1, i + 1));
		else if (e.key === "ArrowUp" || e.key === "ArrowLeft")
			focus(Math.max(0, i - 1));
		else if (e.key === "Home") focus(0);
		else if (e.key === "End") focus(ideas.length - 1);
		else if (e.key === "Enter" || e.key === " ")
			// Selects the place (a ghost opens its proposal).
			(e.currentTarget as HTMLElement).click();
		else if (plain && (e.key === "a" || e.key === "A")) {
			if (!guard.disabled && !ideas[i]?.proposalId) actions.schedule(node.id);
		} else return;
		e.preventDefault();
		e.stopPropagation();
	};

	// "Open in Places →" for members who can rate (not link guests or
	// viewers), on the live trip, when a listed idea is one the Places tab
	// shows (not a suggestion, an airport or a stay: `isRateable`).
	const offerRate =
		mode === "live" &&
		!!access.memberId &&
		access.mode !== "read" &&
		ideas.some((e) => !e.proposalId && isRateable(e.node));
	// A filter narrows places: stops without one wait until it's cleared.
	const stops = filtering ? [] : loose;
	const countText =
		filtering && total
			? `${ideas.length} of ${total}`
			: String(total + stops.length);
	const where = scopeId ? ix.node(scopeId)?.name : undefined;

	return (
		<section
			ref={(el) => {
				dock.current = el;
				if (plan) setDropRef(el);
			}}
			data-testid={plan ? PLAN_TESTID.ideas : TESTID.ideasBin}
			data-over={(plan && isOver) || undefined}
			aria-label={plan ? `Ideas in ${where ?? graph.trip.name}` : "Ideas"}
			className={cn(
				"flex shrink-0 flex-col",
				// The Plan's dock sits on the column's foot while its days scroll.
				plan
					? "sticky bottom-0 z-20 mt-6 border-t bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/85"
					: "border-t",
				plan && isOver && "bg-primary/5 ring-2 ring-primary/40 ring-inset",
				!plan && !embedded && "max-h-[40%]",
			)}
		>
			<div className="@container flex h-9 shrink-0 items-center gap-1 pr-2 max-md:h-11">
				<button
					type="button"
					onClick={() => setOpen(!open)}
					aria-expanded={open}
					className={cn(
						"flex h-full min-w-0 flex-1 items-center gap-1.5 overflow-hidden pl-4 whitespace-nowrap hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none focus-visible:ring-inset",
						!plan && "eyebrow",
					)}
				>
					{plan ? (
						open ? (
							<ChevronDown className="size-4 shrink-0 text-muted-foreground" />
						) : (
							<ChevronUp className="size-4 shrink-0 text-muted-foreground" />
						)
					) : open ? (
						<ChevronDown className="size-3 shrink-0" />
					) : (
						<ChevronRight className="size-3 shrink-0" />
					)}
					<span className={plan ? "text-sm font-medium" : undefined}>
						{plan ? `Ideas in ${where ?? graph.trip.name}` : "Ideas"}
					</span>
					{plan ? null : <span aria-hidden>·</span>}
					<span
						className={cn(
							"tnum",
							plan
								? "text-meta text-muted-foreground"
								: "normal-case tracking-normal",
						)}
						data-testid={OUTLINE_TESTID.ideasCount}
					>
						{countText}
					</span>
					{plan && total + stops.length > 0 && !guard.disabled ? (
						<span className="truncate text-meta text-muted-foreground max-sm:hidden">
							· drag onto a day or tap +
						</span>
					) : null}
				</button>
				{offerRate ? <RateIdeasLink where={where} plan={plan} /> : null}
				<DropdownMenu>
					<DropdownMenuTrigger asChild>
						<Button
							variant="ghost"
							size="xs"
							className={cn(
								"h-7 gap-1 px-1.5 text-xs font-normal text-muted-foreground",
								// The phone's dock has no room: Places sorts them too.
								plan && "max-sm:hidden",
							)}
							data-testid={OUTLINE_TESTID.ideasSort}
							aria-label={`Sort ideas: ${IDEAS_SORT_LABEL[sort]}`}
						>
							<ArrowDownUp className="size-3" />
							{/* The 264px sidebar has no room for it next to "Rate ideas". */}
							<span className={offerRate ? "hidden @[20rem]:inline" : ""}>
								{IDEAS_SORT_LABEL[sort]}
							</span>
						</Button>
					</DropdownMenuTrigger>
					<DropdownMenuContent
						align="end"
						className="w-44"
						onEscapeKeyDown={(e) => e.stopPropagation()}
					>
						<DropdownMenuLabel className="text-xs font-normal text-muted-foreground">
							Sort ideas by
						</DropdownMenuLabel>
						<DropdownMenuRadioGroup
							value={sort}
							onValueChange={(v) => setSort(v as IdeasSort)}
						>
							{IDEAS_SORTS.map((s) => (
								<DropdownMenuRadioItem key={s} value={s}>
									{IDEAS_SORT_LABEL[s]}
								</DropdownMenuRadioItem>
							))}
						</DropdownMenuRadioGroup>
					</DropdownMenuContent>
				</DropdownMenu>
			</div>
			{open ? (
				ideas.length || stops.length ? (
					<div
						role="listbox"
						aria-label={where ? `Ideas in ${where}` : "Ideas"}
						aria-orientation={plan ? "horizontal" : undefined}
						className={cn(
							"min-h-0 pb-2",
							!embedded && !plan && "overflow-y-auto",
							plan &&
								"flex gap-2 overflow-x-auto overscroll-x-contain px-4 pt-0.5 pb-3 [scrollbar-width:thin]",
						)}
					>
						{ideas.map((entry) => (
							<IdeaRow
								key={entry.node.id}
								entry={entry}
								instance={instance}
								scopeId={scopeId}
								tabbable={tabbableId === entry.node.id}
								onFocusRow={setFocusedId}
								onKey={onKey}
								registerRef={registerRef}
								onAdd={plan ? (id) => actions.schedule(id) : undefined}
								card={plan}
								stopMin={stopMin.get(entry.node.id) ?? null}
							/>
						))}
						{stops.map((id) => (
							<DockStop key={id} itemId={id} dayId={addDayId} />
						))}
					</div>
				) : filtering && total > 0 ? (
					<div className="flex items-center justify-between gap-2 px-4 pb-3 text-xs text-muted-foreground">
						<span>No ideas match the filter.</span>
						<Button
							variant="link"
							size="xs"
							className="h-6 px-0"
							onClick={clear}
						>
							Clear filter
						</Button>
					</div>
				) : (
					<div className="flex flex-col items-start gap-2 px-4 pb-4">
						<p className="flex items-center gap-1.5 font-display text-body text-foreground">
							<Lightbulb
								className="size-4 text-muted-foreground"
								strokeWidth={1.5}
							/>
							No saved ideas here.
						</p>
						{access.isGuest && access.mode === "read" ? null : (
							<Button
								variant="outline"
								size="xs"
								disabled={guard.disabled}
								title={guard.reason ?? undefined}
								onClick={() =>
									openAddPlace({
										mode: "search",
										...(scopeId ? { parentId: scopeId } : {}),
									})
								}
							>
								Search places
							</Button>
						)}
					</div>
				)
			) : null}
		</section>
	);
}

export function IdeasBin(
	props: {
		embedded?: boolean;
		/** Whose ideas (default: the scope's). */
		scopeId?: string | null;
		/** Under the Plan's days, with + to add each to the day in view. */
		plan?: boolean;
	} = {},
) {
	const { inContext } = useDnd();
	const body = <IdeasBinInner {...props} />;
	return inContext ? body : <WorkspaceDnd>{body}</WorkspaceDnd>;
}
