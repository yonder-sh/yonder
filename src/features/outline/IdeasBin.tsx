/**
 * The Ideas bin (SPEC §12.5 `IdeasBin()`, DESIGN §4.2): places in the scope
 * that aren't on the plan yet, pinned to the bottom of the Outline (at most
 * 40% of its height). Rows show one rating as dot + label (the max over
 * members; PLACES §1c: dense lists use dots, not pills) and sort by the
 * owner's rule (SPEC §7.3) by default, or by name or recency. The
 * shared filter (ADDENDUM §10, `?f=`) narrows them. Drag a row onto a Plan day
 * to schedule it, or press **A** on a focused row to add it to the focused
 * day. Proposed places (E7) sort in like any other, drawn as ghosts.
 */
import { useDndMonitor, useDraggable } from "@dnd-kit/core";
import { cn } from "cn";
import {
	ArrowDownUp,
	ArrowRight,
	ChevronDown,
	ChevronRight,
	Lightbulb,
} from "lucide-react";
import {
	type KeyboardEvent,
	type MouseEvent,
	useCallback,
	useId,
	useMemo,
	useRef,
	useState,
} from "react";
import { useDnd, WorkspaceDnd } from "@/components/common/dnd/workspace-dnd";
import { useEditGuard } from "@/components/common/edit-guard";
import { TypeGlyph } from "@/components/common/glyphs";
import { PriorityDot } from "@/components/common/priority-dot";
import {
	describeMark,
	leadMark,
	ProposalGhost,
} from "@/components/common/proposal-ghost";
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
import type { GraphNode } from "@/lib/engine/types";
import { bool, oneOf, useFollowValue } from "@/lib/realtime/view-ui";
import { TESTID } from "@/lib/testids";
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
}: {
	entry: IdeaEntry;
	instance: string;
	scopeId: string | null;
	tabbable: boolean;
	onFocusRow(id: string): void;
	onKey(e: KeyboardEvent<HTMLElement>, node: GraphNode): void;
	registerRef(id: string, el: HTMLElement | null): void;
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
			className={cn(
				"group/idea relative flex h-7 cursor-pointer touch-manipulation items-center gap-1.5 pr-2 pl-4 text-sm outline-none select-none max-md:h-11",
				"hover:bg-sidebar-accent focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset",
				selected &&
					"bg-card before:absolute before:inset-y-0 before:left-0 before:w-0.5 before:bg-primary",
				isDragging && "opacity-40",
				proposed && "text-muted-foreground",
			)}
		>
			<TypeGlyph type={node.type} category={node.category} />
			<span className="min-w-0 truncate">{node.name}</span>
			{parent && parent.id !== scopeId ? (
				<span className="min-w-0 shrink-[100] truncate text-xs text-muted-foreground">
					{parent.name}
				</span>
			) : null}
			<span className="ml-auto flex shrink-0 items-center pl-1">
				{ghost ? (
					<span className="sr-only">suggested</span>
				) : (
					<PriorityDot priority={top} />
				)}
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
function RateIdeasLink({ where }: { where: string | undefined }) {
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
			Open in Places
			<ArrowRight className="size-3" aria-hidden />
		</a>
	);
}

function IdeasBinInner({ embedded = false }: { embedded?: boolean }) {
	const { ix, scope, proposals, access, mode } = useWorkspace();
	const { filter, ctx, active: filtering, clear } = usePlaceFilter();
	const openAddPlace = useUi((s) => s.openAddPlace);
	const actions = useOutlineActions();
	const guard = useEditGuard();
	const dnd = useDnd();
	const instance = useId();
	const [open, setOpenState] = useState(
		() => readPref(OPEN_KEY, ["1", "0"] as const, "1") === "1",
	);
	const setOpen = (v: boolean) => {
		setOpenState(v);
		writePref(OPEN_KEY, v ? "1" : "0");
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
	const scopeId = scope?.id ?? null;
	const ghosts = useMemo(
		() => (proposals.show ? ghostNodes(ix, proposals.list) : []),
		[proposals.show, proposals.list, ix],
	);
	const { ideas, total } = useMemo(
		() => ideasFor({ ix, scopeId, filter, ctx, sort, ghosts }),
		[ix, scopeId, filter, ctx, sort, ghosts],
	);

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
		if (e.key === "ArrowDown") focus(Math.min(ideas.length - 1, i + 1));
		else if (e.key === "ArrowUp") focus(Math.max(0, i - 1));
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
	const countText =
		filtering && total ? `${ideas.length} of ${total}` : String(total);
	const where = scope?.name;

	return (
		<section
			data-testid={TESTID.ideasBin}
			aria-label="Ideas"
			className={cn(
				"flex shrink-0 flex-col border-t",
				embedded ? "" : "max-h-[40%]",
			)}
		>
			<div className="@container flex h-9 shrink-0 items-center gap-1 pr-2 max-md:h-11">
				<button
					type="button"
					onClick={() => setOpen(!open)}
					aria-expanded={open}
					className="flex h-full min-w-0 flex-1 items-center gap-1.5 overflow-hidden pl-4 text-[11px] font-semibold tracking-[.06em] whitespace-nowrap text-muted-foreground uppercase hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none focus-visible:ring-inset"
				>
					{open ? (
						<ChevronDown className="size-3 shrink-0" />
					) : (
						<ChevronRight className="size-3 shrink-0" />
					)}
					<span>Ideas</span>
					<span aria-hidden>·</span>
					<span
						className="font-mono normal-case tracking-normal tnum"
						data-testid={OUTLINE_TESTID.ideasCount}
					>
						{countText}
					</span>
				</button>
				{offerRate ? <RateIdeasLink where={where} /> : null}
				<DropdownMenu>
					<DropdownMenuTrigger asChild>
						<Button
							variant="ghost"
							size="xs"
							className="h-7 gap-1 px-1.5 text-xs font-normal text-muted-foreground"
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
				ideas.length ? (
					<div
						role="listbox"
						aria-label={where ? `Ideas in ${where}` : "Ideas"}
						className={cn("min-h-0 pb-2", !embedded && "overflow-y-auto")}
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
							/>
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
						<p className="flex items-center gap-1.5 font-display text-[15px] text-foreground">
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

export function IdeasBin({ embedded }: { embedded?: boolean } = {}) {
	const { inContext } = useDnd();
	const body = <IdeasBinInner embedded={embedded} />;
	return inContext ? body : <WorkspaceDnd>{body}</WorkspaceDnd>;
}
