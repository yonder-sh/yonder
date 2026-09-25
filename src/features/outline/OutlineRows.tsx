/**
 * Outline rows (DESIGN §4.2): 28px, 16px indent per level, a 12px chevron, the
 * type glyph (places: their category glyph in the family colour), the name,
 * the local name (12px muted, with its `lang`, truncated first), and on the
 * right edge: the level filter's hidden-place count, up to three presence
 * dots, a bed for stays, and the scheduled marker (a filled ink dot, or a
 * hollow ring for an idea).
 *
 * - `TreeNodeRow` is a dnd-kit sortable inside the workspace's one
 *   DndContext: drag to re-parent/reorder (the placeholder turns into the
 *   insertion line at the projected depth, or a red slot with the reason), or
 *   drag onto the Plan to schedule.
 * - `DroppedNodeRow` lives in the "Dropped" group and doesn't drag.
 * - `GhostRow`/`OriginRow` are E7 marks (dashed, the author's colour).
 */
import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { cn } from "cn";
import {
	ArrowRight,
	BedDouble,
	ChevronDown,
	ChevronRight,
	MoreHorizontal,
} from "lucide-react";
import {
	type CSSProperties,
	type KeyboardEvent,
	type ReactNode,
	type RefObject,
	useEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import { useEditGuard } from "@/components/common/edit-guard";
import { TypeGlyph } from "@/components/common/glyphs";
import { presenceColor } from "@/components/common/member";
import {
	describeMark,
	leadMark,
	ProposalGhost,
} from "@/components/common/proposal-ghost";
import { useDraftField } from "@/components/common/use-draft-field";
import {
	ContextMenu,
	ContextMenuContent,
	ContextMenuTrigger,
} from "@/components/ui/context-menu";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import { useAttachDrop } from "@/features/media/use-attach-drop";
import type { ProposalMark } from "@/lib/engine/proposals";
import { allowedChildTypes } from "@/lib/engine/tree";
import type { GraphNode, NodeType } from "@/lib/engine/types";
import { langFor } from "@/lib/format";
import { useSetEditing } from "@/lib/realtime/presence";
import { TESTID } from "@/lib/testids";
import { useFlash } from "@/lib/workspace/ui-store";
import { useWorkspace } from "@/lib/workspace/use-workspace";
import { useGhostActions } from "./ghost-actions";
import { firstNameOf } from "./ghosts";
import {
	blurredIntoClosingMenu,
	CONTEXT_KIT,
	DROPDOWN_KIT,
	NodeMenuItems,
	useMenuHandoff,
} from "./NodeMenu";
import { useOutlineUi } from "./outline-context";
import { OUTLINE_TESTID } from "./testids";
import {
	type GhostRow as GhostRowT,
	INDENT,
	type NodeRow,
	type OriginRow as OriginRowT,
	type Projection,
	typeLabel,
} from "./tree-rows";

export const ROW_H = 28;

/**
 * Esc that closes one of our menus must not also run the workspace's Esc
 * chain (clear selection → days → zoom out, a document listener).
 */
export const keepEscape = (e: KeyboardEvent | globalThis.KeyboardEvent) =>
	e.stopPropagation();
export const padFor = (depth: number) => 8 + depth * INDENT;

/** Row facts computed once per render of the Outline. */
export type RowContext = {
	selectedId: string | null;
	scopeId: string | null;
	scheduled: ReadonlySet<string>;
	stays: ReadonlySet<string>;
	/** nodeId → presence colours (≤ 3). */
	presence: ReadonlyMap<string, { color: number; name: string }[]>;
	marks: (nodeId: string) => readonly ProposalMark[];
	focusedId: string | null;
	/** Row keyboard handling (tree nav, typeahead, A, F2, Delete). */
	onRowKey(e: KeyboardEvent<HTMLElement>, id: string): boolean;
	onRowFocus(id: string): void;
	registerRef(id: string, el: HTMLElement | null): void;
	toggle(id: string, open: boolean): void;
	/** Tree drag state (for the placeholder of the dragged row). */
	projection: Projection | null;
	draggingId: string | null;
	sortableId(nodeId: string): string;
	instance: string;
};

// ---------------------------------------------------------------------------
// Parts
// ---------------------------------------------------------------------------

function Chevron({
	row,
	toggle,
}: {
	row: Pick<NodeRow, "id" | "hasChildren" | "open">;
	toggle: RowContext["toggle"];
}) {
	if (!row.hasChildren) return <span className="w-3 shrink-0" />;
	return (
		<button
			type="button"
			tabIndex={-1}
			aria-hidden
			onClick={(e) => {
				e.stopPropagation();
				toggle(row.id, !row.open);
			}}
			onPointerDown={(e) => e.stopPropagation()}
			onMouseDown={(e) => e.stopPropagation()}
			onDoubleClick={(e) => e.stopPropagation()}
			className="-ml-1 flex size-5 shrink-0 items-center justify-center rounded-sm text-muted-foreground hover:bg-sidebar-accent hover:text-foreground"
		>
			{row.open ? (
				<ChevronDown className="size-3" />
			) : (
				<ChevronRight className="size-3" />
			)}
		</button>
	);
}

function Names({ node, dim }: { node: GraphNode; dim?: boolean }) {
	const { ix } = useWorkspace();
	const cc =
		node.countryCode ??
		ix.path(node.id).find((n) => n.countryCode)?.countryCode ??
		null;
	return (
		<span className="flex min-w-16 flex-1 items-baseline gap-1.5">
			<span
				className={cn(
					"min-w-0 shrink truncate",
					dim && "text-muted-foreground line-through",
				)}
			>
				{node.name}
			</span>
			{node.localName ? (
				<span
					lang={langFor(cc)}
					className="min-w-0 shrink-[100] truncate text-xs text-muted-foreground"
				>
					{node.localName}
				</span>
			) : null}
		</span>
	);
}

function RightEdge({ row, rc }: { row: NodeRow; rc: RowContext }) {
	const { node } = row;
	const peers = rc.presence.get(node.id) ?? [];
	const isPlace = node.type === "place";
	const scheduled = rc.scheduled.has(node.id);
	const stay = rc.stays.has(node.id);
	// The level filter's count of the places a row hides (HIER-07): the
	// numeral shows, the text reads "Uji · 1 place" / "Tokyo · 7 places".
	const hiddenLabel = `${row.hiddenPlaces} ${row.hiddenPlaces === 1 ? "place" : "places"}`;
	return (
		<span className="ml-auto flex shrink-0 items-center gap-1.5 pl-1">
			{row.hiddenPlaces > 0 && !row.open ? (
				<span
					className="font-mono text-[11px] text-muted-foreground tnum"
					title={hiddenLabel}
					data-testid={OUTLINE_TESTID.hiddenCount}
				>
					<span className="sr-only"> · </span>
					{row.hiddenPlaces}
					<span className="sr-only">
						{row.hiddenPlaces === 1 ? " place" : " places"}
					</span>
				</span>
			) : null}
			{peers.length ? (
				<span
					role="img"
					className="flex items-center gap-0.5"
					aria-label={`Here: ${peers.map((p) => p.name).join(", ")}`}
				>
					{peers.slice(0, 3).map((p) => (
						<span
							key={`${p.name}-${p.color}`}
							title={p.name}
							className="size-1.5 rounded-full"
							style={{ backgroundColor: presenceColor(p.color) }}
						/>
					))}
				</span>
			) : null}
			{stay ? (
				<BedDouble
					className="size-3 text-muted-foreground"
					strokeWidth={1.5}
					aria-label="Stay"
				/>
			) : null}
			{isPlace && !stay ? (
				<span
					role="img"
					aria-label={scheduled ? "On the plan" : "Idea"}
					data-scheduled={scheduled || undefined}
					className={cn(
						"size-1.5 rounded-full",
						scheduled
							? "bg-foreground"
							: "ring-[1.5px] ring-muted-foreground ring-inset",
					)}
				/>
			) : null}
		</span>
	);
}

function RowMenuButton({ node }: { node: GraphNode }) {
	const [open, setOpen] = useState(false);
	const handoff = useMenuHandoff();
	return (
		<DropdownMenu open={open} onOpenChange={setOpen}>
			<DropdownMenuTrigger asChild>
				<button
					type="button"
					tabIndex={-1}
					aria-label={`More for ${node.name}`}
					data-testid={OUTLINE_TESTID.rowMenu}
					onPointerDown={(e) => e.stopPropagation()}
					onMouseDown={(e) => e.stopPropagation()}
					onClick={(e) => e.stopPropagation()}
					onDoubleClick={(e) => e.stopPropagation()}
					onKeyDown={(e) => e.stopPropagation()}
					className={cn(
						"flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground",
						"opacity-0 group-hover/row:opacity-100 group-focus-within/row:opacity-100 group-data-[selected=true]/row:opacity-100",
						"hover:bg-sidebar-accent hover:text-foreground",
						open && "opacity-100",
					)}
				>
					<MoreHorizontal className="size-4" />
				</button>
			</DropdownMenuTrigger>
			<DropdownMenuContent
				align="start"
				className="w-56"
				onEscapeKeyDown={keepEscape}
				onCloseAutoFocus={handoff.onCloseAutoFocus}
			>
				<NodeMenuItems
					kit={DROPDOWN_KIT}
					node={node}
					handOff={handoff.handOff}
				/>
			</DropdownMenuContent>
		</DropdownMenu>
	);
}

/** After the blur has finished (focusing inside a blur handler is unreliable). */
function takeFocusBack(ref: RefObject<HTMLInputElement | null>) {
	requestAnimationFrame(() => {
		const el = ref.current;
		if (el?.isConnected) el.focus({ preventScroll: true });
	});
}

/** Inline rename (SPEC §10.8: a local draft while focused; "Maya changed this"). */
function RenameInput({ node }: { node: GraphNode }) {
	const ui = useOutlineUi();
	const setEditing = useSetEditing();
	const cancelled = useRef(false);
	const { useTheirs: takeTheirs, ...field } = useDraftField({
		value: node.name,
		updatedAt: node.updatedAt,
		flashId: node.id,
		save: (draft, expectedUpdatedAt) =>
			ui.actions.rename(node.id, draft, expectedUpdatedAt),
	});
	const ref = useRef<HTMLInputElement>(null);
	useEffect(() => {
		ref.current?.focus();
		ref.current?.select();
	}, []);
	return (
		<span className="flex min-w-0 flex-1 flex-col">
			<input
				ref={ref}
				data-testid={OUTLINE_TESTID.inlineInput}
				aria-label={`Rename ${node.name}`}
				value={field.draft}
				maxLength={200}
				onChange={(e) => field.setDraft(e.target.value)}
				onFocus={() => {
					field.onFocus();
					setEditing({ kind: "node", id: node.id, field: "name" });
				}}
				onBlur={(e) => {
					// A menu animating out under the pointer took the focus (PLAN-R3-01).
					if (!cancelled.current && blurredIntoClosingMenu(e.relatedTarget)) {
						takeFocusBack(ref);
						return;
					}
					setEditing(null);
					if (cancelled.current) takeTheirs();
					else field.onBlur();
					ui.setRenamingId(null);
				}}
				onKeyDown={(e) => {
					e.stopPropagation();
					if (e.key === "Enter") ref.current?.blur();
					if (e.key === "Escape") {
						cancelled.current = true;
						ref.current?.blur();
					}
				}}
				onClick={(e) => e.stopPropagation()}
				onPointerDown={(e) => e.stopPropagation()}
				onMouseDown={(e) => e.stopPropagation()}
				className="h-6 min-w-0 rounded-sm border border-ring bg-background px-1.5 text-sm outline-none"
			/>
			{field.remoteChanged ? (
				<span className="text-[11px] text-muted-foreground">
					{field.remoteChanged.name} changed this ·{" "}
					<button
						type="button"
						className="text-primary underline-offset-2 hover:underline"
						onMouseDown={(e) => {
							e.preventDefault();
							takeTheirs();
						}}
					>
						Use theirs
					</button>
				</span>
			) : null}
		</span>
	);
}

/** The default type for a new child ("Add inside…"): one step finer. */
export function defaultChildType(parent: GraphNode | null): NodeType {
	switch (parent?.type) {
		case undefined:
			return "country";
		case "country":
		case "region":
			return "city";
		case "city":
			return "area";
		default:
			return "place";
	}
}

/** "Add inside…": a name and a type, Enter creates, Esc cancels. */
export function AddChildRow({
	parentId,
	depth,
}: {
	parentId: string | null;
	depth: number;
}) {
	const { ix } = useWorkspace();
	const ui = useOutlineUi();
	const parent = parentId ? (ix.node(parentId) ?? null) : null;
	const types = allowedChildTypes(ix, parentId);
	const [type, setType] = useState<NodeType>(() => {
		const d = defaultChildType(parent);
		return types.includes(d) ? d : (types[types.length - 1] ?? "place");
	});
	const [name, setName] = useState("");
	const ref = useRef<HTMLInputElement>(null);
	useEffect(() => ref.current?.focus(), []);
	const submit = () => {
		if (name.trim()) ui.actions.addChild(parentId, type, name);
		ui.stopAddChild();
	};
	return (
		<div
			role="none"
			className="flex h-9 items-center gap-1.5 pr-2"
			style={{ paddingLeft: padFor(depth) + 12 }}
		>
			<TypeGlyph type={type} category={type === "place" ? "other" : null} />
			<input
				ref={ref}
				data-testid={OUTLINE_TESTID.inlineInput}
				aria-label={parent ? `New place inside ${parent.name}` : "New place"}
				placeholder={parent ? `Inside ${parent.name}…` : "New place…"}
				value={name}
				maxLength={200}
				onChange={(e) => setName(e.target.value)}
				onKeyDown={(e) => {
					e.stopPropagation();
					if (e.key === "Enter") submit();
					if (e.key === "Escape") ui.stopAddChild();
				}}
				onBlur={(e) => {
					// Moving to the type picker keeps the row open.
					if (e.relatedTarget?.closest("[data-add-child]")) return;
					// A menu animating out under the pointer took the focus
					// (PLAN-R3-01): not the user leaving the row.
					if (blurredIntoClosingMenu(e.relatedTarget)) {
						takeFocusBack(ref);
						return;
					}
					submit();
				}}
				className="h-7 min-w-0 flex-1 rounded-sm border border-ring bg-background px-1.5 text-sm outline-none"
			/>
			<Select value={type} onValueChange={(v) => setType(v as NodeType)}>
				<SelectTrigger
					size="sm"
					data-add-child
					data-testid={OUTLINE_TESTID.addChildType}
					aria-label="Type"
					className="h-7 w-[92px] shrink-0 px-2 text-xs"
				>
					<SelectValue />
				</SelectTrigger>
				<SelectContent
					data-add-child
					onEscapeKeyDown={keepEscape}
					onCloseAutoFocus={(e) => {
						e.preventDefault();
						ref.current?.focus();
					}}
				>
					{types.map((t) => (
						<SelectItem key={t} value={t}>
							{typeLabel(t)}
						</SelectItem>
					))}
				</SelectContent>
			</Select>
		</div>
	);
}

// ---------------------------------------------------------------------------
// Rows
// ---------------------------------------------------------------------------

type RowShellProps = {
	row: NodeRow;
	rc: RowContext;
	children: ReactNode;
	setNodeRef?: (el: HTMLElement | null) => void;
	sortableProps?: Record<string, unknown>;
	onKeyDownSensor?: (e: KeyboardEvent<HTMLElement>) => void;
	style?: CSSProperties;
	className?: string;
	dragging?: boolean;
	/** "Suggested by Maya: move", on the treeitem (a tree owns only items). */
	description?: string;
};

/** The treeitem element with its context menu, roving focus and keys. */
function RowShell({
	row,
	rc,
	children,
	setNodeRef,
	sortableProps,
	onKeyDownSensor,
	style,
	className,
	dragging,
	description,
}: RowShellProps) {
	const { nav } = useWorkspace();
	const { node } = row;
	const flash = useFlash(node.id);
	const selected = rc.selectedId === node.id;
	const isScope = rc.scopeId === node.id;
	const tabbable = rc.focusedId === node.id;
	// Files and links dropped from the OS attach to the place (WP-Media).
	const attachTarget = useMemo(
		() => ({ kind: "node" as const, nodeId: node.id }),
		[node.id],
	);
	const upload = useEditGuard("edit-only", "Photos need edit access");
	const handoff = useMenuHandoff();
	const attach = useAttachDrop(attachTarget, {
		label: node.name,
		disabled: upload.disabled,
	});
	const el = (
		<div
			{...attach.rootProps}
			{...sortableProps}
			ref={(e) => {
				setNodeRef?.(e);
				rc.registerRef(node.id, e);
			}}
			role="treeitem"
			aria-level={row.depth + 1}
			aria-expanded={row.hasChildren ? row.open : undefined}
			aria-selected={selected}
			aria-current={isScope ? "location" : undefined}
			aria-label={`${node.name}, ${typeLabel(node.type).toLowerCase()}${node.status === "dropped" ? ", dropped" : ""}`}
			aria-description={description}
			tabIndex={tabbable ? 0 : -1}
			data-testid={TESTID.outlineRow}
			data-node-id={node.id}
			data-cursor-anchor={`tree:${node.id}`}
			data-depth={row.depth}
			data-selected={selected}
			data-scope={isScope || undefined}
			onFocus={(e) => {
				if (e.target === e.currentTarget) rc.onRowFocus(node.id);
			}}
			onClick={() => nav.select({ kind: "node", id: node.id })}
			onDoubleClick={() => nav.zoomIn(node.id)}
			onKeyDown={(e) => {
				if (e.target !== e.currentTarget) return;
				if (rc.onRowKey(e, node.id)) return;
				onKeyDownSensor?.(e);
			}}
			className={cn(
				"group/row relative flex h-7 cursor-pointer touch-manipulation items-center gap-1.5 pr-1 text-sm outline-none select-none",
				"hover:bg-sidebar-accent focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset",
				selected &&
					"bg-card before:absolute before:inset-y-0 before:left-0 before:w-0.5 before:bg-primary",
				isScope && "font-semibold text-foreground",
				flash && "animate-glow",
				dragging && "z-10",
				attach.isOver && "bg-primary/10",
				className,
			)}
			style={{
				paddingLeft: padFor(row.depth),
				...(flash
					? ({ "--glow-color": presenceColor(flash.color) } as CSSProperties)
					: {}),
				...style,
			}}
		>
			{children}
			{attach.isOver ? (
				<span className="pointer-events-none absolute inset-y-0 right-2 flex items-center bg-gradient-to-l from-sidebar from-70% pl-6 text-xs font-medium text-primary">
					Attach to {node.name}
				</span>
			) : null}
		</div>
	);
	return (
		<ContextMenu>
			<ContextMenuTrigger asChild>{el}</ContextMenuTrigger>
			<ContextMenuContent
				className="w-56"
				onEscapeKeyDown={keepEscape}
				onCloseAutoFocus={handoff.onCloseAutoFocus}
			>
				<NodeMenuItems
					kit={CONTEXT_KIT}
					node={node}
					handOff={handoff.handOff}
				/>
			</ContextMenuContent>
		</ContextMenu>
	);
}

function RowContent({ row, rc }: { row: NodeRow; rc: RowContext }) {
	const ui = useOutlineUi();
	const { node } = row;
	const renaming = ui.renamingId === node.id;
	return (
		<>
			<Chevron row={row} toggle={rc.toggle} />
			<TypeGlyph type={node.type} category={node.category} />
			{renaming ? (
				<RenameInput node={node} />
			) : (
				<Names node={node} dim={row.section === "dropped"} />
			)}
			{renaming ? null : <RightEdge row={row} rc={rc} />}
			{renaming ? null : <RowMenuButton node={node} />}
		</>
	);
}

/** The dragged row's slot: an insertion line at the projected depth, or a red slot with the reason. */
function DropSlot({ projection }: { projection: Projection | null }) {
	if (!projection) return <div className="h-7" />;
	if (!projection.valid)
		return (
			<div
				role="presentation"
				title={projection.reason ?? undefined}
				className="flex h-7 items-center justify-end rounded-sm bg-destructive/10 pr-2 text-xs text-destructive"
				style={{ paddingLeft: padFor(projection.depth) + 16 }}
			>
				<span className="truncate">{projection.reason}</span>
			</div>
		);
	return (
		<div role="presentation" className="relative h-7">
			<span
				className="absolute top-1/2 right-2 flex -translate-y-1/2 items-center"
				style={{ left: padFor(projection.depth) }}
			>
				<span className="size-2 shrink-0 rounded-full border-2 border-primary bg-background" />
				<span className="-ml-px h-0.5 flex-1 bg-primary" />
			</span>
		</div>
	);
}

export function TreeNodeRow({ row, rc }: { row: NodeRow; rc: RowContext }) {
	const guard = useEditGuard();
	const ui = useOutlineUi();
	const { node } = row;
	const {
		attributes,
		listeners,
		setNodeRef,
		transform,
		transition,
		isDragging,
	} = useSortable({
		id: rc.sortableId(node.id),
		disabled: guard.disabled || ui.renamingId === node.id,
		data: {
			type: "node",
			nodeId: node.id,
			label: node.name,
			panel: "outline",
			origin: rc.instance,
		},
	});
	const marks = rc.marks(node.id);
	const lead = leadMark(marks);
	const ghostActions = useGhostActions();
	const style: CSSProperties = {
		transform: CSS.Translate.toString(transform),
		transition,
	};
	const { onKeyDown: sensorKey, ...pointerListeners } = listeners ?? {};
	// dnd-kit marks a draggable as a pressed "sortable" button, and disabled
	// when dragging is off (viewers, renaming); the treeitem is neither.
	const {
		"aria-disabled": _disabled,
		"aria-pressed": _pressed,
		"aria-roledescription": _roleDescription,
		...ariaAttributes
	} = attributes;
	if (isDragging)
		return (
			<div ref={setNodeRef} style={style} aria-hidden>
				<DropSlot projection={rc.projection} />
			</div>
		);
	const shell = (
		<RowShell
			row={row}
			rc={rc}
			setNodeRef={setNodeRef}
			sortableProps={{ ...ariaAttributes, ...pointerListeners }}
			onKeyDownSensor={
				sensorKey as ((e: KeyboardEvent<HTMLElement>) => void) | undefined
			}
			style={style}
			description={lead ? describeMark(lead) : undefined}
		>
			<RowContent row={row} rc={rc} />
		</RowShell>
	);
	return lead ? (
		<ProposalGhost
			marks={marks}
			actions={ghostActions}
			describe="item"
			className="mt-2 mr-3 mb-0.5 ml-1 rounded-sm"
		>
			{shell}
		</ProposalGhost>
	) : (
		shell
	);
}

export function DroppedNodeRow({ row, rc }: { row: NodeRow; rc: RowContext }) {
	const { ix } = useWorkspace();
	const parent = row.node.parentId ? ix.node(row.node.parentId) : null;
	return (
		<RowShell row={row} rc={rc} className="text-muted-foreground">
			<Chevron row={row} toggle={rc.toggle} />
			<TypeGlyph
				type={row.node.type}
				category={row.node.category}
				tinted={false}
			/>
			<Names node={row.node} dim />
			{parent && row.depth === 1 ? (
				<span className="shrink-[200] truncate text-[11px] text-muted-foreground">
					{parent.name}
				</span>
			) : null}
			<RowMenuButton node={row.node} />
		</RowShell>
	);
}

export function GhostRow({ row, rc }: { row: GhostRowT; rc: RowContext }) {
	const { nav } = useWorkspace();
	const marks = rc.marks(row.id);
	const lead = leadMark(marks);
	const ghostActions = useGhostActions();
	const tabbable = rc.focusedId === row.id;
	const body = (
		<div
			ref={(e) => rc.registerRef(row.id, e)}
			role="treeitem"
			aria-level={row.depth + 1}
			aria-selected={false}
			aria-label={`${row.node.name}, suggested`}
			aria-description={lead ? describeMark(lead) : undefined}
			tabIndex={tabbable ? 0 : -1}
			data-testid={OUTLINE_TESTID.ghostRow}
			data-node-id={row.id}
			onFocus={(e) => e.target === e.currentTarget && rc.onRowFocus(row.id)}
			onClick={() => nav.select({ kind: "proposal", id: row.proposalId })}
			onKeyDown={(e) => {
				if (rc.onRowKey(e, row.id)) return;
				if (e.key === "Enter")
					nav.select({ kind: "proposal", id: row.proposalId });
			}}
			className="flex h-7 cursor-pointer items-center gap-1.5 pr-2 text-sm text-muted-foreground outline-none hover:bg-sidebar-accent focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
			style={{ paddingLeft: padFor(row.depth) }}
		>
			<span className="w-3 shrink-0" />
			<TypeGlyph type={row.node.type} category={row.node.category} />
			<span className="min-w-0 flex-1 truncate">{row.node.name}</span>
			<span className="sr-only">suggested</span>
		</div>
	);
	return lead ? (
		<ProposalGhost
			marks={marks}
			actions={ghostActions}
			describe="item"
			className="mt-2 mr-3 mb-0.5 ml-1 rounded-sm"
		>
			{body}
		</ProposalGhost>
	) : (
		body
	);
}

export function OriginRowView({
	row,
	rc,
}: {
	row: OriginRowT;
	rc: RowContext;
}) {
	const { ix, nav } = useWorkspace();
	const entityId = row.mark.origin?.entity.startsWith("node:")
		? row.mark.origin.entity.slice(5)
		: null;
	const name = entityId ? (ix.node(entityId)?.name ?? "A place") : "A place";
	const color = presenceColor(row.mark.author.color);
	const author = firstNameOf(row.mark.author.name);
	const tabbable = rc.focusedId === row.id;
	return (
		<div
			ref={(e) => rc.registerRef(row.id, e)}
			role="treeitem"
			aria-level={row.depth + 1}
			aria-selected={false}
			tabIndex={tabbable ? 0 : -1}
			data-testid={OUTLINE_TESTID.originRow}
			onFocus={(e) => e.target === e.currentTarget && rc.onRowFocus(row.id)}
			onClick={() => entityId && nav.select({ kind: "node", id: entityId })}
			onKeyDown={(e) => {
				if (rc.onRowKey(e, row.id)) return;
				if (e.key === "Enter" && entityId)
					nav.select({ kind: "node", id: entityId });
			}}
			aria-label={`${name} suggested to move to ${row.mark.origin?.toLabel ?? "another place"} by ${author}`}
			className="mx-1 flex h-7 cursor-pointer items-center gap-1.5 rounded-sm border border-dashed pr-2 text-xs text-muted-foreground outline-none hover:bg-sidebar-accent focus-visible:ring-2 focus-visible:ring-ring"
			style={{ paddingLeft: padFor(row.depth) - 4, borderColor: color }}
		>
			<span
				aria-hidden
				className="size-1.5 shrink-0 rounded-full"
				style={{ backgroundColor: color }}
			/>
			<span className="min-w-0 truncate">{name}</span>
			<ArrowRight className="size-3 shrink-0" aria-hidden />
			<span className="min-w-0 truncate">{row.mark.origin?.toLabel}</span>
			<span className="ml-auto shrink-0">· {author}</span>
		</div>
	);
}
