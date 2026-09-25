import { useSyncExternalStore } from "react";

/** A CSS media query as React state (false during SSR). */
export function useMediaQuery(query: string): boolean {
	return useSyncExternalStore(
		(cb) => {
			if (typeof window === "undefined" || !window.matchMedia) return () => {};
			const m = window.matchMedia(query);
			m.addEventListener("change", cb);
			return () => m.removeEventListener("change", cb);
		},
		() =>
			typeof window !== "undefined" && window.matchMedia
				? window.matchMedia(query).matches
				: false,
		() => false,
	);
}

/** A clock that ticks every `ms` (client-only; null during SSR and tests that don't want it). */
export function useNow(ms = 60_000): number {
	return useSyncExternalStore(
		(cb) => {
			const t = setInterval(cb, ms);
			return () => clearInterval(t);
		},
		() => Math.floor(Date.now() / ms) * ms,
		() => 0,
	);
}
