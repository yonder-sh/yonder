/**
 * The Outline's side of the workspace's single DndContext (spikes/dnd,
 * CONTRACTS §6.3): it watches drags that start in THIS Outline instance
 * (`useDndMonitor`), projects where the row would land (`projectDrop`: depth
 * from the horizontal offset, the rank rule), folds the dragged row's
 * children, swaps in a keyboard getter where ← / → change the depth, shows a
 * lifted row in the shared DragOverlay, and on drop re-parents with one
 * `moveNode` (the server picks the one fractional key). Drops on the Plan are
 * the Plan's (`useDnd().onDrop('node')`); this only handles its own rows.
 */
import {
	type DragEndEvent,
	type KeyboardCoordinateGetter,
	type UniqueIdentifier,
	useDndMonitor,
} from "@dnd-kit/core";
import { cn } from "cn";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { create } from "zustand";
import {
	type DragData,
	panelKeyboardCoordinates,
	useDnd,
} from "@/components/common/dnd/workspace-dnd";
import { TypeGlyph } from "@/components/common/glyphs";
import type { GraphIndex } from "@/lib/engine/graph-index";
import { useWorkspace } from "@/lib/workspace/use-workspace";
import { othersProposedCreate, reviewFirst } from "./ghosts";
import {
	INDENT,
	type NodeRow,
	type Projection,
	projectDrop,
} from "./tree-rows";
import type { OutlineActions } from "./use-outline-actions";

/** Drag data our rows carry on top of `DragData`. */
export type OutlineDragData = DragData & { panel?: string; origin?: string };

/** What the DragOverlay chip needs (it renders outside the Outline's tree). */
export const useOutlineDragStore = create<{
	invalid: string | null;
	set(invalid: string | null): void;
}>((set) => ({ invalid: null, set: (invalid) => set({ invalid }) }));

/** ← / → change the projected depth by one indent; ↑ / ↓ move between rows. */
export const treeKeyboardCoordinates: KeyboardCoordinateGetter = (
	event,
	args,
) => {
	if (event.code === "ArrowRight" || event.code === "ArrowLeft") {
		event.preventDefault();
		const dx = event.code === "ArrowRight" ? INDENT : -INDENT;
		return {
			x: args.currentCoordinates.x + dx,
			y: args.currentCoordinates.y,
		};
	}
	return panelKeyboardCoordinates(event, args);
};

/** The lifted row in the DragOverlay (DESIGN §4.2: shadow-float, 1.02 scale). */
function NodeDragChip({ nodeId, label }: { nodeId: string; label?: string }) {
	const { ix } = useWorkspace();
	const invalid = useOutlineDragStore((s) => s.invalid);
	const node = ix.node(nodeId);
	return (
		<div
			className={cn(
				"inline-flex h-8 w-fit max-w-60 scale-[1.02] items-center gap-1.5 rounded-md border bg-card px-2.5 text-sm shadow-float",
				invalid && "border-destructive/40 bg-destructive/10",
			)}
		>
			{node ? <TypeGlyph type={node.type} category={node.category} /> : null}
			<span className="truncate">{node?.name ?? label ?? "Place"}</span>
		</div>
	);
}

export function renderDragOverlay(d: DragData) {
	if (d.type === "node")
		return <NodeDragChip nodeId={d.nodeId} label={d.label} />;
	return (
		<div className="rounded-lg bg-card px-3 py-2 text-sm shadow-float">
			{d.label ?? "item"}
		</div>
	);
}

type DragState = {
	activeId: string;
	overId: string | null;
	offsetX: number;
	keyboard: boolean;
};

export function useOutlineDnd(opts: {
	instance: string;
	ix: GraphIndex;
	/** The sortable rows (tree section, dragged subtree folded). */
	rows: readonly NodeRow[];
	actions: OutlineActions;
	announce(text: string): void;
	/** Opens the new parent so the moved row stays in sight. */
	reveal(parentId: string): void;
}) {
	const { instance, ix, rows, actions, announce, reveal } = opts;
	const { proposals, access } = useWorkspace();
	const dnd = useDnd();
	const prefix = `outline:${instance}:`;
	const [drag, setDrag] = useState<DragState | null>(null);
	const rowsRef = useRef(rows);
	rowsRef.current = rows;

	const nodeIdOf = useCallback(
		(id: UniqueIdentifier | undefined | null) =>
			typeof id === "string" && id.startsWith(prefix)
				? id.slice(prefix.length)
				: null,
		[prefix],
	);
	const mine = useCallback(
		(data: unknown) =>
			(data as OutlineDragData | undefined)?.origin === instance,
		[instance],
	);

	const end = () => {
		setDrag(null);
		useOutlineDragStore.getState().set(null);
		dnd.setKeyboardCoordinates(null);
		dnd.setOverlay("node", null);
	};

	useDndMonitor({
		onDragStart(e) {
			const data = e.active.data.current as OutlineDragData | undefined;
			if (!mine(data) || data?.type !== "node") return;
			setDrag({
				activeId: data.nodeId,
				overId: data.nodeId,
				offsetX: 0,
				keyboard:
					typeof KeyboardEvent !== "undefined" &&
					e.activatorEvent instanceof KeyboardEvent,
			});
			dnd.setKeyboardCoordinates(treeKeyboardCoordinates);
			dnd.setOverlay("node", renderDragOverlay);
		},
		onDragMove(e) {
			if (!mine(e.active.data.current)) return;
			setDrag((d) => (d ? { ...d, offsetX: e.delta.x } : d));
		},
		onDragOver(e) {
			if (!mine(e.active.data.current)) return;
			setDrag((d) => (d ? { ...d, overId: nodeIdOf(e.over?.id) } : d));
		},
		onDragEnd(e) {
			if (mine(e.active.data.current)) end();
		},
		onDragCancel(e) {
			if (!mine(e.active.data.current)) return;
			end();
			announce("Move cancelled");
		},
	});

	const projection: Projection | null = useMemo(
		() =>
			drag?.overId
				? projectDrop(ix, rows, drag.activeId, drag.overId, drag.offsetX)
				: null,
		[drag, ix, rows],
	);

	// The overlay chip turns red over an invalid target.
	useEffect(() => {
		useOutlineDragStore
			.getState()
			.set(projection && !projection.valid ? projection.reason : null);
	}, [projection]);

	// Keyboard drags: say where the row would go (DESIGN §13).
	const lastSaid = useRef("");
	useEffect(() => {
		if (!drag?.keyboard || !projection) return;
		const node = ix.node(drag.activeId);
		const parent = projection.parentId ? ix.node(projection.parentId) : null;
		const text = !projection.valid
			? `Can't drop here: ${projection.reason}`
			: `${node?.name ?? "Place"}: ${parent ? `inside ${parent.name}` : "top level"}, level ${projection.depth + 1}`;
		if (text !== lastSaid.current) {
			lastSaid.current = text;
			announce(text);
		}
	}, [drag, projection, ix, announce]);

	// The drop: re-parent/reorder within this Outline.
	useEffect(
		() =>
			dnd.onDrop("node", (e: DragEndEvent, data) => {
				if (!mine(e.active.data.current) || data.type !== "node") return;
				const overId = nodeIdOf(e.over?.id);
				if (!overId) return;
				const p = projectDrop(
					ix,
					rowsRef.current,
					data.nodeId,
					overId,
					e.delta.x,
				);
				if (!p || p.noop) return;
				// Someone else's proposed place isn't real yet (E7).
				const ghost = othersProposedCreate(
					proposals.marks.get(`node:${data.nodeId}`),
					access.memberId,
				);
				if (ghost) {
					announce(reviewFirst(ghost));
					toast(reviewFirst(ghost));
					return;
				}
				if (!p.valid) {
					const why = p.reason ?? "That can't go there";
					announce(`Can't drop there: ${why}`);
					toast(why);
					return;
				}
				if (p.parentId) reveal(p.parentId);
				actions.move({
					nodeId: data.nodeId,
					parentId: p.parentId,
					...(p.afterId ? { afterId: p.afterId } : {}),
					...(p.beforeId ? { beforeId: p.beforeId } : {}),
				});
			}),
		[
			dnd,
			ix,
			actions,
			announce,
			mine,
			nodeIdOf,
			reveal,
			proposals.marks,
			access.memberId,
		],
	);

	return {
		draggingId: drag?.activeId ?? null,
		projection,
		sortableId: (nodeId: string) => `${prefix}${nodeId}`,
	};
}
