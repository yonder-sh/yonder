/**
 * State the Outline's rows, menus and dialogs share: the write actions, the
 * polite announcer, which row is being renamed or gets a new child, and the
 * Move… / Delete… dialogs. One provider per mounted Outline (the xl sidebar,
 * the lg/md popover and the mobile drawer each have their own).
 */
import { createContext, useContext } from "react";
import type { OutlineActions } from "./use-outline-actions";

export type OutlineUi = {
	actions: OutlineActions;
	announce(text: string): void;
	renamingId: string | null;
	setRenamingId(id: string | null): void;
	/** The parent that shows an inline "new place" input (`root` = top level). */
	addingUnder: string | null;
	startAddChild(parentId: string | null): void;
	stopAddChild(): void;
	requestMove(nodeId: string): void;
	requestDelete(nodeId: string): void;
	/** The day **A** would add to, for menu labels ("Add to Day 3"). */
	focusedDayLabel: string | null;
};

export const ROOT_KEY = "root";

const Ctx = createContext<OutlineUi | null>(null);
export const OutlineUiProvider = Ctx.Provider;

export function useOutlineUi(): OutlineUi {
	const v = useContext(Ctx);
	if (!v) throw new Error("useOutlineUi() outside <Outline>");
	return v;
}
