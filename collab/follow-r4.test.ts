/**
 * FEEDBACK-4 (FB-21…25) on the collab server: the awareness sanitizer's new
 * fields (`view.ui`, `cam`, `media`, `drag`, `form`, `menu`): validation,
 * caps, per-connection rate limits, private anchors dropped, money marked
 * members-only, and what a link guest receives.
 */
import { describe, expect, it } from "vitest";
import { RATES } from "@/lib/realtime/view-protocol";
import type { CollabContext } from "./auth";
import { sanitizeAwarenessUpdateLive, sanitizeState } from "./awareness";
import { type AnchorLookup, CursorGuard, guestView } from "./cursors";

const TRIP = "0192f5a0-0000-7000-8000-000000000001";
const ITEM = "0192f5a0-0000-7000-8000-0000000000c1";
const DAY = "0192f5a0-0000-7000-8000-0000000000d1";
const PUBLIC_TODO = "0192f5a0-0000-7000-8000-0000000000b1";
const PRIVATE_TODO = "0192f5a0-0000-7000-8000-0000000000b2";
const EXPENSE = "0192f5a0-0000-7000-8000-0000000000e1";
const PRIVATE_EXPENSE = "0192f5a0-0000-7000-8000-0000000000e2";
const PHOTO = "0192f5a0-0000-7000-8000-0000000000f1";
const HIDDEN_PHOTO = "0192f5a0-0000-7000-8000-0000000000f2";
const GONE_PHOTO = "0192f5a0-0000-7000-8000-0000000000f3";

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
	if (id === GONE_PHOTO) return "private";
	return id === HIDDEN_PHOTO ? "members" : "all";
};

function guard(now = () => 0) {
	return new CursorGuard({ lookup, now });
}

async function run(
	g: CursorGuard,
	state: Record<string, unknown>,
	opts: { prev?: Record<string, unknown>; key?: object } = {},
) {
	const states = new Map<number, Record<string, unknown> | null>([[1, state]]);
	const current = new Map<number, Record<string, unknown>>();
	if (opts.prev) current.set(1, opts.prev);
	await sanitizeAwarenessUpdateLive(states, current, ctx, g, opts.key ?? {});
	return states.get(1) as Record<string, unknown>;
}

const view = (extra: Record<string, unknown> = {}) => ({
	scopeId: null,
	scopeName: "Asia 2027",
	lens: "country",
	tab: "plan",
	days: null,
	sel: null,
	path: "/t/asia-2027",
	...extra,
});

const cam = (n: number, z = 5) => ({
	c: [139.7, 35.6],
	z,
	b: 0,
	p: 0,
	g: false,
	w: 900,
	h: 700,
	n,
});

describe("view.ui (FB-21)", () => {
	it("keeps a valid ui with the view, and drops a bad one without losing the path", () => {
		const ok = sanitizeState(
			{
				view: view({
					ui: { plan: { of: [`fold:${DAY}`] }, lists: { near: true } },
				}),
			},
			ctx,
		);
		expect(ok.view).toMatchObject({
			path: "/t/asia-2027",
			ui: { plan: { of: [`fold:${DAY}`] }, lists: { near: true } },
		});
		for (const bad of [
			{ plan: { of: ["<img src=x onerror=alert(1)>"] } },
			{ lists: { group: "free text here" } },
			{ plan: { of: Array.from({ length: 200 }, (_, i) => `fold:${i}`) } },
			"x",
		]) {
			const out = sanitizeState({ view: view({ ui: bad }) }, ctx);
			expect(out.view, JSON.stringify(bad)).toMatchObject({
				path: "/t/asia-2027",
			});
			expect((out.view as { ui?: unknown }).ui).toBeUndefined();
		}
	});

	it("rate-limits view changes (the previous view stays)", async () => {
		const g = guard();
		const key = {};
		let prev: Record<string, unknown> | undefined;
		let kept = 0;
		for (let i = 0; i < RATES.view.burst + 10; i++) {
			const out = await run(
				g,
				{
					view: view({
						path: `/t/asia-2027?days=2027-10-${String((i % 28) + 1).padStart(2, "0")}`,
					}),
				},
				{ prev, key },
			);
			if (prev && JSON.stringify(out.view) === JSON.stringify(prev.view))
				kept++;
			prev = out;
		}
		expect(kept).toBeGreaterThan(0);
	});
});

describe("cam (FB-22)", () => {
	it("validates, passes a resend without a token, rate-limits changes", async () => {
		const g = guard();
		const key = {};
		const first = await run(g, { cam: cam(1) }, { key });
		expect(first.cam).toEqual(cam(1));
		expect(
			(await run(g, { cam: { ...cam(2), z: 99 } }, { key })).cam,
		).toBeNull();
		expect((await run(g, { cam: null }, { key })).cam).toBeNull();
		let prev = first;
		let held = 0;
		for (let i = 2; i < RATES.cam.burst + 12; i++) {
			const out = await run(g, { cam: cam(i) }, { prev, key });
			if ((out.cam as { n: number }).n !== i) held++;
			prev = out;
		}
		expect(held).toBeGreaterThan(0);
		// Later (the bucket refilled), a change goes through again.
		const later = new CursorGuard({ lookup, now: () => 10_000 });
		expect(
			((await run(later, { cam: cam(500) }, { key })).cam as { n: number }).n,
		).toBe(500);
	});
});

describe("media (FB-21c)", () => {
	it("marks hidden-from-guests media members-only and drops unknown media", async () => {
		const g = guard();
		const open = await run(g, {
			media: { id: PHOTO, k: "lb", v: "all", p: null },
		});
		expect(open.media).toMatchObject({ id: PHOTO, v: "all" });
		const hidden = await run(g, {
			media: { id: HIDDEN_PHOTO, k: "lb", v: "all" },
		});
		expect(hidden.media).toMatchObject({ id: HIDDEN_PHOTO, v: "members" });
		const gone = await run(g, { media: { id: GONE_PHOTO, k: "lb", v: "all" } });
		expect(gone.media).toBeNull();
		const play = await run(g, {
			media: { id: PHOTO, k: "lb", v: "all", p: { s: "play", t: 12.5, n: 3 } },
		});
		expect((play.media as { p: unknown }).p).toEqual({
			s: "play",
			t: 12.5,
			n: 3,
		});
		expect(guestView({ media: hidden.media }).media).toBeUndefined();
		expect(guestView({ media: open.media }).media).toEqual(open.media);
	});
});

describe("drag (FB-23)", () => {
	it("drops a drag of (or onto) a private row; keeps a public one", async () => {
		const g = guard();
		const card = await run(g, {
			drag: { a: `item:${ITEM}`, o: { id: `day:${DAY}`, w: "end" }, v: "all" },
		});
		expect(card.drag).toEqual({
			a: `item:${ITEM}`,
			o: { id: `day:${DAY}`, w: "end" },
			v: "all",
		});
		const gift = await run(g, {
			drag: { a: `list:${PRIVATE_TODO}`, o: null, v: "all" },
		});
		expect(gift.drag).toBeNull();
		const ontoGift = await run(g, {
			drag: {
				a: `list:${PUBLIC_TODO}`,
				o: { id: `list:${PRIVATE_TODO}`, w: "before" },
				v: "all",
			},
		});
		expect(ontoGift.drag).toBeNull();
		const bad = await run(g, {
			drag: { a: "money:summary", o: null, v: "all" },
		});
		expect(bad.drag).toBeNull();
	});
});

describe("form (FB-24)", () => {
	it("a private expense's editor is invisible; money forms are members-only", async () => {
		const g = guard();
		const priv = await run(g, {
			form: { k: "expense", m: "edit", t: `exp:${PRIVATE_EXPENSE}`, v: "all" },
		});
		expect(priv.form).toBeNull();
		const add = await run(g, {
			form: {
				k: "expense",
				m: "add",
				t: `item:${ITEM}`,
				v: "all",
				f: "  Amount\n",
			},
		});
		expect(add.form).toEqual({
			k: "expense",
			m: "add",
			t: `item:${ITEM}`,
			f: "Amount",
			v: "members",
		});
		expect(guestView({ form: add.form }).form).toBeUndefined();
		const flight = await run(g, {
			form: {
				k: "flight",
				m: "edit",
				t: `leg:l.${ITEM}.${DAY}`,
				v: "all",
				f: "Seats",
			},
		});
		expect(flight.form).toMatchObject({ k: "flight", v: "all", f: "Seats" });
		expect(guestView({ form: flight.form }).form).toEqual(flight.form);
		const giftRow = await run(g, {
			form: { k: "list", m: "edit", t: `list:${PRIVATE_TODO}`, v: "all" },
		});
		expect(giftRow.form).toBeNull();
		const long = await run(g, {
			form: {
				k: "item",
				m: "edit",
				t: `item:${ITEM}`,
				v: "all",
				f: "x".repeat(100),
			},
		});
		expect(
			[...((long.form as { f: string }).f ?? "")].length,
		).toBeLessThanOrEqual(32);
	});
});

describe("menu (FB-25)", () => {
	it("cleans and caps labels, drops private anchors, strips money for guests", async () => {
		const g = guard();
		const m = await run(g, {
			menu: {
				a: `item:${ITEM}`,
				fx: 0.8,
				fy: 1.05,
				items: [
					"Open  details",
					"",
					`Move${String.fromCharCode(0x202e)}it`,
					"x".repeat(100),
				],
				hi: 2,
				v: "all",
			},
		});
		expect(m.menu).toMatchObject({
			a: `item:${ITEM}`,
			items: ["Open details", "", "Moveit", "x".repeat(40)],
			hi: 2,
			v: "all",
		});
		const gift = await run(g, {
			menu: {
				a: `list:${PRIVATE_TODO}`,
				fx: 0,
				fy: 1,
				items: ["Delete"],
				hi: 0,
				v: "all",
			},
		});
		expect(gift.menu).toBeNull();
		const money = await run(g, {
			menu: {
				a: `exp:${EXPENSE}`,
				fx: 0,
				fy: 1,
				items: ["Edit"],
				hi: -1,
				v: "all",
			},
		});
		expect(money.menu).toMatchObject({ v: "members" });
		expect(guestView({ menu: money.menu }).menu).toBeUndefined();
		expect(guestView({ menu: m.menu }).menu).toEqual(m.menu);
	});
});

describe("what a link guest receives (FB-17a on FB-21)", () => {
	it("no money sub-view and no inspector Money tab in the view", () => {
		const s = guestView({
			view: view({
				path: "/t/asia-2027?sel=root&itab=money",
				ui: { money: { by: "day" }, lists: { near: true } },
			}),
		});
		expect(s.view).toMatchObject({
			path: "/t/asia-2027?sel=root",
			ui: { lists: { near: true } },
		});
		expect(
			(s.view as { ui: Record<string, unknown> }).ui.money,
		).toBeUndefined();
	});
});
