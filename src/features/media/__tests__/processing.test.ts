/**
 * The worker's processing pieces without S3: sharp variants (EXIF
 * orientation, metadata stripped — MED-10), the HEIC assumption (SPEC §15.2),
 * favicons from ICO, PDF pages with poppler (skipped without it), and link
 * previews against a local page through the safe fetch.
 */
import { existsSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
	faviconWebp,
	photoVariants,
	pngFromIco,
	rehostPreview,
} from "../server/images.server";
import { pdftoppmPath, renderPdfPages } from "../server/pdf.server";
import { linkMeta } from "../server/preview.server";
import { createSafeFetch, publicOnly } from "../server/safe-fetch.server";
import { makePdf } from "./make-pdf";

async function jpegWithExif(): Promise<Buffer> {
	// 400×300 landscape pixels tagged "rotate 90° CW" (orientation 6) with GPS.
	return sharp({
		create: {
			width: 400,
			height: 300,
			channels: 3,
			background: { r: 200, g: 60, b: 40 },
		},
	})
		.jpeg()
		.withMetadata({
			orientation: 6,
			exif: { IFD3: { GPSLatitudeRef: "N", GPSLatitude: "35/1 30/1 0/1" } },
		})
		.toBuffer();
}

describe("photo variants", () => {
	it("displays upright, strips EXIF (GPS) and makes a thumbhash", async () => {
		const buf = await jpegWithExif();
		const before = await sharp(buf).metadata();
		expect(before.orientation).toBe(6);
		expect(before.exif).toBeDefined();
		const v = await photoVariants(buf);
		// Orientation 6 swaps the displayed size.
		expect({ w: v.width, h: v.height }).toEqual({ w: 300, h: 400 });
		const thumb = await sharp(v.thumb).metadata();
		expect(thumb.format).toBe("webp");
		expect(thumb.width).toBeLessThan(thumb.height ?? 0);
		expect(thumb.exif).toBeUndefined();
		expect(thumb.orientation).toBeUndefined();
		const display = await sharp(v.display).metadata();
		expect(display.exif).toBeUndefined();
		expect(v.thumbhash.length).toBeGreaterThan(10);
	});

	it("refuses HEIC in the worker (the client converts it; sharp has no HEVC)", async () => {
		// An ISO-BMFF header with the `heic` brand and no decodable image.
		const heic = Buffer.concat([
			Buffer.from([0, 0, 0, 0x18]),
			Buffer.from("ftypheic"),
			Buffer.from([0, 0, 0, 0]),
			Buffer.from("mif1heic"),
		]);
		await expect(photoVariants(heic)).rejects.toThrow();
	});

	it("refuses SVG previews (never rasterize untrusted SVG)", async () => {
		const svg = Buffer.from(
			'<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"/>',
		);
		await expect(rehostPreview(svg)).rejects.toThrow(/raster/);
		expect(await faviconWebp(svg, "image/svg+xml")).toBeNull();
	});

	it("takes the PNG out of an ICO favicon", async () => {
		const png = await sharp({
			create: { width: 32, height: 32, channels: 4, background: "#494fa7" },
		})
			.png()
			.toBuffer();
		const header = Buffer.alloc(6 + 16);
		header.writeUInt16LE(0, 0);
		header.writeUInt16LE(1, 2);
		header.writeUInt16LE(1, 4);
		header[6] = 32;
		header[7] = 32;
		header.writeUInt32LE(png.length, 6 + 8);
		header.writeUInt32LE(22, 6 + 12);
		const ico = Buffer.concat([header, png]);
		expect(pngFromIco(ico)?.equals(png)).toBe(true);
		const webp = await faviconWebp(ico, "image/x-icon");
		expect((await sharp(webp as Buffer).metadata()).width).toBe(64);
	});
});

const poppler = (() => {
	const p = pdftoppmPath();
	return p.includes("/") ? existsSync(p) : false;
})();

describe.skipIf(!poppler)("PDF pages (poppler)", () => {
	it("renders every page, first page portrait", async () => {
		const pdf = makePdf(["E-ticket NH 9", "Baggage", "Conditions"]);
		const r = await renderPdfPages(pdf, { longSide: 800 });
		expect(r.pageCount).toBe(3);
		expect(r.pages).toHaveLength(3);
		const m = await sharp(r.pages[0] as Buffer).metadata();
		expect(m.height).toBe(800);
		expect(m.width).toBeLessThan(800);
	});

	it("caps the rendered pages", async () => {
		const pdf = makePdf(["1", "2", "3", "4", "5"]);
		const r = await renderPdfPages(pdf, { maxPages: 2, longSide: 200 });
		expect(r.pages).toHaveLength(2);
		expect(r.pageCount).toBe(5);
	});

	it("fails on a file that isn't a PDF", async () => {
		await expect(
			renderPdfPages(Buffer.from("%PDF-1.4 nope")),
		).rejects.toThrow();
	});
});

describe("link previews (OpenGraph through the safe fetch)", () => {
	let server: Server;
	let base = "";
	let port = 0;
	beforeAll(async () => {
		server = createServer((req, res) => {
			if (req.url === "/guide") {
				res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
				res.end(`<!doctype html><html><head>
					<title>Fallback title</title>
					<meta property="og:title" content="Mt. Fuji Guide &amp; Tips">
					<meta property="og:description" content="Climbing season,\n  views\u0000 and trains.">
					<meta property="og:site_name" content="japan-guide.com">
					<meta property="og:image" content="/img/fuji.jpg">
					<link rel="icon" href="/favicon.png">
				</head><body>hi</body></html>`);
				return;
			}
			if (req.url === "/doc.pdf") {
				res.writeHead(200, { "content-type": "application/pdf" });
				res.end("%PDF-1.4");
				return;
			}
			res.writeHead(404);
			res.end();
		});
		await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
		port = (server.address() as AddressInfo).port;
		base = `http://127.0.0.1:${port}`;
	});
	afterAll(async () => {
		await new Promise((r) => server.close(r));
	});
	const f = () =>
		createSafeFetch(
			(a) => a === "127.0.0.1" || publicOnly(a),
			["", String(port)],
		);

	it("reads OG tags as clamped plain text and resolves relative URLs", async () => {
		const m = await linkMeta(`${base}/guide`, f(), { cache: false });
		expect(m).toMatchObject({
			ok: true,
			title: "Mt. Fuji Guide & Tips",
			description: "Climbing season, views and trains.",
			siteName: "japan-guide.com",
			imageUrl: `${base}/img/fuji.jpg`,
			faviconUrl: `${base}/favicon.png`,
		});
	});

	it("names a linked PDF after its file", async () => {
		const m = await linkMeta(`${base}/doc.pdf`, f(), { cache: false });
		expect(m).toMatchObject({ ok: true, title: "doc.pdf" });
	});

	it("never throws: a blocked or failed fetch is `ok: false`", async () => {
		expect(
			await linkMeta("http://127.0.0.1:9/x", undefined, { cache: false }),
		).toMatchObject({
			ok: false,
		});
		expect(
			await linkMeta(`${base}/missing`, f(), { cache: false }),
		).toMatchObject({ ok: false });
	});

	it("YouTube and TikTok use oEmbed JSON (stubbed fetcher)", async () => {
		const stub = async (url: string) => {
			const json = url.includes("youtube.com/oembed")
				? {
						title: "Fuji Excursion ride",
						author_name: "Rail Fan",
						thumbnail_url: "https://i.ytimg.com/vi/abcdefghijk/hqdefault.jpg",
					}
				: {
						title: "Golden Gai",
						author_name: "nightowl",
						thumbnail_url: "https://p16.tiktokcdn.com/x.jpg",
						embed_product_id: "7300000000000000001",
					};
			return {
				status: 200,
				headers: {},
				finalUrl: url,
				contentType: "application/json",
				body: Buffer.from(JSON.stringify(json)),
			};
		};
		expect(
			await linkMeta("https://youtu.be/abcdefghijk", stub, { cache: false }),
		).toMatchObject({
			ok: true,
			title: "Fuji Excursion ride",
			author: "Rail Fan",
			embedId: "abcdefghijk",
			siteName: "YouTube",
		});
		expect(
			await linkMeta(
				"https://www.tiktok.com/@nightowl/video/7300000000000000001",
				stub,
				{ cache: false },
			),
		).toMatchObject({
			ok: true,
			author: "nightowl",
			embedId: "7300000000000000001",
			imageUrl: "https://p16.tiktokcdn.com/x.jpg",
		});
	});
});
