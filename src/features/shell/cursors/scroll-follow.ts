/**
 * Follow the view, not just the pointer: while I follow someone, each of
 * my scrolling areas shows what they see in theirs (`followScroll`), from
 * their `look` (the items at the top and bottom of each of their areas) and
 * their `cursor` (the item their pointer is on, or they last tapped). Both
 * aim at items by id, so it works across layouts (a desktop's two columns,
 * a phone's one).
 *
 * - At most one smooth scroll per area per FOLLOW_EVERY_MS (instant with
 *   reduced motion), and only when their pointer or range leaves my view.
 * - Scrolling a list myself (wheel, touch, keys, the scrollbar) pauses it
 *   (`follow-pause.ts`); the edge arrow shows where they are meanwhile.
 * - Updates come straight from the awareness (no React render per update).
 */
import type { Awareness } from "y-protocols/awareness";
import { AwarenessCursor } from "@/lib/realtime/cursor-protocol";
import {
	AwarenessLook,
	isItemAnchor,
	type LookRange,
} from "@/lib/realtime/view-protocol";
import { useFollowPause } from "../follow-pause";
import {
	ANCHOR_ATTR,
	findAnchor,
	resolveAnchor,
	scrollerOf,
	visibleBox,
} from "./anchors";
import { isEmpty } from "./geometry";
import {
	FOLLOW_EVERY_MS,
	followScroll,
	type Span,
	spotY,
} from "./scroll-rules";

/** A scroll within this long of my own wheel / touch / key is mine (ms). */
const MINE_MS = 500;
const TICK_MS = 1_200;
const SCROLL_KEYS = new Set([
	"ArrowUp",
	"ArrowDown",
	"PageUp",
	"PageDown",
	"Home",
	"End",
	" ",
]);

type Plan = { range: Span | null; pointer: number | null; tap: boolean };

/** The followed user's most recently active client state. */
function leaderState(
	awareness: Awareness,
	userId: string,
): Record<string, unknown> | null {
	let best: { st: Record<string, unknown>; at: number } | null = null;
	for (const [clientId, raw] of awareness.getStates()) {
		if (clientId === awareness.clientID) continue;
		const st = raw as Record<string, unknown> & { user?: { id?: unknown } };
		if (st.user?.id !== userId) continue;
		const at = awareness.meta.get(clientId)?.lastUpdated ?? 0;
		if (!best || at >= best.at) best = { st, at };
	}
	return best?.st ?? null;
}

function spanOf(el: Element): Span {
	const r = el.getBoundingClientRect();
	return { top: r.top, bottom: r.bottom };
}

/** Their range on my screen, and the area it is in (null: not here). */
function placeRange(r: LookRange): { scroller: Element; span: Span } | null {
	const t = findAnchor(r.t.id);
	const b = findAnchor(r.b.id);
	const first = t ?? b;
	const scroller = first ? scrollerOf(first) : null;
	if (!scroller) return null;
	const yt = t ? spotY(spanOf(t), r.t.fy) : null;
	const yb = b && scrollerOf(b) === scroller ? spotY(spanOf(b), r.b.fy) : null;
	const top = yt ?? yb;
	const bottom = yb ?? yt;
	if (top === null || bottom === null) return null;
	return { scroller, span: { top, bottom } };
}

export class ScrollFollower {
	private leader: string | null = null;
	private reduced = false;
	private raf = 0;
	private retry: ReturnType<typeof setTimeout> | null = null;
	/** Looks again now and then: my layout moves too (a section opening). */
	private tick: ReturnType<typeof setInterval> | null = null;
	private readonly lastAt = new WeakMap<Element, number>();
	private mine: { at: number; target: Element | null } = {
		at: 0,
		target: null,
	};
	private readonly off: (() => void)[] = [];

	constructor(private readonly awareness: Awareness) {}

	start(): void {
		const onChange = () => this.kick();
		this.awareness.on("change", onChange);
		this.off.push(() => this.awareness.off("change", onChange));
		const opts = { capture: true, passive: true } as const;
		const on = <K extends keyof WindowEventMap>(
			type: K,
			fn: (e: WindowEventMap[K]) => void,
		) => {
			window.addEventListener(type, fn, opts);
			this.off.push(() => window.removeEventListener(type, fn, opts));
		};
		const mark = (target: EventTarget | null) => {
			this.mine = {
				at: performance.now(),
				target: target instanceof Element ? target : null,
			};
		};
		on("wheel", (e) => mark(e.target));
		on("touchmove", (e) => mark(e.target));
		on("keydown", (e) => {
			if (SCROLL_KEYS.has(e.key)) mark(document.activeElement);
		});
		// The scrollbar: a press on the box itself, right of its content.
		on("pointerdown", (e) => {
			const el = e.target;
			if (
				el instanceof HTMLElement &&
				el.scrollHeight > el.clientHeight &&
				e.offsetX >= el.clientWidth
			)
				mark(el);
		});
		on("scroll", (e) => this.onScroll(e.target));
		on("resize", () => this.kick());
		const unsub = useFollowPause.subscribe((s, prev) => {
			if (prev.scroll && !s.scroll) this.kick();
		});
		this.off.push(unsub);
	}

	stop(): void {
		for (const f of this.off.splice(0)) f();
		if (this.raf) cancelAnimationFrame(this.raf);
		if (this.retry) clearTimeout(this.retry);
		if (this.tick) clearInterval(this.tick);
		this.raf = 0;
		this.retry = null;
		this.tick = null;
	}

	configure(o: { leader: string | null; reduced: boolean }): void {
		const changed = o.leader !== this.leader;
		this.leader = o.leader;
		this.reduced = o.reduced;
		if (!changed) return;
		if (this.tick) clearInterval(this.tick);
		this.tick = o.leader ? setInterval(() => this.kick(), TICK_MS) : null;
		this.kick();
	}

	/** My own scroll (right after my wheel, touch or key there) pauses following. */
	private onScroll(target: EventTarget | null): void {
		if (!this.leader) return;
		if (performance.now() - this.mine.at > MINE_MS) return;
		const el =
			target instanceof Element
				? target
				: target === document
					? document.scrollingElement
					: null;
		const from = this.mine.target;
		if (el && from && (el === from || el.contains(from)))
			useFollowPause.getState().pauseScroll();
	}

	private kick(): void {
		if (this.raf || !this.leader) return;
		this.raf = requestAnimationFrame(() => {
			this.raf = 0;
			this.apply(performance.now());
		});
	}

	private apply(now: number): void {
		const leader = this.leader;
		if (!leader || useFollowPause.getState().scroll) return;
		const st = leaderState(this.awareness, leader);
		if (!st) return;
		const plans = new Map<Element, Plan>();
		const look = AwarenessLook.safeParse(st.look);
		if (look.success) {
			for (const r of look.data.r) {
				const at = placeRange(r);
				if (at && !plans.has(at.scroller))
					plans.set(at.scroller, { range: at.span, pointer: null, tap: false });
			}
		}
		const cursor = AwarenessCursor.safeParse(st.cursor);
		const a = cursor.success ? cursor.data.a : null;
		if (a?.k === "el" && isItemAnchor(a.id)) {
			const res = resolveAnchor(a);
			// Only an item (never a whole pane's fractions: another layout).
			const on = res?.el?.getAttribute(ANCHOR_ATTR) ?? "";
			const scroller = res?.el && isItemAnchor(on) ? scrollerOf(res.el) : null;
			if (res && scroller) {
				const plan = plans.get(scroller) ?? {
					range: null,
					pointer: null,
					tap: false,
				};
				plan.pointer = res.y;
				plan.tap = cursor.success && cursor.data.m === "touch";
				plans.set(scroller, plan);
			}
		}
		let wait = Number.POSITIVE_INFINITY;
		for (const [scroller, plan] of plans) {
			if (scroller.closest("[inert]")) continue;
			const box = visibleBox(scroller);
			if (isEmpty(box)) continue;
			const dy = followScroll({
				view: { top: box.top, bottom: box.bottom },
				pointer: plan.pointer,
				range: plan.range,
				tap: plan.tap,
			});
			if (!dy) continue;
			const since = now - (this.lastAt.get(scroller) ?? 0);
			if (since < FOLLOW_EVERY_MS) {
				wait = Math.min(wait, FOLLOW_EVERY_MS - since);
				continue;
			}
			this.lastAt.set(scroller, now);
			scroller.scrollBy({
				top: dy,
				behavior: this.reduced ? "auto" : "smooth",
			});
		}
		// Throttled: look again when it's allowed (their last word may be the final one).
		if (Number.isFinite(wait) && !this.retry)
			this.retry = setTimeout(() => {
				this.retry = null;
				this.kick();
			}, wait + 20);
	}
}
