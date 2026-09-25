import { describe, expect, it } from "vitest";
import {
	autoParent,
	classifyShare,
	cleanShareName,
	firstUrl,
	parentLabel,
	parseMapsUrl,
	readResolution,
} from "../share-classify";

describe("E8 share classification", () => {
	it("tells Maps places, social videos, web pages, media and text apart", () => {
		const e = (url: string | null, text: string | null = null, files = 0) => ({
			url,
			text,
			files: Array.from({ length: files }),
		});
		expect(classifyShare(e("https://maps.app.goo.gl/abc123"))).toBe("maps");
		expect(
			classifyShare(
				e("https://www.google.com/maps/place/Itoya/@35.67,139.76,17z"),
			),
		).toBe("maps");
		expect(classifyShare(e("https://www.tiktok.com/@a/video/1"))).toBe(
			"social",
		);
		expect(classifyShare(e("https://youtube.com/shorts/xyz"))).toBe("social");
		expect(classifyShare(e("https://example.com/ramen"))).toBe("web");
		expect(classifyShare(e(null, "see https://example.com/x"))).toBe("web");
		expect(classifyShare(e(null, null, 2))).toBe("media");
		expect(classifyShare(e(null, "Buy washi tape"))).toBe("text");
		expect(classifyShare(e("https://www.google.com/search?q=x"))).toBe("web");
	});

	it("cleans a name: no URLs, hashtags, handles or emoji; ≤ 60 characters", () => {
		expect(
			cleanShareName(
				"Best ramen in Tokyo 🍜🔥 #ramen #tokyo @foodie https://t.co/x",
				null,
			),
		).toBe("Best ramen in Tokyo");
		expect(cleanShareName(null, "Nishiki Market | TikTok")).toBe(
			"Nishiki Market",
		);
		const long = cleanShareName(
			"A really long title about a hidden kissaten in the back streets of Kyoto near Nishiki",
			null,
		);
		expect(long.length).toBeLessThanOrEqual(60);
		expect(long.endsWith(" ")).toBe(false);
	});

	it("reads name and coordinates from Maps URLs", () => {
		expect(
			parseMapsUrl(
				"https://www.google.com/maps/place/Itoya+Ginza/@35.6718,139.7665,17z/data=!3m1!4b1!4m6!3m5!1s0x0:0x0!8m2!3d35.6719!4d139.7667",
			),
		).toEqual({ name: "Itoya Ginza", lat: 35.6719, lng: 139.7667 });
		expect(parseMapsUrl("https://maps.google.com/?q=35.01,135.77")).toEqual({
			name: null,
			lat: 35.01,
			lng: 135.77,
		});
		expect(parseMapsUrl("https://maps.google.com/?q=Fushimi+Inari")).toEqual({
			name: "Fushimi Inari",
			lat: null,
			lng: null,
		});
		expect(parseMapsUrl("not a url")).toEqual({
			name: null,
			lat: null,
			lng: null,
		});
		expect(firstUrl("look: https://example.com/a).")).toBe(
			"https://example.com/a",
		);
	});

	it("reads WP-Places' resolveSharedLink answer defensively", () => {
		const r = readResolution({
			preview: {
				provider: "google",
				ref: "ChIJ123",
				name: "Itoya Ginza",
				lat: 35.6719,
				lng: 139.7667,
				countryCode: "jp",
				category: "shop",
				photos: [],
				filing: {
					existing: ["jp", "tokyo"],
					create: [
						{ type: "area", name: "Ginza" },
						{ type: "place", name: "nope" },
					],
				},
			},
			existing: { nodeId: "n1", name: "Itoya", crumb: "Japan › Tokyo › Ginza" },
		});
		expect(r?.preview).toMatchObject({
			name: "Itoya Ginza",
			googlePlaceId: "ChIJ123",
			countryCode: "JP",
			filing: {
				existing: ["jp", "tokyo"],
				create: [{ type: "area", name: "Ginza" }],
			},
		});
		expect(r?.existing).toEqual({
			nodeId: "n1",
			name: "Itoya",
			where: "Ginza",
		});
		// A preview without usable coordinates is dropped; junk is null.
		expect(
			readResolution({ preview: { name: "X", lat: 200, lng: 0 } })?.preview,
		).toBeNull();
		expect(
			readResolution({ preview: null, query: "Fushimi Inari" })?.query,
		).toBe("Fushimi Inari");
		expect(readResolution("nope")).toBeNull();
	});

	it("files a new idea by the filing suggestion, else the nearest city, else the top level", () => {
		const nodes = [
			{
				id: "jp",
				parentId: null,
				type: "country",
				name: "Japan",
				lat: null,
				lng: null,
			},
			{
				id: "kyoto",
				parentId: "jp",
				type: "city",
				name: "Kyoto",
				lat: 35.0116,
				lng: 135.7681,
			},
			{
				id: "tokyo",
				parentId: "jp",
				type: "city",
				name: "Tokyo",
				lat: 35.6762,
				lng: 139.6503,
			},
		];
		const filing = {
			existing: ["jp", "tokyo"],
			create: [{ type: "area" as const, name: "Ginza" }],
		};
		const byFiling = autoParent(nodes, { lat: 35.67, lng: 139.76 }, filing);
		expect(byFiling).toEqual({
			parentId: "tokyo",
			create: [{ type: "area", name: "Ginza" }],
		});
		expect(parentLabel(nodes, byFiling, "Asia 2027")).toBe(
			"Japan › Tokyo › Ginza (new)",
		);
		// A filing that names a node this client doesn't know falls back to the coordinates.
		expect(
			autoParent(
				nodes,
				{ lat: 35.0, lng: 135.77 },
				{ existing: ["gone"], create: [] },
			),
		).toEqual({ parentId: "kyoto", create: [] });
		expect(autoParent(nodes, { lat: 48.85, lng: 2.35 }, null)).toEqual({
			parentId: null,
			create: [],
		});
		expect(
			parentLabel(nodes, { parentId: null, create: [] }, "Asia 2027"),
		).toBe("Asia 2027");
	});
});
