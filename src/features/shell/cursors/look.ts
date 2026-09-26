/**
 * Publishes what I see on the trip's channel awareness (`look`): for each
 * scrolling area on my screen, the items at its top and bottom edges (by
 * item id, `edgesOf`), and where my attention is (map or panel). A follower
 * scrolls to the same items in its own layout (`scroll-follow.ts`) and a
 * phone follower's sheet goes up or down with it.
 *
 * - Desktop: the focus is where my last click, wheel, touch or scroll key
 *   went (the map's box, or anything else in the workspace). A phone: my
 *   sheet's snap (peek = map, half, full).
 * - Sent at most every LOOK_SEND_MS, only when it changed; recomputed on
 *   scroll and resize, and every second (a section opening moves things).
 *   The ranges are worked out only while someone follows me.
 * - Items inside anything private (`data-cursor-vis="private"`), ignored or
 *   under a caret never count; the server also drops private rows.
 */
import type { Awareness } from "y-protocols/awareness";
import {
	type AwarenessLook,
	isItemAnchor,
	LOOK_SEND_MS,
	type LookFocus,
	type LookRange,
	MAX_LOOK_RANGES,
	sameLook,
} from "@/lib/realtime/view-protocol";
import {
	ANCHOR_ATTR,
	CARET_ATTR,
	IGNORE_ATTR,
	MAP_ATTR,
	scrollerOf,
	VIS_ATTR,
	visibleBox,
} from "./anchors";
import { type Box, isEmpty } from "./geometry";
import { type Cand, edgesOf } from "./scroll-rules";

const SKIP = `[${VIS_ATTR}="private"],[${IGNORE_ATTR}],[${CARET_ATTR}]`;
/** Portals that aren't the workspace (dialogs, menus, popovers). */
const OVERLAY =
	'[role="dialog"],[role="menu"],[data-radix-popper-content-wrapper]';
const SCROLL_KEYS = new Set([
	"ArrowUp",
	"ArrowDown",
	"PageUp",
	"PageDown",
	"Home",
	"End",
	" ",
]);
const TICK_MS = 1_000;

/** The scrolling areas on screen and what I see of each (DOM order, largest first). */
export function lookRanges(): LookRange[] {
	const groups = new Map<Element, Element[]>();
	const vw = window.innerWidth;
	const vh = window.innerHeight;
	for (const el of document.querySelectorAll(`[${ANCHOR_ATTR}]`)) {
		const id = el.getAttribute(ANCHOR_ATTR) ?? "";
		if (!isItemAnchor(id)) continue;
		const r = el.getBoundingClientRect();
		if (r.bottom <= 0 || r.top >= vh || r.right <= 0 || r.left >= vw) continue;
		if (r.width < 1 || r.height < 1) continue;
		const s = scrollerOf(el);
		if (!s) continue;
		const list = groups.get(s);
		if (list) list.push(el);
		else groups.set(s, [el]);
	}
	const out: { range: LookRange; area: number }[] = [];
	for (const [scroller, els] of groups) {
		if (scroller.closest("[inert]")) continue;
		const box = visibleBox(scroller);
		if (isEmpty(box)) continue;
		const cands = visibleLeaves(els, box);
		const edges = edgesOf(cands, box);
		if (!edges) continue;
		const members = els.some((e) => e.closest(`[${VIS_ATTR}="members"]`));
		out.push({
			range: { ...edges, ...(members ? { v: "members" as const } : {}) },
			area: (box.right - box.left) * (box.bottom - box.top),
		});
	}
	return out
		.sort((a, b) => b.area - a.area)
		.slice(0, MAX_LOOK_RANGES)
		.map((x) => x.range);
}

/** The innermost items of `els` (document order) that show in `box`. */
function visibleLeaves(els: readonly Element[], box: Box): Cand[] {
	const shown: { el: Element; r: DOMRect }[] = [];
	for (const el of els) {
		const r = el.getBoundingClientRect();
		if (r.bottom <= box.top || r.top >= box.bottom) continue;
		if (r.right <= box.left || r.left >= box.right) continue;
		if (el.closest(SKIP)) continue;
		shown.push({ el, r });
	}
	const out: Cand[] = [];
	for (let i = 0; i < shown.length; i++) {
		const cur = shown[i] as { el: Element; r: DOMRect };
		const next = shown[i + 1];
		// In document order a container comes right before what it holds.
		if (next && cur.el.contains(next.el)) continue;
		// A sticky header sits at the top whatever is under it: not an edge.
		if (out.length === 0 && isStuck(cur.el)) continue;
		out.push({
			id: cur.el.getAttribute(ANCHOR_ATTR) ?? "",
			top: cur.r.top,
			bottom: cur.r.bottom,
			left: cur.r.left,
			right: cur.r.right,
		});
	}
	return out;
}

function isStuck(el: Element): boolean {
	const p = getComputedStyle(el).position;
	return p === "sticky" || p === "fixed";
}

/** Where an input event says my attention is, or null (a dialog, a menu). */
export function focusOfTarget(target: EventTarget | null): LookFocus | null {
	if (!(target instanceof Element)) return null;
	if (target.closest(`[${MAP_ATTR}]`)) return "map";
	if (target.closest(OVERLAY)) return null;
	return "panel";
}

export class LookSender {
	private focus: LookFocus = "panel";
	private phoneFocus: LookFocus | null = null;
	private sent: AwarenessLook | null = null;
	private wasFollowed = false;
	private lastAt = 0;
	private timer: ReturnType<typeof setTimeout> | null = null;
	private tick: ReturnType<typeof setInterval> | null = null;
	private readonly off: (() => void)[] = [];

	constructor(
		private readonly awareness: Awareness,
		private readonly selfUserId: () => string | null,
	) {}

	/** Someone follows me (the ranges are only worth working out then). */
	private followed(): boolean {
		const me = this.selfUserId();
		if (!me) return false;
		for (const [id, st] of this.awareness.getStates()) {
			if (id === this.awareness.clientID) continue;
			if ((st as { following?: unknown }).following === me) return true;
		}
		return false;
	}

	start(): void {
		const opts = { capture: true, passive: true } as const;
		const on = <K extends keyof WindowEventMap>(
			type: K,
			fn: (e: WindowEventMap[K]) => void,
		) => {
			window.addEventListener(type, fn, opts);
			this.off.push(() => window.removeEventListener(type, fn, opts));
		};
		const attend = (e: Event) => {
			const f = focusOfTarget(e.target);
			if (f && f !== this.focus) {
				this.focus = f;
				this.schedule(true);
			}
		};
		on("pointerdown", attend);
		on("wheel", attend);
		on("touchstart", attend);
		on("keydown", (e) => {
			if (SCROLL_KEYS.has(e.key)) attend(e);
		});
		on("scroll", () => this.schedule());
		on("resize", () => this.schedule());
		const vis = () => {
			if (document.visibilityState === "visible") this.schedule(true);
		};
		document.addEventListener("visibilitychange", vis);
		this.off.push(() => document.removeEventListener("visibilitychange", vis));
		const onChange = () => {
			const f = this.followed();
			if (f !== this.wasFollowed) {
				this.wasFollowed = f;
				this.schedule(true);
			}
		};
		this.awareness.on("change", onChange);
		this.off.push(() => this.awareness.off("change", onChange));
		this.wasFollowed = this.followed();
		this.tick = setInterval(() => this.schedule(), TICK_MS);
		this.schedule(true);
	}

	stop(): void {
		for (const f of this.off.splice(0)) f();
		if (this.timer) clearTimeout(this.timer);
		if (this.tick) clearInterval(this.tick);
		this.timer = null;
		this.tick = null;
		this.awareness.setLocalStateField("look", null);
	}

	/** A phone's sheet snap stands for my focus (null: a desktop). */
	setPhoneFocus(f: LookFocus | null): void {
		if (f === this.phoneFocus) return;
		this.phoneFocus = f;
		this.schedule(true);
	}

	private schedule(soon = false): void {
		if (this.timer) return;
		const wait = soon
			? 0
			: Math.max(0, LOOK_SEND_MS - (performance.now() - this.lastAt));
		this.timer = setTimeout(() => {
			this.timer = null;
			this.flush();
		}, wait);
	}

	private flush(): void {
		if (document.visibilityState === "hidden") return;
		const look: AwarenessLook = {
			f: this.phoneFocus ?? this.focus,
			r: this.wasFollowed ? lookRanges() : [],
		};
		if (sameLook(this.sent, look)) return;
		this.sent = look;
		this.lastAt = performance.now();
		this.awareness.setLocalStateField("look", look);
	}
}
