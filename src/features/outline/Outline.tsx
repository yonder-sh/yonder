/**
 * The place tree (SPEC §12.5 `Outline()`, §18.3 WP-Outline; DESIGN §4.2).
 *
 * The spikes/dnd flattened sortable tree inside the workspace's one
 * `WorkspaceDnd`: an ARIA `tree` with roving focus, arrow keys (→/← open and
 * close, ↑/↓ move), typeahead, Enter to zoom in, F2 to rename, Delete, and
 * **A** to add a focused place to the focused day. Drag a row to re-parent or
 * reorder (the rank rule is checked while dragging and again by the server),
 * or onto the Plan to schedule it; Space/arrows/Space does the same from the
 * keyboard, announced in a polite live region. A context menu (and a ⋯ button
 * for touch) holds Open, Add inside, Rename, Change type, Move…, Set location,
 * My priority, Drop/Restore and Delete (with Undo).
 *
 * Also: the level filter (Everything / Areas / Cities, HIER-07), the shared
 * place filter (ADDENDUM §10, `?f=`), the "Dropped · N" group, presence dots,
 * and E7 marks: dashed ghosts for proposed places and origin rows at the old
 * parent of a proposed move.
 */
import {
	SortableContext,
	verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { cn } from "cn";
import {
	ChevronDown,
	ChevronRight,
	ChevronsDownUp,
	ChevronsUpDown,
	MoreHorizontal,
	Plus,
} from "lucide-react";
import {
	type KeyboardEvent,
	useCallback,
	useEffect,
	useId,
	useMemo,
	useRef,
	useState,
} from "react";
import { useDnd, WorkspaceDnd } from "@/components/common/dnd/workspace-dnd";
import { EditGuard, useEditGuard } from "@/components/common/edit-guard";
import { EmptyState } from "@/components/common/empty-state";
import { Button } from "@/components/ui/button";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuLabel,
	DropdownMenuRadioGroup,
	DropdownMenuRadioItem,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import type { ProposalMark } from "@/lib/engine/proposals";
import { formatDayDate } from "@/lib/format";
import { usePresence } from "@/lib/realtime/presence";
import { isBool, oneOf, useMirror } from "@/lib/realtime/view-ui";
import { TESTID } from "@/lib/testids";
import { matchesFilter } from "@/lib/workspace/filter-match";
import { useUi } from "@/lib/workspace/ui-store";
import { useWorkspace } from "@/lib/workspace/use-workspace";
import { PlaceFilterButton, PlaceFilterSummary } from "./FilterMenu";
import { ghostNodes, originsByParent } from "./ghosts";
import { IdeasBin } from "./IdeasBin";
import { useMenuHandoff } from "./NodeMenu";
import {
	DeleteNodeDialog,
	deleteImpact,
	impactLines,
	MoveNodeDialog,
} from "./OutlineDialogs";
import {
	AddChildRow,
	DroppedNodeRow,
	GhostRow,
	OriginRowView,
	type RowContext,
	TreeNodeRow,
} from "./OutlineRows";
import { type OutlineUi, OutlineUiProvider, ROOT_KEY } from "./outline-context";
import { OUTLINE_TESTID } from "./testids";
import {
	buildRows,
	foldText,
	LEVEL_LABEL,
	type NodeRow,
	type OutlineLevel,
	type OutlineRow,
	typeahead,
} from "./tree-rows";
import { useIsSmall } from "./use-is-small";
import { useOutlineActions } from "./use-outline-actions";
import { useOutlineDnd } from "./use-outline-dnd";
import { useFilterVisibility } from "./use-place-filter";
import { useTreeExpand } from "./use-tree-expand";

const LEVEL_KEY = "yonder:outline:level";
const LEVELS: OutlineLevel[] = ["all", "area", "city"];
const isLevel = oneOf<OutlineLevel>(LEVELS);

function readLevel(): OutlineLevel {
	try {
		const v = globalThis.localStorage?.getItem(LEVEL_KEY);
		return v && (LEVELS as string[]).includes(v) ? (v as OutlineLevel) : "all";
	} catch {
		return "all";
	}
}

const NO_MARKS: readonly ProposalMark[] = [];

function DroppedHeader({
	count,
	open,
	onToggle,
	rc,
}: {
	count: number;
	open: boolean;
	onToggle(): void;
	rc: RowContext;
}) {
	return (
		<div
			ref={(e) => rc.registerRef("dropped", e)}
			role="treeitem"
			aria-level={1}
			aria-expanded={open}
			aria-selected={false}
			tabIndex={rc.focusedId === "dropped" ? 0 : -1}
			data-testid={OUTLINE_TESTID.droppedGroup}
			onFocus={(e) => e.target === e.currentTarget && rc.onRowFocus("dropped")}
			onClick={onToggle}
			onKeyDown={(e) => {
				if (rc.onRowKey(e, "dropped")) return;
				if (e.key === "Enter" || e.key === " ") {
					e.preventDefault();
					onToggle();
				}
			}}
			className="mt-1 flex h-8 cursor-pointer items-center gap-1.5 border-t pl-2 text-[11px] font-semibold tracking-[.06em] text-muted-foreground uppercase outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset max-md:h-11"
		>
			{open ? (
				<ChevronDown className="size-3" />
			) : (
				<ChevronRight className="size-3" />
			)}
			Dropped · <span className="font-mono tnum">{count}</span>
		</div>
	);
}

function OutlineInner() {
	const { ix, scope, sel, graph, proposals, counts, nav } = useWorkspace();
	const instance = useId();
	const small = useIsSmall();
	const guard = useEditGuard();
	const openAddPlace = useUi((s) => s.openAddPlace);
	const headerMenu = useMenuHandoff();

	// -- announcer -------------------------------------------------------------
	const [liveText, setLiveText] = useState("");
	const announce = useCallback((text: string) => {
		setLiveText("");
		setTimeout(() => setLiveText(text), 30);
	}, []);
	const actions = useOutlineActions(announce);

	// -- filters ---------------------------------------------------------------
	const { filter, ctx, vis, active: filtering } = useFilterVisibility();
	const [level, setLevelState] = useState<OutlineLevel>(readLevel);
	const setLevel = (l: OutlineLevel) => {
		setLevelState(l);
		try {
			globalThis.localStorage?.setItem(LEVEL_KEY, l);
		} catch {
			// ignore
		}
	};
	const [droppedOpen, setDroppedOpen] = useState(false);
	// FB-21d: the level and the "Dropped" fold travel with my view; a
	// follower mirrors them (without saving the leader's level as theirs).
	useMirror("outline.level", level, setLevelState, isLevel);
	useMirror("outline.dropped", droppedOpen, setDroppedOpen, isBool);

	// -- expand state ----------------------------------------------------------
	const autoOpen = useMemo(() => {
		const s = new Set<string>();
		if (scope) for (const n of ix.path(scope.id)) s.add(n.id);
		if (sel?.kind === "node")
			for (const n of ix.path(sel.id)) if (n.id !== sel.id) s.add(n.id);
		return s;
	}, [ix, scope, sel]);
	const expand = useTreeExpand(autoOpen);

	// -- E7 marks ----------------------------------------------------------------
	const ghostsAll = useMemo(
		() => (proposals.show ? ghostNodes(ix, proposals.list) : []),
		[proposals.show, proposals.list, ix],
	);
	const ghosts = useMemo(
		() =>
			filtering
				? ghostsAll.filter((g) => matchesFilter(g.node, filter, ctx))
				: ghostsAll,
		[ghostsAll, filtering, filter, ctx],
	);
	const origins = useMemo(
		() => originsByParent(proposals.marks),
		[proposals.marks],
	);
	const visible = useMemo(() => {
		if (!vis) return null;
		const v = new Set(vis.visible);
		for (const g of ghosts)
			if (g.node.parentId)
				for (const a of ix.path(g.node.parentId)) v.add(a.id);
		return v;
	}, [vis, ghosts, ix]);

	// -- rows --------------------------------------------------------------------
	const [dragFold, setDragFold] = useState<string | null>(null);
	const isOpen = useCallback(
		(id: string) => (filtering ? !expand.isClosed(id) : expand.isOpen(id)),
		[filtering, expand],
	);
	const rows = useMemo(
		() =>
			buildRows({
				ix,
				isOpen,
				level,
				visible,
				foldId: dragFold,
				ghosts,
				origins,
				droppedOpen,
			}),
		[ix, isOpen, level, visible, dragFold, ghosts, origins, droppedOpen],
	);
	const treeRows = useMemo(
		() =>
			rows.filter(
				(r): r is NodeRow => r.kind === "node" && r.section === "tree",
			),
		[rows],
	);

	// -- drag ------------------------------------------------------------------
	const reveal = useCallback(
		(id: string) => {
			if (!expand.isOpen(id)) expand.setOpen(id, true);
		},
		[expand],
	);
	const dnd = useOutlineDnd({
		instance,
		ix,
		rows: treeRows,
		actions,
		announce,
		reveal,
	});
	useEffect(() => setDragFold(dnd.draggingId), [dnd.draggingId]);
	const sortableIds = useMemo(
		() => treeRows.map((r) => dnd.sortableId(r.id)),
		[treeRows, dnd],
	);

	// -- presence ----------------------------------------------------------------
	const { clients } = usePresence();
	const presence = useMemo(() => {
		const m = new Map<string, { color: number; name: string }[]>();
		const seen = new Set<string>();
		for (const p of clients) {
			const v = p.view;
			if (!v) continue;
			const at = v.sel?.startsWith("n.") ? v.sel.slice(2) : v.scopeId;
			if (!at) continue;
			const key = `${p.user.id}:${at}`;
			if (seen.has(key)) continue;
			seen.add(key);
			const list = m.get(at) ?? [];
			list.push({ color: p.user.color, name: p.user.name });
			m.set(at, list);
		}
		return m;
	}, [clients]);
	const stays = useMemo(
		() =>
			new Set(
				ix.days.map((d) => d.nightNodeId).filter((x): x is string => !!x),
			),
		[ix],
	);

	// -- UI state (rename, add, dialogs) ---------------------------------------
	const [renamingId, setRenamingId] = useState<string | null>(null);
	const [addingUnder, setAddingUnder] = useState<string | null>(null);
	const [moveId, setMoveId] = useState<string | null>(null);
	const [deleteId, setDeleteId] = useState<string | null>(null);
	const focusedDay = actions.focusedDayId();
	const focusedDayLabel = focusedDay
		? (() => {
				const d = ix.day(focusedDay);
				return d
					? `Day ${ix.dayNumber(focusedDay)} · ${formatDayDate(d.date)}`
					: null;
			})()
		: null;
	const requestDelete = useCallback(
		(nodeId: string) => {
			const lines = impactLines(deleteImpact(ix, counts, nodeId));
			if (lines.length) setDeleteId(nodeId);
			else actions.remove(nodeId);
		},
		[ix, counts, actions],
	);
	const ui = useMemo<OutlineUi>(
		() => ({
			actions,
			announce,
			renamingId,
			setRenamingId,
			addingUnder,
			startAddChild: (parentId) => {
				if (parentId) expand.setOpen(parentId, true);
				setAddingUnder(parentId ?? ROOT_KEY);
			},
			stopAddChild: () => setAddingUnder(null),
			requestMove: setMoveId,
			requestDelete,
			focusedDayLabel,
		}),
		[
			actions,
			announce,
			renamingId,
			addingUnder,
			expand,
			requestDelete,
			focusedDayLabel,
		],
	);

	// -- roving focus + keys ---------------------------------------------------
	const refs = useRef(new Map<string, HTMLElement>());
	const registerRef = useCallback((id: string, el: HTMLElement | null) => {
		if (el) refs.current.set(id, el);
		else refs.current.delete(id);
	}, []);
	const focusable = useMemo(
		() => rows.map((r) => ({ id: r.id, row: r })),
		[rows],
	);
	const [focusedId, setFocusedId] = useState<string | null>(null);
	const selectedId = sel?.kind === "node" ? sel.id : null;
	const tabbableId =
		(focusedId && focusable.some((f) => f.id === focusedId) && focusedId) ||
		(selectedId && focusable.some((f) => f.id === selectedId) && selectedId) ||
		(scope && focusable.some((f) => f.id === scope.id) && scope.id) ||
		focusable[0]?.id ||
		null;
	const focusRow = (id: string | undefined) => {
		if (id) refs.current.get(id)?.focus();
	};
	const typeBuf = useRef({ text: "", at: 0 });

	const onRowKey = (e: KeyboardEvent<HTMLElement>, id: string): boolean => {
		// A keyboard drag owns the keys (dnd-kit listens on the document).
		if (dnd.draggingId) return true;
		const i = focusable.findIndex((f) => f.id === id);
		const row = focusable[i]?.row as OutlineRow | undefined;
		if (!row) return false;
		const plain = !e.metaKey && !e.ctrlKey && !e.altKey;
		const node = row.kind === "node" ? row.node : null;
		const done = () => {
			e.preventDefault();
			e.stopPropagation();
			return true;
		};
		switch (e.key) {
			case "ArrowDown":
				focusRow(focusable[i + 1]?.id);
				return done();
			case "ArrowUp":
				focusRow(focusable[i - 1]?.id);
				return done();
			case "Home":
				focusRow(focusable[0]?.id);
				return done();
			case "End":
				focusRow(focusable.at(-1)?.id);
				return done();
			case "ArrowRight":
				if (row.kind === "node" && row.hasChildren) {
					if (!row.open) expand.setOpen(row.id, true);
					else focusRow(focusable[i + 1]?.id);
				} else if (row.kind === "dropped-header" && !row.open)
					setDroppedOpen(true);
				return done();
			case "ArrowLeft":
				if (row.kind === "node" && row.open) expand.setOpen(row.id, false);
				else if (row.kind === "dropped-header" && row.open)
					setDroppedOpen(false);
				else if (row.kind !== "dropped-header" && row.parentId)
					focusRow(row.parentId);
				return done();
			case "Enter":
				if (!node) return false;
				nav.zoomIn(node.id);
				return done();
			case "F2":
				if (!node || guard.disabled) return done();
				setRenamingId(node.id);
				return done();
			case "Delete":
			case "Backspace":
				if (!node || guard.disabled) return done();
				requestDelete(node.id);
				return done();
		}
		// Typeahead takes letters and digits only: `[`, `]`, `?` and the like
		// stay workspace keys (lens, shortcuts) while a row has focus.
		if (!plain || e.key.length !== 1 || !/^[\p{L}\p{N}]$/u.test(e.key))
			return false;
		// A: add the focused place to the focused day (DESIGN §13), unless a
		// typeahead word is being typed ("As…akusa").
		const now = Date.now();
		const buf = now - typeBuf.current.at < 700 ? typeBuf.current.text : "";
		if ((e.key === "a" || e.key === "A") && !buf && node?.type === "place") {
			if (!guard.disabled) actions.schedule(node.id);
			return done();
		}
		const text = buf + e.key;
		typeBuf.current = { text, at: now };
		const names = focusable
			.filter((f) => f.row.kind === "node" || f.row.kind === "ghost")
			.map((f) => ({
				id: f.id,
				name:
					f.row.kind === "node" || f.row.kind === "ghost"
						? f.row.node.name
						: "",
			}));
		const from = names.findIndex((n) => n.id === id);
		const hit = typeahead(names, Math.max(0, from), foldText(text));
		if (hit) focusRow(hit);
		return done();
	};

	const marksOf = useCallback(
		(nodeId: string) => proposals.marks.get(`node:${nodeId}`) ?? NO_MARKS,
		[proposals.marks],
	);
	const rc: RowContext = {
		selectedId,
		scopeId: scope?.id ?? null,
		scheduled: ix.scheduledNodeIds,
		stays,
		presence,
		marks: marksOf,
		focusedId: tabbableId,
		onRowKey,
		onRowFocus: setFocusedId,
		registerRef,
		toggle: (id, open) => expand.setOpen(id, open),
		projection: dnd.projection,
		draggingId: dnd.draggingId,
		sortableId: dnd.sortableId,
		instance,
	};

	// Keep the scope's row in view when the scope changes.
	const scopeId = scope?.id ?? null;
	useEffect(() => {
		if (!scopeId) return;
		const el = refs.current.get(scopeId);
		el?.scrollIntoView?.({ block: "nearest" });
	}, [scopeId]);

	// -- render ------------------------------------------------------------------
	const matchedCount = vis?.matched.size ?? 0;
	const addRow = (parentKey: string, depth: number) =>
		addingUnder === parentKey ? (
			<AddChildRow
				key={`add:${parentKey}`}
				parentId={parentKey === ROOT_KEY ? null : parentKey}
				depth={depth}
			/>
		) : null;

	// "Add inside…" goes after the parent's last visible descendant.
	let addAfter = -1;
	let addDepth = 0;
	if (addingUnder && addingUnder !== ROOT_KEY) {
		const at = rows.findIndex((r) => r.kind === "node" && r.id === addingUnder);
		if (at >= 0) {
			const parentDepth = (rows[at] as OutlineRow).depth;
			let j = at + 1;
			while (j < rows.length && (rows[j] as OutlineRow).depth > parentDepth)
				j++;
			addAfter = j - 1;
			addDepth = parentDepth + 1;
		}
	}
	const rendered: React.ReactNode[] = [];
	rows.forEach((r, i) => {
		if (r.kind === "node" && r.section === "tree")
			rendered.push(<TreeNodeRow key={r.id} row={r} rc={rc} />);
		else if (r.kind === "node")
			rendered.push(<DroppedNodeRow key={`d:${r.id}`} row={r} rc={rc} />);
		else if (r.kind === "ghost")
			rendered.push(<GhostRow key={`g:${r.id}`} row={r} rc={rc} />);
		else if (r.kind === "origin")
			rendered.push(<OriginRowView key={r.id} row={r} rc={rc} />);
		else
			rendered.push(
				<DroppedHeader
					key="dropped"
					count={r.count}
					open={r.open}
					onToggle={() => setDroppedOpen((o) => !o)}
					rc={rc}
				/>,
			);
		if (i === addAfter && addingUnder)
			rendered.push(addRow(addingUnder, addDepth));
	});
	const rootAdd = addingUnder === ROOT_KEY ? addRow(ROOT_KEY, 0) : null;

	return (
		<OutlineUiProvider value={ui}>
			<div
				data-testid={TESTID.outline}
				className="flex min-h-0 flex-1 flex-col"
			>
				<div className="flex h-9 shrink-0 items-center gap-0.5 pr-2 pl-4">
					{/* The mobile drawer already has its own "Outline" title. */}
					<span className="flex-1 text-[11px] font-semibold tracking-[.06em] text-muted-foreground uppercase max-md:opacity-0">
						Outline
					</span>
					<PlaceFilterButton />
					<EditGuard>
						<Button
							variant="ghost"
							size="icon"
							className="size-7"
							aria-label="Add a place"
							onClick={() =>
								openAddPlace({
									mode: "search",
									...(scope ? { parentId: scope.id } : {}),
								})
							}
						>
							<Plus className="size-4" />
						</Button>
					</EditGuard>
					<DropdownMenu>
						<DropdownMenuTrigger asChild>
							<Button
								variant="ghost"
								size="icon"
								className="size-7"
								aria-label="Outline options"
								data-testid={OUTLINE_TESTID.headerMenu}
							>
								<MoreHorizontal className="size-4" />
							</Button>
						</DropdownMenuTrigger>
						<DropdownMenuContent
							align="end"
							className="w-52"
							onEscapeKeyDown={(e) => e.stopPropagation()}
							onCloseAutoFocus={headerMenu.onCloseAutoFocus}
						>
							<DropdownMenuLabel className="text-xs font-normal text-muted-foreground">
								Show
							</DropdownMenuLabel>
							<DropdownMenuRadioGroup
								value={level}
								onValueChange={(v) => setLevel(v as OutlineLevel)}
							>
								{LEVELS.map((l) => (
									<DropdownMenuRadioItem key={l} value={l}>
										{LEVEL_LABEL[l]}
									</DropdownMenuRadioItem>
								))}
							</DropdownMenuRadioGroup>
							<DropdownMenuSeparator />
							<DropdownMenuItem
								onSelect={() =>
									expand.setMany(
										ix.outline
											.filter((n) => ix.children(n.id).length)
											.map((n) => n.id),
										true,
									)
								}
							>
								<ChevronsUpDown />
								Expand all
							</DropdownMenuItem>
							<DropdownMenuItem
								onSelect={() =>
									expand.setMany(
										ix.outline
											.filter((n) => ix.children(n.id).length)
											.map((n) => n.id),
										false,
									)
								}
							>
								<ChevronsDownUp />
								Collapse all
							</DropdownMenuItem>
							<DropdownMenuSeparator />
							<DropdownMenuItem
								disabled={guard.disabled}
								onSelect={headerMenu.handOff(() =>
									ui.startAddChild(scope?.id ?? null),
								)}
							>
								<Plus />
								{scope ? `New place in ${scope.name}` : "New country or place"}
							</DropdownMenuItem>
						</DropdownMenuContent>
					</DropdownMenu>
				</div>
				<PlaceFilterSummary count={matchedCount} />
				{level !== "all" ? (
					<div className="flex h-7 shrink-0 items-center justify-between gap-2 pr-2 pl-4 text-xs text-muted-foreground">
						<span>Showing {LEVEL_LABEL[level].toLowerCase()} only</span>
						<Button
							variant="link"
							size="xs"
							className="h-6 px-0"
							onClick={() => setLevel("all")}
						>
							Show everything
						</Button>
					</div>
				) : null}
				{graph.nodes.length === 0 ? (
					<EmptyState
						line="Where to first?"
						action={
							<EditGuard>
								<Button
									size="sm"
									onClick={() => openAddPlace({ mode: "first" })}
								>
									Search places
								</Button>
							</EditGuard>
						}
					/>
				) : (
					<div
						role="tree"
						aria-label="Places"
						className={cn(
							"min-h-0 flex-1 pb-2",
							// Deep trees scroll sideways instead of cutting names to "D…" (HIER-02).
							small ? "" : "overflow-auto",
							// DESIGN §6: 44px touch rows in the mobile drawer.
							"max-md:[&_[role=treeitem]]:h-11",
						)}
					>
						<SortableContext
							items={sortableIds}
							strategy={verticalListSortingStrategy}
						>
							{rendered}
						</SortableContext>
						{rootAdd}
						{filtering && matchedCount === 0 && ghosts.length === 0 ? (
							<div className="flex items-center justify-between gap-2 px-4 py-3 text-xs text-muted-foreground">
								<span>No places match the filter.</span>
							</div>
						) : null}
					</div>
				)}
				{small ? <IdeasBin embedded /> : null}
				<div
					aria-live="polite"
					role="status"
					className="sr-only"
					data-testid={OUTLINE_TESTID.live}
				>
					{liveText}
				</div>
				<MoveNodeDialog nodeId={moveId} onClose={() => setMoveId(null)} />
				<DeleteNodeDialog nodeId={deleteId} onClose={() => setDeleteId(null)} />
			</div>
		</OutlineUiProvider>
	);
}

export function Outline() {
	// The workspace mounts one `WorkspaceDnd`; stand-alone renders get their own.
	const { inContext } = useDnd();
	return inContext ? (
		<OutlineInner />
	) : (
		<WorkspaceDnd>
			<OutlineInner />
		</WorkspaceDnd>
	);
}
