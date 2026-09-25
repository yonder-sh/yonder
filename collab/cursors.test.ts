import { describe, expect, it } from "vitest";
import {
	Awareness,
	applyAwarenessUpdate,
	encodeAwarenessUpdate,
} from "y-protocols/awareness";
import * as Y from "yjs";
import {
	CHAT_PER_MIN,
	CURSOR_BURST,
	REACT_PER_10S,
} from "@/lib/realtime/cursor-protocol";
import type { CollabContext } from "./auth";
import { sanitizeAwarenessUpdateLive } from "./awareness";
import {
	type AnchorLookup,
	CursorGuard,
	guestMessage,
	guestView,
	installGuestAwarenessFilter,
	mapAwarenessUpdate,
} from "./cursors";

const TRIP = "0192f5a0-0000-7000-8000-000000000001";
const PUBLIC_TODO = "0192f5a0-0000-7000-8000-0000000000b1";
const PRIVATE_TODO = "0192f5a0-0000-7000-8000-0000000000b2";
const EXPENSE = "0192f5a0-0000-7000-8000-0000000000e1";
const PRIVATE_EXPENSE = "0192f5a0-0000-7000-8000-0000000000e2";
const ITEM = "0192f5a0-0000-7000-8000-0000000000c1";

const ctx: CollabContext = {
	userId: "u-ada",
	tripId: TRIP,
	slug: "asia-2027",
	role: "editor",
	memberId: "0192f5a0-0000-7000-8000-0000000000aa",
	guest: false,
	color: 3,
	name: "Ada Lovelace",
	docKind: "channel",
};

const lookup: AnchorLookup = async (_trip, kind, id) => {
	if (kind === "list") return id === PRIVATE_TODO ? "private" : "all";
	if (kind === "exp") return id === PRIVATE_EXPENSE ? "private" : "members";
	return "all";
};

function guard(now = () => 0, l: AnchorLookup = lookup) {
	return new CursorGuard({ lookup: l, now });
}

const el = (id: string, fx = 0.25, fy = 0.5) => ({ k: "el", id, fx, fy });
const cursor = (a: unknown, extra: Record<string, unknown> = {}) => ({
	a,
	v: "all",
	m: "mouse",
	...extra,
});

async function run(
	g: CursorGuard,
	state: Record<string, unknown>,
	opts: {
		prev?: Record<string, unknown>;
		key?: object;
		c?: CollabContext;
	} = {},
) {
	const states = new Map<number, Record<string, unknown> | null>([[1, state]]);
	const current = new Map<number, Record<string, unknown>>();
	if (opts.prev) current.set(1, opts.prev);
	await sanitizeAwarenessUpdateLive(
		states,
		current,
		opts.c ?? ctx,
		g,
		opts.key ?? {},
	);
	return states.get(1) as Record<string, unknown>;
}

describe("the cursor sanitizer (FB-17)", () => {
	it("keeps a valid map or element cursor and stamps the user", async () => {
		const g = guard();
		const map = await run(g, {
			cursor: cursor({ k: "map", lng: 139.7, lat: 35.66 }),
		});
		expect(map.cursor).toEqual({
			a: { k: "map", lng: 139.7, lat: 35.66 },
			v: "all",
			m: "mouse",
		});
		expect((map.user as { id: string }).id).toBe("u-ada");
		const card = await run(g, { cursor: cursor(el(`item:${ITEM}`)) });
		expect(card.cursor).toMatchObject({ a: el(`item:${ITEM}`), v: "all" });
	});

	it("hides malformed cursors and unknown anchor kinds", async () => {
		const g = guard();
		for (const bad of [
			cursor({ k: "map", lng: 500, lat: 0 }),
			cursor(el(`item:${ITEM}`, 1.5)),
			cursor(el("<img src=x>")),
			{ a: null, v: "everyone", m: "mouse" },
			"x",
		]) {
			const out = await run(g, { cursor: bad });
			expect(out.cursor, JSON.stringify(bad)).toBeNull();
		}
		const unknown = await run(g, { cursor: cursor(el("bank:1234")) });
		expect(unknown.cursor).toBeNull();
	});

	it("drops the anchor (and its chat) of a private to-do or expense", async () => {
		const g = guard();
		const priv = await run(g, {
			cursor: cursor(el(`list:${PRIVATE_TODO}`), {
				chat: { n: 1, text: "a gift!" },
			}),
		});
		expect(priv.cursor).toEqual({ a: null, v: "all", m: "mouse" });
		const privExp = await run(g, {
			cursor: cursor(el(`exp:${PRIVATE_EXPENSE}`)),
		});
		expect((privExp.cursor as { a: unknown }).a).toBeNull();
		const pub = await run(g, { cursor: cursor(el(`list:${PUBLIC_TODO}`)) });
		expect((pub.cursor as { a: unknown }).a).toEqual(el(`list:${PUBLIC_TODO}`));
	});

	it("forces money anchors to members-only whatever the client says", async () => {
		const g = guard();
		for (const id of [
			"money:summary",
			"tab:money",
			"pane:money",
			`exp:${EXPENSE}`,
			"budget:trip",
		]) {
			const out = await run(g, { cursor: cursor(el(id)) });
			expect((out.cursor as { v: string }).v, id).toBe("members");
		}
		const tab = await run(g, { cursor: cursor(el("tab:plan")) });
		expect((tab.cursor as { v: string }).v).toBe("all");
	});

	it("a lookup that fails is private (fail closed) and is asked again", async () => {
		let calls = 0;
		const g = guard(
			() => 0,
			async () => {
				calls += 1;
				throw new Error("db down");
			},
		);
		const out = await run(g, { cursor: cursor(el(`list:${PUBLIC_TODO}`)) });
		expect((out.cursor as { a: unknown }).a).toBeNull();
		await run(g, { cursor: cursor(el(`list:${PUBLIC_TODO}`)) });
		expect(calls).toBe(2);
	});

	it("caches lookups", async () => {
		let calls = 0;
		const g = guard(
			() => 0,
			async () => {
				calls += 1;
				return "all";
			},
		);
		for (let i = 0; i < 5; i++)
			await run(g, { cursor: cursor(el(`list:${PUBLIC_TODO}`, i / 10)) });
		expect(calls).toBe(1);
	});

	it("rate-limits cursor updates per connection, keeping the last accepted one", async () => {
		let t = 0;
		const g = guard(() => t);
		const key = {};
		let prev: Record<string, unknown> | undefined;
		for (let i = 0; i < CURSOR_BURST; i++) {
			prev = await run(
				g,
				{ cursor: cursor(el(`item:${ITEM}`, i / 100)) },
				{ key, prev },
			);
		}
		expect((prev as { cursor: { a: { fx: number } } }).cursor.a.fx).toBe(
			(CURSOR_BURST - 1) / 100,
		);
		const over = await run(
			g,
			{ cursor: cursor(el(`item:${ITEM}`, 0.99)) },
			{ key, prev },
		);
		expect((over.cursor as { a: { fx: number } }).a.fx).toBe(
			(CURSOR_BURST - 1) / 100,
		);
		// Another connection has its own budget.
		const other = await run(g, { cursor: cursor(el(`item:${ITEM}`, 0.99)) });
		expect((other.cursor as { a: { fx: number } }).a.fx).toBe(0.99);
		// The budget refills.
		t += 1_000;
		const later = await run(
			g,
			{ cursor: cursor(el(`item:${ITEM}`, 0.5)) },
			{ key, prev },
		);
		expect((later.cursor as { a: { fx: number } }).a.fx).toBe(0.5);
	});

	it("cleans chat text and caps new chat messages per minute", async () => {
		let t = 0;
		const g = guard(() => t);
		const key = {};
		const out = await run(
			g,
			{
				cursor: cursor(el(`item:${ITEM}`), {
					chat: {
						n: 1,
						text: `hi\u202e there\u0000\n${"x".repeat(200)}`,
					},
				}),
			},
			{ key },
		);
		const chat = (out.cursor as { chat: { text: string } }).chat;
		expect(chat.text.startsWith("hi there ")).toBe(true);
		expect([...chat.text].length).toBe(80);
		for (let n = 2; n <= CHAT_PER_MIN + 3; n++) {
			t += 100; // cursor budget stays fine
			const r = await run(
				g,
				{
					cursor: cursor(el(`item:${ITEM}`), { chat: { n, text: `m${n}` } }),
				},
				{ key },
			);
			const c = (r.cursor as { chat?: { text: string } }).chat;
			if (n <= CHAT_PER_MIN) expect(c?.text).toBe(`m${n}`);
			else expect(c).toBeUndefined();
		}
	});

	it("reactions: validated, on a visible anchor, rate-limited", async () => {
		let t = 0;
		const g = guard(() => t);
		const key = {};
		const r = (n: number, e = "🔥", a: unknown = el(`item:${ITEM}`)) => ({
			react: { n, e, a, v: "all" },
		});
		expect((await run(g, r(1), { key })).react).toMatchObject({
			n: 1,
			e: "🔥",
		});
		expect((await run(g, r(2, "💣"), { key })).react).toBeUndefined();
		expect(
			(await run(g, r(3, "👍", el(`list:${PRIVATE_TODO}`)), { key })).react,
		).toBeUndefined();
		expect(
			(await run(g, r(4, "👍", el("money:summary")), { key })).react,
		).toMatchObject({ v: "members" });
		let prev: Record<string, unknown> | undefined;
		let accepted = 2; // n=1 and n=4 so far
		for (let n = 5; n < 5 + REACT_PER_10S; n++) {
			t += 10;
			prev = await run(g, r(n), { key, prev });
			if ((prev.react as { n: number }).n === n) accepted += 1;
		}
		expect(accepted).toBe(REACT_PER_10S);
		t += 10_000;
		const later = await run(g, r(99), { key, prev });
		expect((later.react as { n: number }).n).toBe(99);
	});

	it("keeps valid following/spotlight, drops junk", async () => {
		const g = guard();
		const ok = await run(g, {
			following: "u-bob",
			spotlight: { id: "abc123def" },
		});
		expect(ok.following).toBe("u-bob");
		expect(ok.spotlight).toEqual({ id: "abc123def" });
		const bad = await run(g, {
			following: "<script>",
			spotlight: { id: "x", evil: 1 },
		});
		expect(bad.following).toBeUndefined();
		expect(bad.spotlight).toBeUndefined();
	});

	it("never keeps channel cursor fields on note documents", async () => {
		const g = guard();
		const out = await run(
			g,
			{ cursor: { anchor: {}, head: {} }, react: { n: 1 }, spotlight: null },
			{ c: { ...ctx, docKind: "note" } },
		);
		expect(out.cursor).toEqual({ anchor: {}, head: {} }); // the TipTap caret
		expect(out.react).toBeUndefined();
		expect("spotlight" in out).toBe(false);
	});
});

describe("what a link guest receives (FB-17a)", () => {
	it("guestView strips members-only cursors, reactions and the Money tab", () => {
		const s = guestView({
			user: { id: "u" },
			cursor: { a: el("money:summary"), v: "members", m: "mouse" },
			react: { n: 1, e: "🔥", a: el("tab:money"), v: "members" },
			view: {
				tab: "money",
				path: "/t/asia-2027/japan?tab=money&lens=city",
				scopeName: "Japan",
			},
		});
		expect(s.cursor).toBeNull();
		expect(s.react).toBeUndefined();
		expect(s.view).toMatchObject({
			tab: "plan",
			path: "/t/asia-2027/japan?lens=city",
		});
		const pub = { cursor: { a: el(`item:${ITEM}`), v: "all", m: "mouse" } };
		expect(guestView(pub)).toBe(pub);
		expect(
			(
				guestView({ view: { tab: "money", path: "/t/x?tab=money" } }).view as {
					path: string;
				}
			).path,
		).toBe("/t/x");
	});

	/** A Hocuspocus awareness frame: varString(address) varUint(1) varUint8Array(update). */
	function frame(address: string, update: Uint8Array): Uint8Array {
		const enc = new TextEncoder().encode(address);
		const out: number[] = [enc.length, ...enc, 1];
		let n = update.length;
		while (n > 0x7f) {
			out.push(0x80 | (n & 0x7f));
			n = Math.floor(n / 128);
		}
		out.push(n);
		return Uint8Array.from([...out, ...update]);
	}

	function peer(state: Record<string, unknown>) {
		const a = new Awareness(new Y.Doc());
		a.setLocalState(state);
		return a;
	}

	it("rewrites awareness frames and round-trips through y-protocols", () => {
		const member = peer({
			user: { id: "u-m" },
			cursor: { a: el(`exp:${EXPENSE}`), v: "members", m: "mouse" },
		});
		const pub = peer({
			user: { id: "u-p" },
			cursor: { a: el(`item:${ITEM}`), v: "all", m: "mouse" },
		});
		const both = new Awareness(new Y.Doc());
		applyAwarenessUpdate(
			both,
			encodeAwarenessUpdate(member, [member.clientID]),
			null,
		);
		applyAwarenessUpdate(
			both,
			encodeAwarenessUpdate(pub, [pub.clientID]),
			null,
		);
		const update = encodeAwarenessUpdate(both, [member.clientID, pub.clientID]);
		const out = guestMessage(frame(`trip/${TRIP}`, update));
		expect(out).not.toBeNull();
		// Unwrap the frame and apply the update to a guest's awareness.
		const bytes = out as Uint8Array;
		const addrLen = bytes[0] ?? 0;
		expect(new TextDecoder().decode(bytes.subarray(1, 1 + addrLen))).toBe(
			`trip/${TRIP}`,
		);
		expect(bytes[1 + addrLen]).toBe(1);
		let pos = 2 + addrLen;
		let len = 0;
		let mult = 1;
		for (;;) {
			const b = bytes[pos++] ?? 0;
			len += (b & 0x7f) * mult;
			if (b < 0x80) break;
			mult *= 128;
		}
		const guest = new Awareness(new Y.Doc());
		applyAwarenessUpdate(guest, bytes.subarray(pos, pos + len), null);
		const seen = guest.getStates();
		expect(seen.get(member.clientID)?.cursor).toBeNull();
		expect(seen.get(pub.clientID)?.cursor).toMatchObject({
			a: el(`item:${ITEM}`),
		});
		expect(JSON.stringify([...seen.values()])).not.toContain(EXPENSE);
	});

	it("keeps removals and passes other message types through", () => {
		const a = peer({ user: { id: "u" } });
		const removal = new Awareness(new Y.Doc());
		applyAwarenessUpdate(removal, encodeAwarenessUpdate(a, [a.clientID]), null);
		removal.setLocalState(null);
		const upd = mapAwarenessUpdate(
			encodeAwarenessUpdate(a, [a.clientID]),
			(s) => ({ ...s, x: 1 }),
		);
		const b = new Awareness(new Y.Doc());
		applyAwarenessUpdate(b, upd, null);
		expect(b.getStates().get(a.clientID)).toMatchObject({ x: 1 });

		const stateless = Uint8Array.from([3, 97, 98, 99, 5, 1, 120]);
		expect(guestMessage(stateless)).toBe(stateless);
		const broken = Uint8Array.from([3, 97, 98, 99, 1, 50, 1]);
		expect(guestMessage(broken)).toBeNull();
	});

	it("installGuestAwarenessFilter filters guest channel connections only", () => {
		const sent: { who: string; msg: Uint8Array }[] = [];
		class Conn {
			constructor(
				readonly who: string,
				readonly context: Partial<CollabContext>,
			) {}
			send(msg: Uint8Array) {
				sent.push({ who: this.who, msg });
			}
		}
		installGuestAwarenessFilter(Conn.prototype);
		installGuestAwarenessFilter(Conn.prototype); // idempotent
		const m = peer({
			user: { id: "u-m" },
			cursor: { a: el("money:summary"), v: "members", m: "mouse" },
		});
		const msg = frame(`trip/${TRIP}`, encodeAwarenessUpdate(m, [m.clientID]));
		new Conn("member", { guest: false, docKind: "channel" }).send(msg);
		new Conn("guest", { guest: true, docKind: "channel" }).send(msg);
		new Conn("guest-note", { guest: true, docKind: "note" }).send(msg);
		const text = (u: Uint8Array) => new TextDecoder().decode(u);
		expect(sent.map((s) => s.who)).toEqual(["member", "guest", "guest-note"]);
		expect(text(sent[0]?.msg ?? new Uint8Array())).toContain("money:summary");
		expect(text(sent[1]?.msg ?? new Uint8Array())).not.toContain(
			"money:summary",
		);
		expect(sent[2]?.msg).toBe(msg);
	});
});
