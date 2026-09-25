/**
 * Workspace keyboard shortcuts (DESIGN §13; the `?` sheet lists them): `[` /
 * `]` lens, the Esc chain, Enter zooms into the selected node, D selects the
 * selection's day, J / K step through the plan's stops, ⌘K opens the palette,
 * ⌘\ toggles the Outline, `?` shows the shortcuts. Ignored while typing in
 * inputs (react-hotkeys-hook default), except ⌘K.
 */
import { useCallback, useRef } from "react";
import { useHotkeys } from "react-hotkeys-hook";
import type { GraphIndex } from "@/lib/engine/graph-index";
import type { DayRange } from "@/lib/engine/types";
import { inDayRange } from "@/lib/engine/visits";
import type { Sel } from "@/lib/workspace/search";
import { useUi } from "@/lib/workspace/ui-store";
import { useWorkspace } from "@/lib/workspace/use-workspace";
import { useShell } from "./shell-store";

/** The plan's stops in order: in the scope (effective place) and the day range. */
export function planStops(
	ix: GraphIndex,
	scopeId: string | null,
	days: DayRange | null,
): string[] {
	return ix.ordered
		.filter((it) => {
			const day = ix.day(it.dayId);
			if (!day || (days && !inDayRange(day.date, days))) return false;
			if (!scopeId) return true;
			return ix.isWithin(ix.effectiveNodeId(it.id), scopeId);
		})
		.map((it) => it.id);
}

/** J (+1) / K (−1): the next stop from the selected item, or the first / last. */
export function stepStop(
	stops: readonly string[],
	sel: Sel | null,
	dir: 1 | -1,
): string | null {
	if (!stops.length) return null;
	const at = sel?.kind === "item" ? stops.indexOf(sel.id) : -1;
	if (at < 0) return (dir === 1 ? stops[0] : stops.at(-1)) ?? null;
	const next = at + dir;
	return next < 0 || next >= stops.length ? null : (stops[next] ?? null);
}

/**
 * Keys pressed inside an open layer (a dialog, sheet, menu, popover or
 * listbox) belong to that layer: its own Esc closes it, so the workspace must
 * not also clear the selection or zoom out.
 */
export function inOpenLayer(target: EventTarget | null): boolean {
	const el = target instanceof Element ? target : null;
	const layer = el?.closest(
		'[role="dialog"],[role="alertdialog"],[role="menu"],[role="listbox"],[data-radix-popper-content-wrapper]',
	);
	// A layer that is animating out no longer owns the keyboard.
	return !!layer && layer.getAttribute("data-state") !== "closed";
}

const OPTS = {
	// A key an open menu, popover or lightbox already handled is theirs too.
	ignoreEventWhen: (e: KeyboardEvent) =>
		e.defaultPrevented || inOpenLayer(e.target),
};

export function useWorkspaceHotkeys() {
	const { nav, sel, ix, scope, days } = useWorkspace();
	const openAddPlace = useUi((s) => s.openAddPlace);
	const toggleOutline = useShell((s) => s.toggleOutline);
	const setShortcutsOpen = useShell((s) => s.setShortcutsOpen);
	// Read the latest state when a key fires (a quick J, J must not reuse the old selection).
	const latest = useRef({ nav, sel, ix, scope, days });
	latest.current = { nav, sel, ix, scope, days };
	const step = useCallback((dir: 1 | -1) => {
		const w = latest.current;
		const id = stepStop(
			planStops(w.ix, w.scope?.id ?? null, w.days),
			w.sel,
			dir,
		);
		if (id) w.nav.select({ kind: "item", id });
	}, []);
	useHotkeys("bracketleft", () => latest.current.nav.stepLens(-1), OPTS);
	useHotkeys("bracketright", () => latest.current.nav.stepLens(1), OPTS);
	useHotkeys("escape", () => latest.current.nav.escape(), OPTS);
	useHotkeys(
		"enter",
		() => {
			const { sel, nav } = latest.current;
			if (sel?.kind === "node") nav.zoomIn(sel.id);
		},
		OPTS,
	);
	useHotkeys(
		"d",
		() => {
			const { sel, ix, nav } = latest.current;
			const dayId =
				sel?.kind === "item"
					? ix.item(sel.id)?.dayId
					: sel?.kind === "day"
						? sel.id
						: null;
			const day = dayId ? ix.day(dayId) : undefined;
			if (day) nav.setDays({ from: day.date, to: day.date });
		},
		OPTS,
	);
	useHotkeys("j", () => step(1), OPTS, [step]);
	useHotkeys("k", () => step(-1), OPTS, [step]);
	useHotkeys(
		"mod+k",
		(e) => {
			e.preventDefault();
			openAddPlace({ mode: "search" });
		},
		{ enableOnFormTags: true },
		[openAddPlace],
	);
	useHotkeys(
		"mod+backslash",
		(e) => {
			e.preventDefault();
			toggleOutline();
		},
		OPTS,
		[toggleOutline],
	);
	useHotkeys("shift+slash", () => setShortcutsOpen(true), OPTS, [
		setShortcutsOpen,
	]);
}
