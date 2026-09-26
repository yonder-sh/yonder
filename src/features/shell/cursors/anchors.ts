/**
 * Semantic cursor anchors in the DOM (FB-17): what a point on MY screen means
 * (`encodeAt`), and where someone else's anchor is on MY screen
 * (`resolveAnchor`). The markup contract, for every package:
 *
 * - `data-cursor-anchor="<kind>:<id>"` on a thing people point at (a card, a
 *   day, a tree row, a list row, a tab…). Kinds and who may see them are in
 *   `cursor-protocol.ts` (`ANCHOR_KINDS`). The nearest one to the pointer wins.
 * - A thing drawn more than once on one screen (a day that crosses two
 *   countries, in each country's band) qualifies each drawing's id with the
 *   drawing: `day:<dayId>_<firstCardId>` (`copyAnchorId`). Ids are unique on
 *   a screen; the lookup falls back between drawings (`findAnchor`).
 * - `data-cursor-scroll` on an anchor that is itself a scroll box: its
 *   fractions are of the scrolled CONTENT, not of the visible box.
 * - `data-cursor-vis="members"` on anything guests can't see (money);
 *   `data-cursor-vis="private"` on anything only I can see (a private to-do or
 *   expense, my private note): the cursor disappears there for everyone.
 * - `data-cursor-caret` on a text editor whose own caret takes over (notes).
 * - `data-cursor-ignore` on anything else a cursor must never point into.
 * - `data-cursor-map` on the map's box (the map projector does the rest).
 *
 * Menus, dialogs and popovers render in portals outside every anchor, so a
 * cursor over them has no anchor: it fades out.
 */
import {
	ANCHOR_COPY_SEP,
	anchorPolicy,
	type CursorAnchor,
	type CursorVis,
	plainAnchorId,
	roundAnchor,
} from "@/lib/realtime/cursor-protocol";
import { MENU_CURSOR_ID } from "@/lib/realtime/view-protocol";
import { getMapProjector } from "@/lib/workspace/map-projector";
import { type Box, clamp01, intersect, isEmpty } from "./geometry";

export const ANCHOR_ATTR = "data-cursor-anchor";
export const SCROLL_ATTR = "data-cursor-scroll";
export const VIS_ATTR = "data-cursor-vis";
export const CARET_ATTR = "data-cursor-caret";
export const IGNORE_ATTR = "data-cursor-ignore";
export const MAP_ATTR = "data-cursor-map";

export type Encoded = { anchor: CursorAnchor | null; vis: CursorVis };
const HIDDEN: Encoded = { anchor: null, vis: "all" };

/**
 * FB-25: my open menu while others see its ghost (`menu-presence.ts`). A
 * cursor over it travels as fractions of the menu (`menu:open`), so it
 * lands on the same entry of the ghost; any other portal still hides it.
 */
let sharedMenu: { el: Element; vis: CursorVis } | null = null;
export function setSharedMenu(m: { el: Element; vis: CursorVis } | null): void {
	sharedMenu = m;
}

/** The anchor (and who may see it) of client point (x, y) over `target`. */
export function encodeAt(
	target: Element | null,
	x: number,
	y: number,
): Encoded {
	if (sharedMenu && target && sharedMenu.el.contains(target)) {
		const f = fractionsIn(sharedMenu.el, x, y);
		return f
			? {
					anchor: roundAnchor({ k: "el", id: MENU_CURSOR_ID, ...f }),
					vis: sharedMenu.vis,
				}
			: HIDDEN;
	}
	let vis: CursorVis = "all";
	let anchorEl: Element | null = null;
	let mapEl: Element | null = null;
	for (let el = target; el; el = el.parentElement) {
		if (el.hasAttribute(IGNORE_ATTR) || el.hasAttribute(CARET_ATTR))
			return HIDDEN;
		const v = el.getAttribute(VIS_ATTR);
		if (v === "private") return HIDDEN;
		if (v === "members") vis = "members";
		if (!anchorEl && !mapEl) {
			if (el.hasAttribute(ANCHOR_ATTR)) anchorEl = el;
			else if (el.hasAttribute(MAP_ATTR)) mapEl = el;
		}
	}
	if (anchorEl) {
		const id = anchorEl.getAttribute(ANCHOR_ATTR) ?? "";
		const policy = anchorPolicy(id);
		if (!policy) return HIDDEN;
		if (policy === "members") vis = "members";
		const f = fractionsIn(anchorEl, x, y);
		if (!f) return HIDDEN;
		// The enclosing anchor, for screens that don't render this element.
		const upEl = anchorEl.parentElement?.closest(`[${ANCHOR_ATTR}]`);
		const upId = upEl?.getAttribute(ANCHOR_ATTR) ?? "";
		const upPolicy = upEl ? anchorPolicy(upId) : null;
		const uf = upEl && upPolicy ? fractionsIn(upEl, x, y) : null;
		if (upPolicy === "members") vis = "members";
		return {
			anchor: roundAnchor({
				k: "el",
				id,
				fx: f.fx,
				fy: f.fy,
				...(uf ? { p: { id: upId, fx: uf.fx, fy: uf.fy } } : {}),
			}),
			vis,
		};
	}
	if (mapEl) {
		const map = getMapProjector();
		if (!map || !mapEl.contains(map.container)) return HIDDEN;
		const ll = map.unproject(x, y);
		if (!ll || !Number.isFinite(ll.lng) || !Number.isFinite(ll.lat))
			return HIDDEN;
		const lng = ((((ll.lng + 180) % 360) + 360) % 360) - 180;
		if (Math.abs(ll.lat) > 90) return HIDDEN;
		return { anchor: roundAnchor({ k: "map", lng, lat: ll.lat }), vis };
	}
	return HIDDEN;
}

/** Fractions of (x, y) in `el` (of its scrolled content with `data-cursor-scroll`). */
export function fractionsIn(
	el: Element,
	x: number,
	y: number,
): { fx: number; fy: number } | null {
	const r = el.getBoundingClientRect();
	if (r.width < 1 || r.height < 1) return null;
	if (el.hasAttribute(SCROLL_ATTR)) {
		const w = Math.max(el.scrollWidth, r.width);
		const h = Math.max(el.scrollHeight, r.height);
		return {
			fx: clamp01((x - r.left + el.scrollLeft) / w),
			fy: clamp01((y - r.top + el.scrollTop) / h),
		};
	}
	return {
		fx: clamp01((x - r.left) / r.width),
		fy: clamp01((y - r.top) / r.height),
	};
}

/** Where fractions (fx, fy) of `el` are on screen now. */
export function pointIn(
	el: Element,
	fx: number,
	fy: number,
): { x: number; y: number } | null {
	const r = el.getBoundingClientRect();
	if (r.width < 1 || r.height < 1) return null;
	if (el.hasAttribute(SCROLL_ATTR)) {
		const w = Math.max(el.scrollWidth, r.width);
		const h = Math.max(el.scrollHeight, r.height);
		return {
			x: r.left - el.scrollLeft + fx * w,
			y: r.top - el.scrollTop + fy * h,
		};
	}
	return { x: r.left + fx * r.width, y: r.top + fy * r.height };
}

export type Resolved = {
	x: number;
	y: number;
	/** The visible part of the region the point lives in (its scroll boxes ∩ the viewport). */
	clip: Box;
	/** The anchor element (element anchors). */
	el: Element | null;
	/** The map's box (map anchors). */
	map: HTMLElement | null;
};

function viewport(): Box {
	return {
		left: 0,
		top: 0,
		right: window.innerWidth,
		bottom: window.innerHeight,
	};
}

const clipCache = new WeakMap<Element, Element[]>();

/** The ancestors of `el` that clip it (overflow other than visible). Cached per element. */
function clippers(el: Element): Element[] {
	const hit = clipCache.get(el);
	if (hit) return hit;
	const out: Element[] = [];
	for (
		let p = el.parentElement;
		p && p !== document.body;
		p = p.parentElement
	) {
		const s = getComputedStyle(p);
		if (s.overflowX !== "visible" || s.overflowY !== "visible") out.push(p);
		if (s.position === "fixed") break;
	}
	clipCache.set(el, out);
	return out;
}

/** The visible box `el` can be seen in (its clipping ancestors ∩ the viewport). */
export function clipOf(el: Element): Box {
	let box = viewport();
	for (const c of clippers(el)) {
		const r = c.getBoundingClientRect();
		box = intersect(box, {
			left: r.left,
			top: r.top,
			right: r.right,
			bottom: r.bottom,
		});
	}
	return box;
}

const scrollerCache = new WeakMap<Element, Element | null>();

function scrolls(el: Element): boolean {
	const o = getComputedStyle(el).overflowY;
	return o === "auto" || o === "scroll" || o === "overlay";
}

/**
 * The element `el` scrolls in (the nearest ancestor that scrolls
 * vertically and has something to scroll), else null.
 */
export function scrollerOf(el: Element): Element | null {
	let s = scrollerCache.get(el);
	if (s === undefined) {
		s = null;
		for (
			let p = el.parentElement;
			p && p !== document.body;
			p = p.parentElement
		) {
			if (scrolls(p)) {
				s = p;
				break;
			}
		}
		scrollerCache.set(el, s);
	}
	// A box that has nothing to scroll now lets its own scroller take over.
	if (s && s.scrollHeight <= s.clientHeight + 1)
		return s.isConnected ? scrollerOf(s) : null;
	return s;
}

/** The part of scroll box `el` I can see now (its box ∩ its clipping ancestors). */
export function visibleBox(el: Element): Box {
	const r = el.getBoundingClientRect();
	return intersect(clipOf(el), {
		left: r.left,
		top: r.top,
		right: r.right,
		bottom: r.bottom,
	});
}

/** The first of `els` on screen now, else the first rendered one. */
function firstShown(els: Iterable<Element>): Element | null {
	let fallback: Element | null = null;
	for (const el of els) {
		const r = el.getBoundingClientRect();
		if (r.width < 1 || r.height < 1) continue;
		const c = clipOf(el);
		if (!isEmpty(intersect(c, r))) return el; // visible now: best
		fallback ??= el;
	}
	return fallback;
}

/**
 * The element that stands for anchor `id` on this screen (the one on screen
 * now when several do): the element carrying `id` itself; else, for one
 * drawing of a thing drawn several times (`day:<id>_<copy>`,
 * `cursor-protocol.ts`), the thing drawn once (this screen is at a lens that
 * doesn't split that day); else, for a thing drawn once, one of its drawings
 * here (this screen splits the day across bands). Never ANOTHER drawing of a
 * split thing: the other country's part of a day is not where they are.
 */
export function findAnchor(id: string): Element | null {
	if (!anchorPolicy(id)) return null;
	const exact = firstShown(
		document.querySelectorAll(`[${ANCHOR_ATTR}="${id}"]`),
	);
	if (exact) return exact;
	const plain = plainAnchorId(id);
	if (plain !== id)
		return firstShown(document.querySelectorAll(`[${ANCHOR_ATTR}="${plain}"]`));
	return firstShown(
		document.querySelectorAll(`[${ANCHOR_ATTR}^="${id}${ANCHOR_COPY_SEP}"]`),
	);
}

/** A CSS selector for every drawing of the thing behind anchor `id`. */
export function anchorSelector(id: string): string {
	const plain = plainAnchorId(id);
	return `[${ANCHOR_ATTR}="${plain}"],[${ANCHOR_ATTR}^="${plain}${ANCHOR_COPY_SEP}"]`;
}

/** Someone's anchor on my screen, or null when it isn't here (another tab, a closed panel). */
export function resolveAnchor(
	a: CursorAnchor,
	cached?: Element | null,
): Resolved | null {
	if (a.k === "map") {
		const map = getMapProjector();
		if (!map?.container.isConnected) return null;
		const p = map.project(a.lng, a.lat);
		if (!p || !Number.isFinite(p.x) || !Number.isFinite(p.y)) return null;
		const r = map.container.getBoundingClientRect();
		const clip = intersect(viewport(), {
			left: r.left,
			top: r.top,
			right: r.right,
			bottom: r.bottom,
		});
		if (isEmpty(clip)) return null;
		return { x: p.x, y: p.y, clip, el: null, map: map.container };
	}
	const cachedId = cached?.isConnected
		? cached.getAttribute(ANCHOR_ATTR)
		: null;
	// The element itself (cached while it stays), or another drawing of it;
	// re-looked-up each frame otherwise, so a day coming into view takes over
	// from its enclosing anchor as soon as it is rendered.
	let el = cachedId === a.id ? (cached ?? null) : findAnchor(a.id);
	let spot = { fx: a.fx, fy: a.fy };
	if (!el && a.p) {
		el = cachedId === a.p.id ? (cached ?? null) : findAnchor(a.p.id);
		spot = a.p;
	}
	if (!el) return null;
	const p = pointIn(el, spot.fx, spot.fy);
	if (!p) return null;
	const clip = clipOf(el);
	if (isEmpty(clip)) return null;
	return { x: p.x, y: p.y, clip, el, map: null };
}

/** True when nothing opaque (a dialog, the sheet, the inspector) covers (x, y). */
export function uncovered(r: Resolved): boolean {
	const top = document.elementFromPoint(r.x, r.y);
	if (!top) return false;
	if (r.el) return r.el === top || r.el.contains(top) || top.contains(r.el);
	return !!r.map && (r.map === top || r.map.contains(top));
}

/** Scrolls anchor `el` into view (Follow, an edge arrow's jump). */
export function scrollAnchorIntoView(
	el: Element,
	reduced: boolean,
	block: ScrollLogicalPosition = "nearest",
): void {
	el.scrollIntoView({
		block,
		inline: "nearest",
		behavior: reduced ? "auto" : "smooth",
	});
}
