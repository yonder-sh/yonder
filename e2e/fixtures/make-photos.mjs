/**
 * Regenerates the photo fixtures of the media specs (qa-content-16, qa-content-25):
 *   chureito-sunrise.jpg  1200×800 pixels stored sideways with EXIF Orientation 6
 *                         (upright it is portrait) and GPS at Chureito Pagoda;
 *                         the app must rotate it and strip the GPS from derivatives.
 *   golden-gai-alley.png  a plain PNG (no EXIF).
 * Run from the repo root (sharp is an app dependency):
 *   nix shell nixpkgs#nodejs_22 -c node e2e/fixtures/make-photos.mjs
 */
import { writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const here = path.dirname(fileURLToPath(import.meta.url));

/** A little-endian TIFF block for an EXIF APP1: IFD0 (Make, Orientation, GPS pointer) + GPS IFD. */
function exifTiff({ make, orientation, lat, lng }) {
	const dms = (v) => {
		const a = Math.abs(v);
		const d = Math.floor(a);
		const m = Math.floor((a - d) * 60);
		const s = Math.round(((a - d) * 60 - m) * 60 * 100);
		return [
			[d, 1],
			[m, 1],
			[s, 100],
		];
	};
	const buf = Buffer.alloc(512);
	let end = 8;
	const alloc = (n) => {
		const at = end;
		end += n + (n % 2);
		return at;
	};
	buf.write("II", 0, "ascii");
	buf.writeUInt16LE(42, 2);
	buf.writeUInt32LE(8, 4);
	const ifd = (entries) => {
		const at = alloc(2 + entries.length * 12 + 4);
		buf.writeUInt16LE(entries.length, at);
		entries.forEach((e, i) => {
			const p = at + 2 + i * 12;
			buf.writeUInt16LE(e.tag, p);
			buf.writeUInt16LE(e.type, p + 2);
			buf.writeUInt32LE(e.count, p + 4);
			e.write(p + 8);
		});
		buf.writeUInt32LE(0, at + 2 + entries.length * 12);
		return at;
	};
	const ascii = (tag, s) => ({
		tag,
		type: 2,
		count: s.length + 1,
		write: (p) => {
			if (s.length + 1 <= 4) buf.write(`${s}\0`, p, "ascii");
			else {
				const at = alloc(s.length + 1);
				buf.write(`${s}\0`, at, "ascii");
				buf.writeUInt32LE(at, p);
			}
		},
	});
	const rationals = (tag, parts) => ({
		tag,
		type: 5,
		count: parts.length,
		write: (p) => {
			const at = alloc(parts.length * 8);
			parts.forEach(([n, d], i) => {
				buf.writeUInt32LE(n, at + i * 8);
				buf.writeUInt32LE(d, at + i * 8 + 4);
			});
			buf.writeUInt32LE(at, p);
		},
	});
	let gpsPointer = 0;
	ifd([
		ascii(0x010f, make),
		{ tag: 0x0112, type: 3, count: 1, write: (p) => buf.writeUInt16LE(orientation, p) },
		{ tag: 0x8825, type: 4, count: 1, write: (p) => (gpsPointer = p) },
	]);
	const gps = ifd([
		{ tag: 0x0000, type: 1, count: 4, write: (p) => buf.set([2, 3, 0, 0], p) },
		ascii(0x0001, lat >= 0 ? "N" : "S"),
		rationals(0x0002, dms(lat)),
		ascii(0x0003, lng >= 0 ? "E" : "W"),
		rationals(0x0004, dms(lng)),
	]);
	buf.writeUInt32LE(gps, gpsPointer);
	return buf.subarray(0, end);
}

/** Inserts an EXIF APP1 after the JFIF APP0 of a baseline JPEG. */
function withExif(jpeg, tiff) {
	const body = Buffer.concat([Buffer.from("Exif\0\0", "binary"), tiff]);
	const app1 = Buffer.alloc(4);
	app1.writeUInt16BE(0xffe1, 0);
	app1.writeUInt16BE(body.length + 2, 2);
	let at = 2;
	if (jpeg.readUInt16BE(2) === 0xffe0) at = 4 + jpeg.readUInt16BE(4);
	return Buffer.concat([jpeg.subarray(0, at), app1, body, jpeg.subarray(at)]);
}

// Sideways: the sky is on the right (Orientation 6 = rotate 90° clockwise to view).
const sunrise = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="800">
	<defs><linearGradient id="sky" x1="1" y1="0" x2="0" y2="0">
		<stop offset="0" stop-color="#f6a55a"/><stop offset="0.55" stop-color="#f7d9a8"/><stop offset="1" stop-color="#4c6b8a"/>
	</linearGradient></defs>
	<rect width="1200" height="800" fill="url(#sky)"/>
	<polygon points="700,150 700,650 430,400" fill="#e9eef2"/>
	<rect x="160" y="330" width="300" height="140" fill="#b3261e"/>
	<rect x="140" y="310" width="30" height="180" fill="#6b1a14"/>
	<rect x="0" y="0" width="160" height="800" fill="#2f4a2a"/>
</svg>`);
const jpeg = await sharp(sunrise).jpeg({ quality: 82 }).toBuffer();
const tiff = exifTiff({ make: "Yonder QA", orientation: 6, lat: 35.50111, lng: 138.80139 });
writeFileSync(path.join(here, "chureito-sunrise.jpg"), withExif(jpeg, tiff));

const alley = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="900" height="600">
	<rect width="900" height="600" fill="#1d1b2e"/>
	<rect x="0" y="0" width="260" height="600" fill="#3a2d4f"/><rect x="640" y="0" width="260" height="600" fill="#34304a"/>
	<rect x="300" y="80" width="80" height="40" fill="#ff5d73"/><rect x="520" y="140" width="70" height="36" fill="#ffd166"/>
	<rect x="260" y="520" width="380" height="80" fill="#4b4453"/>
</svg>`);
writeFileSync(path.join(here, "golden-gai-alley.png"), await sharp(alley).png().toBuffer());
console.log("wrote chureito-sunrise.jpg and golden-gai-alley.png");
