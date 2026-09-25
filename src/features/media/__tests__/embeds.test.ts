import { describe, expect, it } from "vitest";
import { canonicalLink, classifyUrl, displayHost, embedSrc } from "../embeds";
import {
	cleanFileName,
	filterOf,
	kindForMime,
	uploadProblem,
} from "../media-kinds";
import { sniffMatches } from "../server/sniff";

describe("classifyUrl (SPEC §15.3, MED-04)", () => {
	it.each([
		["https://www.youtube.com/watch?v=dQw4w9WgXcQ", "dQw4w9WgXcQ", false],
		[
			"https://www.youtube.com/watch?feature=share&v=dQw4w9WgXcQ&t=10",
			"dQw4w9WgXcQ",
			false,
		],
		["https://youtu.be/dQw4w9WgXcQ?si=abc", "dQw4w9WgXcQ", false],
		["https://youtube.com/shorts/abcdefghijk", "abcdefghijk", true],
		["https://m.youtube.com/live/abcdefghijk", "abcdefghijk", false],
		[
			"https://www.youtube-nocookie.com/embed/abcdefghijk",
			"abcdefghijk",
			false,
		],
	])("YouTube %s", (url, id, short) => {
		const c = classifyUrl(url);
		expect(c).toMatchObject({
			kind: "embed",
			provider: "youtube",
			embedId: id,
			short,
		});
		expect(c.kind === "embed" && c.aspect).toBeCloseTo(short ? 9 / 16 : 16 / 9);
	});

	it("TikTok long, photo and short links", () => {
		expect(
			classifyUrl(
				"https://www.tiktok.com/@scout2015/video/6718335390845095173",
			),
		).toMatchObject({
			kind: "embed",
			provider: "tiktok",
			embedId: "6718335390845095173",
		});
		expect(
			classifyUrl("https://www.tiktok.com/@some.one/photo/7300000000000000000"),
		).toMatchObject({ provider: "tiktok", embedId: "7300000000000000000" });
		expect(classifyUrl("https://vm.tiktok.com/ZMabc123/")).toMatchObject({
			kind: "embed",
			provider: "tiktok",
			embedId: null,
		});
	});

	it("Instagram posts and reels (igsh stripped by the canonical link)", () => {
		const c = classifyUrl(
			"https://www.instagram.com/reel/C8abcDEF123/?igsh=xyz",
		);
		expect(c).toMatchObject({
			provider: "instagram",
			embedId: "C8abcDEF123",
			igType: "reel",
		});
		expect(canonicalLink("instagram", "C8abcDEF123", null, "reel")).toBe(
			"https://www.instagram.com/reel/C8abcDEF123/",
		);
		expect(
			classifyUrl("https://instagram.com/kyoto.eats/reels/Cabc12345/"),
		).toMatchObject({
			igType: "reel",
			author: "kyoto.eats",
		});
		expect(classifyUrl("https://www.instagram.com/p/Babc12345/")).toMatchObject(
			{ igType: "p" },
		);
	});

	it("everything else is a web link, including look-alike hosts", () => {
		for (const url of [
			"https://www.japan-guide.com/e/e2172.html",
			"https://youtube.com.evil.example/watch?v=dQw4w9WgXcQ",
			"https://notinstagram.com/p/abcdef/",
			"https://www.youtube.com/channel/UC123",
		])
			expect(classifyUrl(url)).toEqual({ kind: "link", provider: "web" });
		expect(classifyUrl("javascript:alert(1)")).toEqual({
			kind: "link",
			provider: "web",
		});
	});

	it("builds iframe srcs only from allowlisted providers and strict ids", () => {
		expect(embedSrc("youtube", "dQw4w9WgXcQ")).toBe(
			"https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ?playsinline=1&rel=0",
		);
		expect(embedSrc("tiktok", "6718335390845095173")).toMatch(
			/^https:\/\/www\.tiktok\.com\/player\/v1\/6718335390845095173\?/,
		);
		expect(embedSrc("instagram", "C8abcDEF123", { igType: "p" })).toBe(
			"https://www.instagram.com/p/C8abcDEF123/embed/captioned/",
		);
		expect(embedSrc("youtube", 'x"><script>')).toBeNull();
		expect(embedSrc("tiktok", "../../evil")).toBeNull();
		expect(embedSrc("vimeo", "123")).toBeNull();
		expect(embedSrc("youtube", null)).toBeNull();
	});

	it("displayHost", () => {
		expect(displayHost("https://www.japan-guide.com/e/x.html")).toBe(
			"japan-guide.com",
		);
		expect(displayHost("nope")).toBe("");
	});
});

describe("upload rules (MED-06)", () => {
	it("refuses the wrong type and oversize files before any request", () => {
		expect(
			uploadProblem({
				name: "malware.exe",
				type: "application/x-msdownload",
				size: 10,
			}),
		).toBe("malware.exe isn't a photo, video or PDF.");
		expect(
			uploadProblem({ name: "logo.svg", type: "image/svg+xml", size: 10 }),
		).toMatch(/SVG/);
		expect(
			uploadProblem({
				name: "big.jpg",
				type: "image/jpeg",
				size: 60 * 1024 * 1024,
			}),
		).toBe("big.jpg is 60.0 MB — Photos can be up to 50.0 MB.");
		expect(
			uploadProblem({
				name: "ticket.pdf",
				type: "application/pdf",
				size: 51 * 1024 * 1024,
			}),
		).toBe("ticket.pdf is 51.0 MB — PDFs can be up to 50.0 MB.");
		expect(
			uploadProblem({ name: "ok.pdf", type: "application/pdf", size: 1000 }),
		).toBeNull();
		expect(
			uploadProblem({
				name: "clip.mp4",
				type: "video/mp4",
				size: 1900 * 1024 * 1024,
			}),
		).toBeNull();
		expect(
			uploadProblem({
				name: "long.mp4",
				type: "video/mp4",
				size: 2.5 * 1024 * 1024 * 1024,
			}),
		).toBe("long.mp4 is 2.5 GB — Videos can be up to 2 GB.");
	});

	it("maps types to kinds and filters", () => {
		expect(kindForMime("image/avif")).toBe("photo");
		expect(kindForMime("video/quicktime")).toBe("video");
		expect(kindForMime("application/pdf")).toBe("pdf");
		expect(kindForMime("text/html")).toBeNull();
		expect(filterOf("embed")).toBe("social");
		expect(filterOf("link")).toBe("guides");
		expect(filterOf("pdf")).toBe("documents");
	});

	it("cleans file names for display and Content-Disposition", () => {
		expect(cleanFileName("C:\\Users\\me\\E-ticket NH9.pdf")).toBe(
			"E-ticket NH9.pdf",
		);
		expect(cleanFileName('../../"evil"\u0000.pdf')).toBe("evil.pdf");
		expect(cleanFileName("")).toBe("document");
	});
});

describe("magic bytes (SECURITY §5)", () => {
	const bytes = (...xs: (number | string)[]) =>
		new Uint8Array(
			xs.flatMap((x) =>
				typeof x === "string" ? [...x].map((c) => c.charCodeAt(0)) : [x],
			),
		);
	it("accepts the real signatures", () => {
		expect(sniffMatches("image/jpeg", bytes(0xff, 0xd8, 0xff, 0xe0))).toBe(
			true,
		);
		expect(
			sniffMatches("image/png", bytes(0x89, "PNG", 0x0d, 0x0a, 0x1a, 0x0a)),
		).toBe(true);
		expect(sniffMatches("image/gif", bytes("GIF89a"))).toBe(true);
		expect(sniffMatches("image/webp", bytes("RIFF", 0, 0, 0, 0, "WEBP"))).toBe(
			true,
		);
		expect(sniffMatches("video/mp4", bytes(0, 0, 0, 0x20, "ftypisom"))).toBe(
			true,
		);
		expect(sniffMatches("image/avif", bytes(0, 0, 0, 0x20, "ftypavif"))).toBe(
			true,
		);
		expect(sniffMatches("video/webm", bytes(0x1a, 0x45, 0xdf, 0xa3))).toBe(
			true,
		);
		expect(sniffMatches("application/pdf", bytes("%PDF-1.7\n"))).toBe(true);
	});
	it("refuses a file that isn't what it claims", () => {
		expect(sniffMatches("image/jpeg", bytes("<html><script>"))).toBe(false);
		expect(sniffMatches("application/pdf", bytes("MZ", 0x90, 0))).toBe(false);
		expect(sniffMatches("video/mp4", bytes("#EXTM3U\n#EXT-X"))).toBe(false);
		expect(sniffMatches("image/png", bytes(0xff, 0xd8, 0xff))).toBe(false);
	});
});
