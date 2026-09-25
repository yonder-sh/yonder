/**
 * The ONE drag system of the workspace (SPEC §12.6, spikes/dnd): a single
 * `@dnd-kit/core` DndContext spanning the Outline and the Plan, so a place can
 * be dragged from the tree into a day.
 *
 * - Sensors: Mouse (4px) + Touch (long-press 220 ms, 8px tolerance) + Keyboard.
 *   Never Pointer + Touch together; draggables set `touch-action: manipulation`.
 *   The keyboard uses the spike's fix (spikes/dnd FINDINGS "Fixed"):
 *   `sortableKeyboardCoordinates` restricted to the droppables of the ACTIVE
 *   item's panel (so arrow keys move within the Plan or within the Outline,
 *   across days), skipping droppables marked `data.kbSkip` (whole-day
 *   containers). A package can replace it with
 *   `useDnd().setKeyboardCoordinates(fn)` (e.g. tree depth moves).
 * - Collisions: `pointerWithin` picks the panel (droppables carry
 *   `data.panel`), then `closestCenter` among that panel's droppables. A
 *   pointer over no panel has NO target (the drop is a no-op; never the
 *   closest droppable elsewhere). Keyboard drags have no pointer: they stay in
 *   the active item's panel.
 * - Packages may also subscribe with dnd-kit's `useDndMonitor` (onDragOver /
 *   onDragMove: tree depth projection, cross-day previews) inside this context.
 * - Features register behaviour with `useDnd().onDrop(type, handler)`; drag
 *   `data` is `{ type: 'node', nodeId }` (Outline, Ideas), `{ type: 'item', itemId }`
 *   (Plan) or `{ type: 'list', listItemId, … }` (Lists).
 * - One shared DragOverlay. `useDnd().setOverlay(type, render)` supplies its
 *   content for one drag type (each package registers its own, so they never
 *   overwrite each other); `setOverlay(render)` is the older catch-all slot,
 *   used when no per-type render answers. A render returning null falls
 *   through to the default chip.
 * - `useDnd().inContext` is false for the no-op fallback outside
 *   `<WorkspaceDnd>` (dnd-kit's `useDndMonitor` throws there).
 */
import {
	type Announcements,
	type CollisionDetection,
	closestCenter,
	DndContext,
	type DragEndEvent,
	DragOverlay,
	type DragStartEvent,
	type KeyboardCoordinateGetter,
	KeyboardSensor,
	MouseSensor,
	pointerWithin,
	TouchSensor,
	type UniqueIdentifier,
	useSensor,
	useSensors,
} from "@dnd-kit/core";
import { sortableKeyboardCoordinates } from "@dnd-kit/sortable";
import {
	createContext,
	type ReactNode,
	useCallback,
	useContext,
	useEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import type { ListKind } from "@/lib/schemas/enums";
import type { BundleTarget } from "@/lib/schemas/targets";

export type DragData =
	| { type: "node"; nodeId: string; label?: string }
	| { type: "item"; itemId: string; label?: string }
	/** WP-Lists rows (to-dos and shopping), sortable within their board. */
	| {
			type: "list";
			listItemId: string;
			label?: string;
			panel: "lists";
			target: BundleTarget;
			list: ListKind;
			board: string;
	  };

export type DropHandler = (e: DragEndEvent, data: DragData) => void;

export type OverlayRender = (data: DragData) => ReactNode;

type DndApi = {
	/** Registers a drop behaviour for a drag type; returns an unregister function. */
	onDrop(type: DragData["type"], handler: DropHandler): () => void;
	/**
	 * What the shared DragOverlay renders. `(type, render)` sets it for one drag
	 * type (null clears only that type); `(render)` sets the catch-all slot.
	 * A render that returns null falls through to the default chip.
	 */
	setOverlay(render: OverlayRender | null): void;
	setOverlay(type: DragData["type"], render: OverlayRender | null): void;
	/** Replaces the keyboard coordinate getter (null = the panel-aware default). */
	setKeyboardCoordinates(fn: KeyboardCoordinateGetter | null): void;
	active: DragData | null;
	/** True inside `<WorkspaceDnd>`; false for the no-op fallback. */
	inContext: boolean;
};

const DndApiContext = createContext<DndApi | null>(null);

type Containers = Parameters<CollisionDetection>[0]["droppableContainers"];

/** The panel of the active draggable (its own sortable droppable carries `data.panel`). */
function activePanel(
	activeId: UniqueIdentifier | undefined,
	containers: Containers,
	activeData?: { panel?: unknown },
): string | undefined {
	if (typeof activeData?.panel === "string") return activeData.panel;
	if (activeId === undefined) return undefined;
	const own = containers.find((c) => c.id === activeId);
	const panel = own?.data.current?.panel;
	return typeof panel === "string" ? panel : undefined;
}

/**
 * spikes/dnd `kbCoords`: sortable keyboard moves among the droppables of the
 * active item's panel only (never jumping into another panel), skipping
 * `kbSkip` containers. Without a known panel it is plain sortable movement.
 */
export const panelKeyboardCoordinates: KeyboardCoordinateGetter = (
	event,
	args,
) => {
	const { active, droppableContainers } = args.context;
	const all = [...droppableContainers.values()];
	const panel = activePanel(
		active?.id,
		all,
		active?.data.current as { panel?: unknown } | undefined,
	);
	const keep = all.filter(
		(c) =>
			!c.data.current?.kbSkip &&
			(panel === undefined || c.data.current?.panel === panel),
	);
	const narrowed = new Map(
		keep.map((c) => [c.id, c]),
	) as unknown as typeof droppableContainers;
	narrowed.getEnabled = () => keep.filter((c) => !c.disabled);
	return sortableKeyboardCoordinates(event, {
		...args,
		context: { ...args.context, droppableContainers: narrowed },
	});
};

/** Panel-aware collisions: the panel under the pointer first, then the closest droppable in it. */
const collisions: CollisionDetection = (args) => {
	// Keyboard drags have no pointer: stay within the active item's panel.
	if (!args.pointerCoordinates) {
		const panel = activePanel(
			args.active.id,
			args.droppableContainers,
			args.active.data.current as { panel?: unknown } | undefined,
		);
		return closestCenter(
			panel
				? {
						...args,
						droppableContainers: args.droppableContainers.filter(
							(d) => d.data.current?.panel === panel,
						),
					}
				: args,
		);
	}
	const within = pointerWithin(args);
	const panel = within
		.map((c) => args.droppableContainers.find((d) => d.id === c.id))
		.find((d) => d?.data.current?.panel)?.data.current?.panel as
		| string
		| undefined;
	// Over no panel (e.g. the empty sidebar under the Outline): no target at all,
	// never the closest droppable in another panel (that created Plan items).
	if (!panel) return within;
	return closestCenter({
		...args,
		droppableContainers: args.droppableContainers.filter(
			(d) => d.data.current?.panel === panel,
		),
	});
};

const labelOf = (d: DragData | undefined | null) =>
	d?.label ??
	(d?.type === "node" ? "place" : d?.type === "list" ? "to-do" : "item");

const announcements: Announcements = {
	onDragStart: ({ active }) =>
		`Picked up ${labelOf(active.data.current as DragData)}.`,
	onDragOver: ({ active, over }) =>
		over
			? `${labelOf(active.data.current as DragData)} is over ${String(over.data.current?.label ?? over.id)}.`
			: undefined,
	onDragEnd: ({ active, over }) =>
		over
			? `${labelOf(active.data.current as DragData)} dropped on ${String(over.data.current?.label ?? over.id)}.`
			: `${labelOf(active.data.current as DragData)} dropped.`,
	onDragCancel: ({ active }) =>
		`Moving ${labelOf(active.data.current as DragData)} was cancelled.`,
};

/** Keys a drag owns while it runs: Esc cancels it, Enter and Space drop it. */
const DRAG_KEYS = new Set(["Escape", "Enter", " "]);

/**
 * QA A11Y-02: while a drag runs, Esc (cancel) and Enter/Space (drop) belong to
 * the drag. dnd-kit's keyboard sensor sees them only at the document, AFTER
 * the workspace hotkeys (Esc clears the day range or zooms out, Enter zooms
 * in), so a window capture listener marks them handled first
 * (`preventDefault`); the hotkeys skip handled keys and dnd-kit still gets them.
 */
export function useDragKeyGuard(dragging: boolean): void {
	useEffect(() => {
		if (!dragging) return;
		const onKey = (e: KeyboardEvent) => {
			if (DRAG_KEYS.has(e.key)) e.preventDefault();
		};
		window.addEventListener("keydown", onKey, true);
		return () => window.removeEventListener("keydown", onKey, true);
	}, [dragging]);
}

export function WorkspaceDnd({ children }: { children: ReactNode }) {
	const handlers = useRef(new Map<DragData["type"], Set<DropHandler>>());
	const [active, setActive] = useState<DragData | null>(null);
	useDragKeyGuard(active !== null);
	const [overlay, setOverlayState] = useState<{
		any: OverlayRender | null;
		byType: Partial<Record<DragData["type"], OverlayRender>>;
	}>({ any: null, byType: {} });
	// A ref, so a package's getter applies without re-creating the sensors.
	const kbOverride = useRef<KeyboardCoordinateGetter | null>(null);
	const coordinateGetter = useCallback<KeyboardCoordinateGetter>(
		(event, args) =>
			(kbOverride.current ?? panelKeyboardCoordinates)(event, args),
		[],
	);

	const sensors = useSensors(
		useSensor(MouseSensor, { activationConstraint: { distance: 4 } }),
		useSensor(TouchSensor, {
			activationConstraint: { delay: 220, tolerance: 8 },
		}),
		useSensor(KeyboardSensor, { coordinateGetter }),
	);

	const onDrop = useCallback((type: DragData["type"], handler: DropHandler) => {
		const set = handlers.current.get(type) ?? new Set();
		set.add(handler);
		handlers.current.set(type, set);
		return () => {
			set.delete(handler);
		};
	}, []);

	const setOverlay = useCallback(
		(a: DragData["type"] | OverlayRender | null, b?: OverlayRender | null) =>
			setOverlayState((s) => {
				if (typeof a !== "string") return { ...s, any: a };
				const byType = { ...s.byType };
				if (b) byType[a] = b;
				else delete byType[a];
				return { ...s, byType };
			}),
		[],
	) as DndApi["setOverlay"];

	const setKeyboardCoordinates = useCallback(
		(fn: KeyboardCoordinateGetter | null) => {
			kbOverride.current = fn;
		},
		[],
	);

	const api = useMemo<DndApi>(
		() => ({
			onDrop,
			setOverlay,
			setKeyboardCoordinates,
			active,
			inContext: true,
		}),
		[onDrop, setOverlay, setKeyboardCoordinates, active],
	);

	const handleStart = (e: DragStartEvent) =>
		setActive((e.active.data.current as DragData) ?? null);
	const handleEnd = (e: DragEndEvent) => {
		const data = e.active.data.current as DragData | undefined;
		setActive(null);
		if (!data || !e.over) return;
		for (const h of handlers.current.get(data.type) ?? []) h(e, data);
	};

	return (
		<DndApiContext.Provider value={api}>
			<DndContext
				sensors={sensors}
				collisionDetection={collisions}
				onDragStart={handleStart}
				onDragEnd={handleEnd}
				onDragCancel={() => setActive(null)}
				accessibility={{ announcements }}
			>
				{children}
				<DragOverlay
					// Click-through, so my cursor keeps its anchor under the card (FB-23).
					className="yc-dnd-overlay"
					dropAnimation={{ duration: 200, easing: "cubic-bezier(.22,1,.36,1)" }}
				>
					{active
						? (overlay.byType[active.type]?.(active) ??
							overlay.any?.(active) ?? (
								<div className="rounded-lg bg-card px-3 py-2 text-sm shadow-float">
									{labelOf(active)}
								</div>
							))
						: null}
				</DragOverlay>
			</DndContext>
		</DndApiContext.Provider>
	);
}

/** The drag API; a no-op outside `<WorkspaceDnd>` (so stubs render anywhere). */
export function useDnd(): DndApi {
	return (
		useContext(DndApiContext) ?? {
			onDrop: () => () => {},
			setOverlay: () => {},
			setKeyboardCoordinates: () => {},
			active: null,
			inContext: false,
		}
	);
}
