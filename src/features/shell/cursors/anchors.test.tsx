/**
 * FB-17 anchor encode/decode on a real DOM (happy-dom): boxes are stubbed so
 * the same anchor can be read back on "another screen" with other sizes.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { registerMapProjector } from "@/lib/workspace/map-projector";
import { encodeAt, resolveAnchor } from "./anchors";

const ITEM = "0192f5a0-0000-7000-8000-0000000000c1";
const DAY = "0192f5a0-0000-7000-8000-0000000000d1";
const TODO = "0192f5a0-0000-7000-8000-0000000000b1";

type R = { left: number; top: number; width: number; height: number };
function box(el: Element, r: R) {
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
const $ = (id: string) => document.getElementById(id) as HTMLElement;

beforeEach(() => {
	document.body.innerHTML = `
		<div id="pane" data-cursor-anchor="pane:plan">
			<section id="day" data-cursor-anchor="day:${DAY}">
				<div id="card" data-cursor-anchor="item:${ITEM}"><span id="title">Shibuya Sky</span></div>
				<div id="gap"></div>
			</section>
		</div>
		<ul><li id="todo" data-cursor-anchor="list:${TODO}" data-cursor-vis="private"><span id="gift">A gift</span></li></ul>
		<div data-cursor-vis="members"><section id="money" data-cursor-anchor="money:summary"><b id="total">$1</b></section></div>
		<div data-cursor-caret=""><p id="note">typing</p></div>
		<div id="menu" role="menu"><button id="menuitem">Rename</button></div>
		<div id="map" data-cursor-map=""><canvas id="canvas"></canvas></div>
		<div data-cursor-anchor="bogus:1"><i id="bogus"></i></div>
	`;
	box($("pane"), { left: 0, top: 0, width: 400, height: 1000 });
	box($("day"), { left: 0, top: 150, width: 400, height: 300 });
	box($("card"), { left: 100, top: 200, width: 200, height: 100 });
	box($("title"), { left: 110, top: 210, width: 100, height: 20 });
	box($("money"), { left: 0, top: 0, width: 300, height: 120 });
});

let unregister: (() => void) | null = null;
afterEach(() => {
	unregister?.();
	unregister = null;
});

describe("encodeAt", () => {
	it("anchors a point on a card to the card, with its day as the fallback", () => {
		const e = encodeAt($("title"), 130, 245);
		expect(e.vis).toBe("all");
		expect(e.anchor).toEqual({
			k: "el",
			id: `item:${ITEM}`,
			fx: 0.15,
			fy: 0.45,
			p: { id: `day:${DAY}`, fx: 0.325, fy: 0.3167 },
		});
	});

	it("never anchors inside private things, the notes editor, or menus", () => {
		expect(encodeAt($("gift"), 10, 10).anchor).toBeNull();
		expect(encodeAt($("note"), 10, 10).anchor).toBeNull();
		expect(encodeAt($("menuitem"), 10, 10).anchor).toBeNull();
		expect(encodeAt($("bogus"), 10, 10).anchor).toBeNull();
		expect(encodeAt(null, 10, 10).anchor).toBeNull();
	});

	it("money is members-only", () => {
		const e = encodeAt($("total"), 150, 60);
		expect(e.vis).toBe("members");
		expect(e.anchor).toMatchObject({ id: "money:summary", fx: 0.5, fy: 0.5 });
	});

	it("the map travels as lng/lat through its projector", () => {
		unregister = registerMapProjector({
			container: $("canvas"),
			unproject: (x, y) => ({ lng: 100 + x / 10, lat: 30 + y / 100 }),
			project: (lng, lat) => ({ x: (lng - 100) * 10, y: (lat - 30) * 100 }),
			easeTo: () => {},
		});
		expect(encodeAt($("canvas"), 397, 566).anchor).toEqual({
			k: "map",
			lng: 139.7,
			lat: 35.66,
		});
		// No map registered: nothing.
		unregister();
		unregister = null;
		expect(encodeAt($("canvas"), 1, 1).anchor).toBeNull();
	});
});

describe("resolveAnchor (the other screen)", () => {
	it("lands on the same spot of the same card at another size", () => {
		const a = encodeAt($("title"), 130, 245).anchor;
		if (!a) throw new Error("no anchor");
		// The other person's layout: a wider card further down.
		box($("card"), { left: 40, top: 600, width: 500, height: 80 });
		const r = resolveAnchor(a);
		expect(r?.x).toBeCloseTo(40 + 0.15 * 500, 5);
		expect(r?.y).toBeCloseTo(600 + 0.45 * 80, 5);
		expect(r?.el).toBe($("card"));
	});

	it("falls back to the enclosing day when the card isn't rendered there", () => {
		const a = encodeAt($("title"), 130, 245).anchor;
		if (!a) throw new Error("no anchor");
		$("card").remove();
		box($("day"), { left: 0, top: 2000, width: 300, height: 600 });
		const r = resolveAnchor(a);
		expect(r?.el).toBe($("day"));
		expect(r?.x).toBeCloseTo(0.325 * 300, 5);
		expect(r?.y).toBeCloseTo(2000 + 0.3167 * 600, 3);
		// Outside the viewport: the overlay draws an edge arrow for it.
		expect(r && r.y > r.clip.bottom).toBe(true);
	});

	it("nothing when neither is on this screen", () => {
		expect(
			resolveAnchor({ k: "el", id: "item:nope", fx: 0.5, fy: 0.5 }),
		).toBeNull();
		expect(resolveAnchor({ k: "map", lng: 1, lat: 1 })).toBeNull();
	});

	it("a map anchor projects through the map", () => {
		box($("canvas"), { left: 0, top: 0, width: 800, height: 700 });
		unregister = registerMapProjector({
			container: $("canvas"),
			unproject: () => null,
			project: (lng, lat) => ({ x: (lng - 100) * 10, y: (lat - 30) * 100 }),
			easeTo: () => {},
		});
		const r = resolveAnchor({ k: "map", lng: 139.7, lat: 35.66 });
		expect(r?.x).toBeCloseTo(397, 5);
		expect(r?.y).toBeCloseTo(566, 5);
		expect(r?.map).toBe($("canvas"));
	});
});

describe("a day drawn twice (it crosses two countries: one drawing per band)", () => {
	const JP = "0192f5a0-0000-7000-8000-0000000000a1"; // the Japan drawing's first card
	const KR = "0192f5a0-0000-7000-8000-0000000000a2"; // the Korea drawing's first card
	const drawing = (first: string) => `${DAY}_${first}`;

	beforeEach(() => {
		document.body.innerHTML = `
			<div id="pane" data-cursor-anchor="pane:plan">
				<section id="jp" data-cursor-anchor="day:${drawing(JP)}">
					<header id="jph" data-cursor-anchor="dayh:${drawing(JP)}"><b id="jpdate">Thu 7 Oct</b></header>
					<div id="jpcard" data-cursor-anchor="item:${JP}"></div>
				</section>
				<section id="kr" data-cursor-anchor="day:${drawing(KR)}">
					<header id="krh" data-cursor-anchor="dayh:${drawing(KR)}"><b id="krdate">Thu 7 Oct</b></header>
					<div id="krcard" data-cursor-anchor="item:${KR}"></div>
				</section>
			</div>
		`;
		box($("pane"), { left: 0, top: 0, width: 520, height: 700 });
		box($("jp"), { left: 0, top: 100, width: 520, height: 200 });
		box($("jph"), { left: 0, top: 109, width: 520, height: 63 });
		box($("jpdate"), { left: 16, top: 120, width: 90, height: 24 });
		box($("jpcard"), { left: 40, top: 180, width: 420, height: 90 });
		box($("kr"), { left: 0, top: 375, width: 520, height: 200 });
		box($("krh"), { left: 0, top: 384, width: 520, height: 63 });
		box($("krdate"), { left: 16, top: 395, width: 90, height: 24 });
		box($("krcard"), { left: 40, top: 455, width: 420, height: 90 });
	});

	/** The other screen: narrower, both drawings elsewhere (QA verify72's 1440 → 1120). */
	function otherScreen() {
		box($("jp"), { left: 0, top: 60, width: 460, height: 220 });
		box($("jph"), { left: 0, top: 60, width: 460, height: 63 });
		box($("jpcard"), { left: 30, top: 140, width: 360, height: 100 });
		box($("kr"), { left: 0, top: 300, width: 460, height: 220 });
		box($("krh"), { left: 0, top: 300, width: 460, height: 63 });
		box($("krcard"), { left: 30, top: 380, width: 360, height: 100 });
	}

	it("a point on the second header lands on the second header, not the first", () => {
		const e = encodeAt($("krdate"), 60, 410);
		expect(e.anchor).toMatchObject({
			k: "el",
			id: `dayh:${drawing(KR)}`,
			p: { id: `day:${drawing(KR)}` },
		});
		if (!e.anchor) throw new Error("no anchor");
		otherScreen();
		const r = resolveAnchor(e.anchor);
		expect(r?.el).toBe($("krh"));
		expect(r?.y).toBeGreaterThanOrEqual(300);
		expect(r?.y).toBeLessThanOrEqual(363);
		// And the first header stays the first header's.
		const first = encodeAt($("jpdate"), 60, 130).anchor;
		if (!first) throw new Error("no anchor");
		expect(resolveAnchor(first)?.el).toBe($("jph"));
	});

	it("a card of the second drawing that isn't rendered here falls back to the second drawing", () => {
		const a = encodeAt($("krcard"), 100, 500).anchor;
		expect(a).toMatchObject({
			id: `item:${KR}`,
			p: { id: `day:${drawing(KR)}` },
		});
		if (!a) throw new Error("no anchor");
		otherScreen();
		$("krcard").remove();
		const r = resolveAnchor(a);
		expect(r?.el).toBe($("kr"));
		expect(r?.y).toBeGreaterThan(300);
	});

	it("keeps the cached drawing and never swaps it for the other one", () => {
		const a = encodeAt($("krdate"), 60, 410).anchor;
		if (!a) throw new Error("no anchor");
		const once = resolveAnchor(a);
		expect(resolveAnchor(a, once?.el)?.el).toBe($("krh"));
		// A stale cache (the other drawing) is not taken for it.
		expect(resolveAnchor(a, $("jph"))?.el).toBe($("krh"));
	});

	it("at a lens that draws the day once, a drawing lands on the day; the reverse lands on a drawing", () => {
		const onDrawing = encodeAt($("krdate"), 60, 410).anchor;
		if (!onDrawing) throw new Error("no anchor");
		// This screen draws the day once (the place lens): the plain ids.
		$("kr").remove();
		$("jp").setAttribute("data-cursor-anchor", `day:${DAY}`);
		$("jph").setAttribute("data-cursor-anchor", `dayh:${DAY}`);
		expect(resolveAnchor(onDrawing)?.el).toBe($("jph"));
		// Someone at that lens points at the plain day: a screen that splits it
		// shows them on one of its drawings.
		const plain = encodeAt($("jpdate"), 60, 130).anchor;
		expect(plain).toMatchObject({ id: `dayh:${DAY}` });
		if (!plain) throw new Error("no anchor");
		$("jp").setAttribute("data-cursor-anchor", `day:${drawing(JP)}`);
		$("jph").setAttribute("data-cursor-anchor", `dayh:${drawing(JP)}`);
		expect(resolveAnchor(plain)?.el).toBe($("jph"));
	});

	it("never lands on the OTHER drawing of a split day", () => {
		const a = encodeAt($("krdate"), 60, 410).anchor;
		if (!a) throw new Error("no anchor");
		// This screen collapsed the Korea band: only the Japan drawing is here.
		$("kr").remove();
		// Not the Japan drawing's header or section: the cursor hides.
		expect(resolveAnchor(a)).toBeNull();
	});
});
