/**
 * FB-25 open menus, the sending side: when I open a context menu or a ⋯ /
 * dropdown menu whose trigger sits on an FB-17 anchor (an item card, a day
 * header, an Outline row, a list row, the trip menu…), my awareness `menu`
 * carries its entries as plain-text labels (cleaned, ≤ 15 × 40), the entry I
 * hover or focus, and where it sits relative to that anchor. Others on the
 * same screen (and followers) draw a non-interactive ghost of it
 * (`ghosts.ts`); my cursor over it travels as `menu:open` fractions. Closed
 * with the menu. A menu on something private (`data-cursor-vis="private"`)
 * never travels; the server also drops any on a private anchor.
 *
 * It watches the DOM rather than each menu component: Radix renders every
 * open menu as `[role=menu][data-state=open]` in a portal on <body>; a
 * dropdown's trigger points at it (`aria-controls`), a context menu's is
 * where the right-click / long-press happened.
 */
import type { Awareness } from "y-protocols/awareness";
import { anchorKind, type CursorVis } from "@/lib/realtime/cursor-protocol";
import {
	type AwarenessMenu,
	cleanMenuItems,
	MENU_MAX_ITEMS,
} from "@/lib/realtime/view-protocol";
import { ANCHOR_ATTR, encodeAt, setSharedMenu } from "./anchors";

const MENU_SEL = '[role="menu"][data-state="open"]';
const ENTRY_SEL =
	'[role="menuitem"],[role="menuitemcheckbox"],[role="menuitemradio"],[role="separator"]';
/** A context menu opens within this long of its right-click / long-press. */
const CONTEXT_MS = 1_500;

/** A menu's entries as plain labels ("" = a separator) and the highlighted one. */
export function readMenu(menu: Element): { items: string[]; hi: number } {
	const entries = [...menu.querySelectorAll(ENTRY_SEL)].filter(
		// Only this menu's own entries (never a nested submenu's).
		(e) => e.closest('[role="menu"]') === menu,
	);
	const items: string[] = [];
	let hi = -1;
	for (const e of entries.slice(0, MENU_MAX_ITEMS)) {
		if (e.getAttribute("role") === "separator") {
			// No leading or doubled separators.
			if (items.length && items.at(-1) !== "") items.push("");
			continue;
		}
		const copy = e.cloneNode(true) as Element;
		for (const k of copy.querySelectorAll(
			'[data-slot$="shortcut"],kbd,[aria-hidden="true"]',
		))
			k.remove();
		const checked = e.getAttribute("aria-checked") === "true" ? "✓ " : "";
		if (e.hasAttribute("data-highlighted")) hi = items.length;
		items.push(`${checked}${copy.textContent ?? ""}`);
	}
	while (items.at(-1) === "") items.pop();
	return { items: cleanMenuItems(items), hi };
}

export class MenuSender {
	private lastPress: { target: Element; at: number; context: boolean } | null =
		null;
	private open: {
		menu: Element;
		anchorEl: Element;
		base: Omit<AwarenessMenu, "items" | "hi">;
		watch: MutationObserver;
	} | null = null;
	private sent = "";
	private readonly off: (() => void)[] = [];
	private body: MutationObserver | null = null;

	constructor(private readonly awareness: Awareness) {}

	start(): void {
		const press = (context: boolean) => (e: Event) => {
			if (e.target instanceof Element)
				this.lastPress = { target: e.target, at: performance.now(), context };
		};
		const onDown = press(false);
		const onContext = press(true);
		const onKey = (e: KeyboardEvent) => {
			// Shift+F10 / the Menu key open a context menu on the focused element.
			if (e.key === "ContextMenu" || (e.key === "F10" && e.shiftKey))
				onContext(e);
		};
		const opts = { capture: true, passive: true } as const;
		window.addEventListener("pointerdown", onDown, opts);
		window.addEventListener("contextmenu", onContext, opts);
		window.addEventListener("keydown", onKey, opts);
		this.off.push(() => {
			window.removeEventListener("pointerdown", onDown, opts);
			window.removeEventListener("contextmenu", onContext, opts);
			window.removeEventListener("keydown", onKey, opts);
		});
		// Radix appends menus (in portals) to <body>, and sets data-state on close.
		this.body = new MutationObserver(() => this.scan());
		this.body.observe(document.body, { childList: true });
		this.scan();
	}

	stop(): void {
		for (const f of this.off.splice(0)) f();
		this.body?.disconnect();
		this.close();
	}

	private scan(): void {
		const menus = [...document.querySelectorAll(MENU_SEL)];
		// The outermost open menu (a submenu's trigger lives inside it).
		const top =
			menus.find(
				(m) =>
					!menus.some((o) => o !== m && o.contains(m)) &&
					!m.hasAttribute("data-radix-menu-sub-content") &&
					!document.querySelector(`[aria-controls="${m.id}"][role="menuitem"]`),
			) ?? null;
		if (this.open && this.open.menu === top && top.isConnected) return;
		this.close();
		if (top) this.begin(top);
	}

	private triggerOf(menu: Element): Element | null {
		if (menu.id) {
			const t = document.querySelector(
				`[aria-controls="${CSS.escape(menu.id)}"]`,
			);
			if (t) return t;
		}
		const p = this.lastPress;
		if (
			p?.context &&
			performance.now() - p.at < CONTEXT_MS &&
			p.target.isConnected
		)
			return p.target;
		return null;
	}

	private begin(menu: Element): void {
		const trigger = this.triggerOf(menu);
		if (!trigger) return;
		const tr = trigger.getBoundingClientRect();
		const at = encodeAt(
			trigger,
			tr.left + tr.width / 2,
			tr.top + tr.height / 2,
		);
		const a = at.anchor;
		if (a?.k !== "el" || !anchorKind(a.id)) return; // private, unanchored
		const anchorEl =
			trigger.closest(`[${ANCHOR_ATTR}="${CSS.escape(a.id)}"]`) ??
			trigger.closest(`[${ANCHOR_ATTR}]`);
		if (!anchorEl) return;
		const vis: CursorVis = at.vis;
		const watch = new MutationObserver(() => this.update());
		watch.observe(menu, {
			attributes: true,
			attributeFilter: ["data-highlighted", "data-state", "aria-checked"],
			subtree: true,
			childList: true,
		});
		this.open = {
			menu,
			anchorEl,
			base: { a: a.id, fx: 0, fy: 0, v: vis },
			watch,
		};
		setSharedMenu({ el: menu, vis });
		// Radix positions the content a frame after mounting.
		requestAnimationFrame(() => this.update());
		this.update();
	}

	private update(): void {
		const o = this.open;
		if (!o) return;
		if (!o.menu.isConnected || o.menu.getAttribute("data-state") !== "open") {
			this.close();
			this.scan();
			return;
		}
		const { items, hi } = readMenu(o.menu);
		if (!items.length) return;
		const ar = o.anchorEl.getBoundingClientRect();
		const mr = o.menu.getBoundingClientRect();
		const clamp = (v: number) =>
			Math.round(Math.max(-3, Math.min(4, v)) * 1e4) / 1e4;
		const menu: AwarenessMenu = {
			...o.base,
			fx: ar.width > 0 ? clamp((mr.left - ar.left) / ar.width) : 0,
			fy: ar.height > 0 ? clamp((mr.top - ar.top) / ar.height) : 0,
			items,
			hi,
		};
		const json = JSON.stringify(menu);
		if (json === this.sent) return;
		this.sent = json;
		this.awareness.setLocalStateField("menu", menu);
	}

	private close(): void {
		if (this.open) {
			this.open.watch.disconnect();
			this.open = null;
		}
		setSharedMenu(null);
		if (this.sent !== "null") {
			this.sent = "null";
			this.awareness.setLocalStateField("menu", null);
		}
	}
}
