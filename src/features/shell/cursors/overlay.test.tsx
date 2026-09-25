/**
 * The cursor overlay on happy-dom (FB-17a): one layer, driven by awareness,
 * no React. Cap, scope, the hide setting, touch taps and reactions.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	Awareness,
	applyAwarenessUpdate,
	encodeAwarenessUpdate,
} from "y-protocols/awareness";
import * as Y from "yjs";
import { MAX_CURSORS } from "@/lib/realtime/cursor-protocol";
import { CursorOverlay } from "./overlay";

const ITEM = "0192f5a0-0000-7000-8000-0000000000c1";

function stubBox(
	el: Element,
	r: { left: number; top: number; width: number; height: number },
) {
	(
		el as unknown as { getBoundingClientRect: () => DOMRect }
	).getBoundingClientRect = () =>
		({
			...r,
			x: r.left,
			y: r.top,
			right: r.left + r.width,
			bottom: r.top + r.height,
			toJSON: () => r,
		}) as DOMRect;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let mine: Awareness;
let layer: HTMLDivElement;
let card: HTMLElement;
let overlay: CursorOverlay | null = null;
const peers = new Map<string, Awareness>();

function peer(id: string, state: Record<string, unknown>) {
	let a = peers.get(id);
	if (!a) {
		a = new Awareness(new Y.Doc());
		peers.set(id, a);
	}
	a.setLocalState({
		user: { id, memberId: null, name: `${id} Person`, color: 2, guest: false },
		view: {
			scopeId: null,
			scopeName: "Trip",
			lens: "country",
			tab: "plan",
			days: null,
			sel: null,
			path: "/t/x",
		},
		...state,
	});
	applyAwarenessUpdate(mine, encodeAwarenessUpdate(a, [a.clientID]), "remote");
}

const on = () =>
	layer.querySelectorAll('[data-testid="remote-cursor"][data-state="on"]')
		.length;

beforeEach(() => {
	document.body.innerHTML = `<div id="card" data-cursor-anchor="item:${ITEM}"></div><div id="layer"></div>`;
	card = document.getElementById("card") as HTMLElement;
	layer = document.getElementById("layer") as HTMLDivElement;
	stubBox(card, { left: 100, top: 200, width: 400, height: 100 });
	document.elementFromPoint = () => card;
	window.requestAnimationFrame = (cb) =>
		setTimeout(() => cb(performance.now()), 8) as unknown as number;
	window.cancelAnimationFrame = (h) => clearTimeout(h);
	mine = new Awareness(new Y.Doc());
	peers.clear();
});

afterEach(() => {
	overlay?.destroy();
	overlay = null;
});

const cursorAt = (fx: number, extra: Record<string, unknown> = {}) => ({
	cursor: {
		a: { k: "el", id: `item:${ITEM}`, fx, fy: 0.5 },
		v: "all",
		m: "mouse",
		...extra,
	},
});

describe("CursorOverlay", () => {
	it("draws at most MAX_CURSORS cursors, at the anchored spot", async () => {
		for (let i = 0; i < 11; i++) peer(`u${i}`, cursorAt(i / 20));
		overlay = new CursorOverlay(mine, layer, {
			selfUserId: "me",
			scopeId: null,
			hide: false,
			following: null,
			reduced: true,
		});
		await sleep(40);
		expect(on()).toBe(MAX_CURSORS);
		// u10 moves: the most recently moved win a place.
		peer("u10", cursorAt(0.6));
		await sleep(60);
		expect(on()).toBe(MAX_CURSORS);
		const u10 = layer.querySelector('[data-user-id="u10"]') as HTMLElement;
		expect(u10.dataset.state).toBe("on"); // the most recently moved win
		expect(u10.style.transform).toBe("translate3d(340px, 250px, 0)");
		expect(u10.textContent).toContain("u10 Person");
	});

	it("only people on my scope; none with 'Show others' cursors' off", async () => {
		peer("here", cursorAt(0.5));
		peer("away", {
			...cursorAt(0.2),
			view: {
				scopeId: "0192f5a0-0000-7000-8000-00000000c010",
				scopeName: "Kyoto",
				lens: "city",
				tab: "plan",
				days: null,
				sel: null,
				path: "/t/x/kyoto",
			},
		});
		overlay = new CursorOverlay(mine, layer, {
			selfUserId: "me",
			scopeId: null,
			hide: false,
			following: null,
			reduced: true,
		});
		await sleep(60);
		expect(on()).toBe(1);
		expect(
			(layer.querySelector('[data-user-id="here"]') as HTMLElement).dataset
				.state,
		).toBe("on");
		overlay.configure({ hide: true });
		await sleep(60);
		expect(on()).toBe(0);
	});

	it("my own other tab never shows; a hidden anchor fades", async () => {
		peer("me", cursorAt(0.5));
		peer("bob", { cursor: { a: null, v: "all", m: "mouse" } });
		overlay = new CursorOverlay(mine, layer, {
			selfUserId: "me",
			scopeId: null,
			hide: false,
			following: null,
			reduced: true,
		});
		await sleep(60);
		expect(layer.querySelector('[data-user-id="me"]')).toBeNull();
		expect(on()).toBe(0);
	});

	it("touch draws no arrow, a new tap ripples; a new reaction floats", async () => {
		peer("phone", cursorAt(0.5, { m: "touch", tap: 1 }));
		overlay = new CursorOverlay(mine, layer, {
			selfUserId: "me",
			scopeId: null,
			hide: false,
			following: null,
			reduced: true,
		});
		await sleep(60);
		expect(on()).toBe(0);
		// The tap already there on first sight is not replayed…
		expect(layer.querySelectorAll('[data-testid="remote-tap"]').length).toBe(0);
		// …a new one ripples where it happened.
		peer("phone", cursorAt(0.25, { m: "touch", tap: 2 }));
		const ripple = layer.querySelector(
			'[data-testid="remote-tap"]',
		) as HTMLElement;
		expect(ripple).not.toBeNull();
		expect([ripple.style.left, ripple.style.top]).toEqual(["200px", "250px"]);
		peer("phone", {
			...cursorAt(0.25, { m: "touch", tap: 2 }),
			react: {
				n: 1,
				e: "🔥",
				a: { k: "el", id: `item:${ITEM}`, fx: 0.5, fy: 0.5 },
				v: "all",
			},
		});
		const r = layer.querySelector(
			'[data-testid="remote-reaction"]',
		) as HTMLElement;
		expect(r.textContent).toContain("🔥");
		expect([r.style.left, r.style.top]).toEqual(["300px", "250px"]);
	});

	it("chat text is shown as text, never markup", async () => {
		peer(
			"bob",
			cursorAt(0.5, { chat: { n: 1, text: "<img src=x onerror=alert(1)>" } }),
		);
		overlay = new CursorOverlay(mine, layer, {
			selfUserId: "me",
			scopeId: null,
			hide: false,
			following: null,
			reduced: true,
		});
		await sleep(40);
		const chat = layer.querySelector(
			'[data-testid="remote-cursor-chat"]',
		) as HTMLElement;
		expect(chat.textContent).toBe("<img src=x onerror=alert(1)>");
		expect(layer.querySelector("img")).toBeNull();
	});

	it("rings a peer's selected card (a style sheet, removed on destroy)", async () => {
		peer("bob", {
			view: {
				scopeId: null,
				scopeName: "Trip",
				lens: "country",
				tab: "plan",
				days: null,
				sel: `i.${ITEM}`,
				path: "/t/x",
			},
		});
		overlay = new CursorOverlay(mine, layer, {
			selfUserId: "me",
			scopeId: null,
			hide: false,
			following: null,
			reduced: true,
		});
		const style = document.head.querySelector(
			"style[data-yonder-peer-selection]",
		);
		expect(style?.textContent).toContain(`[data-cursor-anchor="item:${ITEM}"]`);
		overlay.destroy();
		overlay = null;
		expect(
			document.head.querySelector("style[data-yonder-peer-selection]"),
		).toBeNull();
	});
});
