/**
 * Every untrusted image decode goes through here (SPEC §15.2–§15.3):
 * `sharp(buf, { limitInputPixels: 50e6, failOn: 'error' }).rotate()`, WebP
 * variants with the metadata stripped (sharp drops EXIF unless asked), and a
 * thumbhash from a ≤ 100 px RGBA copy.
 */
import sharp from "sharp";
import { rgbaToThumbHash } from "thumbhash";

const LIMIT = { limitInputPixels: 50e6, failOn: "error" as const };

export type Sized = { width: number; height: number };

/** Base64 thumbhash of an image buffer (auto-oriented). */
export async function thumbhashOf(buf: Buffer): Promise<string> {
	const { data, info } = await sharp(buf, LIMIT)
		.rotate()
		.resize(100, 100, { fit: "inside" })
		.ensureAlpha()
		.raw()
		.toBuffer({ resolveWithObject: true });
	const hash = rgbaToThumbHash(info.width, info.height, data);
	return Buffer.from(hash).toString("base64");
}

/** Width and height as displayed (EXIF orientations 5–8 swap them). */
export async function orientedSize(buf: Buffer): Promise<Sized> {
	const m = await sharp(buf, LIMIT).metadata();
	const w = m.width ?? 0;
	const h = m.height ?? 0;
	return (m.orientation ?? 1) >= 5
		? { width: h, height: w }
		: { width: w, height: h };
}

/** A WebP that fits in `max` × `max` (never enlarged). */
export async function webpInside(
	buf: Buffer,
	max: number,
	quality: number,
): Promise<Buffer> {
	return sharp(buf, LIMIT)
		.rotate()
		.resize(max, max, { fit: "inside", withoutEnlargement: true })
		.webp({ quality })
		.toBuffer();
}

/** Photo upload → thumb (480, q75), display (1920, q80), size and thumbhash. */
export async function photoVariants(
	buf: Buffer,
): Promise<Sized & { thumb: Buffer; display: Buffer; thumbhash: string }> {
	const size = await orientedSize(buf);
	const [thumb, display, thumbhash] = await Promise.all([
		webpInside(buf, 480, 75),
		webpInside(buf, 1920, 80),
		thumbhashOf(buf),
	]);
	return { ...size, thumb, display, thumbhash };
}

/** A poster frame or rendered page → thumb + thumbhash + size. */
export async function thumbFrom(
	buf: Buffer,
): Promise<Sized & { thumb: Buffer; thumbhash: string }> {
	const size = await orientedSize(buf);
	const [thumb, thumbhash] = await Promise.all([
		webpInside(buf, 480, 75),
		thumbhashOf(buf),
	]);
	return { ...size, thumb, thumbhash };
}

const RASTER = new Set(["jpeg", "png", "webp", "gif", "avif", "heif", "tiff"]);

/** Refuses anything that isn't a raster image (untrusted SVG, PDF, …). */
export async function assertRaster(buf: Buffer): Promise<void> {
	const m = await sharp(buf, LIMIT).metadata();
	if (!m.format || !RASTER.has(m.format)) throw new Error("not a raster image");
}

/** A remote preview image (og:image, oEmbed thumbnail) → image.webp (≤ 1200). */
export async function rehostPreview(
	buf: Buffer,
): Promise<Sized & { image: Buffer; thumbhash: string }> {
	await assertRaster(buf);
	const size = await orientedSize(buf);
	if (!size.width || !size.height) throw new Error("not an image");
	const [image, thumbhash] = await Promise.all([
		webpInside(buf, 1200, 80),
		thumbhashOf(buf),
	]);
	return { ...size, image, thumbhash };
}

/**
 * The largest PNG inside an ICO file, or null (BMP-only icons are skipped;
 * sharp can't read ICO itself).
 */
export function pngFromIco(buf: Buffer): Buffer | null {
	if (buf.length < 6 || buf.readUInt16LE(0) !== 0 || buf.readUInt16LE(2) !== 1)
		return null;
	const count = buf.readUInt16LE(4);
	let best: { size: number; data: Buffer } | null = null;
	for (let i = 0; i < Math.min(count, 64); i++) {
		const at = 6 + i * 16;
		if (at + 16 > buf.length) break;
		const w = buf[at] || 256;
		const len = buf.readUInt32LE(at + 8);
		const off = buf.readUInt32LE(at + 12);
		if (off + len > buf.length || len < 8) continue;
		const data = buf.subarray(off, off + len);
		const isPng = data[0] === 0x89 && data[1] === 0x50 && data[2] === 0x4e;
		if (isPng && (!best || w > best.size)) best = { size: w, data };
	}
	return best?.data ?? null;
}

/** A favicon (PNG, ICO with a PNG inside, SVG is refused, anything sharp reads) → 64 px WebP. */
export async function faviconWebp(
	buf: Buffer,
	contentType: string,
): Promise<Buffer | null> {
	if (contentType.includes("svg")) return null; // never rasterize untrusted SVG
	const src =
		contentType.includes("icon") || contentType.includes("ico")
			? pngFromIco(buf)
			: buf;
	if (!src) return null;
	try {
		await assertRaster(src);
		return await sharp(src, LIMIT)
			.resize(64, 64, {
				fit: "contain",
				background: { r: 0, g: 0, b: 0, alpha: 0 },
			})
			.webp({ quality: 85 })
			.toBuffer();
	} catch {
		return null;
	}
}
