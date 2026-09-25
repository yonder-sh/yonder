/**
 * View settings synced to the account (ADDENDUM §7.2): default lens, tree
 * expand state per trip, map style, compact mode, 12/24 h, km/mi and the
 * display currency. The durable copy is F's `user_prefs` row (`userPrefsQuery`
 * / `setUserPrefs`, merged server-side per key, per trip for `treeExpanded`,
 * `null` deleting a key); localStorage is the fast cache, so a cold start (or
 * offline) renders with the last known settings at once.
 *
 *   const { prefs, setPrefs } = useViewPrefs()
 *   setPrefs({ clock: "12h" })
 *   setPrefs({ defaultLens: null })        // back to "Automatic"
 *
 * The clock and units also drive `@/lib/format`'s page-wide display setting
 * (`setDisplayPrefs`), so every package's `formatTime` / `TimeText` /
 * `formatDistance` follows without reading prefs itself.
 *
 * Other packages read the same hook (WP-Plan: `compact`; WP-Map: `mapStyle`;
 * WP-Outline: `useTreeExpanded(tripId)`; WP-Money: `displayCurrency`).
 * Unknown or invalid cached values are dropped key by key (`readUserPrefs`),
 * never thrown.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
	useCallback,
	useEffect,
	useMemo,
	useRef,
	useSyncExternalStore,
} from "react";
import { setUserPrefs } from "@/functions/prefs.functions";
import { setDisplayPrefs } from "@/lib/format";
import { meKeys } from "@/lib/query/keys";
import { userPrefsQuery } from "@/lib/query/trip-queries";
import { mergeUserPrefs, readUserPrefs, UserPrefs } from "@/lib/schemas/misc";

export const PREFS_STORAGE_KEY = "yonder:prefs";
/** Changes within this window reach the server as one patch. */
const SYNC_DEBOUNCE_MS = 500;

export type ViewPrefs = UserPrefs;

/**
 * The defaults readers apply (nothing stored = these). No `mapStyle`: with
 * none saved the map follows the app theme (WP-Map's `useMapStyle`, FB-04).
 */
export const PREF_DEFAULTS = {
	compact: false,
	clock: "24h",
	units: "km",
	displayCurrency: null,
} as const satisfies Partial<Required<UserPrefs>>;

// ---- the fast cache (module-level, shared by every hook instance) ----------

let cache: UserPrefs | null = null;
/** Local changes not yet acknowledged by the server (one merged patch). */
let pending: UserPrefs | null = null;
const listeners = new Set<() => void>();

function readStorage(): UserPrefs {
	try {
		const raw = globalThis.localStorage?.getItem(PREFS_STORAGE_KEY);
		return raw ? readUserPrefs(JSON.parse(raw)) : {};
	} catch {
		return {};
	}
}

/** The page-wide 12/24 h and km/mi (`@/lib/format`) follow the prefs. */
function applyDisplay(p: UserPrefs): void {
	setDisplayPrefs({
		clock: p.clock ?? PREF_DEFAULTS.clock,
		units: p.units ?? PREF_DEFAULTS.units,
	});
}

function current(): UserPrefs {
	if (!cache) {
		cache = readStorage();
		applyDisplay(cache);
	}
	return cache;
}

function publish(next: UserPrefs): void {
	cache = next;
	applyDisplay(next);
	try {
		globalThis.localStorage?.setItem(PREFS_STORAGE_KEY, JSON.stringify(next));
	} catch {
		// storage unavailable: the in-memory copy still serves this tab
	}
	for (const l of listeners) l();
}

function subscribe(cb: () => void): () => void {
	listeners.add(cb);
	return () => listeners.delete(cb);
}

const EMPTY: UserPrefs = {};

/** Applies a patch to stored prefs exactly like the server (`mergeUserPrefs`). */
export const mergePrefs = mergeUserPrefs;

/**
 * Two patches as one (the later wins per key; `null` survives, so a reset
 * still reaches the server; `treeExpanded` combines per trip).
 */
export function combinePatches(a: UserPrefs, b: UserPrefs): UserPrefs {
	const out: UserPrefs = { ...a };
	for (const [k, v] of Object.entries(b) as [keyof UserPrefs, unknown][]) {
		if (v === undefined) continue;
		(out as Record<string, unknown>)[k] =
			k === "treeExpanded" && v && a.treeExpanded
				? { ...a.treeExpanded, ...(v as Record<string, string[]>) }
				: v;
	}
	return out;
}

/**
 * The prefs (cache first, then the account's copy) and a setter that updates
 * the cache at once and syncs the patch to the account.
 * `enabled: false` (fixture mode, signed-out pages) keeps it local.
 */
export function useViewPrefs(opts: { enabled?: boolean } = {}): {
	prefs: UserPrefs;
	setPrefs(patch: UserPrefs): void;
	/** The account copy has loaded (or failed): settings are final. */
	synced: boolean;
} {
	const enabled = opts.enabled ?? true;
	const prefs = useSyncExternalStore(subscribe, current, () => EMPTY);
	const qc = useQueryClient();
	const q = useQuery({ ...userPrefsQuery(), enabled });

	// The account copy wins over the cache once it arrives (a key removed on
	// another device goes here too); unsent local changes stay on top.
	useEffect(() => {
		if (!q.data) return;
		const next = pending ? mergeUserPrefs(q.data, pending) : q.data;
		if (JSON.stringify(next) !== JSON.stringify(current())) publish(next);
	}, [q.data]);

	const save = useMutation({
		mutationFn: (patch: UserPrefs) => setUserPrefs({ data: patch }),
		onSuccess: (stored) => {
			qc.setQueryData(meKeys.prefs, stored);
		},
	});
	const { mutate } = save;
	// Rapid changes (expanding tree rows) go to the server as one merged patch.
	const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
	const flush = useCallback(() => {
		timer.current = null;
		const patch = pending;
		pending = null;
		if (patch) mutate(patch);
	}, [mutate]);
	useEffect(
		() => () => {
			if (!timer.current) return;
			clearTimeout(timer.current);
			flush();
		},
		[flush],
	);
	const setPrefs = useCallback(
		(patch: UserPrefs) => {
			const parsed = UserPrefs.safeParse(patch);
			if (!parsed.success) return;
			publish(mergeUserPrefs(current(), parsed.data));
			if (!enabled) return;
			// Every mounted reader sees the change before the server answers.
			qc.setQueryData<UserPrefs>(meKeys.prefs, (old) =>
				mergeUserPrefs(old ?? {}, parsed.data),
			);
			pending = combinePatches(pending ?? {}, parsed.data);
			if (timer.current) clearTimeout(timer.current);
			timer.current = setTimeout(flush, SYNC_DEBOUNCE_MS);
		},
		[enabled, flush, qc],
	);
	return { prefs, setPrefs, synced: !enabled || q.isFetched };
}

const NO_IDS: string[] = [];

/** One trip's expanded Outline rows, synced with the account (per trip on the server). */
export function useTreeExpanded(
	tripId: string,
	opts: { enabled?: boolean } = {},
): [string[], (ids: readonly string[]) => void] {
	const { prefs, setPrefs } = useViewPrefs(opts);
	const ids = useMemo(
		() => prefs.treeExpanded?.[tripId] ?? NO_IDS,
		[prefs.treeExpanded, tripId],
	);
	const set = useCallback(
		(next: readonly string[]) =>
			setPrefs({
				treeExpanded: { [tripId]: [...new Set(next)].slice(0, 500) },
			}),
		[setPrefs, tripId],
	);
	return [ids, set];
}

/** Test hook: forget the module cache (the next read goes back to storage). */
export function resetPrefsCacheForTests(): void {
	cache = null;
	pending = null;
}
