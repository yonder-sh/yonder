/**
 * The map's small client state: the basemap style (the account's view
 * setting, FB-04; the app theme until one is chosen), the layer menu's "Show"
 * switches and "Selected days" mode (per browser, localStorage), and the
 * shared place filter (`?f=`, ADDENDUM §10).
 */
import { useCallback, useEffect, useState } from "react";
import { useViewPrefs } from "@/features/shell/view-prefs";
import type { WorkspaceFilter } from "@/lib/workspace/filter";
import { useUi } from "@/lib/workspace/ui-store";
import { useWorkspace } from "@/lib/workspace/use-workspace";
import type { MapShow } from "./map-data";
import { effectiveMapStyle, type MapStyle, type MapTheme } from "./palette";

export {
	effectiveMapStyle,
	MAP_STYLES,
	type MapStyle,
	mapTone,
} from "./palette";

const SHOW_KEY = "yonder:map:show";
const DAYS_KEY = "yonder:map:days";
export const DEFAULT_SHOW: MapShow = {
	ideas: true,
	dropped: false,
	stays: true,
};

function readJson<T>(key: string): T | null {
	try {
		const raw = window.localStorage.getItem(key);
		return raw ? (JSON.parse(raw) as T) : null;
	} catch {
		return null;
	}
}
function writeJson(key: string, value: unknown) {
	try {
		window.localStorage.setItem(key, JSON.stringify(value));
	} catch {
		// storage unavailable: the choice lasts for this page
	}
}

/** Light or dark, from the `.dark` class ThemeProvider puts on `<html>`. */
const readTheme = (): MapTheme =>
	typeof document !== "undefined" &&
	document.documentElement.classList.contains("dark")
		? "dark"
		: "light";

export function useMapTheme(): MapTheme {
	const [theme, setTheme] = useState<MapTheme>(readTheme);
	useEffect(() => {
		const el = document.documentElement;
		const obs = new MutationObserver(() => setTheme(readTheme()));
		obs.observe(el, { attributes: true, attributeFilter: ["class"] });
		return () => obs.disconnect();
	}, []);
	return theme;
}

/**
 * FB-04: the map style (Light / Dark / Satellite) from the account's view
 * prefs (`mapStyle`, WP-Shell's `useViewPrefs`), and a setter that saves it
 * the same way View settings does. Signed-out and fixture pages keep it local.
 */
export function useMapStyle(): [MapStyle, (style: MapStyle) => void] {
	const { mode } = useWorkspace();
	const { prefs, setPrefs } = useViewPrefs({ enabled: mode === "live" });
	const theme = useMapTheme();
	const style = effectiveMapStyle(prefs.mapStyle, theme);
	const set = useCallback(
		(mapStyle: MapStyle) => setPrefs({ mapStyle }),
		[setPrefs],
	);
	return [style, set];
}

/** Layer menu "Show: Ideas · Dropped · Stays" (DESIGN §5.1). */
export function useMapShow(): [MapShow, (patch: Partial<MapShow>) => void] {
	const [show, setShow] = useState<MapShow>(() => ({
		...DEFAULT_SHOW,
		...(typeof window === "undefined"
			? {}
			: readJson<Partial<MapShow>>(SHOW_KEY)),
	}));
	const update = useCallback((patch: Partial<MapShow>) => {
		setShow((s) => {
			const next = { ...s, ...patch };
			writeJson(SHOW_KEY, next);
			return next;
		});
	}, []);
	return [show, update];
}

/** "Selected days: Only · Dim others" lives in `useUi`; WP-Map persists it. */
export function useDayModePersistence() {
	const mode = useUi((s) => s.dayFilterMode);
	const setMode = useUi((s) => s.setDayFilterMode);
	useEffect(() => {
		const saved = readJson<string>(DAYS_KEY);
		if (saved === "only" || saved === "dim") setMode(saved);
	}, [setMode]);
	useEffect(() => {
		writeJson(DAYS_KEY, mode);
	}, [mode]);
}

/**
 * The shared place filter (`?f=`, ADDENDUM §10): F parses it into
 * `Workspace.filter`, and `nav.setFilter` rewrites only `f` (replace, no
 * scroll; an empty filter drops the param).
 */
export function useSharedFilter(): [
	WorkspaceFilter,
	(f: WorkspaceFilter | null) => void,
] {
	const { filter, nav } = useWorkspace();
	const set = useCallback(
		(f: WorkspaceFilter | null) => nav.setFilter(f),
		[nav],
	);
	return [filter, set];
}
