/**
 * What sits on the screen's foot: bars marked `data-bottom-bar` (the phone's
 * tab bar, the Plan's dock, a selection bar, a drawer's Save row…), the
 * floating buttons (`="float"`: the (+) and the Rate pill) and the keyboard.
 * Measured onto <html>, so nothing floats over another's buttons:
 * - `--page-bars-h`: the page's bars (not a dialog's; floats sit above these,
 *   and stay put under a dialog's backdrop);
 * - `--bottom-bars-h`: everything visible, floats too (toasts sit above);
 * - `--keyboard-h`: the on-screen keyboard (iOS).
 */
import { useEffect, useSyncExternalStore } from "react";

/** A bar this close above the foot (or above a bar there) still counts. */
const SLACK = 40;

type Box = { top: number; bottom: number };

/**
 * How far up from the viewport's foot the bars stacked on it reach: a bar
 * counts when it is within SLACK of the foot or of a bar already counted (pure).
 */
export function stackedInset(boxes: readonly Box[], vh: number): number {
	let inset = 0;
	const sorted = boxes
		.filter((b) => b.bottom > b.top)
		.sort((a, b) => b.bottom - a.bottom);
	for (const b of sorted) {
		if (b.bottom < vh - inset - SLACK) break;
		inset = Math.max(inset, vh - b.top);
	}
	return Math.max(0, Math.round(inset));
}

/** The keyboard's height over the layout viewport (iOS), else 0. */
function keyboardInset(): number {
	const vv = window.visualViewport;
	if (!vv) return 0;
	return Math.max(0, Math.round(window.innerHeight - vv.height - vv.offsetTop));
}

function measure() {
	const vh = window.innerHeight;
	const page: Box[] = [];
	const shown: Box[] = [];
	for (const el of document.querySelectorAll<HTMLElement>(
		"[data-bottom-bar]",
	)) {
		const r = el.getBoundingClientRect();
		if (r.width <= 0) continue;
		const box = { top: r.top, bottom: r.bottom };
		if (el.dataset.bottomBar !== "float" && !el.closest('[role="dialog"]'))
			page.push(box);
		// Under a modal (aria-hidden by it): covered, not in the way.
		if (!el.closest('[aria-hidden="true"],[inert]')) shown.push(box);
	}
	const root = document.documentElement.style;
	root.setProperty("--page-bars-h", `${stackedInset(page, vh)}px`);
	root.setProperty("--bottom-bars-h", `${stackedInset(shown, vh)}px`);
	root.setProperty("--keyboard-h", `${keyboardInset()}px`);
}

/** Keeps the three variables current (mount once, at the root). */
export function useBottomBars() {
	useEffect(() => {
		let frame = 0;
		const schedule = () => {
			if (!frame)
				frame = requestAnimationFrame(() => {
					frame = 0;
					measure();
				});
		};
		measure();
		const mo = new MutationObserver(schedule);
		mo.observe(document.body, {
			childList: true,
			subtree: true,
			attributes: true,
			attributeFilter: ["aria-hidden", "inert", "data-state", "class"],
		});
		const vv = window.visualViewport;
		window.addEventListener("resize", schedule);
		vv?.addEventListener("resize", schedule);
		vv?.addEventListener("scroll", schedule);
		// Sheets slide in and sticky bars scroll into place: measure where they land.
		document.addEventListener("transitionend", schedule, true);
		document.addEventListener("animationend", schedule, true);
		document.addEventListener("scroll", schedule, true);
		return () => {
			cancelAnimationFrame(frame);
			mo.disconnect();
			window.removeEventListener("resize", schedule);
			vv?.removeEventListener("resize", schedule);
			vv?.removeEventListener("scroll", schedule);
			document.removeEventListener("transitionend", schedule, true);
			document.removeEventListener("animationend", schedule, true);
			document.removeEventListener("scroll", schedule, true);
		};
	}, []);
}

/** A text field has focus on a touch screen: the keyboard is (about to be) up. */
function typing(): boolean {
	const el = document.activeElement;
	if (!(el instanceof HTMLElement)) return false;
	if (!window.matchMedia?.("(pointer: coarse)").matches) return false;
	if (el.isContentEditable || el instanceof HTMLTextAreaElement) return true;
	return (
		el instanceof HTMLInputElement &&
		!/^(button|checkbox|color|file|hidden|image|radio|range|reset|submit)$/.test(
			el.type,
		)
	);
}

function subscribeFocus(on: () => void) {
	document.addEventListener("focusin", on);
	document.addEventListener("focusout", on);
	return () => {
		document.removeEventListener("focusin", on);
		document.removeEventListener("focusout", on);
	};
}

/** True while typing on a phone: floating buttons step aside for the keyboard. */
export function useTyping(): boolean {
	return useSyncExternalStore(subscribeFocus, typing, () => false);
}

/** A float's bottom edge: `gap` above the page's bars (else the home indicator). */
export const floatBottom = (gap: number) =>
	`calc(max(var(--page-bars-h, 0px), env(safe-area-inset-bottom, 0px)) + ${gap}px)`;

/**
 * Toasts' bottom edge: `gap` above the bars and floats on the foot, the
 * keyboard and the home indicator, whichever reaches highest.
 */
export const toastBottom = (gap: number) =>
	`calc(max(var(--bottom-bars-h, 0px), var(--keyboard-h, 0px), env(safe-area-inset-bottom, 0px)) + ${gap}px)`;
