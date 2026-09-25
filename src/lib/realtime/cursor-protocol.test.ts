import { describe, expect, it } from "vitest";
import {
	AwarenessCursor,
	anchorKind,
	anchorPolicy,
	CHAT_MAX,
	CursorAnchor,
	cleanChatText,
	copyAnchorId,
	MAX_ANCHOR_ID,
	plainAnchorId,
	randomId,
	roundAnchor,
	sameAnchor,
	stricterVis,
} from "./cursor-protocol";

const ID = "0192f5a0-0000-7000-8000-0000000000c1";

describe("cursor anchors (FB-17)", () => {
	it("knows its kinds and refuses everything else", () => {
		expect(anchorKind(`item:${ID}`)).toBe("item");
		expect(anchorKind(`leg:l.${ID}.${ID}`)).toBe("leg");
		expect(anchorKind("pane:plan")).toBe("pane");
		for (const bad of [
			"",
			"item",
			"item:",
			"bank:1",
			"ITEM:x",
			'item:"x"',
			"item:<b>",
			"item:a b",
			`item:${"x".repeat(200)}`,
			"constructor:x",
			"__proto__:x",
		])
			expect(anchorKind(bad), bad).toBeNull();
	});

	it("says who may see an anchor", () => {
		expect(anchorPolicy(`item:${ID}`)).toBe("all");
		expect(anchorPolicy("tab:plan")).toBe("all");
		expect(anchorPolicy("tab:money")).toBe("members");
		expect(anchorPolicy("pane:money")).toBe("members");
		expect(anchorPolicy("money:summary")).toBe("members");
		expect(anchorPolicy("budget:x")).toBe("members");
		expect(anchorPolicy(`list:${ID}`)).toBe("lookup");
		expect(anchorPolicy(`exp:${ID}`)).toBe("lookup");
		expect(anchorPolicy(`media:${ID}`)).toBe("lookup");
		expect(anchorPolicy("nope:1")).toBeNull();
		expect(stricterVis("all", "members")).toBe("members");
		expect(stricterVis("all", "all")).toBe("all");
	});

	it("names each drawing of a day drawn twice, within the wire format", () => {
		const DAY = "0192f5a0-0000-7000-8000-0000000000d1";
		const one = copyAnchorId(`day:${DAY}`, ID);
		expect(one).toBe(`day:${DAY}_${ID}`);
		expect(copyAnchorId(`day:${DAY}`, undefined)).toBe(`day:${DAY}`);
		expect(plainAnchorId(one)).toBe(`day:${DAY}`);
		expect(plainAnchorId(`leg:l.${ID}.${ID}`)).toBe(`leg:l.${ID}.${ID}`);
		const head = copyAnchorId(`dayh:${DAY}`, ID);
		expect(head.length).toBeLessThanOrEqual(MAX_ANCHOR_ID);
		expect(anchorKind(head)).toBe("dayh");
		expect(anchorPolicy(one)).toBe("all");
		expect(
			CursorAnchor.safeParse({
				k: "el",
				id: head,
				fx: 0.5,
				fy: 0.5,
				p: { id: one, fx: 0.1, fy: 0.2 },
			}).success,
		).toBe(true);
		// A qualified money tab is still money.
		expect(anchorPolicy("tab:money_x")).toBe("members");
		expect(anchorPolicy("pane:money_1")).toBe("members");
	});

	it("encodes, rounds and decodes both anchor forms", () => {
		const el = roundAnchor({
			k: "el",
			id: `item:${ID}`,
			fx: 0.123456,
			fy: 0.98765,
			p: { id: "day:x", fx: 0.5, fy: 0.333333 },
		});
		expect(el).toEqual({
			k: "el",
			id: `item:${ID}`,
			fx: 0.1235,
			fy: 0.9877,
			p: { id: "day:x", fx: 0.5, fy: 0.3333 },
		});
		expect(CursorAnchor.parse(JSON.parse(JSON.stringify(el)))).toEqual(el);
		const map = roundAnchor({ k: "map", lng: 139.70041234, lat: 35.6595123 });
		expect(map).toEqual({ k: "map", lng: 139.700412, lat: 35.659512 });
		expect(sameAnchor(map, { ...map })).toBe(true);
		expect(sameAnchor(map, el)).toBe(false);
		expect(sameAnchor(null, undefined)).toBe(true);
		for (const bad of [
			{ k: "el", id: `item:${ID}`, fx: -0.1, fy: 0 },
			{ k: "el", id: `item:${ID}`, fx: 0, fy: Number.NaN },
			{ k: "map", lng: 181, lat: 0 },
			{ k: "map", lng: 0, lat: -91 },
			{ k: "el", id: "x:1", fx: 0, fy: 0 },
			{ k: "zz" },
		])
			expect(CursorAnchor.safeParse(bad).success, JSON.stringify(bad)).toBe(
				false,
			);
	});

	it("validates the awareness cursor", () => {
		expect(
			AwarenessCursor.safeParse({
				a: { k: "map", lng: 1, lat: 2 },
				v: "all",
				m: "mouse",
				chat: { n: 1, text: "hi" },
			}).success,
		).toBe(true);
		expect(
			AwarenessCursor.safeParse({ a: null, v: "all", m: "touch", tap: 3 })
				.success,
		).toBe(true);
		expect(
			AwarenessCursor.safeParse({ a: null, v: "guests", m: "mouse" }).success,
		).toBe(false);
	});
});

describe("cursor chat text", () => {
	it("drops controls and bidi tricks, collapses spaces, caps length", () => {
		expect(cleanChatText("  hi\n\tthere  ")).toBe("hi there ");
		expect(cleanChatText("evil‮gnp.exe")).toBe("evilgnp.exe");
		expect(cleanChatText("a\u0000b c")).toBe("a b c");
		expect(cleanChatText(42)).toBe("");
		// Emoji sequences (ZWJ) survive.
		expect(cleanChatText("👩‍👩‍👧 ok")).toBe("👩‍👩‍👧 ok");
		const long = cleanChatText("🔥".repeat(200));
		expect([...long].length).toBe(CHAT_MAX);
	});

	it("makes short random ids", () => {
		const a = randomId();
		expect(a).toMatch(/^[a-z0-9]{12}$/);
		expect(randomId()).not.toBe(a);
	});
});
