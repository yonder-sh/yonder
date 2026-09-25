/**
 * Plan-wide React contexts: the cross-day drop indicator and the Plan's
 * local UI state (folded area blocks, compact mode, money counts).
 */
import { createContext } from "react";
import type { GraphIndex } from "@/lib/engine/graph-index";

/** Where a drop would land while dragging across days (the sortable can't show it there). */
export type DropIndicator = {
	dayId: string | null;
	itemId: string | null;
	where: "before" | "after";
} | null;
export const DropIndicatorContext = createContext<DropIndicator>(null);

/** The day of the card being dragged (its section must stay rendered while it is). */
export const DragDayContext = createContext<string | null>(null);

/** Area blocks the user folded (by block key); everything else is open. */
export type PlanUiState = {
	collapsedBlocks: ReadonlySet<string>;
	toggleBlock(key: string): void;
	/**
	 * Opened stretch folds inside days (`<daySectionKey>|<firstItemId>`), kept
	 * here, not per day, so they travel with my view (FB-21a).
	 */
	openStretch: ReadonlySet<string>;
	toggleStretch(key: string): void;
	compact: boolean;
	/** Expense counts per mark key (`item:<id>`), computed once for all cards. */
	money: Readonly<Record<string, number>>;
	/**
	 * The index of the server's graph while the workspace's `ix` simulates
	 * open suggestions (null when `ix` is the server's): what a real leg can
	 * be relinked to (QA COLLAB-R2-01).
	 */
	realIx: GraphIndex | null;
};
export const PlanUiContext = createContext<PlanUiState>({
	collapsedBlocks: new Set(),
	toggleBlock: () => {},
	openStretch: new Set(),
	toggleStretch: () => {},
	compact: false,
	money: {},
	realIx: null,
});
