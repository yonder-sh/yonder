/**
 * `useIsSmall()`: the < 768 px layout (the mobile Outline drawer), where rows
 * are 44 px touch targets and Ideas sit under the tree (DESIGN §6).
 */
import { useSyncExternalStore } from "react";

const SMALL = "(max-width: 767.98px)";

function subscribe(cb: () => void) {
	if (typeof window === "undefined" || !window.matchMedia) return () => {};
	const mq = window.matchMedia(SMALL);
	mq.addEventListener("change", cb);
	return () => mq.removeEventListener("change", cb);
}

export function useIsSmall(): boolean {
	return useSyncExternalStore(
		subscribe,
		() => typeof window !== "undefined" && !!window.matchMedia?.(SMALL).matches,
		() => false,
	);
}
