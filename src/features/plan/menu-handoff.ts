/**
 * Plan menu items that open another surface (FB-07): "Set stay…" (the stay
 * picker), "Rename day…" / "Add a title…" (an inline input), "Delete day…"
 * (the inline confirm), "Pin start time…" and the "+" menu's "Custom…" (a
 * popover).
 *
 * Radix keeps a closing menu mounted, and live under the pointer, for its
 * ~150 ms exit animation: the item under a resting hand focuses itself on
 * `pointermove`, and the menu focuses itself on `pointerleave`. A popover
 * opened straight from `onSelect` (or one `setTimeout(0)` later) mounts
 * inside that window, so the first twitch of the mouse moves the focus back
 * into the dying menu: the popover sees a focus-outside and closes (the stay
 * picker "shows for half a second and disappears"), and an inline input
 * blurs and closes.
 *
 * `handOff(fn)` runs `fn` once the menu content has UNMOUNTED: Radix calls
 * `onCloseAutoFocus` from the content's focus scope after the exit
 * animation, and the handler also skips Radix's return of the focus to the
 * ⋯ trigger, so the new surface keeps it. Spread `onCloseAutoFocus` on the
 * menu's content (or call it first from your own handler: it returns true
 * when it ran a handed-off action).
 *
 * Menu items that open a modal dialog (Add expense, Place…, Flight…) don't
 * need it: a modal dialog traps the focus and never closes on focus-outside.
 */
import { useEffect, useMemo, useRef } from "react";

/** Wraps a menu item's action so it runs once the menu has closed. */
export type HandOff = (fn: () => void) => () => void;

/** Only if the menu never reports its unmount (it always should). */
export const HANDOFF_FALLBACK_MS = 1000;

export function useMenuHandoff(): {
	handOff: HandOff;
	onCloseAutoFocus(e: Event): boolean;
} {
	const pending = useRef<(() => void) | null>(null);
	const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
	useEffect(
		() => () => {
			if (timer.current) clearTimeout(timer.current);
		},
		[],
	);
	return useMemo(() => {
		const flush = () => {
			if (timer.current) clearTimeout(timer.current);
			timer.current = null;
			const fn = pending.current;
			pending.current = null;
			fn?.();
		};
		return {
			handOff: (fn) => () => {
				pending.current = fn;
				if (timer.current) clearTimeout(timer.current);
				timer.current = setTimeout(flush, HANDOFF_FALLBACK_MS);
			},
			onCloseAutoFocus: (e) => {
				if (!pending.current) return false;
				e.preventDefault();
				flush();
				return true;
			},
		};
	}, []);
}
