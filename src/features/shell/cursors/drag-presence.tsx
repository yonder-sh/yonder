/**
 * FB-23 live drags, the sending side: while I drag a plan card, an Outline /
 * Ideas row or a list row, my awareness `drag` says what (its FB-17 anchor)
 * and where it would land (the drop target's anchor, before / at the end).
 * Cleared on drop and cancel (and by the server's awareness timeout on
 * disconnect; receivers also drop a drag that stops changing). A private
 * row's drag never travels (its anchor encodes as nothing), and the server
 * drops any drag on or over something private.
 */
import {
	type DragOverEvent,
	type DragStartEvent,
	useDndMonitor,
} from "@dnd-kit/core";
import { useEffect, useRef } from "react";
import type { Awareness } from "y-protocols/awareness";
import { anchorKind } from "@/lib/realtime/cursor-protocol";
import { useTripAwareness } from "@/lib/realtime/presence";
import { type AwarenessDrag, DRAG_KINDS } from "@/lib/realtime/view-protocol";
import { encodeAt } from "./anchors";

type Over = { id: unknown; data: { current?: Record<string, unknown> } } | null;

/** Where a drop over `over` would land, as an anchor (null: nowhere we can show). */
export function dropTargetOf(
	over: Over,
	activeId: unknown,
): AwarenessDrag["o"] {
	if (!over || over.id === activeId) return null;
	const d = over.data.current;
	if (!d) return null;
	const str = (v: unknown) => (typeof v === "string" ? v : null);
	if (d.panel === "plan") {
		const item = str(d.itemId);
		if (item) return { id: `item:${item}`, w: "before" };
		if (d.unscheduled) return { id: "pane:unscheduled", w: "end" };
		const day = str(d.dayId);
		if (day) return { id: `day:${day}`, w: "end" };
		return null;
	}
	const list = str(d.listItemId);
	if (d.type === "list" && list) return { id: `list:${list}`, w: "before" };
	const node = str(d.nodeId);
	if (d.type === "node" && node) return { id: `tree:${node}`, w: "before" };
	return null;
}

/** The dragged thing's anchor (from where the drag started), or null. */
function draggedAnchor(
	e: DragStartEvent,
): Pick<AwarenessDrag, "a" | "v"> | null {
	const ev = e.activatorEvent as (Event & Partial<PointerEvent>) | null;
	const target = ev?.target instanceof Element ? ev.target : null;
	if (!target) return null;
	const r = target.getBoundingClientRect();
	const x = typeof ev?.clientX === "number" ? ev.clientX : r.left + 1;
	const y = typeof ev?.clientY === "number" ? ev.clientY : r.top + 1;
	const at = encodeAt(target, x, y);
	if (at.anchor?.k !== "el") return null;
	const kind = anchorKind(at.anchor.id);
	if (!kind || !(DRAG_KINDS as readonly string[]).includes(kind)) return null;
	return { a: at.anchor.id, v: at.vis };
}

function write(awareness: Awareness | null, drag: AwarenessDrag | null) {
	awareness?.setLocalStateField("drag", drag);
}

export function DragPresence() {
	const { awareness } = useTripAwareness();
	const cur = useRef<AwarenessDrag | null>(null);
	const aw = useRef(awareness);
	aw.current = awareness;
	useDndMonitor({
		onDragStart(e) {
			const a = draggedAnchor(e);
			cur.current = a ? { ...a, o: null } : null;
			write(aw.current, cur.current);
		},
		onDragOver(e: DragOverEvent) {
			const c = cur.current;
			if (!c) return;
			const o = dropTargetOf(e.over as Over, e.active.id);
			if (JSON.stringify(o) === JSON.stringify(c.o)) return;
			cur.current = { ...c, o };
			write(aw.current, cur.current);
		},
		onDragEnd() {
			if (!cur.current) return;
			cur.current = null;
			write(aw.current, null);
		},
		onDragCancel() {
			if (!cur.current) return;
			cur.current = null;
			write(aw.current, null);
		},
	});
	useEffect(() => () => write(awareness, null), [awareness]);
	return null;
}
