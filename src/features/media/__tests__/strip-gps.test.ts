/**
 * CONTENT-06 / SECURITY §5 privacy: the stored photo original loses its GPS
 * (EXIF and XMP) losslessly — same length, same pixels, orientation and the
 * other tags kept — and VIS-16: preview text decodes character references.
 */
import exifr from "exifr";
import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { decodeEntities } from "../server/entities";
import { cleanText } from "../server/preview.server";
import { blankXmpGps, stripGps, stripTiffGps } from "../server/strip-gps";

/** Chureito Pagoda, as the QA fixture: 35°29'50"N 138°48'3"E, orientation 6. */
const META = {
	orientation: 6,
	exif: {
		IFD0: { Make: "QA Camera" },
		IFD3: {
			GPSLatitudeRef: "N",
			GPSLatitude: "35/1 29/1 50/1",
			GPSLongitudeRef: "E",
			GPSLongitude: "138/1 48/1 3/1",
		},
	},
};

const photo = (fmt: "jpeg" | "png" | "webp") =>
	sharp({
		create: {
			width: 40,
			height: 30,
			channels: 3,
			background: { r: 200, g: 60, b: 40 },
		},
	})
		[fmt]()
		.withMetadata(META)
		.toBuffer();

/** The EXIF block sharp reports, parsed (WebP isn't an exifr format; its TIFF is). */
async function exifOf(buf: Buffer) {
	const exif = (await sharp(buf).metadata()).exif;
	if (!exif) return null;
	const tiff =
		exif.subarray(0, 6).toString("latin1") === "Exif\0\0"
			? exif.subarray(6)
			: exif;
	return (await exifr.parse(tiff, { gps: true, tiff: true, ifd0: {} })) as
		| {
				latitude?: number;
				longitude?: number;
				Make?: string;
				Orientation?: unknown;
		  }
		| undefined;
}

const pixels = (buf: Buffer) => sharp(buf).raw().toBuffer();

describe("stripGps (CONTENT-06)", () => {
	for (const fmt of ["jpeg", "png", "webp"] as const) {
		it(`${fmt}: GPS goes, the length, pixels, orientation and other tags stay`, async () => {
			const buf = await photo(fmt);
			const before = await exifOf(buf);
			expect(before?.latitude).toBeCloseTo(35.4972, 3);
			expect(before?.longitude).toBeCloseTo(138.8008, 3);
			const copy = Buffer.from(buf);
			expect(stripGps(copy, `image/${fmt}`)).toBe(true);
			expect(copy.length).toBe(buf.length);
			const after = await exifOf(copy);
			expect(after?.latitude).toBeUndefined();
			expect(after?.longitude).toBeUndefined();
			expect(after?.Make).toBe("QA Camera");
			expect((await sharp(copy).metadata()).orientation).toBe(6);
			expect((await pixels(copy)).equals(await pixels(buf))).toBe(true);
			// Idempotent: a second pass finds nothing left.
			expect(stripGps(copy, `image/${fmt}`)).toBe(false);
		});
	}

	it("the JPEG no longer holds the GPS IFD pointer (what the QA spec greps for)", async () => {
		const buf = await photo("jpeg");
		// SOI, then the EXIF APP1 segment.
		expect([buf[2], buf[3]]).toEqual([0xff, 0xe1]);
		const app1End = 4 + buf.readUInt16BE(4);
		const hasPointer = (b: Buffer) =>
			b.subarray(0, app1End).includes(Buffer.from([0x25, 0x88])) ||
			b.subarray(0, app1End).includes(Buffer.from([0x88, 0x25]));
		expect(hasPointer(buf)).toBe(true);
		stripGps(buf, "image/jpeg");
		expect(hasPointer(buf)).toBe(false);
		const all = await exifr.parse(buf, true);
		expect(Object.keys(all ?? {}).some((k) => k.startsWith("GPS"))).toBe(false);
	});

	it("big-endian TIFF: drops the pointer from IFD0 and zeroes the GPS IFD", () => {
		// MM, IFD0 at 8 with two entries (Make→ASCII inline "QA\0", GPSInfo→38),
		// no next IFD; GPS IFD at 38 with one RATIONAL×3 entry at 56.
		const t = Buffer.alloc(80);
		t.write("MM", 0, "latin1");
		t.writeUInt16BE(42, 2);
		t.writeUInt32BE(8, 4);
		t.writeUInt16BE(2, 8);
		t.writeUInt16BE(0x010f, 10); // Make
		t.writeUInt16BE(2, 12);
		t.writeUInt32BE(3, 14);
		t.write("QA\0", 18, "latin1");
		t.writeUInt16BE(0x8825, 22); // GPSInfo
		t.writeUInt16BE(4, 24);
		t.writeUInt32BE(1, 26);
		t.writeUInt32BE(38, 30);
		t.writeUInt32BE(0, 34); // next IFD
		t.writeUInt16BE(1, 38);
		t.writeUInt16BE(0x0002, 40); // GPSLatitude
		t.writeUInt16BE(5, 42);
		t.writeUInt32BE(3, 44);
		t.writeUInt32BE(56, 48);
		for (let i = 0; i < 6; i++) t.writeUInt32BE(35 + i, 56 + i * 4);
		expect(stripTiffGps(t)).toBe(true);
		expect(t.readUInt16BE(8)).toBe(1);
		expect(t.readUInt16BE(10)).toBe(0x010f);
		expect(t.toString("latin1", 18, 20)).toBe("QA");
		expect(t.readUInt32BE(22)).toBe(0); // the old next-IFD slot moved up
		expect(t.subarray(38).every((b) => b === 0)).toBe(true);
	});

	it("blanks XMP GPS properties in place (elements and attributes)", () => {
		const xmp = `<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF><rdf:Description exif:GPSLatitude="35,29.8333N" exif:DateTimeOriginal="2027-10-20T06:00:00">
<exif:GPSLongitude>138,48.05E</exif:GPSLongitude><exif:GPSVersionID/><dc:title>Chureito</dc:title></rdf:Description></rdf:RDF></x:xmpmeta>`;
		const b = Buffer.from(xmp, "latin1");
		expect(blankXmpGps(b)).toBe(true);
		const s = b.toString("latin1");
		expect(s.length).toBe(xmp.length);
		expect(s).not.toMatch(/GPS|35,29|138,48/);
		expect(s).toContain('exif:DateTimeOriginal="2027-10-20T06:00:00"');
		expect(s).toContain("<dc:title>Chureito</dc:title>");
	});

	it("leaves other types and files without GPS alone; never throws on junk", async () => {
		const plain = await sharp({
			create: { width: 8, height: 8, channels: 3, background: "#123" },
		})
			.jpeg()
			.toBuffer();
		expect(stripGps(Buffer.from(plain), "image/jpeg")).toBe(false);
		expect(stripGps(Buffer.from("GIF89a...."), "image/gif")).toBe(false);
		const junk = Buffer.from([
			0xff,
			0xd8,
			0xff,
			0xe1,
			0xff,
			0xff,
			...Buffer.from("Exif\0\0MM\0*\xff\xff\xff\xff", "latin1"),
		]);
		expect(() => stripGps(junk, "image/jpeg")).not.toThrow();
	});
});

describe("preview text (VIS-16)", () => {
	it("decodes character references once", () => {
		expect(
			decodeEntities(
				"We&#039;ve got you covered when it comes to Kappabashi knife shopping &mdash; from the best stores&hellip;",
			),
		).toBe(
			"We've got you covered when it comes to Kappabashi knife shopping — from the best stores…",
		);
		expect(
			decodeEntities("Tom &amp; Jerry &#x27;s &eacute;t&eacute; &euro;5"),
		).toBe("Tom & Jerry 's été €5");
		// Once only, unknown names and non-characters stay as written.
		expect(
			decodeEntities("&amp;mdash; &bogus; &constructor; &#0; &#xD800;"),
		).toBe("&mdash; &bogus; &constructor; &#0; &#xD800;");
		expect(decodeEntities(null)).toBeNull();
	});

	it("cleanText decodes, then strips control characters and collapses whitespace", () => {
		expect(cleanText("A&nbsp;&nbsp;B &#1; C&lt;br&gt;", 100)).toBe(
			"A B &#1; C<br>",
		);
		expect(cleanText("We&#039;ve", 100)).toBe("We've");
	});
});
