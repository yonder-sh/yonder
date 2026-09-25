/**
 * Cross-feature, ephemeral UI state (SPEC §12.4). Anything that belongs in a
 * deep link (scope, lens, days, sel, tab…) lives in the URL instead
 * (`search.ts`); anything that belongs to one package lives in that package.
 *
 * One store per page (zustand, client-only use). Reset it when leaving a trip
 * (`resetUi()`), so hover/flash state never leaks into another trip.
 */
import type { Feature, LineString } from "geojson";
import { create } from "zustand";
import type { ExpenseCategory } from "@/lib/schemas/enums";
import type { BundleTarget, LegTarget } from "@/lib/schemas/targets";
import {
	readSuggesting,
	setSuggestMode,
	writeSuggesting,
} from "./suggest-mode";

export type HoverTarget = {
	kind: "item" | "rep" | "pair" | "edge" | "day";
	id: string;
};

export type AddPlaceRequest = {
	mode: "search" | "schedule" | "locate" | "first";
	dayId?: string;
	afterItemId?: string;
	/** Insert before this item (the "+" above a day's first card). */
	beforeItemId?: string;
	parentId?: string;
	nodeId?: string;
};

export type AddFlightRequest = {
	dayId?: string;
	afterItemId?: string;
	/** Insert before this item (the "+" above a day's first card). */
	beforeItemId?: string;
	target?: LegTarget;
};

export type MapPadding = {
	top: number;
	right: number;
	bottom: number;
	left: number;
};

export type Flash = { color: number; name: string; until: number };

/** E1: the hours editor for one node (WP-Insights `HoursEditorDialog`). */
export type HoursEditorRequest = { nodeId: string };

/** E5: the Add expense dialog (WP-Money), pre-filled from where it was opened. */
export type AddExpenseRequest = {
	target?: BundleTarget;
	title?: string;
	category?: ExpenseCategory;
	amountMinor?: number;
	currency?: string;
	/** "Add as expense" from a shopping item / a leg's cost. */
	listItemId?: string;
	/**
	 * ADDENDUM §10 gift privacy: start the expense private (an expense from a
	 * PRIVATE list item; the server forces it private for such an item anyway).
	 */
	isPrivate?: boolean;
	/** Open the editor on an existing expense (inbox links, overviews). */
	expenseId?: string;
	/** Start a refund of this expense. */
	refundOfId?: string;
};

/** E2: the date what-if draft (never persisted; survives navigation). */
export type DateDraft = { deltaDays: number };

export type UiState = {
	hover: HoverTarget | null;
	setHover(h: HoverTarget | null): void;
	/** WP-Transit sets it (option hover); WP-Map draws it. */
	previewRoute: Feature<LineString, { color?: string }>[] | null;
	setPreviewRoute(r: UiState["previewRoute"]): void;
	/** WP-Shell sets it (inspector width, sheet height); WP-Map fits with it. */
	mapPadding: MapPadding;
	setMapPadding(p: MapPadding): void;
	/** Map layer menu "Selected days"; persisted in localStorage by WP-Map. */
	dayFilterMode: "only" | "dim";
	setDayFilterMode(m: "only" | "dim"): void;
	addPlace: AddPlaceRequest | null;
	openAddPlace(r: AddPlaceRequest | null): void;
	addFlight: AddFlightRequest | null;
	openAddFlight(r: AddFlightRequest | null): void;
	shareOpen: boolean;
	setShareOpen(v: boolean): void;
	settingsOpen: boolean;
	setSettingsOpen(v: boolean): void;
	profileOpen: boolean;
	setProfileOpen(v: boolean): void;
	/** entity id → the remote actor whose change should glow (§10.8). */
	flashes: Record<string, Flash>;
	flash(id: string, actor: { name: string; color: number }): void;
	/** userId of the peer being followed (WP-Shell). */
	following: string | null;
	setFollowing(userId: string | null): void;
	/** The map's current zoom (WP-Map writes it; the "Show areas" chip reads it). */
	mapZoom: number;
	setMapZoom(z: number): void;
	/** Mobile: which snap the bottom sheet is at (WP-Shell). */
	sheetSnap: number | string | null;
	setSheetSnap(s: number | string | null): void;
	// ---- F-ext0 (EXTENSIONS §2.3) ----
	/** E7: this trip's suggest mode (editors' toggle; mirrored to localStorage and the mode header). */
	suggesting: boolean;
	/** Loads the remembered mode when a trip opens (the workspace route calls it). */
	loadSuggesting(tripId: string): void;
	setSuggesting(tripId: string, on: boolean): void;
	/** E7 ReviewDrawer (WP-Suggest). */
	reviewOpen: boolean;
	setReviewOpen(v: boolean): void;
	/** E1 HoursEditorDialog (WP-Insights). */
	hoursEditor: HoursEditorRequest | null;
	openHoursEditor(r: HoursEditorRequest | null): void;
	/** E5 AddExpenseDialog (WP-Money). */
	addExpense: AddExpenseRequest | null;
	openAddExpense(r: AddExpenseRequest | null): void;
	/** E2 ShiftTripDialog (WP-Insights). */
	shiftOpen: boolean;
	openShiftTrip(v?: boolean): void;
	/** E2 what-if draft; WhatIfChip shows while set. */
	dateDraft: DateDraft | null;
	setDateDraft(d: DateDraft | null): void;
	/** Clears per-trip state when leaving a trip. */
	resetUi(): void;
};

/** How long a remote-change glow lasts (the `glow` keyframes run 1.2 s). */
export const FLASH_MS = 1_200;

const PER_TRIP = {
	hover: null,
	previewRoute: null,
	addPlace: null,
	addFlight: null,
	shareOpen: false,
	settingsOpen: false,
	profileOpen: false,
	flashes: {},
	following: null,
	suggesting: false,
	reviewOpen: false,
	hoursEditor: null,
	addExpense: null,
	shiftOpen: false,
	dateDraft: null,
} satisfies Partial<UiState>;

export const useUi = create<UiState>()((set) => ({
	...PER_TRIP,
	mapPadding: { top: 16, right: 16, bottom: 16, left: 16 },
	dayFilterMode: "only",
	mapZoom: 4,
	sheetSnap: null,
	setHover: (hover) => set({ hover }),
	setPreviewRoute: (previewRoute) => set({ previewRoute }),
	setMapPadding: (mapPadding) => set({ mapPadding }),
	setDayFilterMode: (dayFilterMode) => set({ dayFilterMode }),
	openAddPlace: (addPlace) => set({ addPlace }),
	openAddFlight: (addFlight) => set({ addFlight }),
	setShareOpen: (shareOpen) => set({ shareOpen }),
	setSettingsOpen: (settingsOpen) => set({ settingsOpen }),
	setProfileOpen: (profileOpen) => set({ profileOpen }),
	flash: (id, actor) => {
		const until = Date.now() + FLASH_MS;
		set((s) => ({
			flashes: {
				...pruneFlashes(s.flashes),
				[id]: { color: actor.color, name: actor.name, until },
			},
		}));
	},
	setFollowing: (following) => set({ following }),
	setMapZoom: (mapZoom) => set({ mapZoom }),
	setSheetSnap: (sheetSnap) => set({ sheetSnap }),
	loadSuggesting: (tripId) => {
		const suggesting = readSuggesting(tripId);
		setSuggestMode(tripId, suggesting);
		set({ suggesting });
	},
	setSuggesting: (tripId, on) => {
		writeSuggesting(tripId, on);
		setSuggestMode(tripId, on);
		set({ suggesting: on });
	},
	setReviewOpen: (reviewOpen) => set({ reviewOpen }),
	openHoursEditor: (hoursEditor) => set({ hoursEditor }),
	openAddExpense: (addExpense) => set({ addExpense }),
	openShiftTrip: (shiftOpen = true) => set({ shiftOpen }),
	setDateDraft: (dateDraft) => set({ dateDraft }),
	resetUi: () => {
		setSuggestMode(null, false);
		set({ ...PER_TRIP });
	},
}));

function pruneFlashes(f: Record<string, Flash>): Record<string, Flash> {
	const now = Date.now();
	return Object.fromEntries(Object.entries(f).filter(([, v]) => v.until > now));
}

/** The live glow on an entity, or null. Components add `animate-glow` with `--glow-color`. */
export function useFlash(id: string | null | undefined): Flash | null {
	return useUi((s) => {
		if (!id) return null;
		const f = s.flashes[id];
		return f && f.until > Date.now() ? f : null;
	});
}
