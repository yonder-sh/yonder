/**
 * One list (Todo or Shopping) over a scope: the header (View, the person
 * filter, "Near …" for shopping), the add row, and the groups for the View
 * (EXTENSIONS §7 UX; DESIGN §7.3). Used by the Lists tab (one or two boards)
 * and the inspector's `ListsPanel`.
 *
 * - Groups: a sticky head with the open count; done rows fold at the end
 *   ("3 done ▸"); a group with nothing open moves its done rows to a trailing
 *   "Done" fold.
 * - Quick complete: optimistic, silent, 4 s in place, then folds.
 * - The glow dot: only the first "open now" row of a group.
 */
import {
	SortableContext,
	verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { cn } from "cn";
import { ChevronRight, Lock, MapPin, Plus, User } from "lucide-react";
import {
	type ReactNode,
	type RefObject,
	useCallback,
	useEffect,
	useId,
	useMemo,
	useRef,
	useState,
} from "react";
import { Crumbs } from "@/components/common/crumbs";
import { type DragData, useDnd } from "@/components/common/dnd/workspace-dnd";
import { useEditGuard } from "@/components/common/edit-guard";
import { EmptyState } from "@/components/common/empty-state";
import { assignableMembers, resolveMember } from "@/components/common/member";
import { Button } from "@/components/ui/button";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectSeparator,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { useHoursIssues } from "@/features/insights/use-hours-issues";
import { MentionInput } from "@/features/notes/MentionInput";
import { dueCtxOf, dueState, effectiveDue } from "@/lib/engine/due";
import {
	bool,
	oneOf,
	useFollowState,
	useFollowValue,
} from "@/lib/realtime/view-ui";
import type { ListKind } from "@/lib/schemas/enums";
import type { BundleTarget } from "@/lib/schemas/targets";
import { useWorkspace } from "@/lib/workspace/use-workspace";
import { ListRow, type RowCtx } from "./ListRow";
import {
	defaultView,
	droppedRowIds,
	filterRows,
	groupRows,
	groupTarget,
	type ListGroup,
	type ListsView,
	nearAnchor,
	rollupRows,
	type ScopeOptions,
	targetLabel,
	VIEW_LABEL,
	viewsFor,
} from "./list-model";
import type { ListItemDto } from "./lists.functions";
import { PlacePicker } from "./pickers";
import { sameTarget } from "./queries";
import { LISTS_TESTID } from "./testids";
import { useListActions } from "./use-list-actions";
import { useNow } from "./use-now";
import { useShowDone } from "./use-show-done";

const LINGER_MS = 4_000;

/** A view a follower may take for each list (the other list has other views). */
const VIEW_OF = {
	todo: oneOf<ListsView>(viewsFor("todo")),
	shopping: oneOf<ListsView>(viewsFor("shopping")),
} as const;

/** The View per trip, scope and list (`yonder:lists:<tripId>:<root|scope>:<kind>`). */
export function useListsView(
	kind: ListKind,
	atRoot: boolean,
	storageScope: string,
): [ListsView, (v: ListsView) => void, (v: ListsView) => void] {
	const { graph } = useWorkspace();
	const key = `yonder:lists:${graph.trip.id}:${storageScope}:${kind}`;
	const fallback = defaultView(kind, atRoot);
	const [view, setView] = useState<ListsView>(fallback);
	useEffect(() => {
		try {
			const v = localStorage.getItem(key) as ListsView | null;
			setView(v && viewsFor(kind).includes(v) ? v : fallback);
		} catch {
			setView(fallback);
		}
	}, [key, kind, fallback]);
	const set = useCallback(
		(v: ListsView) => {
			setView(v);
			try {
				localStorage.setItem(key, v);
			} catch {
				// storage blocked: the choice lasts this visit
			}
		},
		[key],
	);
	// The third: show a View without remembering it (a followed one).
	return [view, set, setView];
}

export type BoardProps = {
	kind: ListKind;
	items: readonly ListItemDto[];
	scope: ScopeOptions;
	/** Where the add row attaches by default, and how to say it ("Tokyo"). */
	addTarget: BundleTarget;
	/** The View storage scope ("root" or a node id). */
	storageScope: string;
	/** Person filter: the URL `who` in the tab, local state in the inspector. */
	who: string | null;
	setWho: (memberId: string | null) => void;
	/** Show the kind as a title (side by side) instead of relying on the switch. */
	title?: string;
	/** The inspector: tighter header, no View select when narrow. */
	compact?: boolean;
	/** Scope name for empty states ("Tokyo"). */
	where: string;
	loading?: boolean;
	/** Slot at the end of the header (the Todo | Shopping switch). */
	headerStart?: ReactNode;
};

export function ListBoard(props: BoardProps) {
	const {
		kind,
		items,
		scope,
		addTarget,
		storageScope,
		who,
		setWho,
		title,
		compact,
		where,
		headerStart,
	} = props;
	const ws = useWorkspace();
	const { ix, schedule, graph, access, sel } = ws;
	const editGuard = useEditGuard();
	// The fixture preview has no server: everything reads, nothing writes.
	const guard =
		ws.mode === "live"
			? editGuard
			: { disabled: true, reason: "Preview only" as string | null };
	const actions = useListActions();
	const now = useNow();
	const hours = useHoursIssues();
	const [view, setView, showView] = useListsView(
		kind,
		scope.scopeId === null && scope.includeDescendants !== false,
		storageScope,
	);
	// FB-21d: the grouping and "Near" travel with my view; a follower mirrors
	// them (the inspector's board separately from the tab's).
	const part = compact ? "p" : "";
	const k = kind === "shopping" ? "s" : "t";
	const [nearOn, setNearOn] = useFollowState("lists.snear", false, bool, {
		enabled: !compact && k === "s",
	});
	useFollowValue(`lists.${part}${k}group`, view, showView, VIEW_OF[kind]);
	const [lingering, setLingering] = useState<Record<string, true>>({});
	const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
	useEffect(
		() => () => {
			for (const t of timers.current.values()) clearTimeout(t);
		},
		[],
	);

	const dueCtx = useMemo(() => dueCtxOf(ix, schedule), [ix, schedule]);
	const closedIssue = useCallback(
		(itemId: string) =>
			(hours.byItem[itemId] ?? []).some(
				(i) => i.kind === "closed" && i.severity === "warn",
			),
		[hours],
	);

	const selNode =
		sel?.kind === "node"
			? sel.id
			: sel?.kind === "item"
				? (ix.item(sel.id)?.nodeId ?? null)
				: null;
	// "Near …" narrows the tab to the selection's area (the inspector already is scoped).
	const near = kind === "shopping" && !compact ? nearAnchor(ix, selNode) : null;
	const nearActive = nearOn && !!near;

	// Rows on dropped places stay out unless asked for (QA ROLL-12), with a trace.
	const [showDropped, setShowDropped] = useFollowState(
		`lists.${part}${k}dropped`,
		false,
		bool,
	);
	const kindRows = useMemo(
		() => items.filter((r) => r.list === kind),
		[items, kind],
	);
	const placeGroups = useMemo(
		() => rollupRows(ix, kindRows, { ...scope, showDropped }),
		[ix, kindRows, scope, showDropped],
	);
	const droppedCount = useMemo(
		() => droppedRowIds(ix, kindRows, scope).size,
		[ix, kindRows, scope],
	);
	const [showDone, setShowDone] = useShowDone({ enabled: ws.mode === "live" });
	const inView = useMemo(() => {
		const seen = new Set<string>();
		const flat = [];
		for (const g of placeGroups)
			for (const s of g.subs)
				for (const row of s.rows) {
					if (seen.has(row.id)) continue;
					seen.add(row.id);
					flat.push({ row, sub: s.sub, repId: g.repId });
				}
		return filterRows(ix, flat, { who, nearNodeId: nearActive ? near : null });
	}, [placeGroups, ix, who, nearActive, near]);

	const memberName = useCallback(
		(id: string) => resolveMember(graph.members, id)?.name ?? "Former member",
		[graph.members],
	);
	const groups = useMemo(() => {
		const keep = new Set(inView.map((r) => r.row.id));
		const pg =
			view === "place"
				? placeGroups.map((g) => ({
						...g,
						subs: g.subs.map((s) => ({
							...s,
							rows: s.rows.filter((r) => keep.has(r.id)),
						})),
					}))
				: undefined;
		return groupRows(
			view,
			inView,
			{
				ix,
				schedule,
				dueCtx,
				now,
				scopeId: scope.scopeId,
				memberName,
				meMemberId: access.memberId,
				closedIssue,
			},
			pg,
		).filter((g) => g.rows.length > 0);
	}, [
		view,
		inView,
		placeGroups,
		ix,
		schedule,
		dueCtx,
		now,
		scope.scopeId,
		memberName,
		access.memberId,
		closedIssue,
	]);

	const onToggle = useCallback(
		(row: ListItemDto) => {
			const t = timers.current.get(row.id);
			if (t) clearTimeout(t);
			timers.current.delete(row.id);
			if (row.status === "open") {
				actions.setStatus(row.id, "done");
				setLingering((l) => ({ ...l, [row.id]: true }));
				timers.current.set(
					row.id,
					setTimeout(() => {
						timers.current.delete(row.id);
						setLingering(({ [row.id]: _gone, ...rest }) => rest);
					}, LINGER_MS),
				);
			} else {
				actions.setStatus(row.id, "open");
				setLingering(({ [row.id]: _gone, ...rest }) => rest);
			}
		},
		[actions],
	);

	// Drag to reorder (Place view): before the row it lands on when moving up,
	// after it when moving down; onto another place's row = move it there.
	const dnd = useDnd();
	const boardId = useId();
	const itemsRef = useRef(items);
	itemsRef.current = items;
	const moveRef = useRef(actions.move);
	moveRef.current = actions.move;
	useEffect(
		() =>
			dnd.onDrop("list", (e, a) => {
				const o = e.over?.data.current as DragData | undefined;
				if (a.type !== "list") return;
				// Only drags that started and ended in THIS board (the tab and the
				// inspector can show the same row).
				if (
					a.board !== boardId ||
					o?.type !== "list" ||
					o.board !== boardId ||
					o.listItemId === a.listItemId
				)
					return;
				const all = itemsRef.current;
				const from = all.findIndex((r) => r.id === a.listItemId);
				const to = all.findIndex((r) => r.id === o.listItemId);
				const retarget = !sameTarget(a.target, o.target);
				moveRef.current(a.listItemId, {
					...(retarget ? { target: o.target } : {}),
					...(!retarget && from < to
						? { afterId: o.listItemId }
						: { beforeId: o.listItemId }),
				});
			}),
		[dnd, boardId],
	);

	const rowCtx: RowCtx = {
		ix,
		schedule,
		dueCtx,
		now,
		scopeId: scope.scopeId,
		showSource: view !== "place",
		canEdit: !guard.disabled,
		reason: guard.reason,
		closedIssue,
	};

	// Groups with nothing open hand their done rows to one trailing fold.
	const shown: ListGroup[] = [];
	const doneOnly: ListGroup["rows"] = [];
	for (const g of groups) {
		const open = g.rows.filter(
			(r) => r.row.status === "open" || lingering[r.row.id],
		);
		if (open.length) shown.push(g);
		else doneOnly.push(...g.rows);
	}
	const anyDated = inView.some(
		(r) => r.row.dueDate || r.row.dueDayId || r.row.dueRule,
	);
	const openCount = inView.filter((r) => r.row.status === "open").length;
	const addRef = useRef<{ focus: () => void } | null>(null);
	const empty = !props.loading && inView.length === 0;

	return (
		<section
			data-testid={kind === "todo" ? "rollup-todo" : "rollup-shopping"}
			aria-label={kind === "todo" ? "To-dos" : "Shopping"}
			className="@container flex min-w-0 flex-col"
		>
			<div
				className={cn(
					"flex flex-wrap items-center gap-2 px-4",
					compact ? "pb-2" : "py-2",
				)}
			>
				{headerStart}
				{title ? (
					<h3 className="text-[11px] font-semibold tracking-[.06em] text-muted-foreground uppercase">
						{title}
						<span className="ml-1.5 font-mono tnum">{openCount || ""}</span>
					</h3>
				) : null}
				<div className="ml-auto flex flex-wrap items-center gap-1.5">
					{near ? (
						<button
							type="button"
							data-testid={LISTS_TESTID.near}
							aria-pressed={nearActive}
							onClick={() => setNearOn((v) => !v)}
							className={cn(
								"inline-flex h-7 items-center gap-1 rounded-full border px-2.5 text-xs transition-colors",
								nearActive
									? "border-foreground bg-foreground text-background"
									: "text-muted-foreground hover:text-foreground",
							)}
						>
							<MapPin className="size-3.5" strokeWidth={1.5} />
							Near {ix.node(near)?.name}
						</button>
					) : null}
					<PersonFilter who={who} setWho={setWho} />
					<Select value={view} onValueChange={(v) => setView(v as ListsView)}>
						<SelectTrigger
							size="sm"
							data-testid={LISTS_TESTID.view}
							aria-label="View"
							className="h-7 gap-1 px-2.5 text-xs"
						>
							<span className="text-muted-foreground @max-md:hidden">View</span>
							<SelectValue />
						</SelectTrigger>
						<SelectContent align="end">
							{viewsFor(kind).map((v) => (
								<SelectItem key={v} value={v}>
									{VIEW_LABEL[v]}
								</SelectItem>
							))}
						</SelectContent>
					</Select>
				</div>
			</div>

			<AddRow
				kind={kind}
				target={addTarget}
				disabled={guard.disabled}
				reason={guard.reason}
				handle={addRef}
			/>

			{props.loading && inView.length === 0 ? (
				<div aria-hidden className="flex flex-col gap-3 px-4 py-3">
					{[0, 1, 2].map((i) => (
						<div key={i} className="flex items-center gap-3">
							<Skeleton className="size-4 rounded-[4px]" />
							<Skeleton
								className="h-4 flex-1"
								style={{ maxWidth: `${70 - i * 12}%` }}
							/>
						</div>
					))}
				</div>
			) : null}
			{empty ? (
				<EmptyState
					className="py-8"
					line={
						who || nearActive
							? "Nothing here with these filters."
							: kind === "todo"
								? `Nothing to do in ${where} — yet.`
								: `No shopping list for ${where}.`
					}
					action={
						who || nearActive ? (
							<Button
								size="sm"
								variant="outline"
								onClick={() => {
									setWho(null);
									setNearOn(false);
								}}
							>
								Show everything
							</Button>
						) : !guard.disabled ? (
							<Button size="sm" onClick={() => addRef.current?.focus()}>
								{kind === "todo" ? "Add a to-do" : "Add an item"}
							</Button>
						) : undefined
					}
				/>
			) : null}
			{!empty && view === "due" && !anyDated ? (
				<p className="px-4 pt-2 pb-1 font-display text-[15px] text-muted-foreground">
					Nothing dated. Add a date from any to-do's ⋯.
				</p>
			) : null}

			<div className="flex flex-col">
				{shown.map((g) => (
					<GroupBlock
						boardId={boardId}
						key={g.key}
						group={g}
						view={view}
						kind={kind}
						rowCtx={rowCtx}
						lingering={lingering}
						onToggle={onToggle}
						actions={actions}
						showDone={showDone}
						setShowDone={setShowDone}
					/>
				))}
				{doneOnly.length ? (
					<GroupBlock
						boardId={boardId}
						key="done"
						group={{ key: "done", title: "Done", rows: doneOnly }}
						view="recent"
						kind={kind}
						rowCtx={rowCtx}
						lingering={lingering}
						onToggle={onToggle}
						actions={actions}
						showDone={showDone}
						setShowDone={setShowDone}
					/>
				) : null}
			</div>
			{droppedCount ? (
				<button
					type="button"
					data-testid={LISTS_TESTID.dropped}
					aria-pressed={showDropped}
					onClick={() => setShowDropped((v) => !v)}
					className="mx-4 mt-3 self-start text-xs text-muted-foreground hover:text-foreground"
				>
					{showDropped ? (
						"Hide dropped places"
					) : (
						<>
							<span className="font-mono tnum">{droppedCount}</span> on dropped
							places ·{" "}
							<span className="underline underline-offset-3">Show</span>
						</>
					)}
				</button>
			) : null}
		</section>
	);
}

/** Place view's trailing "N done" fold: its rows say where they're from, relative to the scope. */
const DONE_PLACE_GROUP = {
	repId: null,
	dayId: null,
	groupKind: "scope",
} as const satisfies Pick<ListGroup, "repId" | "dayId" | "groupKind">;

function GroupBlock({
	boardId,
	group,
	view,
	kind,
	rowCtx,
	lingering,
	onToggle,
	actions,
	showDone,
	setShowDone,
}: {
	boardId: string;
	group: ListGroup;
	view: ListsView;
	kind: ListKind;
	rowCtx: RowCtx;
	lingering: Record<string, true>;
	onToggle: (row: ListItemDto) => void;
	actions: ReturnType<typeof useListActions>;
	/** The remembered "done rows open" choice (QA ROLL-08); each fold starts from it. */
	showDone: boolean;
	setShowDone: (v: boolean) => void;
}) {
	const ws = useWorkspace();
	const [doneOpen, setDoneOpenState] = useState(showDone);
	// The account's choice can arrive after the first render (another device).
	useEffect(() => setDoneOpenState(showDone), [showDone]);
	const setDoneOpen = (v: boolean) => {
		setDoneOpenState(v);
		setShowDone(v);
	};
	const addTarget =
		view === "place" && rowCtx.canEdit
			? groupTarget(group, rowCtx.scopeId)
			: null;
	const [adding, setAdding] = useState(false);
	const open = group.rows.filter(
		(r) => r.row.status === "open" || lingering[r.row.id],
	);
	const done = group.rows.filter(
		(r) => r.row.status !== "open" && !lingering[r.row.id],
	);
	const openCount = group.rows.filter((r) => r.row.status === "open").length;
	const isDoneGroup = group.key === "done";
	let glowUsed = false;
	const renderRow = (r: ListGroup["rows"][number]) => {
		let glow = false;
		if (!glowUsed && r.row.status === "open") {
			const due = effectiveDue(r.row, rowCtx.dueCtx);
			if (dueState(due, rowCtx.now, r.row.status) === "open_now") {
				glow = true;
				glowUsed = true;
			}
		}
		return (
			<ListRow
				key={r.row.id}
				row={r.row}
				ctx={rowCtx}
				lingering={!!lingering[r.row.id]}
				glow={glow}
				onToggle={onToggle}
				actions={actions}
				sortable={view === "place" && group.key !== "done"}
				boardId={boardId}
				placeGroup={
					view === "place"
						? group
						: isDoneGroup && !rowCtx.showSource
							? DONE_PLACE_GROUP
							: undefined
				}
			/>
		);
	};
	return (
		<div
			data-testid={LISTS_TESTID.group}
			data-group={group.key}
			className="group/group"
		>
			{isDoneGroup ? null : (
				<GroupHead
					title={group.title}
					count={openCount}
					tone={group.tone}
					repId={
						view === "place" && group.repId && group.repId !== rowCtx.scopeId
							? group.repId
							: null
					}
					scopeId={rowCtx.scopeId}
					onZoom={
						view === "place" && group.repId && group.repId !== rowCtx.scopeId
							? () => ws.nav.zoomIn(group.repId as string)
							: undefined
					}
					onAdd={addTarget ? () => setAdding(true) : undefined}
				/>
			)}
			{open.length ? (
				<SortableContext
					items={open.map((r) => `list:${boardId}:${r.row.id}`)}
					strategy={verticalListSortingStrategy}
					disabled={view !== "place"}
				>
					<ul className="flex flex-col">{open.map(renderRow)}</ul>
				</SortableContext>
			) : null}
			{addTarget && adding && !isDoneGroup ? (
				<GroupAdd
					kind={kind}
					target={addTarget}
					where={group.title}
					onClose={() => setAdding(false)}
				/>
			) : null}
			{done.length ? (
				<>
					<button
						type="button"
						data-testid={LISTS_TESTID.doneFold}
						aria-expanded={doneOpen}
						onClick={() => setDoneOpen(!doneOpen)}
						className="flex h-8 items-center gap-1 px-4 text-xs text-muted-foreground hover:text-foreground"
					>
						<span className="font-mono tnum">{done.length}</span>{" "}
						{isDoneGroup ? "done" : "done"}
						<ChevronRight
							className={cn(
								"size-3.5 transition-transform",
								doneOpen && "rotate-90",
							)}
						/>
					</button>
					{doneOpen ? (
						<ul className="flex flex-col opacity-80">{done.map(renderRow)}</ul>
					) : null}
				</>
			) : null}
		</div>
	);
}

/**
 * A group's sticky head (DESIGN §7.3): the place as crumbs relative to the
 * board's scope (or the bucket/day/person title), the open count, a quiet
 * "+" that opens the group's own add row, and › to zoom into the place.
 */
function GroupHead({
	title,
	count,
	tone,
	repId,
	scopeId,
	onZoom,
	onAdd,
}: {
	title: string;
	count: number;
	tone?: "overdue" | "normal";
	repId: string | null;
	scopeId: string | null;
	onZoom?: () => void;
	onAdd?: () => void;
}) {
	return (
		<div
			data-testid={LISTS_TESTID.groupHead}
			className="sticky top-0 z-20 flex h-8 items-center gap-2 border-b bg-background/95 px-4 backdrop-blur"
		>
			{repId ? (
				<Crumbs
					nodeIds={repId}
					relativeTo={scopeId}
					className="min-w-0 text-xs font-medium text-foreground"
				/>
			) : (
				<span
					className={cn(
						"truncate text-xs font-medium",
						tone === "overdue" ? "text-warning" : "text-foreground",
					)}
				>
					{title}
				</span>
			)}
			{count ? (
				<span className="font-mono text-xs text-muted-foreground tnum">
					{count}
				</span>
			) : null}
			<span className="ml-auto flex shrink-0 items-center gap-0.5">
				{onAdd ? (
					<button
						type="button"
						data-testid={LISTS_TESTID.groupAdd}
						onClick={onAdd}
						aria-label={`Add to ${title}`}
						title={`Add to ${title}`}
						className="rounded p-1 text-muted-foreground opacity-0 transition-opacity group-hover/group:opacity-100 hover:bg-accent hover:text-foreground focus-visible:opacity-100 max-md:opacity-70"
					>
						<Plus className="size-3.5" strokeWidth={1.5} />
					</button>
				) : null}
				{onZoom ? (
					<button
						type="button"
						onClick={onZoom}
						aria-label={`Zoom into ${title}`}
						className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
					>
						<ChevronRight className="size-4" />
					</button>
				) : null}
			</span>
		</div>
	);
}

/** "Everyone ▾": filter by who a row is for (members only; the URL `who` in the tab). */
function PersonFilter({
	who,
	setWho,
}: {
	who: string | null;
	setWho: (id: string | null) => void;
}) {
	const { graph, access } = useWorkspace();
	const members = assignableMembers(graph.members).filter(
		(m) => !m.mergedIntoId,
	);
	if (members.length < 2 && !who) return null;
	const me = access.memberId;
	return (
		<Select
			value={who ?? "all"}
			onValueChange={(v) => setWho(v === "all" ? null : v)}
		>
			<SelectTrigger
				size="sm"
				data-testid={LISTS_TESTID.who}
				aria-label="Who it's for"
				className={cn("h-7 gap-1 px-2.5 text-xs", who && "border-foreground")}
			>
				<User className="size-3.5" strokeWidth={1.5} />
				{/* Narrow boards: just the icon until someone is picked. */}
				<span className={cn(!who && "@max-md:sr-only")}>
					<SelectValue />
				</span>
			</SelectTrigger>
			<SelectContent align="end">
				<SelectItem value="all">Everyone</SelectItem>
				{me ? <SelectItem value={me}>Assigned to me</SelectItem> : null}
				<SelectSeparator />
				{members
					.filter((m) => m.id !== me)
					.map((m) => (
						<SelectItem key={m.id} value={m.id}>
							{m.name}
						</SelectItem>
					))}
			</SelectContent>
		</Select>
	);
}

/**
 * The add row (DESIGN §7.3): "Add a to-do…" with mentions; Enter attaches it
 * to the current target (the chip "→ Tokyo ▾" retargets) and keeps the focus
 * for the next one. The lock makes it private (members only; ADDENDUM §7.2).
 */
function AddRow({
	kind,
	target: initial,
	disabled,
	reason,
	handle,
}: {
	kind: ListKind;
	target: BundleTarget;
	disabled: boolean;
	reason: string | null;
	handle: RefObject<{ focus: () => void } | null>;
}) {
	const ws = useWorkspace();
	const actions = useListActions();
	const [text, setText] = useState("");
	const [target, setTarget] = useState<BundleTarget>(initial);
	const [pickOpen, setPickOpen] = useState(false);
	const [isPrivate, setPrivate] = useState(false);
	const [focusTick, setFocusTick] = useState(0);
	const initialKey = JSON.stringify(initial);
	// biome-ignore lint/correctness/useExhaustiveDependencies: follow the scope when it changes.
	useEffect(() => setTarget(initial), [initialKey]);
	handle.current = { focus: () => setFocusTick((t) => t + 1) };
	const canPrivate =
		ws.mode === "live" && !ws.access.isGuest && !!ws.access.memberId;
	const submit = (value: string) => {
		const v = value.trim();
		if (!v || disabled) return;
		actions.create(
			{
				target,
				list: kind,
				text: v,
				isPrivate: isPrivate || undefined,
			},
			// QA ERR-07/ERR-03: a failed save gives the typed text back.
			{ onError: () => setText((cur) => cur || v) },
		);
		setText("");
	};
	return (
		<div
			data-testid={LISTS_TESTID.add}
			className="flex items-center gap-2 px-4 pb-2"
			title={disabled ? (reason ?? undefined) : undefined}
		>
			<MentionInput
				key={focusTick}
				value={text}
				onChange={setText}
				onSubmit={submit}
				placeholder={
					disabled
						? (reason ?? "View only")
						: kind === "todo"
							? "Add a to-do…"
							: "Add something to buy…"
				}
				ariaLabel={kind === "todo" ? "Add a to-do" : "Add a shopping item"}
				disabled={disabled}
				autoFocus={focusTick > 0}
				className="h-8 flex-1"
			/>
			<PlacePicker
				open={pickOpen}
				onOpenChange={setPickOpen}
				value={target.kind === "node" ? target.nodeId : null}
				allowRoot
				onPick={(nodeId) => {
					setPickOpen(false);
					setTarget(nodeId ? { kind: "node", nodeId } : { kind: "trip" });
				}}
			>
				<button
					type="button"
					data-testid={LISTS_TESTID.addTarget}
					disabled={disabled}
					className="inline-flex h-7 max-w-24 shrink-0 items-center gap-1 rounded-full bg-muted px-2.5 text-xs text-muted-foreground hover:text-foreground disabled:opacity-50 @md:max-w-36"
					title="Where it goes"
				>
					<span aria-hidden>→</span>
					<span className="truncate">
						{target.kind === "trip"
							? ws.graph.trip.name
							: targetLabel(ws.ix, target).split(" › ").at(-1)}
					</span>
				</button>
			</PlacePicker>
			{canPrivate ? (
				<button
					type="button"
					data-testid={LISTS_TESTID.addPrivate}
					aria-pressed={isPrivate}
					disabled={disabled}
					onClick={() => setPrivate((v) => !v)}
					title={
						isPrivate
							? "Private: only you will see it"
							: "Make it private (a gift?)"
					}
					className={cn(
						"inline-flex size-7 shrink-0 items-center justify-center rounded-full transition-colors disabled:opacity-50",
						isPrivate
							? "bg-foreground text-background"
							: "text-muted-foreground hover:bg-accent hover:text-foreground",
					)}
				>
					<Lock className="size-3.5" strokeWidth={1.5} />
					<span className="sr-only">Only me</span>
				</button>
			) : null}
		</div>
	);
}

/**
 * The add row at the bottom of a Place group (DESIGN §7.3), opened by the
 * head's "+": attached to that group's place (or day). Enter adds and keeps
 * it open for the next one; Esc, or leaving it empty, closes it.
 */
function GroupAdd({
	kind,
	target,
	where,
	onClose,
}: {
	kind: ListKind;
	target: BundleTarget;
	where: string;
	onClose: () => void;
}) {
	const actions = useListActions();
	const [text, setText] = useState("");
	return (
		<div className="flex items-center gap-2 py-1.5 pr-4 pl-11">
			<MentionInput
				value={text}
				onChange={setText}
				autoFocus
				onSubmit={(v) => {
					const t = v.trim();
					if (!t) return onClose();
					actions.create({ target, list: kind, text: t });
					setText("");
				}}
				onCancel={onClose}
				onBlur={() => {
					if (!text.trim()) onClose();
				}}
				placeholder={
					kind === "todo"
						? `A to-do for ${where}…`
						: `Something to buy at ${where}…`
				}
				ariaLabel={`Add to ${where}`}
				testId={LISTS_TESTID.groupAddInput}
				className="h-8 flex-1"
			/>
		</div>
	);
}
