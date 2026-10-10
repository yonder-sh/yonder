/** Saved's tiles: the badge, the one line, the feed's order. */
import { describe, expect, it } from "vitest";
import { feedPile, savedKind, sourceLabel, tileLine } from "../lib";

const base = {
	url: null,
	text: null,
	title: null,
	provider: null,
	siteName: null,
	previewTitle: null,
	description: null,
	place: null,
};

describe("a saved tile", () => {
	it("names its source: the provider, Maps, the site, else a note", () => {
		expect(sourceLabel({ ...base, url: "https://x", provider: "tiktok" })).toBe(
			"TikTok",
		);
		expect(sourceLabel({ ...base, url: "https://maps.app.goo.gl/abc" })).toBe(
			"Maps",
		);
		expect(
			sourceLabel({
				...base,
				url: "https://www.japan-guide.com/e/e2172.html",
				siteName: "japan-guide.com",
			}),
		).toBe("japan-guide.com");
		expect(sourceLabel({ ...base, url: "https://www.timeout.com/tokyo" })).toBe(
			"timeout.com",
		);
		expect(sourceLabel({ ...base, text: "Onibus Coffee" })).toBe("Note");
	});

	it("says one line: the place, else the words shared, else the caption", () => {
		expect(
			tileLine({
				...base,
				url: "https://maps.app.goo.gl/abc",
				previewTitle: "Itoya",
				place: { name: "Itoya Ginza", lat: 35.67, lng: 139.77 },
			}),
		).toBe("Itoya Ginza");
		expect(
			tileLine({
				...base,
				url: "https://www.tiktok.com/@a/video/1",
				previewTitle: "Best matcha in Uji 🍵",
			}),
		).toBe("Best matcha in Uji 🍵");
		expect(
			tileLine({
				...base,
				url: "https://www.tiktok.com/@a/video/1",
				text: "Matcha #kyoto 🍵",
			}),
		).toBe("Matcha");
		expect(
			tileLine({
				...base,
				url: "https://www.tiktok.com/@a/video/1",
				text: "Hojicha at Kagizen",
				previewTitle: "TikTok - Make Your Day",
			}),
		).toBe("Hojicha at Kagizen");
		expect(tileLine({ ...base, url: "https://www.timeout.com/tokyo" })).toBe(
			"timeout.com",
		);
	});

	it("knows its kind", () => {
		expect(savedKind({ url: "https://maps.app.goo.gl/x", text: null })).toBe(
			"maps",
		);
		expect(
			savedKind({ url: "https://www.instagram.com/reel/C0X/", text: null }),
		).toBe("social");
		expect(savedKind({ url: null, text: "ramen" })).toBe("text");
	});
});

describe("the feed's order", () => {
	it("starts at the tile you opened, then the grid's order", () => {
		expect(feedPile(["a", "b", "c", "d"], "c")).toEqual(["c", "a", "b", "d"]);
		expect(feedPile(["a", "b"], "gone")).toEqual(["a", "b"]);
		expect(feedPile(["a", "b"], null)).toEqual(["a", "b"]);
	});
});
