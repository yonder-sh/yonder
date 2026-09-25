/**
 * Lossless location removal from photo originals (SECURITY §5 privacy,
 * CONTENT-06). The variants are re-encoded without any metadata; the stored
 * original is what "Download" and the lightbox serve, so it keeps its pixels
 * and every other tag (orientation, date, camera) and loses only its GPS:
 *
 * - EXIF (JPEG APP1 — every one, MPF secondary images included — PNG `eXIf`,
 *   WebP `EXIF`): the GPS IFD's entries and values are zeroed and its pointer
 *   (tag 0x8825) is removed from IFD0/IFD1.
 * - XMP (JPEG APP1, PNG uncompressed `iTXt`, WebP `XMP `): every `*:GPS*`
 *   property is blanked with spaces (the XML stays well-formed).
 *
 * Every edit is in place and keeps the byte length, so no offset or container
 * size moves (PNG chunk CRCs are recomputed). GIF has no EXIF; AVIF is left
 * alone (link guests never get photo originals, see `serveMedia`). Pure;
 * never throws.
 */
import { crc32 } from "node:zlib";

/** Bytes per value of each TIFF field type (index = type). */
const TYPE_SIZE = [0, 1, 1, 2, 4, 8, 1, 1, 2, 4, 8, 4, 8, 4];
const GPS_IFD_TAG = 0x8825;
const EXIF_ID = Buffer.from("Exif\0\0", "latin1");
const XMP_ID = Buffer.from("http://ns.adobe.com/xap/1.0/\0", "latin1");

/**
 * Removes the GPS IFD from a TIFF structure (an EXIF block starting at its
 * `II*\0`/`MM\0*` header), in place. True when something changed.
 */
export function stripTiffGps(t: Buffer): boolean {
	if (t.length < 8) return false;
	const le = t[0] === 0x49 && t[1] === 0x49;
	if (!le && !(t[0] === 0x4d && t[1] === 0x4d)) return false;
	const u16 = (o: number) => (le ? t.readUInt16LE(o) : t.readUInt16BE(o));
	const u32 = (o: number) => (le ? t.readUInt32LE(o) : t.readUInt32BE(o));
	const w16 = (o: number, v: number) =>
		le ? t.writeUInt16LE(v, o) : t.writeUInt16BE(v, o);
	if (u16(2) !== 42) return false;

	const zeroIfd = (off: number) => {
		if (off < 8 || off + 2 > t.length) return;
		const n = u16(off);
		for (let i = 0; i < n; i++) {
			const e = off + 2 + i * 12;
			if (e + 12 > t.length) break;
			const size = (TYPE_SIZE[u16(e + 2)] ?? 1) * u32(e + 4);
			const at = u32(e + 8);
			if (size > 4 && at >= 8 && at + size <= t.length)
				t.fill(0, at, at + size);
		}
		t.fill(0, off, Math.min(t.length, off + 2 + n * 12 + 4));
	};

	let changed = false;
	const seen = new Set<number>();
	let ifd = u32(4);
	// IFD0 (the image) and IFD1 (the EXIF thumbnail); never loops.
	for (let hop = 0; hop < 4 && ifd >= 8 && !seen.has(ifd); hop++) {
		seen.add(ifd);
		if (ifd + 2 > t.length) break;
		let count = u16(ifd);
		if (ifd + 2 + count * 12 + 4 > t.length) break;
		for (let i = 0; i < count; ) {
			const e = ifd + 2 + i * 12;
			if (u16(e) !== GPS_IFD_TAG) {
				i++;
				continue;
			}
			zeroIfd(u32(e + 8));
			// Drop the entry: the later entries and the next-IFD pointer move
			// up 12 bytes; the freed 12 bytes at the end become zeros.
			const end = ifd + 2 + count * 12 + 4;
			t.copyWithin(e, e + 12, end);
			t.fill(0, end - 12, end);
			count--;
			w16(ifd, count);
			changed = true;
		}
		ifd = u32(ifd + 2 + count * 12);
	}
	return changed;
}

const PREFIX = String.raw`[A-Za-z_][\w.-]*:GPS[\w.-]*`;
const XMP_GPS = [
	// <exif:GPSLatitude>35,29.8N</exif:GPSLatitude>
	new RegExp(String.raw`<(${PREFIX})(?:\s[^>]*)?(?<!/)>[\s\S]*?</\1\s*>`, "g"),
	// <exif:GPSLatitude/> or with attributes
	new RegExp(String.raw`<${PREFIX}(?:\s[^>]*)?/>`, "g"),
	// exif:GPSLatitude="35,29.8N"
	new RegExp(String.raw`\s${PREFIX}\s*=\s*(?:"[^"]*"|'[^']*')`, "g"),
];

/** Blanks every `*:GPS*` XMP property with spaces, in place. True when something changed. */
export function blankXmpGps(b: Buffer): boolean {
	const s = b.toString("latin1");
	if (!s.includes(":GPS")) return false;
	let out = s;
	for (const re of XMP_GPS) out = out.replace(re, (m) => " ".repeat(m.length));
	if (out === s) return false;
	b.write(out, 0, "latin1");
	return true;
}

/** Every APP1 segment with `id` after its length: the segment's payload after the id. */
function* app1Payloads(buf: Buffer, id: Buffer): Generator<Buffer> {
	let from = 4;
	for (;;) {
		const at = buf.indexOf(id, from);
		if (at < 0) return;
		from = at + id.length;
		// FF E1 <len hi> <len lo> <id>: in entropy-coded data FF is only ever
		// followed by 00 or a restart marker, so FF E1 is always a real marker.
		if (buf[at - 4] !== 0xff || buf[at - 3] !== 0xe1) continue;
		const end = Math.min(buf.length, at - 2 + buf.readUInt16BE(at - 2));
		if (end > at + id.length) yield buf.subarray(at + id.length, end);
	}
}

function stripJpeg(buf: Buffer): boolean {
	let changed = false;
	for (const tiff of app1Payloads(buf, EXIF_ID))
		changed = stripTiffGps(tiff) || changed;
	for (const xmp of app1Payloads(buf, XMP_ID))
		changed = blankXmpGps(xmp) || changed;
	return changed;
}

/** An EXIF payload that some writers prefix with `Exif\0\0`. */
const tiffOf = (b: Buffer) =>
	b.subarray(0, 6).equals(EXIF_ID) ? b.subarray(6) : b;

function stripPng(buf: Buffer): boolean {
	let changed = false;
	let off = 8;
	while (off + 12 <= buf.length) {
		const len = buf.readUInt32BE(off);
		const type = buf.toString("latin1", off + 4, off + 8);
		const end = off + 8 + len;
		if (end + 4 > buf.length) break;
		const data = buf.subarray(off + 8, end);
		let hit = false;
		if (type === "eXIf") hit = stripTiffGps(tiffOf(data));
		else if (type === "iTXt") {
			// keyword \0 flag method language \0 translated \0 text
			const k = data.indexOf(0);
			if (
				k > 0 &&
				data.toString("latin1", 0, k) === "XML:com.adobe.xmp" &&
				data[k + 1] === 0
			) {
				const lang = data.indexOf(0, k + 3);
				const tr = lang < 0 ? -1 : data.indexOf(0, lang + 1);
				if (tr > 0) hit = blankXmpGps(data.subarray(tr + 1));
			}
		}
		if (hit) {
			buf.writeUInt32BE(crc32(buf.subarray(off + 4, end)) >>> 0, end);
			changed = true;
		}
		if (type === "IEND") break;
		off = end + 4;
	}
	return changed;
}

function stripWebp(buf: Buffer): boolean {
	let changed = false;
	let off = 12;
	while (off + 8 <= buf.length) {
		const type = buf.toString("latin1", off, off + 4);
		const len = buf.readUInt32LE(off + 4);
		const end = off + 8 + len;
		if (end > buf.length) break;
		const data = buf.subarray(off + 8, end);
		if (type === "EXIF") changed = stripTiffGps(tiffOf(data)) || changed;
		else if (type === "XMP ") changed = blankXmpGps(data) || changed;
		off = end + (len & 1);
	}
	return changed;
}

/**
 * Removes location metadata from a photo original of type `mime`, in place
 * (same length). True when the buffer (may have) changed and should be
 * written back.
 */
export function stripGps(buf: Buffer, mime: string): boolean {
	try {
		if (mime === "image/jpeg" && buf[0] === 0xff && buf[1] === 0xd8)
			return stripJpeg(buf);
		if (mime === "image/png" && buf.readUInt32BE(0) === 0x89504e47)
			return stripPng(buf);
		if (
			mime === "image/webp" &&
			buf.toString("latin1", 0, 4) === "RIFF" &&
			buf.toString("latin1", 8, 12) === "WEBP"
		)
			return stripWebp(buf);
	} catch {
		// A malformed file: whatever was edited so far is still well-formed.
		return true;
	}
	return false;
}
