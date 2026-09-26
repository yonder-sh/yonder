/**
 * Live cursors in the workspace (FB-17, 17a–d), mounted once in live mode:
 * - the overlay layer with everyone else's cursors (`CursorOverlay`), and my
 *   own cursor on the trip awareness (`CursorSender`);
 * - cursor chat: `/` opens a small box at my pointer; what I type floats next
 *   to my cursor for the others, Enter keeps it up a few seconds, Esc drops it;
 * - emoji reactions: `E` opens the palette at my pointer (1–8 pick); on a
 *   phone, hold a card, row or day and let go for the same palette, and the
 *   emoji lands on that card.
 * - what I see of each list, and map or panel (`LookSender`), and, while I
 *   follow someone, my lists showing what they see (`ScrollFollower`).
 * The "Show others' cursors" view setting hides the others' cursors and chat
 * here; mine is always shared (owner decision).
 */
import "./cursors.css";
import { useReducedMotion } from "motion/react";
import {
	type KeyboardEvent as ReactKeyboardEvent,
	useCallback,
	useEffect,
	useRef,
	useState,
} from "react";
import { createPortal } from "react-dom";
import { useHotkeys } from "react-hotkeys-hook";
import { presenceColor } from "@/components/common/person-avatar";
import {
	CHAT_LINGER_MS,
	CHAT_MAX,
	REACTIONS,
	type Reaction,
} from "@/lib/realtime/cursor-protocol";
import { useTripAwareness } from "@/lib/realtime/presence";
import { getMapProjector } from "@/lib/workspace/map-projector";
import { useUi } from "@/lib/workspace/ui-store";
import { useWorkspace } from "@/lib/workspace/use-workspace";
import { SHELL_TESTID } from "../testids";
import { useBreakpoint } from "../use-breakpoint";
import { inOpenLayer } from "../use-workspace-hotkeys";
import { useViewPrefs } from "../view-prefs";
import { useAnchorLabel } from "./anchor-label";
import { ANCHOR_ATTR, type Encoded, encodeAt } from "./anchors";
import { LookSender } from "./look";
import { MenuSender } from "./menu-presence";
import { CursorOverlay } from "./overlay";
import { ScrollFollower } from "./scroll-follow";
import { focusOfSnap, SHEET_SNAPS } from "./scroll-rules";
import { CursorSender } from "./sender";

const E2E = import.meta.env.VITE_E2E === "1";
/** Hold this long (and let go) on a card to react (touch; the drag starts at 220 ms, still). */
const LONG_PRESS_MS = 480;
const LONG_PRESS_SLOP = 10;

type Palette = { x: number; y: number; at?: Encoded };

const HOTKEY_OPTS = {
	ignoreEventWhen: (e: KeyboardEvent) =>
		e.defaultPrevented || inOpenLayer(e.target),
	preventDefault: true,
};

export function LiveCursors() {
	const { awareness, selfUserId } = useTripAwareness();
	const { scope, mode, graph } = useWorkspace();
	// FB-23 / FB-24: a dragged or edited thing's name, from MY data.
	const labelOf = useAnchorLabel();
	const following = useUi((s) => s.following);
	const { prefs } = useViewPrefs({ enabled: mode === "live" });
	const hide = prefs.hideCursors === true;
	const reduced = useReducedMotion() === true;
	const [layer, setLayer] = useState<HTMLDivElement | null>(null);
	const overlay = useRef<CursorOverlay | null>(null);
	const sender = useRef<CursorSender | null>(null);
	const scroller = useRef<ScrollFollower | null>(null);
	const looker = useRef<LookSender | null>(null);
	const phone = useBreakpoint() === "sm";
	// A phone: my sheet's snap says whether I look at the map or the panel.
	const snap = useUi((s) => s.sheetSnap);
	const phoneFocus = phone ? focusOfSnap(snap, SHEET_SNAPS) : null;
	const cfg = useRef({
		selfUserId,
		scopeId: scope?.id ?? null,
		hide,
		following,
		reduced,
		labelOf,
		phoneFocus,
	});
	cfg.current = {
		selfUserId,
		scopeId: scope?.id ?? null,
		hide,
		following,
		reduced,
		labelOf,
		phoneFocus,
	};

	useEffect(() => {
		if (!awareness || !layer) return;
		const o = new CursorOverlay(awareness, layer, cfg.current, { probe: E2E });
		const s = new CursorSender(awareness);
		s.start();
		// FB-25: my open menus, for the others' ghosts.
		const menus = new MenuSender(awareness);
		menus.start();
		// What I see (for my followers), and what the one I follow sees.
		const look = new LookSender(awareness, () => cfg.current.selfUserId);
		look.setPhoneFocus(cfg.current.phoneFocus);
		look.start();
		const follow = new ScrollFollower(awareness);
		follow.start();
		follow.configure({
			leader: cfg.current.following,
			reduced: cfg.current.reduced,
		});
		overlay.current = o;
		sender.current = s;
		scroller.current = follow;
		looker.current = look;
		if (E2E)
			// E2E only: what this page received, and the raw awareness (to prove the
			// server drops what an honest client would never send).
			(window as unknown as { __yonderCursors?: unknown }).__yonderCursors = {
				probe: o.probe,
				sender: s,
				overlay: o,
				awareness,
				map: getMapProjector,
			};
		return () => {
			follow.stop();
			look.stop();
			menus.stop();
			s.stop();
			o.destroy();
			overlay.current = null;
			sender.current = null;
			scroller.current = null;
			looker.current = null;
			if (E2E)
				delete (window as unknown as { __yonderCursors?: unknown })
					.__yonderCursors;
		};
	}, [awareness, layer]);

	const scopeId = scope?.id ?? null;
	useEffect(() => {
		overlay.current?.configure({
			selfUserId,
			scopeId,
			hide,
			following,
			reduced,
			labelOf,
		});
		scroller.current?.configure({ leader: following, reduced });
	}, [selfUserId, scopeId, hide, following, reduced, labelOf]);

	useEffect(() => {
		looker.current?.setPhoneFocus(phoneFocus);
	}, [phoneFocus]);

	// ---- cursor chat (FB-17c) ------------------------------------------------
	const [chatOpen, setChatOpen] = useState(false);
	useHotkeys("slash", () => setChatOpen(true), HOTKEY_OPTS);

	// ---- reactions (FB-17d) --------------------------------------------------
	const [palette, setPalette] = useState<Palette | null>(null);
	useHotkeys(
		"e",
		() => {
			const p = sender.current?.position;
			const here = sender.current?.encodeHere();
			if (!p || !here?.anchor) return;
			setPalette({ x: p.x, y: p.y, at: here });
		},
		HOTKEY_OPTS,
	);
	const react = useCallback(
		(e: Reaction, at: Palette | null) => {
			const s = sender.current;
			if (!s || !at) return;
			if (s.react(e, at.at))
				overlay.current?.spawnLocalReaction(e, at.x, at.y, graph.me.color);
		},
		[graph.me.color],
	);
	useLongPress((p) => setPalette(p));

	// Client-only: the layer lives in a portal on <body> (never server-rendered).
	const [mounted, setMounted] = useState(false);
	useEffect(() => setMounted(true), []);
	if (!mounted) return null;
	return createPortal(
		<>
			<div
				ref={setLayer}
				className="yc-layer"
				data-testid={SHELL_TESTID.cursorLayer}
				aria-hidden="true"
			/>
			{chatOpen && sender.current ? (
				<ChatComposer
					sender={sender.current}
					color={graph.me.color}
					onClose={() => setChatOpen(false)}
				/>
			) : null}
			{palette ? (
				<ReactionPalette
					at={palette}
					onPick={(e) => {
						react(e, palette);
						setPalette(null);
					}}
					onClose={() => setPalette(null)}
				/>
			) : null}
		</>,
		document.body,
	);
}

/**
 * Touch: hold a card / row / day still for LONG_PRESS_MS and let go → the
 * reaction palette, anchored on that element (long-press also lifts a card
 * for dragging; letting go without moving drops it where it was).
 */
function useLongPress(open: (p: Palette) => void): void {
	const latest = useRef(open);
	latest.current = open;
	useEffect(() => {
		let down: {
			x: number;
			y: number;
			t: number;
			id: number;
			target: Element | null;
		} | null = null;
		const onDown = (e: PointerEvent) => {
			if (e.pointerType !== "touch") return;
			const target = e.target instanceof Element ? e.target : null;
			if (!target?.closest(`[${ANCHOR_ATTR}]`)) return;
			down = {
				x: e.clientX,
				y: e.clientY,
				t: performance.now(),
				id: e.pointerId,
				target,
			};
		};
		const onMove = (e: PointerEvent) => {
			if (down && e.pointerId === down.id) {
				if (
					Math.hypot(e.clientX - down.x, e.clientY - down.y) > LONG_PRESS_SLOP
				)
					down = null;
			}
		};
		const onUp = (e: PointerEvent) => {
			const d = down;
			down = null;
			if (!d || e.pointerId !== d.id) return;
			if (performance.now() - d.t < LONG_PRESS_MS) return;
			if (Math.hypot(e.clientX - d.x, e.clientY - d.y) > LONG_PRESS_SLOP)
				return;
			const at = encodeAt(d.target, d.x, d.y);
			if (!at.anchor) return;
			latest.current({ x: d.x, y: d.y, at });
		};
		const cancel = () => {
			down = null;
		};
		const opts = { capture: true, passive: true } as const;
		window.addEventListener("pointerdown", onDown, opts);
		window.addEventListener("pointermove", onMove, opts);
		window.addEventListener("pointerup", onUp, opts);
		window.addEventListener("pointercancel", cancel, opts);
		window.addEventListener("scroll", cancel, opts);
		return () => {
			window.removeEventListener("pointerdown", onDown, opts);
			window.removeEventListener("pointermove", onMove, opts);
			window.removeEventListener("pointerup", onUp, opts);
			window.removeEventListener("pointercancel", cancel, opts);
			window.removeEventListener("scroll", cancel, opts);
		};
	}, []);
}

/** Places a fixed box of size (w, h) near (x, y), inside the viewport. */
function near(x: number, y: number, w: number, h: number) {
	const vw = window.innerWidth;
	const vh = window.innerHeight;
	return {
		left: Math.max(8, Math.min(x + 14, vw - w - 8)),
		top: Math.max(8, Math.min(y + 18, vh - h - 8)),
	};
}

/**
 * My cursor chat box (FB-17c). It rides next to my pointer (moved straight
 * on the element, never a render); every keystroke goes out with the cursor
 * (≤ 20 Hz); Enter leaves the message up for CHAT_LINGER_MS; Esc or an empty
 * box ends it at once.
 */
function ChatComposer({
	sender,
	color,
	onClose,
}: {
	sender: CursorSender;
	color: number;
	onClose(): void;
}) {
	const box = useRef<HTMLDivElement>(null);
	const input = useRef<HTMLInputElement>(null);
	const [sent, setSent] = useState<string | null>(null);
	const [text, setText] = useState("");

	useEffect(() => {
		const place = (x: number, y: number) => {
			const el = box.current;
			if (!el) return;
			const p = near(x, y, el.offsetWidth || 240, el.offsetHeight || 32);
			el.style.transform = `translate3d(${p.left}px, ${p.top}px, 0)`;
		};
		const start = sender.position ?? {
			x: window.innerWidth / 2,
			y: window.innerHeight / 2,
		};
		place(start.x, start.y);
		const move = (e: PointerEvent) => {
			if (e.pointerType !== "touch") place(e.clientX, e.clientY);
		};
		window.addEventListener("pointermove", move, { passive: true });
		input.current?.focus();
		return () => window.removeEventListener("pointermove", move);
	}, [sender]);

	// A sent message lingers, then ends.
	useEffect(() => {
		if (sent === null) return;
		const t = setTimeout(() => {
			sender.setChat(null);
			onClose();
		}, CHAT_LINGER_MS);
		return () => clearTimeout(t);
	}, [sent, sender, onClose]);

	useEffect(() => () => sender.setChat(null), [sender]);

	const onKeyDown = (e: ReactKeyboardEvent<HTMLInputElement>) => {
		if (e.key === "Escape") {
			e.preventDefault();
			e.stopPropagation();
			sender.setChat(null);
			onClose();
		} else if (e.key === "Enter") {
			e.preventDefault();
			const t = text.trim();
			if (!t) {
				sender.setChat(null);
				onClose();
				return;
			}
			sender.setChat(t);
			setSent(t);
		}
	};

	return (
		<div
			ref={box}
			className="yc-compose"
			style={{ ["--yc-color" as string]: presenceColor(color) }}
			data-cursor-ignore=""
		>
			{sent === null ? (
				<input
					ref={input}
					data-testid={SHELL_TESTID.cursorChatInput}
					aria-label="Say something next to your cursor"
					placeholder="Say something…"
					maxLength={CHAT_MAX}
					value={text}
					onChange={(e) => {
						setText(e.target.value);
						sender.setChat(e.target.value || null, { fresh: !text });
					}}
					onKeyDown={onKeyDown}
					onBlur={() => {
						if (!text.trim()) {
							sender.setChat(null);
							onClose();
						}
					}}
				/>
			) : (
				<span
					className="yc-chat block"
					data-testid={SHELL_TESTID.cursorChatSent}
				>
					{sent}
				</span>
			)}
		</div>
	);
}

/** The emoji palette (FB-17d): at my pointer (E) or where I held a card (touch). */
function ReactionPalette({
	at,
	onPick,
	onClose,
}: {
	at: Palette;
	onPick(e: Reaction): void;
	onClose(): void;
}) {
	const ref = useRef<HTMLDivElement>(null);
	const w = REACTIONS.length * 40 + 12;
	const pos = near(at.x - 14 - w / 2, at.y - 18 - 56, w, 48);
	useEffect(() => {
		const outside = (e: PointerEvent) => {
			if (!ref.current?.contains(e.target as Node)) onClose();
		};
		const keys = (e: KeyboardEvent) => {
			if (e.key === "Escape") {
				e.preventDefault();
				e.stopPropagation();
				onClose();
				return;
			}
			const n = Number(e.key);
			const r = Number.isInteger(n) ? REACTIONS[n - 1] : undefined;
			if (r) {
				e.preventDefault();
				e.stopPropagation();
				onPick(r);
			}
		};
		// The touch that opened it lifts after this mounts: listen from the next frame.
		const raf = requestAnimationFrame(() => {
			window.addEventListener("pointerdown", outside, true);
		});
		window.addEventListener("keydown", keys, true);
		ref.current?.querySelector("button")?.focus({ preventScroll: true });
		return () => {
			cancelAnimationFrame(raf);
			window.removeEventListener("pointerdown", outside, true);
			window.removeEventListener("keydown", keys, true);
		};
	}, [onClose, onPick]);
	return (
		<div
			ref={ref}
			role="toolbar"
			aria-label="React"
			data-testid={SHELL_TESTID.reactionPalette}
			data-cursor-ignore=""
			className="fixed z-[46] flex items-center gap-0.5 rounded-full border bg-popover p-1 shadow-float animate-in fade-in-0 zoom-in-95 duration-150 motion-reduce:animate-none"
			style={{ left: pos.left, top: pos.top }}
		>
			{REACTIONS.map((r, i) => (
				<button
					key={r}
					type="button"
					aria-label={`React ${r} (${i + 1})`}
					onClick={() => onPick(r)}
					className="flex size-9 items-center justify-center rounded-full text-xl leading-none transition-transform hover:scale-110 hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none motion-reduce:transition-none"
				>
					{r}
				</button>
			))}
		</div>
	);
}
