import { useEffect, useRef } from "react";

/**
 * While an overlay of ours is open (lightbox, PDF viewer), Escape closes it
 * and nothing else: the workspace's Esc chain (clear selection → days → zoom
 * out) must not also run. A capturing window listener sees the key first.
 */
export function useEscapeOwner(onEscape: () => void, active = true): void {
	const cb = useRef(onEscape);
	cb.current = onEscape;
	useEffect(() => {
		if (!active) return;
		const onKey = (e: KeyboardEvent) => {
			if (e.key !== "Escape") return;
			e.preventDefault();
			e.stopImmediatePropagation();
			cb.current();
		};
		window.addEventListener("keydown", onKey, true);
		return () => window.removeEventListener("keydown", onKey, true);
	}, [active]);
}

/** The same, as an element to drop inside a dialog's content. */
export function EscapeOwner({ onEscape }: { onEscape: () => void }): null {
	useEscapeOwner(onEscape);
	return null;
}
