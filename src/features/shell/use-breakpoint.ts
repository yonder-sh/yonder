/**
 * DESIGN §3 breakpoints: xl ≥ 1280 (three panes, floating inspector), lg
 * 1024–1279 (Outline in a popover), md 768–1023 (timeline 55% / map 45%,
 * inspector Sheet), sm < 768 (full-screen map + bottom sheet).
 *
 * The workspace is client-rendered (`ssr: false`), so reading `window` in the
 * initial state is safe and avoids a layout flash.
 */
import { useSyncExternalStore } from "react";

export type Breakpoint = "sm" | "md" | "lg" | "xl";

const QUERIES = {
	xl: "(min-width: 1280px)",
	lg: "(min-width: 1024px)",
	md: "(min-width: 768px)",
} as const;

function current(): Breakpoint {
	if (typeof window === "undefined") return "xl";
	if (window.matchMedia(QUERIES.xl).matches) return "xl";
	if (window.matchMedia(QUERIES.lg).matches) return "lg";
	if (window.matchMedia(QUERIES.md).matches) return "md";
	return "sm";
}

function subscribe(cb: () => void) {
	const lists = Object.values(QUERIES).map((q) => window.matchMedia(q));
	for (const l of lists) l.addEventListener("change", cb);
	return () => {
		for (const l of lists) l.removeEventListener("change", cb);
	};
}

export function useBreakpoint(): Breakpoint {
	return useSyncExternalStore(subscribe, current, () => "xl");
}
