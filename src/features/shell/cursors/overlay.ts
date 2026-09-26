/**
 * The live-cursor overlay (FB-17, 17a–d): everyone else's cursor, chat,
 * reactions and taps on ONE fixed layer, driven straight from the trip's
 * channel awareness — no React render per update.
 *
 * - Awareness `change` → parse each changed client's `cursor`/`react` (zod),
 *   keep one entry per user (their most recently active tab).
 * - Every animation frame while something moves: resolve each anchor on MY
 *   screen (`resolveAnchor`), ease the cursor toward it (`Track`), and write
 *   `transform`. The loop sleeps when nothing moves; scrolling, resizing, the
 *   map moving and new awareness wake it.
 * - Shown only for people on my scope; at most MAX_CURSORS (most recently
 *   moved); fades after CURSOR_IDLE_MS still; hidden when the anchor isn't on
 *   my screen (another tab, a panel I don't have open), when something covers
 *   it (a dialog, the sheet), or when I turned others' cursors off.
 * - Off-screen (a scrolled timeline, outside the map): an edge arrow with the
 *   name; clicking it scrolls or pans there (and resumes a paused Follow).
 * - Follow: a followed cursor over the map is kept in view when their camera
 *   isn't mirrored; lists follow their view (`scroll-follow.ts`).
 * - Touch peers never hover: a new `tap` shows a ripple. Everyone's selection
 *   gets a presence-coloured ring on its card/row/day (a style sheet, not a
 *   render).
 * - Reduced motion: positions snap, reactions and ripples fade in place.
 */
import type { Awareness } from "y-protocols/awareness";
import { presenceColor } from "@/components/common/person-avatar";
import {
	AwarenessCursor,
	AwarenessReact,
	CURSOR_IDLE_MS,
	type CursorAnchor,
	MAX_CURSORS,
	REACTIONS,
} from "@/lib/realtime/cursor-protocol";
import {
	AwarenessDrag,
	AwarenessForm,
	AwarenessMenu,
	DRAG_IDLE_MS,
	MENU_CURSOR_ID,
} from "@/lib/realtime/view-protocol";
import {
	getMapProjector,
	isMapCameraFollowed,
	onMapMoved,
} from "@/lib/workspace/map-projector";
import { useFollowPause } from "../follow-pause";
import {
	anchorSelector,
	pointIn,
	type Resolved,
	resolveAnchor,
	scrollAnchorIntoView,
	uncovered,
} from "./anchors";
import { edgeArrow, inside, Track } from "./geometry";
import { type GhostPeer, Ghosts, type LabelOf } from "./ghosts";
import { FOLLOW_EVERY_MS } from "./scroll-rules";

export type OverlayConfig = {
	selfUserId: string | null;
	/** My current scope (people elsewhere get a "where" chip, not a cursor). */
	scopeId: string | null;
	/** View setting: hide other people's cursors (and their chat). */
	hide: boolean;
	/** The user I follow: their anchor is kept in view. */
	following: string | null;
	reduced: boolean;
	/** FB-23: the name of a dragged thing, from MY data (null = unknown). */
	labelOf?: LabelOf;
};

type Parsed = {
	clientId: number;
	userId: string;
	name: string;
	color: number;
	scopeId: string | null | undefined;
	sel: string | null;
	cursor: AwarenessCursor | null;
	react: AwarenessReact | null;
	/** FB-23 / FB-24 / FB-25. */
	drag: AwarenessDrag | null;
	menu: AwarenessMenu | null;
	form: AwarenessForm | null;
	at: number;
};

type Remote = {
	userId: string;
	name: string;
	color: number;
	scopeId: string | null | undefined;
	cursor: AwarenessCursor | null;
	anchorKey: string;
	movedAt: number;
	track: Track;
	anchorEl: Element | null;
	root: HTMLDivElement;
	label: HTMLSpanElement;
	chat: HTMLSpanElement;
	edge: HTMLButtonElement;
	edgeLabel: HTMLSpanElement;
	edgeIcon: SVGSVGElement;
	state: "on" | "idle" | "off";
	edgeState: "on" | "off";
	coveredAt: number;
	covered: boolean;
	followAt: number;
	lastResolved: Resolved | null;
	tap: number | undefined;
	react: number | undefined;
	drag: AwarenessDrag | null;
	dragKey: string;
	dragAt: number;
	menu: AwarenessMenu | null;
	form: AwarenessForm | null;
	/** The cursor is over their own open menu (drawn on its ghost). */
	onMenu: boolean;
};

const SVG_NS = "http://www.w3.org/2000/svg";
/** A classic pointer arrow, tip at (1, 1). */
const ARROW_PATH =
	"M1.5 1.5 L1.5 14.2 L5 10.9 L7.6 16.4 L10 15.3 L7.5 10 L12.4 10 Z";
const CHEVRON_PATH = "M5 3 L10 8 L5 13";

/** Most floating emoji / ripples on screen at once. */
const MAX_FLOATERS = 24;
/** How often a visible cursor re-checks what covers it (ms). */
const COVER_CHECK_MS = 180;

function svg(path: string, fill: boolean): SVGSVGElement {
	const s = document.createElementNS(SVG_NS, "svg");
	s.setAttribute("viewBox", "0 0 18 18");
	s.setAttribute("aria-hidden", "true");
	const p = document.createElementNS(SVG_NS, "path");
	p.setAttribute("d", path);
	if (fill) {
		p.setAttribute("fill", "currentColor");
		p.setAttribute("stroke", "#fff");
		p.setAttribute("stroke-width", "1.3");
		p.setAttribute("stroke-linejoin", "round");
	} else {
		p.setAttribute("fill", "none");
		p.setAttribute("stroke", "currentColor");
		p.setAttribute("stroke-width", "2");
		p.setAttribute("stroke-linecap", "round");
		p.setAttribute("stroke-linejoin", "round");
	}
	s.appendChild(p);
	return s;
}

function anchorKey(a: CursorAnchor | null | undefined): string {
	if (!a) return "";
	return a.k === "map" ? `m${a.lng},${a.lat}` : `e${a.id}@${a.fx},${a.fy}`;
}

/** The anchor ids a peer's `view.sel` highlights (their selection, FB-17 touch). */
export function selectionAnchors(sel: string | null | undefined): string[] {
	if (!sel) return [];
	const [k, id] = sel.split(".");
	if (!id) return [];
	if (k === "i") return [`item:${id}`];
	if (k === "d") return [`dayh:${id}`];
	// A node: its Outline row already carries their presence dot, the map pin its halo.
	return [];
}

/** What the E2E probe records (VITE_E2E only): every anchor this page received. */
export type CursorProbe = {
	seen: { userId: string; anchor: CursorAnchor | null; vis: string }[];
	reacts: { userId: string; e: string; anchor: CursorAnchor }[];
	chats: { userId: string; text: string }[];
	/** FB-23 / FB-25: every drag and menu received. */
	drags: { userId: string; drag: AwarenessDrag | null }[];
	menus: { userId: string; menu: AwarenessMenu | null }[];
};

export class CursorOverlay {
	private readonly remotes = new Map<string, Remote>();
	private readonly parsed = new Map<number, Parsed>();
	private cfg: OverlayConfig;
	private raf = 0;
	private awakeUntil = 0;
	private lastT = 0;
	private floaters = 0;
	private idleTimer: ReturnType<typeof setTimeout> | null = null;
	private readonly style: HTMLStyleElement;
	private styleText = "";
	private readonly off: (() => void)[] = [];
	private readonly ghosts: Ghosts;
	private ghostRules = "";
	private selectionRules = "";
	readonly probe: CursorProbe | null;

	constructor(
		private readonly awareness: Awareness,
		private readonly layer: HTMLElement,
		cfg: OverlayConfig,
		opts: { probe?: boolean } = {},
	) {
		this.cfg = cfg;
		this.probe = opts.probe
			? { seen: [], reacts: [], chats: [], drags: [], menus: [] }
			: null;
		this.ghosts = new Ghosts(layer, cfg.labelOf ?? (() => null));
		this.style = document.createElement("style");
		this.style.setAttribute("data-yonder-peer-selection", "");
		document.head.appendChild(this.style);
		const onChange = ({
			added,
			updated,
			removed,
		}: {
			added: number[];
			updated: number[];
			removed: number[];
		}) => this.onAwareness([...added, ...updated], removed);
		awareness.on("change", onChange);
		this.off.push(() => awareness.off("change", onChange));
		const wake = () => this.kick();
		window.addEventListener("scroll", wake, { capture: true, passive: true });
		window.addEventListener("resize", wake, { passive: true });
		this.off.push(() => {
			window.removeEventListener("scroll", wake, { capture: true });
			window.removeEventListener("resize", wake);
		});
		this.off.push(onMapMoved(wake));
		this.onAwareness([...awareness.getStates().keys()], []);
	}

	configure(next: Partial<OverlayConfig>): void {
		this.cfg = { ...this.cfg, ...next };
		if (next.labelOf) this.ghosts.setLabelOf(next.labelOf);
		this.rebuild();
	}

	destroy(): void {
		for (const f of this.off.splice(0)) f();
		if (this.raf) cancelAnimationFrame(this.raf);
		if (this.idleTimer) clearTimeout(this.idleTimer);
		for (const r of this.remotes.values()) {
			r.root.remove();
			r.edge.remove();
		}
		this.remotes.clear();
		this.ghosts.destroy();
		this.style.remove();
	}

	/** Floats one of MY reactions where I made it (the others see it via awareness). */
	spawnLocalReaction(e: string, x: number, y: number, color: number): void {
		this.float(e, x, y, color, null);
	}

	// ---- awareness ----------------------------------------------------------

	private onAwareness(changed: number[], removed: number[]): void {
		const own = this.awareness.clientID;
		const states = this.awareness.getStates();
		for (const id of removed) this.parsed.delete(id);
		for (const id of changed) {
			if (id === own) continue;
			const st = states.get(id) as Record<string, unknown> | undefined;
			const user = st?.user as
				| { id?: unknown; name?: unknown; color?: unknown }
				| undefined;
			if (!st || !user || typeof user.id !== "string") {
				this.parsed.delete(id);
				continue;
			}
			const cursor = AwarenessCursor.safeParse(st.cursor);
			const react = AwarenessReact.safeParse(st.react);
			const drag = AwarenessDrag.safeParse(st.drag);
			const menu = AwarenessMenu.safeParse(st.menu);
			const form = AwarenessForm.safeParse(st.form);
			const view = st.view as
				| { scopeId?: string | null; sel?: string | null }
				| undefined;
			this.parsed.set(id, {
				clientId: id,
				userId: user.id,
				name: typeof user.name === "string" ? user.name : "Someone",
				color: typeof user.color === "number" ? user.color : 0,
				scopeId: view ? (view.scopeId ?? null) : undefined,
				sel: typeof view?.sel === "string" ? view.sel : null,
				cursor: cursor.success ? cursor.data : null,
				react: react.success ? react.data : null,
				drag: drag.success ? drag.data : null,
				menu: menu.success ? menu.data : null,
				form: form.success ? form.data : null,
				at: this.awareness.meta.get(id)?.lastUpdated ?? 0,
			});
		}
		this.rebuild();
	}

	/** Re-derives one entry per user from the parsed clients. */
	private rebuild(): void {
		const best = new Map<string, Parsed>();
		for (const p of this.parsed.values()) {
			if (this.cfg.selfUserId && p.userId === this.cfg.selfUserId) continue;
			const prev = best.get(p.userId);
			// The tab that moved last speaks for the person.
			if (!prev || p.at >= prev.at) best.set(p.userId, p);
		}
		const now = performance.now();
		for (const [userId, p] of best) {
			let r = this.remotes.get(userId);
			if (!r) {
				r = this.create(p);
				this.remotes.set(userId, r);
				// First sight: remember their last tap/reaction without replaying it.
				r.tap = p.cursor?.tap;
				r.react = p.react?.n;
			}
			if (r.name !== p.name || r.color !== p.color) {
				r.name = p.name;
				r.color = p.color;
				this.paint(r);
			}
			r.scopeId = p.scopeId;
			const key = anchorKey(p.cursor?.a);
			if (key !== r.anchorKey) {
				r.anchorKey = key;
				r.movedAt = now;
				r.anchorEl = null;
			}
			const chatText = p.cursor?.chat?.text ?? "";
			if (r.chat.textContent !== chatText) {
				r.chat.textContent = chatText;
				r.chat.hidden = !chatText;
				if (chatText) r.movedAt = now; // a message keeps them awake
				if (chatText && this.probe)
					this.probe.chats.push({ userId, text: chatText });
			}
			r.cursor = p.cursor;
			// FB-23: a drag (its idle clock restarts on every change, or a cursor move).
			const dragKey = p.drag ? JSON.stringify(p.drag) : "";
			if (dragKey !== r.dragKey) {
				r.dragKey = dragKey;
				r.drag = p.drag;
				r.dragAt = now;
				this.probe?.drags.push({ userId, drag: p.drag });
			} else if (r.drag && key !== "" && r.movedAt === now) r.dragAt = now;
			r.form = p.form;
			const menuJson = JSON.stringify(p.menu);
			if (menuJson !== JSON.stringify(r.menu)) {
				r.menu = p.menu;
				this.probe?.menus.push({ userId, menu: p.menu });
			}
			if (this.probe && p.cursor) {
				this.probe.seen.push({ userId, anchor: p.cursor.a, vis: p.cursor.v });
				if (this.probe.seen.length > 20_000) this.probe.seen.splice(0, 10_000);
			}
			// A tap (touch never hovers): a ripple where they tapped.
			const tap = p.cursor?.tap;
			if (p.cursor?.m === "touch" && tap !== undefined && tap !== r.tap) {
				r.tap = tap;
				if (p.cursor.a && this.sameScope(r) && !this.cfg.hide)
					this.ripple(p.cursor.a, r.color);
			}
			// A new reaction floats (even with others' cursors hidden: it is brief).
			const react = p.react;
			if (react && react.n !== r.react) {
				r.react = react.n;
				if (this.probe)
					this.probe.reacts.push({ userId, e: react.e, anchor: react.a });
				if ((REACTIONS as readonly string[]).includes(react.e))
					this.floatAt(react.e, react.a, r.color, r.name);
			}
		}
		for (const [userId, r] of this.remotes) {
			if (best.has(userId)) continue;
			r.root.remove();
			r.edge.remove();
			this.remotes.delete(userId);
		}
		this.updateSelectionStyle(best);
		this.kick();
	}

	private sameScope(r: { scopeId: string | null | undefined }): boolean {
		return r.scopeId !== undefined && r.scopeId === this.cfg.scopeId;
	}

	// ---- DOM ------------------------------------------------------------------

	private create(p: Parsed): Remote {
		const root = document.createElement("div");
		root.className = "yc-cursor";
		root.dataset.testid = "remote-cursor";
		root.dataset.userId = p.userId;
		root.dataset.state = "off";
		root.appendChild(svg(ARROW_PATH, true));
		const tag = document.createElement("div");
		tag.className = "yc-tag";
		const label = document.createElement("span");
		label.className = "yc-label";
		const chat = document.createElement("span");
		chat.className = "yc-chat";
		chat.dataset.testid = "remote-cursor-chat";
		chat.hidden = true;
		tag.append(label, chat);
		root.appendChild(tag);
		const edge = document.createElement("button");
		edge.type = "button";
		edge.className = "yc-edge";
		edge.dataset.testid = "remote-cursor-edge";
		edge.dataset.userId = p.userId;
		edge.dataset.state = "off";
		edge.tabIndex = -1;
		const edgeIcon = svg(CHEVRON_PATH, false);
		const edgeLabel = document.createElement("span");
		edge.append(edgeIcon, edgeLabel);
		edge.addEventListener("click", () => this.jumpTo(p.userId));
		this.layer.append(root, edge);
		const r: Remote = {
			userId: p.userId,
			name: p.name,
			color: p.color,
			scopeId: p.scopeId,
			cursor: null,
			anchorKey: "",
			movedAt: 0,
			track: new Track(),
			anchorEl: null,
			root,
			label,
			chat,
			edge,
			edgeLabel,
			edgeIcon,
			state: "off",
			edgeState: "off",
			coveredAt: 0,
			covered: false,
			followAt: 0,
			lastResolved: null,
			tap: undefined,
			react: undefined,
			drag: null,
			dragKey: "",
			dragAt: 0,
			menu: null,
			form: null,
			onMenu: false,
		};
		this.paint(r);
		return r;
	}

	private paint(r: Remote): void {
		const c = presenceColor(r.color);
		r.root.style.setProperty("--yc-color", c);
		r.edge.style.setProperty("--yc-color", c);
		r.label.textContent = r.name;
		r.edgeLabel.textContent = r.name.split(" ")[0] ?? r.name;
		r.edge.setAttribute("aria-label", `Go to ${r.name}'s cursor`);
	}

	private setState(r: Remote, state: Remote["state"]): void {
		if (r.state === state) return;
		r.state = state;
		r.root.dataset.state = state;
		if (state === "off") r.track.reset();
	}

	private setEdge(r: Remote, state: Remote["edgeState"]): void {
		if (r.edgeState === state) return;
		r.edgeState = state;
		r.edge.dataset.state = state;
		r.edge.tabIndex = state === "on" ? 0 : -1;
	}

	private jumpTo(userId: string): void {
		const r = this.remotes.get(userId);
		const a = r?.cursor?.a;
		if (!r || !a) return;
		if (this.cfg.following === userId) useFollowPause.getState().resume();
		if (a.k === "map") getMapProjector()?.easeTo(a.lng, a.lat);
		else {
			const res = resolveAnchor(a, r.anchorEl);
			if (res?.el) scrollAnchorIntoView(res.el, this.cfg.reduced, "center");
		}
		this.kick();
	}

	private floatAt(e: string, a: CursorAnchor, color: number, name: string) {
		const res = resolveAnchor(a);
		if (!res || !inside(res, res.clip, 0)) return;
		this.float(e, res.x, res.y, color, name);
	}

	private float(
		e: string,
		x: number,
		y: number,
		color: number,
		name: string | null,
	): void {
		if (this.floaters >= MAX_FLOATERS) return;
		const el = document.createElement("span");
		el.className = "yc-react";
		el.dataset.testid = "remote-reaction";
		el.style.setProperty("--yc-color", presenceColor(color));
		// left/top, not `transform`: the animation's own `scale`/`translate`
		// would otherwise scale the position too (they compose with transform).
		el.style.left = `${x}px`;
		el.style.top = `${y}px`;
		el.textContent = e;
		if (name) {
			const n = document.createElement("span");
			n.className = "yc-react-name";
			n.textContent = name.split(" ")[0] ?? name;
			el.appendChild(n);
		}
		this.layer.appendChild(el);
		this.floaters += 1;
		setTimeout(() => {
			el.remove();
			this.floaters -= 1;
		}, 1_800);
	}

	private ripple(a: CursorAnchor, color: number): void {
		const res = resolveAnchor(a);
		if (!res || !inside(res, res.clip, 0) || this.floaters >= MAX_FLOATERS)
			return;
		const el = document.createElement("span");
		el.className = "yc-ripple";
		el.dataset.testid = "remote-tap";
		el.style.setProperty("--yc-color", presenceColor(color));
		el.style.left = `${res.x}px`;
		el.style.top = `${res.y}px`;
		this.layer.appendChild(el);
		this.floaters += 1;
		setTimeout(() => {
			el.remove();
			this.floaters -= 1;
		}, 750);
	}

	/** A presence-coloured ring on each same-scope peer's selected card / row / day. */
	private updateSelectionStyle(best: Map<string, Parsed>): void {
		const rules: string[] = [];
		for (const p of best.values()) {
			if (p.scopeId === undefined || p.scopeId !== this.cfg.scopeId) continue;
			const ids = selectionAnchors(p.sel);
			if (!ids.length) continue;
			// Every drawing of it (a day split across two bands has two headers).
			const sel = ids.map(anchorSelector).join(",");
			rules.push(
				`${sel}{box-shadow:0 0 0 3px color-mix(in oklab, ${presenceColor(p.color)} 42%, transparent)}`,
			);
		}
		this.selectionRules = rules.join("\n");
		this.writeStyle();
	}

	/** The peer style sheet: selection rings (FB-17) and dimmed drag originals (FB-23). */
	private writeStyle(): void {
		const text = `${this.selectionRules}\n${this.ghostRules}`;
		if (text !== this.styleText) {
			this.styleText = text;
			this.style.textContent = text;
		}
	}

	// ---- the frame loop ---------------------------------------------------------

	/** Wake the loop for a little while (something moved). */
	kick(): void {
		this.awakeUntil = performance.now() + 400;
		if (!this.raf) {
			this.lastT = performance.now();
			this.raf = requestAnimationFrame(this.frame);
		}
	}

	private readonly frame = (t: number): void => {
		this.raf = 0;
		const dt = Math.min(64, Math.max(0, t - this.lastT));
		this.lastT = t;
		const moving = this.render(t, dt);
		if (moving || t < this.awakeUntil) {
			this.raf = requestAnimationFrame(this.frame);
		}
	};

	/** One frame; true while any cursor is still gliding. */
	private render(now: number, dt: number): boolean {
		const { hide, reduced, following } = this.cfg;
		const candidates = [...this.remotes.values()]
			.filter((r) => r.cursor?.a && this.sameScope(r))
			.sort((a, b) => b.movedAt - a.movedAt)
			.slice(0, MAX_CURSORS);
		const shown = new Set(candidates);
		let moving = false;
		let nextIdle = Number.POSITIVE_INFINITY;
		for (const r of this.remotes.values()) {
			const a = r.cursor?.a;
			if (!a || !shown.has(r)) {
				this.setState(r, "off");
				this.setEdge(r, "off");
				continue;
			}
			// FB-25: over their own open menu, the cursor sits on its ghost.
			const onMenu = a.k === "el" && a.id === MENU_CURSOR_ID;
			let res: Resolved | null;
			if (a.k === "el" && onMenu) {
				const menu = this.ghosts.menuElOf(r.userId);
				const pt = menu ? pointIn(menu, a.fx, a.fy) : null;
				res =
					menu && pt
						? {
								x: pt.x,
								y: pt.y,
								clip: {
									left: 0,
									top: 0,
									right: window.innerWidth,
									bottom: window.innerHeight,
								},
								el: menu,
								map: null,
							}
						: null;
			} else res = resolveAnchor(a, r.anchorEl);
			r.onMenu = onMenu;
			r.anchorEl = onMenu ? null : (res?.el ?? null);
			r.lastResolved = res;
			// Follow keeps their anchor in view, cursors shown or not.
			if (following === r.userId && res && !onMenu) this.follow(r, res, a, now);
			// Touch never hovers: a phone's taps ripple, it draws no arrow.
			if (!res || hide || r.cursor?.m === "touch") {
				this.setState(r, "off");
				this.setEdge(r, "off");
				continue;
			}
			const chatting = !!r.cursor?.chat?.text;
			const idleAt = r.movedAt + CURSOR_IDLE_MS;
			const idle = !chatting && now >= idleAt;
			if (!idle && !chatting) nextIdle = Math.min(nextIdle, idleAt);
			if (!inside(res, res.clip, 1)) {
				// Off-screen: an arrow on the edge of the region it lives in.
				this.setState(r, "off");
				const arrow = edgeArrow(res, res.clip);
				if (!arrow || idle) {
					this.setEdge(r, "off");
					continue;
				}
				const w = r.edge.offsetWidth || 60;
				const x = Math.min(
					Math.max(arrow.x - w / 2, res.clip.left + 4),
					res.clip.right - w - 4,
				);
				const y = Math.min(
					Math.max(arrow.y - 11, res.clip.top + 4),
					res.clip.bottom - 26,
				);
				r.edge.style.transform = `translate3d(${x}px, ${y}px, 0)`;
				r.edgeIcon.style.transform = `rotate(${arrow.angle}rad)`;
				this.setEdge(r, "on");
				continue;
			}
			this.setEdge(r, "off");
			if (onMenu) r.covered = false;
			else if (now - r.coveredAt > COVER_CHECK_MS) {
				r.coveredAt = now;
				r.covered = !uncovered(res);
			}
			if (r.covered) {
				// Look again soon: the dialog closes, a sticky header scrolls away.
				if (!idle) nextIdle = Math.min(nextIdle, now + 400);
				this.setState(r, "off");
				continue;
			}
			const snapped =
				r.state === "off" ? r.track.aim(res, true) : r.track.aim(res, reduced);
			const settled = snapped || r.track.step(dt, reduced);
			if (!settled) moving = true;
			r.root.style.transform = `translate3d(${r.track.x}px, ${r.track.y}px, 0)`;
			this.setState(r, idle ? "idle" : "on");
		}
		// FB-23 / FB-25: drag ghosts at their cursors, drop lines, menu ghosts.
		const peers: GhostPeer[] = [];
		for (const r of this.remotes.values()) {
			peers.push({
				userId: r.userId,
				name: r.name,
				color: r.color,
				here: this.sameScope(r),
				drag: r.drag,
				dragAt: r.dragAt,
				menu: r.menu,
				form: r.form,
				cursor: r.state === "on" ? { x: r.track.x, y: r.track.y } : null,
			});
			// A drag with no news for DRAG_IDLE_MS fades: wake up then.
			if (r.drag && r.dragAt + DRAG_IDLE_MS > now)
				nextIdle = Math.min(nextIdle, r.dragAt + DRAG_IDLE_MS);
		}
		this.ghosts.update(peers, now, { hideMenus: hide });
		this.ghostRules = this.ghosts.styleRules(peers, now).join("\n");
		this.writeStyle();
		// Wake up again when the next cursor goes idle (its fade is a CSS
		// transition), or to re-check one that something covered.
		if (this.idleTimer) clearTimeout(this.idleTimer);
		this.idleTimer = null;
		if (Number.isFinite(nextIdle)) {
			this.idleTimer = setTimeout(
				() => this.kick(),
				Math.max(16, nextIdle - performance.now() + 20),
			);
		}
		return moving;
	}

	/** Follow mode (FB-17a): keep the followed person's cursor on the map in view. */
	private follow(r: Remote, res: Resolved, a: CursorAnchor, now: number) {
		// Lists follow the view (`scroll-follow.ts`); FB-22: the map mirrors their camera.
		if (a.k !== "map" || isMapCameraFollowed()) return;
		if (inside(res, res.clip, -24)) return;
		if (now - r.followAt < FOLLOW_EVERY_MS) return;
		r.followAt = now;
		getMapProjector()?.easeTo(a.lng, a.lat);
	}
}
