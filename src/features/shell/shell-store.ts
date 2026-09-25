/**
 * WP-Shell's own ephemeral UI state (dialogs and the Outline collapse). Cross-
 * feature state stays in `useUi()` (F); this store is for chrome only the
 * shell renders, so no other package needs to know about it.
 *
 * The Outline collapse (⌘\, DESIGN §4.2) is remembered per device in
 * localStorage, like the pane sizes.
 */
import { create } from "zustand";

const OUTLINE_KEY = "yonder:outline-collapsed";

function readCollapsed(): boolean {
	try {
		return globalThis.localStorage?.getItem(OUTLINE_KEY) === "1";
	} catch {
		return false;
	}
}

function writeCollapsed(v: boolean): void {
	try {
		if (v) globalThis.localStorage?.setItem(OUTLINE_KEY, "1");
		else globalThis.localStorage?.removeItem(OUTLINE_KEY);
	} catch {
		// storage unavailable (private mode): the collapse just isn't remembered
	}
}

export type ShellState = {
	/** xl Outline collapsed to 0 (⌘\). */
	outlineCollapsed: boolean;
	toggleOutline(): void;
	/** The `?` shortcuts sheet. */
	shortcutsOpen: boolean;
	setShortcutsOpen(v: boolean): void;
	/** The activity view (digest "N changes" link, the inspector footer). */
	activityOpen: boolean;
	setActivityOpen(v: boolean): void;
	/** View settings (ADDENDUM §7.2). */
	viewSettingsOpen: boolean;
	setViewSettingsOpen(v: boolean): void;
	/** The inbox popover / drawer. */
	inboxOpen: boolean;
	setInboxOpen(v: boolean): void;
	/**
	 * A request to open the inspector on a tab while `sel` (serialized) is the
	 * selection: a "Still to plan" to-do opens on its Lists tab (PLAN-R2-05).
	 * It holds while that selection stays (the inspector can remount when the
	 * route's search changes) and is dropped once the selection moves to
	 * anything but `from` (where the click happened); `at` lets it lapse.
	 */
	inspectorTab: {
		sel: string;
		tab: InspectorTab;
		from: string;
		at: number;
	} | null;
	openInspectorTab(sel: string, tab: InspectorTab, from?: string): void;
	clearInspectorTab(): void;
};

export type InspectorTab = "overview" | "media" | "lists" | "notes" | "money";

/** How long an `inspectorTab` request stays good. */
export const INSPECTOR_TAB_TTL_MS = 10_000;

export const useShell = create<ShellState>()((set, get) => ({
	outlineCollapsed: readCollapsed(),
	toggleOutline: () => {
		const next = !get().outlineCollapsed;
		writeCollapsed(next);
		set({ outlineCollapsed: next });
	},
	shortcutsOpen: false,
	setShortcutsOpen: (shortcutsOpen) => set({ shortcutsOpen }),
	activityOpen: false,
	setActivityOpen: (activityOpen) => set({ activityOpen }),
	viewSettingsOpen: false,
	setViewSettingsOpen: (viewSettingsOpen) => set({ viewSettingsOpen }),
	inboxOpen: false,
	setInboxOpen: (inboxOpen) => set({ inboxOpen }),
	inspectorTab: null,
	openInspectorTab: (sel, tab, from = "none") =>
		set({ inspectorTab: { sel, tab, from, at: Date.now() } }),
	clearInspectorTab: () => set({ inspectorTab: null }),
}));
