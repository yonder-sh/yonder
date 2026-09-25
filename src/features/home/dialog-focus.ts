/**
 * Focus for the Share and Trip settings dialogs (QA A11Y-02). Both open from
 * the UI store, so Radix has no trigger to go back to, and neither focuses its
 * first field (that would open the phone keyboard). Instead:
 *
 * - on open, the dialog itself takes focus, so Tab starts inside it and the
 *   trap keeps it there (and one Esc closes it);
 * - on close, focus goes back to what opened it. For a menu item that is gone
 *   by then, that is the menu's button (Radix labels a menu by its trigger).
 *
 *   const focus = useDialogFocus();
 *   <DialogContent {...focus}>…
 */
import { useMemo, useRef } from "react";

function openerOf(el: Element | null): HTMLElement | null {
	if (!(el instanceof HTMLElement) || el === document.body) return null;
	const menu = el.closest('[role="menu"]');
	if (!menu) return el;
	const id = menu.getAttribute("aria-labelledby");
	const trigger = id ? document.getElementById(id) : null;
	return trigger instanceof HTMLElement ? trigger : null;
}

export function useDialogFocus(): {
	onOpenAutoFocus: (e: Event) => void;
	onCloseAutoFocus: (e: Event) => void;
} {
	const returnTo = useRef<HTMLElement | null>(null);
	return useMemo(
		() => ({
			onOpenAutoFocus: (e: Event) => {
				e.preventDefault();
				returnTo.current = openerOf(document.activeElement);
				const dialog = (e.currentTarget ?? e.target) as HTMLElement | null;
				dialog?.focus({ preventScroll: true });
			},
			onCloseAutoFocus: (e: Event) => {
				const el = returnTo.current;
				returnTo.current = null;
				if (!el?.isConnected) return;
				e.preventDefault();
				el.focus({ preventScroll: true });
			},
		}),
		[],
	);
}
