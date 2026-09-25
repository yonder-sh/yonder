/**
 * The Outline row menu (SPEC §18.3 WP-Outline): Open, Add inside, Rename,
 * Change type, Move…, Set location, My priority, Add to day, Drop/Restore,
 * Delete. The same items render in the right-click ContextMenu and in the
 * row's ⋯ DropdownMenu (touch has no right-click: long-press is the drag).
 * Edit items stay visible but disabled with the reason (SPEC §0 rule 17).
 */
import {
	ArrowRightToLine,
	CalendarPlus,
	Check,
	CornerDownRight,
	FolderInput,
	LocateFixed,
	Pencil,
	Shapes,
	Star,
	Trash2,
	Undo2,
	XCircle,
} from "lucide-react";
import { type ComponentType, type ReactNode, useMemo, useRef } from "react";
import { useEditGuard } from "@/components/common/edit-guard";
import { TypeGlyph } from "@/components/common/glyphs";
import {
	ContextMenuItem,
	ContextMenuLabel,
	ContextMenuSeparator,
	ContextMenuShortcut,
	ContextMenuSub,
	ContextMenuSubContent,
	ContextMenuSubTrigger,
} from "@/components/ui/context-menu";
import {
	DropdownMenuItem,
	DropdownMenuLabel,
	DropdownMenuSeparator,
	DropdownMenuShortcut,
	DropdownMenuSub,
	DropdownMenuSubContent,
	DropdownMenuSubTrigger,
} from "@/components/ui/dropdown-menu";
import { PRIORITIES, PRIORITY_ORDER } from "@/lib/domain/taxonomy";
import { allowedTypes, isSchedulable } from "@/lib/engine/tree";
import type { GraphNode } from "@/lib/engine/types";
import { useUi } from "@/lib/workspace/ui-store";
import { useWorkspace } from "@/lib/workspace/use-workspace";
import { useOutlineUi } from "./outline-context";
import { PriorityBadge } from "./PriorityBadge";
import { typeLabel } from "./tree-rows";

type ItemProps = {
	onSelect?: (e: Event) => void;
	disabled?: boolean;
	variant?: "default" | "destructive";
	children?: ReactNode;
	className?: string;
};
export type MenuKit = {
	Item: ComponentType<ItemProps>;
	Label: ComponentType<{ children?: ReactNode; className?: string }>;
	Separator: ComponentType<Record<string, never>>;
	Shortcut: ComponentType<{ children?: ReactNode }>;
	Sub: ComponentType<{ children?: ReactNode }>;
	SubTrigger: ComponentType<{
		children?: ReactNode;
		disabled?: boolean;
		className?: string;
	}>;
	SubContent: ComponentType<{ children?: ReactNode; className?: string }>;
};

export const CONTEXT_KIT: MenuKit = {
	Item: ContextMenuItem as MenuKit["Item"],
	Label: ContextMenuLabel as MenuKit["Label"],
	Separator: ContextMenuSeparator as MenuKit["Separator"],
	Shortcut: ContextMenuShortcut as MenuKit["Shortcut"],
	Sub: ContextMenuSub as MenuKit["Sub"],
	SubTrigger: ContextMenuSubTrigger as MenuKit["SubTrigger"],
	SubContent: ContextMenuSubContent as MenuKit["SubContent"],
};

export const DROPDOWN_KIT: MenuKit = {
	Item: DropdownMenuItem as MenuKit["Item"],
	Label: DropdownMenuLabel as MenuKit["Label"],
	Separator: DropdownMenuSeparator as MenuKit["Separator"],
	Shortcut: DropdownMenuShortcut as MenuKit["Shortcut"],
	Sub: DropdownMenuSub as MenuKit["Sub"],
	SubTrigger: DropdownMenuSubTrigger as MenuKit["SubTrigger"],
	SubContent: DropdownMenuSubContent as MenuKit["SubContent"],
};

/** Wraps an item's action so it runs once the menu has closed. */
export type HandOff = (fn: () => void) => () => void;
const now: HandOff = (fn) => fn;

/**
 * Only if the menu never reports its unmount (it always should): long after
 * the exit animation (~150 ms).
 */
const HANDOFF_FALLBACK_MS = 1000;

/**
 * An item that opens an inline input ("Add inside…", Rename) keeps the focus
 * there. `handOff(fn)` runs `fn` once the menu content has UNMOUNTED, from
 * `onCloseAutoFocus` (Radix fires it after the exit animation), and skips
 * Radix's return of the focus to the ⋯ trigger or the right-clicked row,
 * which would blur the new input or send the next keys to the row's
 * typeahead. Spread `onCloseAutoFocus` on the menu's content.
 *
 * Why not sooner (QA PLAN-R3-01): while the menu animates out it is still
 * under the pointer. When the new input sits below the Outline's fold,
 * focusing it scrolls the Outline, the browser re-hit-tests the resting
 * pointer, and the closing menu takes the focus back (Radix focuses the menu
 * on pointer leave/move). The empty input's blur then cancels it, so "Add
 * inside…" did nothing on Busan or Seoul.
 */
export function useMenuHandoff(): {
	handOff: HandOff;
	onCloseAutoFocus(e: Event): void;
} {
	const pending = useRef<(() => void) | null>(null);
	return useMemo(() => {
		const flush = () => {
			const fn = pending.current;
			pending.current = null;
			fn?.();
		};
		return {
			handOff: (fn) => () => {
				pending.current = fn;
				setTimeout(() => {
					if (pending.current === fn) flush();
				}, HANDOFF_FALLBACK_MS);
			},
			onCloseAutoFocus: (e) => {
				if (!pending.current) return;
				e.preventDefault();
				flush();
			},
		};
	}, []);
}

/**
 * The focus is moving into a menu that is animating out (Radix focuses its
 * content on pointer leave). An inline input that loses the focus this way
 * didn't lose it to the user: it takes it back instead of treating the blur
 * as "done". A second guard behind `useMenuHandoff`.
 */
export function blurredIntoClosingMenu(next: EventTarget | null): boolean {
	return (
		next instanceof Element && !!next.closest("[role=menu][data-state=closed]")
	);
}

export function NodeMenuItems({
	kit: K,
	node,
	handOff = now,
}: {
	kit: MenuKit;
	node: GraphNode;
	/** From `useMenuHandoff()` on the menu that renders these items. */
	handOff?: HandOff;
}) {
	const { ix, access, nav } = useWorkspace();
	const ui = useOutlineUi();
	const guard = useEditGuard();
	// PLACES §1c: raters set their own priority while the rest stays read-only.
	const rateOff = useEditGuard("rate").disabled;
	const openAddPlace = useUi((s) => s.openAddPlace);
	const off = guard.disabled;
	const types = allowedTypes(ix, node.id);
	const me = access.memberId;
	const mine = me ? (node.priorities[me] ?? null) : null;
	const dropped = node.status === "dropped";
	const schedulable = node.type === "place" && isSchedulable(ix, node.id);

	return (
		<>
			{off && guard.reason ? (
				<K.Label className="text-xs font-normal text-muted-foreground">
					{guard.reason}
				</K.Label>
			) : null}
			<K.Item onSelect={() => nav.zoomIn(node.id)}>
				<ArrowRightToLine />
				Open {node.name}
				<K.Shortcut>↵</K.Shortcut>
			</K.Item>
			{schedulable ? (
				<K.Item disabled={off} onSelect={() => ui.actions.schedule(node.id)}>
					<CalendarPlus />
					{ui.focusedDayLabel ? `Add to ${ui.focusedDayLabel}` : "Schedule…"}
					<K.Shortcut>A</K.Shortcut>
				</K.Item>
			) : null}
			<K.Separator />
			<K.Item
				disabled={off}
				onSelect={handOff(() => ui.startAddChild(node.id))}
			>
				<CornerDownRight />
				Add inside…
			</K.Item>
			<K.Item
				disabled={off}
				onSelect={handOff(() => ui.setRenamingId(node.id))}
			>
				<Pencil />
				Rename
				<K.Shortcut>F2</K.Shortcut>
			</K.Item>
			<K.Sub>
				<K.SubTrigger className="gap-2" disabled={off || types.length < 2}>
					<Shapes className="size-4 text-muted-foreground" />
					Change type
				</K.SubTrigger>
				<K.SubContent className="min-w-40">
					{types.map((t) => (
						<K.Item
							key={t}
							disabled={off || t === node.type}
							onSelect={() => ui.actions.changeType(node.id, t)}
						>
							<TypeGlyph type={t} category={t === "place" ? "other" : null} />
							{typeLabel(t)}
							{t === node.type ? <Check className="ml-auto" /> : null}
						</K.Item>
					))}
				</K.SubContent>
			</K.Sub>
			<K.Item disabled={off} onSelect={() => ui.requestMove(node.id)}>
				<FolderInput />
				Move…
			</K.Item>
			<K.Item
				disabled={off}
				onSelect={() => openAddPlace({ mode: "locate", nodeId: node.id })}
			>
				<LocateFixed />
				{node.lat === null ? "Set location" : "Change location"}
			</K.Item>
			{me ? (
				<K.Sub>
					<K.SubTrigger className="gap-2" disabled={rateOff}>
						<Star className="size-4 text-muted-foreground" />
						My priority
						{mine ? (
							<span className="ml-auto pl-2 text-xs text-muted-foreground">
								{PRIORITIES[mine].label}
							</span>
						) : null}
					</K.SubTrigger>
					<K.SubContent className="min-w-44">
						{PRIORITY_ORDER.map((p) => (
							<K.Item
								key={p}
								disabled={rateOff}
								onSelect={() => ui.actions.setPriority(node.id, me, p)}
							>
								<PriorityBadge priority={p} />
								{mine === p ? <Check className="ml-auto" /> : null}
							</K.Item>
						))}
						<K.Separator />
						<K.Item
							disabled={rateOff || !mine}
							onSelect={() => ui.actions.setPriority(node.id, me, null)}
						>
							<XCircle />
							Clear my rating
						</K.Item>
					</K.SubContent>
				</K.Sub>
			) : null}
			<K.Separator />
			<K.Item
				disabled={off}
				onSelect={() =>
					ui.actions.setStatus(node.id, dropped ? "active" : "dropped")
				}
			>
				{dropped ? <Undo2 /> : <XCircle />}
				{dropped ? "Restore" : "Drop"}
			</K.Item>
			<K.Item
				variant="destructive"
				disabled={off}
				onSelect={() => ui.requestDelete(node.id)}
			>
				<Trash2 />
				Delete…
				<K.Shortcut>⌫</K.Shortcut>
			</K.Item>
		</>
	);
}
