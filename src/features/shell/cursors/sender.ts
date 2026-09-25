/**
 * Publishes MY cursor on the trip's channel awareness (FB-17): at most every
 * CURSOR_SEND_MS (~20 Hz), only when it changed, anchored semantically
 * (`encodeAt`). There is deliberately no way to stop sharing it (owner
 * decision); it simply disappears where it must:
 * - over menus, dialogs, the notes editor (its caret takes over) and anything
 *   private (`data-cursor-vis="private"`): `a: null`, it fades for everyone;
 * - when the tab is hidden or the pointer leaves the window: `a: null`, and
 *   nothing is sent until the pointer moves again.
 * Touch never hovers: a tap sends `m: "touch"` with a new `tap` number (a
 * ripple for the others) and nothing while the finger moves.
 * Scrolling, wheel zooms and map moves re-encode the same screen point, so
 * the anchor follows what is now under a still mouse.
 */
import type { Awareness } from "y-protocols/awareness";
import {
	type AwarenessCursor,
	type AwarenessReact,
	CURSOR_SEND_MS,
	type CursorAnchor,
	type CursorChat,
	type CursorVis,
	cleanChatText,
	type Reaction,
	sameAnchor,
} from "@/lib/realtime/cursor-protocol";
import { onMapMoved } from "@/lib/workspace/map-projector";
import { type Encoded, encodeAt } from "./anchors";

/** A tap: shorter and stiller than this is a tap, not a scroll or a hold. */
const TAP_MS = 450;
const TAP_SLOP = 10;

export class CursorSender {
	private x = -1;
	private y = -1;
	private pointer: "mouse" | "touch" = "mouse";
	private timer: ReturnType<typeof setTimeout> | null = null;
	private lastSentAt = 0;
	private sent: AwarenessCursor | null | undefined;
	private chat: CursorChat | null = null;
	private chatN = 0;
	private tapN = 0;
	private reactN = 0;
	private down: { x: number; y: number; t: number; id: number } | null = null;
	private readonly off: (() => void)[] = [];

	constructor(private readonly awareness: Awareness) {}

	start(): void {
		const opts = { capture: true, passive: true } as const;
		const on = <K extends keyof WindowEventMap>(
			type: K,
			fn: (e: WindowEventMap[K]) => void,
		) => {
			window.addEventListener(type, fn, opts);
			this.off.push(() => window.removeEventListener(type, fn, opts));
		};
		on("pointermove", (e) => {
			if (e.pointerType === "touch") return; // touch never hovers
			this.pointer = "mouse";
			this.x = e.clientX;
			this.y = e.clientY;
			this.schedule();
		});
		on("pointerdown", (e) => {
			if (e.pointerType !== "touch") return;
			this.down = {
				x: e.clientX,
				y: e.clientY,
				t: performance.now(),
				id: e.pointerId,
			};
		});
		on("pointerup", (e) => {
			if (e.pointerType !== "touch") return;
			const d = this.down;
			this.down = null;
			if (
				!d ||
				d.id !== e.pointerId ||
				performance.now() - d.t > TAP_MS ||
				Math.hypot(e.clientX - d.x, e.clientY - d.y) > TAP_SLOP
			)
				return;
			this.tap(e.clientX, e.clientY, e.target as Element | null);
		});
		on("pointercancel", () => {
			this.down = null;
		});
		on("scroll", () => this.pointer === "mouse" && this.schedule());
		on("wheel", () => this.pointer === "mouse" && this.schedule());
		// Capturing on window also sees every element's blur: only the window's own counts.
		on("blur", (e) => e.target === window && this.hide());
		const leave = (e: MouseEvent) => {
			if (!e.relatedTarget) this.hide();
		};
		document.addEventListener("mouseout", leave);
		this.off.push(() => document.removeEventListener("mouseout", leave));
		const vis = () => {
			if (document.visibilityState === "hidden") this.hide();
		};
		document.addEventListener("visibilitychange", vis);
		this.off.push(() => document.removeEventListener("visibilitychange", vis));
		this.off.push(
			onMapMoved(() => this.pointer === "mouse" && this.schedule()),
		);
	}

	stop(): void {
		for (const f of this.off.splice(0)) f();
		if (this.timer) clearTimeout(this.timer);
		this.timer = null;
		this.write(null);
	}

	/** My pointer's last client position (the chat box and the reaction palette sit there). */
	get position(): { x: number; y: number } | null {
		return this.x < 0 ? null : { x: this.x, y: this.y };
	}

	/** What is under my pointer now (null over menus, the notes editor, private things). */
	encodeHere(): Encoded {
		if (this.x < 0) return { anchor: null, vis: "all" };
		return encodeAt(document.elementFromPoint(this.x, this.y), this.x, this.y);
	}

	/** Cursor chat (FB-17c): the text so far; null ends the message. Sent with the cursor. */
	setChat(text: string | null, opts: { fresh?: boolean } = {}): void {
		const clean = text === null ? "" : cleanChatText(text);
		const starts = !this.chat || !!opts.fresh;
		if (!clean) {
			this.chat = null;
		} else {
			if (starts) this.chatN += 1;
			this.chat = { n: this.chatN, text: clean };
		}
		// Keystrokes ride the cursor's ~20 Hz; a new or ended message goes at once.
		this.schedule(starts || !clean);
	}

	/**
	 * An emoji reaction (FB-17d) at `anchor` (a card, from the touch menu), or
	 * where my pointer is. False when there is nothing to react on.
	 */
	react(e: Reaction, at?: Encoded): boolean {
		const where = at ?? this.encodeHere();
		if (!where.anchor) return false;
		this.reactN += 1;
		const r: AwarenessReact = {
			n: this.reactN,
			e,
			a: where.anchor,
			v: where.vis,
		};
		this.awareness.setLocalStateField("react", r);
		return true;
	}

	private hide(): void {
		if (this.timer) clearTimeout(this.timer);
		this.timer = null;
		this.x = -1;
		this.y = -1;
		this.write({ a: null, v: "all", m: this.pointer });
	}

	private tap(x: number, y: number, target: Element | null): void {
		this.pointer = "touch";
		this.x = x;
		this.y = y;
		const at = encodeAt(target ?? document.elementFromPoint(x, y), x, y);
		this.tapN += 1;
		this.write({
			a: at.anchor,
			v: at.vis,
			m: "touch",
			tap: this.tapN,
			...(this.chat && at.anchor ? { chat: this.chat } : {}),
		});
	}

	private schedule(soon = false): void {
		if (this.timer) return;
		const wait = soon
			? 0
			: Math.max(0, CURSOR_SEND_MS - (performance.now() - this.lastSentAt));
		this.timer = setTimeout(() => {
			this.timer = null;
			this.flush();
		}, wait);
	}

	private flush(): void {
		if (document.visibilityState === "hidden") return;
		if (this.x < 0) return;
		const at = this.encodeHere();
		this.write({
			a: at.anchor,
			v: at.vis,
			m: this.pointer,
			...(this.pointer === "touch" ? { tap: this.tapN } : {}),
			...(this.chat && at.anchor ? { chat: this.chat } : {}),
		});
	}

	private write(c: AwarenessCursor | null): void {
		if (same(this.sent, c)) return;
		this.sent = c;
		this.lastSentAt = performance.now();
		this.awareness.setLocalStateField("cursor", c);
	}
}

function same(
	a: AwarenessCursor | null | undefined,
	b: AwarenessCursor | null,
): boolean {
	if (a === undefined) return false;
	if (!a || !b) return a === b;
	return (
		sameAnchor(a.a, b.a) &&
		a.v === b.v &&
		a.m === b.m &&
		a.tap === b.tap &&
		(a.chat?.n ?? null) === (b.chat?.n ?? null) &&
		(a.chat?.text ?? null) === (b.chat?.text ?? null)
	);
}

export type { CursorAnchor, CursorVis };
