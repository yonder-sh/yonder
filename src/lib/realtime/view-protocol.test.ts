import { describe, expect, it } from "vitest";
import {
	AwarenessCam,
	AwarenessDrag,
	AwarenessForm,
	AwarenessMedia,
	AwarenessMenu,
	cleanLabel,
	cleanMenuItems,
	cleanViewUi,
	decodePlanFolds,
	dropMoneyParams,
	encodePlanFolds,
	expectedVideoTime,
	fitViewUi,
	followZoom,
	MAX_UI_KEYS,
	MENU_LABEL_MAX,
	MENU_MAX_ITEMS,
	roundCam,
	sameCam,
	videoOff,
	wireKeys,
} from "./view-protocol";

const ID = "0192f5a0-0000-7000-8000-0000000000c1";
const DAY = "0192f5a0-0000-7000-8000-0000000000d1";

describe("camera fit (FB-22)", () => {
	it("keeps the zoom for the same visible size", () => {
		expect(followZoom({ z: 7, w: 800, h: 600 }, { w: 800, h: 600 })).toBe(7);
	});
	it("zooms out by log2 of the smaller ratio, so the follower sees at least as much", () => {
		// Half as wide, same height: one zoom level out.
		expect(followZoom({ z: 7, w: 1200, h: 800 }, { w: 600, h: 800 })).toBe(6);
		// A phone (390×500 visible) following a desktop (1200×800): the width decides.
		const z = followZoom({ z: 8, w: 1200, h: 800 }, { w: 390, h: 500 });
		expect(z).toBeCloseTo(8 + Math.log2(390 / 1200), 6);
		// The follower's view spans at least the leader's in both directions.
		const span = (w: number, zoom: number) => w / 2 ** zoom;
		expect(span(390, z)).toBeGreaterThanOrEqual(span(1200, 8) - 1e-9);
		expect(span(500, z)).toBeGreaterThanOrEqual(span(800, 8) - 1e-9);
	});
	it("zooms in for a bigger screen, and clamps to [0, 22]", () => {
		expect(followZoom({ z: 5, w: 500, h: 500 }, { w: 2000, h: 1000 })).toBe(6);
		expect(followZoom({ z: 0.5, w: 2000, h: 2000 }, { w: 100, h: 100 })).toBe(
			0,
		);
		expect(followZoom({ z: 21.8, w: 100, h: 100 }, { w: 4000, h: 4000 })).toBe(
			22,
		);
	});
	it("validates and rounds the wire camera", () => {
		const cam = roundCam({
			c: [139.70001234567, 35.6581234567],
			z: 12.345678,
			b: 10.12345,
			p: 30.555,
			g: false,
			w: 800.4,
			h: 600.6,
			n: 3,
		});
		expect(cam).toEqual({
			c: [139.700012, 35.658123],
			z: 12.346,
			b: 10.12,
			p: 30.56,
			g: false,
			w: 800,
			h: 601,
			n: 3,
		});
		expect(AwarenessCam.safeParse(cam).success).toBe(true);
		expect(sameCam(cam, { ...cam, n: 9 })).toBe(true);
		expect(sameCam(cam, { ...cam, z: 1 })).toBe(false);
		for (const bad of [
			{ ...cam, c: [200, 0] },
			{ ...cam, z: 30 },
			{ ...cam, p: 90 },
			{ ...cam, w: 1 },
			{ ...cam, g: "yes" },
			{ ...cam, z: Number.NaN },
		])
			expect(AwarenessCam.safeParse(bad).success).toBe(false);
	});
});

describe("plan folds on the wire (FB-21a)", () => {
	const bands = [`band:${ID}#0`, `band:${DAY}#0`];
	it("round-trips the four fold sets", () => {
		const f = encodePlanFolds({
			openFolds: [`fold:${DAY}`],
			collapsedBands: new Set([`band:${ID}#0`]),
			collapsedBlocks: [`${DAY}|${ID}#1`],
			openStretch: [`${DAY}:${ID}#0|${ID}`],
			bands,
		});
		expect(f).toEqual({
			of: [`fold:${DAY}`],
			cb: [`band:${ID}#0`],
			ck: [`${DAY}|${ID}#1`],
			os: [`${DAY}:${ID}#0|${ID}`],
		});
		const back = decodePlanFolds(f, bands);
		expect([...back.openFolds]).toEqual([`fold:${DAY}`]);
		expect([...back.collapsedBands]).toEqual([`band:${ID}#0`]);
		expect([...back.collapsedBlocks]).toEqual([`${DAY}|${ID}#1`]);
		expect([...back.openStretch]).toEqual([`${DAY}:${ID}#0|${ID}`]);
		expect(cleanViewUi({ plan: f })).toEqual({ plan: f });
	});
	it('says "all bands collapsed" instead of listing them (Collapse all)', () => {
		const f = encodePlanFolds({
			openFolds: [],
			collapsedBands: new Set(bands),
			collapsedBlocks: [],
			openStretch: [],
			bands,
		});
		expect(f).toEqual({ ca: 1 });
		// The follower collapses every band on ITS screen.
		const mine = [...bands, `band:${ID}#1`];
		expect([...decodePlanFolds(f, mine).collapsedBands]).toEqual(mine);
		expect(decodePlanFolds({}, mine).collapsedBands.size).toBe(0);
	});
	it("drops keys that could carry markup and caps the count", () => {
		expect(wireKeys(["ok:1", "<img src=x>", "a b", ""])).toEqual(["ok:1"]);
		const many = Array.from({ length: 80 }, (_, i) => `fold:${i}`);
		expect(wireKeys(many)).toHaveLength(MAX_UI_KEYS);
		expect(cleanViewUi({ plan: { of: ["<script>"] } })).toBeNull();
		expect(cleanViewUi({ plan: { of: many } })).toBeNull();
	});
});

describe("view.ui (FB-21d)", () => {
	it("accepts short switches, never free text", () => {
		expect(
			cleanViewUi({
				lists: { group: "place", near: true, pwho: ID },
				map: { layers: true, days: "dim" },
			}),
		).toEqual({
			lists: { group: "place", near: true, pwho: ID },
			map: { layers: true, days: "dim" },
		});
		expect(cleanViewUi({ lists: { group: "Shibuya Sky!" } })).toBeNull();
		expect(cleanViewUi({ lists: { "bad key": true } })).toBeNull();
		expect(cleanViewUi({ lists: { n: 3 } })).toBeNull();
		const wide = Object.fromEntries(
			Array.from({ length: 13 }, (_, i) => [`k${"abcdefghijklm"[i]}`, true]),
		);
		expect(cleanViewUi({ lists: wide })).toBeNull();
		// Unknown parts are stripped.
		expect(cleanViewUi({ secret: { a: true } })).toEqual({});
	});
	it("fits what it can: a bad part is left out, the rest travels", () => {
		expect(
			fitViewUi({
				lists: { group: "place" },
				money: { by: "NOT OK" },
				outline: { level: "city" },
			}),
		).toEqual({ lists: { group: "place" }, outline: { level: "city" } });
	});
});

describe("media, drags, forms, menus (FB-21c, 23, 24, 25)", () => {
	it("video catch-up: follows the play clock, seeks past 1.5 s", () => {
		expect(expectedVideoTime({ s: "play", t: 10, n: 1 }, 2.5)).toBe(12.5);
		expect(expectedVideoTime({ s: "pause", t: 10, n: 1 }, 2.5)).toBe(10);
		expect(videoOff(10, 11.4)).toBe(false);
		expect(videoOff(10, 11.6)).toBe(true);
		expect(
			AwarenessMedia.safeParse({ id: ID, k: "lb", v: "all", p: null }).success,
		).toBe(true);
		expect(
			AwarenessMedia.safeParse({ id: "x", k: "lb", v: "all" }).success,
		).toBe(false);
	});
	it("drags: only draggable kinds, only known drop kinds", () => {
		const ok = { a: `item:${ID}`, o: { id: `day:${DAY}`, w: "end" }, v: "all" };
		expect(AwarenessDrag.safeParse(ok).success).toBe(true);
		expect(AwarenessDrag.safeParse({ ...ok, a: "money:summary" }).success).toBe(
			false,
		);
		expect(
			AwarenessDrag.safeParse({ ...ok, o: { id: "exp:1", w: "end" } }).success,
		).toBe(false);
		expect(
			AwarenessDrag.safeParse({ ...ok, o: { id: `day:${DAY}`, w: "in" } })
				.success,
		).toBe(false);
	});
	it("forms: a kind, add or edit, an anchored target", () => {
		const f = { k: "expense", m: "add", t: `item:${ID}`, v: "members" };
		expect(AwarenessForm.safeParse(f).success).toBe(true);
		expect(AwarenessForm.safeParse({ ...f, k: "password" }).success).toBe(
			false,
		);
		expect(
			AwarenessForm.safeParse({ ...f, t: "javascript:alert(1)" }).success,
		).toBe(false);
	});
	it("menus: plain labels, capped, cleaned; hi within range", () => {
		const m = {
			a: `item:${ID}`,
			fx: 0.9,
			fy: 1.1,
			items: ["Open", "", "Delete"],
			hi: 2,
			v: "all",
		};
		expect(AwarenessMenu.safeParse(m).success).toBe(true);
		expect(
			AwarenessMenu.safeParse({
				...m,
				items: Array(MENU_MAX_ITEMS + 1).fill("x"),
			}).success,
		).toBe(false);
		expect(AwarenessMenu.safeParse({ ...m, hi: 15 }).success).toBe(false);
		expect(AwarenessMenu.safeParse({ ...m, fx: 9 }).success).toBe(false);
		expect(AwarenessMenu.safeParse({ ...m, a: "nope:1" }).success).toBe(false);
		const cleaned = cleanMenuItems([
			"  Move   to\nday  ",
			"x".repeat(80),
			`evil${String.fromCharCode(0x202e)}txt.exe`,
		]);
		expect(cleaned[0]).toBe("Move to day");
		expect([...(cleaned[1] ?? "")]).toHaveLength(MENU_LABEL_MAX);
		expect(cleaned[2]).toBe("eviltxt.exe");
		expect(cleanLabel(42, 10)).toBe("");
	});
});

describe("guests (FB-17a)", () => {
	it("drops the Money tab and the inspector's Money tab from a path", () => {
		expect(dropMoneyParams("/t/x?tab=money")).toBe("/t/x");
		expect(dropMoneyParams("/t/x?itab=money&sel=root")).toBe("/t/x?sel=root");
		expect(dropMoneyParams("/t/x?tab=money&itab=money")).toBe("/t/x");
		expect(dropMoneyParams("/t/x?lens=city&itab=money")).toBe("/t/x?lens=city");
		expect(dropMoneyParams("/t/x?itab=media")).toBe("/t/x?itab=media");
	});
});
