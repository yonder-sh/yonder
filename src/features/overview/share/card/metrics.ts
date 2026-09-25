/**
 * Text measurement for the share card, from the same TTF files resvg draws
 * with: advance widths (`hmtx` through `cmap`), plus the vertical metrics the
 * layout needs. No kerning (resvg applies it, so real text comes out a hair
 * narrower than measured: fitting stays on the safe side). Pure: font bytes in.
 */

export type CardFont = "display" | "text" | "textSemi" | "textBold" | "mono";

/** The family and weight each role is drawn with (`font-family` / `font-weight` in the SVG). */
export const CARD_FONTS: Record<CardFont, { family: string; weight: number }> =
	{
		display: { family: "Parkinsans", weight: 700 },
		text: { family: "Commissioner", weight: 400 },
		textSemi: { family: "Commissioner", weight: 600 },
		textBold: { family: "Commissioner", weight: 700 },
		mono: { family: "Atkinson Hyperlegible Mono", weight: 400 },
	};

export interface FontMetrics {
	unitsPerEm: number;
	/** hhea ascender / descender (descender negative), in font units. */
	ascender: number;
	descender: number;
	lineGap: number;
	capHeight: number;
	advance(codePoint: number): number;
}

export interface Measurer {
	/** Width of `text` at `size` px, with `letterSpacing` px after every character (as CSS does). */
	width(
		font: CardFont,
		size: number,
		text: string,
		letterSpacing?: number,
	): number;
	/** Cap height at `size` px (to centre a line of capitals on a point). */
	capHeight(font: CardFont, size: number): number;
	/** Ascent of the CSS `line-height: normal` box at `size` px. */
	ascent(font: CardFont, size: number): number;
	/** Height of the CSS `line-height: normal` box at `size` px. */
	lineHeight(font: CardFont, size: number): number;
}

function tables(
	view: DataView,
): Map<string, { offset: number; length: number }> {
	const out = new Map<string, { offset: number; length: number }>();
	const n = view.getUint16(4);
	for (let i = 0; i < n; i++) {
		const rec = 12 + 16 * i;
		const tag = String.fromCharCode(
			view.getUint8(rec),
			view.getUint8(rec + 1),
			view.getUint8(rec + 2),
			view.getUint8(rec + 3),
		);
		out.set(tag, {
			offset: view.getUint32(rec + 8),
			length: view.getUint32(rec + 12),
		});
	}
	return out;
}

/** Code point → glyph id from the best Unicode `cmap` subtable (format 12, else 4). */
function readCmap(view: DataView, at: number): (cp: number) => number {
	const count = view.getUint16(at + 2);
	let f4 = -1;
	let f12 = -1;
	for (let i = 0; i < count; i++) {
		const rec = at + 4 + 8 * i;
		const platform = view.getUint16(rec);
		const encoding = view.getUint16(rec + 2);
		const sub = at + view.getUint32(rec + 4);
		const format = view.getUint16(sub);
		const unicode =
			platform === 0 || (platform === 3 && (encoding === 1 || encoding === 10));
		if (!unicode) continue;
		if (format === 12 && f12 < 0) f12 = sub;
		if (format === 4 && f4 < 0) f4 = sub;
	}
	if (f12 >= 0) {
		const groups = view.getUint32(f12 + 12);
		return (cp) => {
			let lo = 0;
			let hi = groups - 1;
			while (lo <= hi) {
				const mid = (lo + hi) >> 1;
				const g = f12 + 16 + 12 * mid;
				const start = view.getUint32(g);
				const end = view.getUint32(g + 4);
				if (cp < start) hi = mid - 1;
				else if (cp > end) lo = mid + 1;
				else return view.getUint32(g + 8) + (cp - start);
			}
			return 0;
		};
	}
	if (f4 < 0) return () => 0;
	const segX2 = view.getUint16(f4 + 6);
	const ends = f4 + 14;
	const starts = ends + segX2 + 2;
	const deltas = starts + segX2;
	const ranges = deltas + segX2;
	return (cp) => {
		if (cp > 0xffff) return 0;
		for (let s = 0; s < segX2; s += 2) {
			if (view.getUint16(ends + s) < cp) continue;
			const start = view.getUint16(starts + s);
			if (start > cp) return 0;
			const delta = view.getInt16(deltas + s);
			const range = view.getUint16(ranges + s);
			if (range === 0) return (cp + delta) & 0xffff;
			const gi = view.getUint16(ranges + s + range + 2 * (cp - start));
			return gi === 0 ? 0 : (gi + delta) & 0xffff;
		}
		return 0;
	};
}

/** Reads the metrics of a TrueType/OpenType font file. */
export function readFontMetrics(bytes: Uint8Array): FontMetrics {
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	const t = tables(view);
	const head = t.get("head");
	const hhea = t.get("hhea");
	const hmtx = t.get("hmtx");
	const cmap = t.get("cmap");
	const os2 = t.get("OS/2");
	if (!head || !hhea || !hmtx || !cmap) throw new Error("not a TrueType font");
	const unitsPerEm = view.getUint16(head.offset + 18);
	const ascender = view.getInt16(hhea.offset + 4);
	const descender = view.getInt16(hhea.offset + 6);
	const lineGap = view.getInt16(hhea.offset + 8);
	const hMetrics = view.getUint16(hhea.offset + 34);
	const capHeight =
		os2 && view.getUint16(os2.offset) >= 2
			? view.getInt16(os2.offset + 88)
			: Math.round(unitsPerEm * 0.7);
	const glyph = readCmap(view, cmap.offset);
	const cache = new Map<number, number>();
	const adv = (gid: number) =>
		view.getUint16(hmtx.offset + 4 * Math.min(gid, hMetrics - 1));
	return {
		unitsPerEm,
		ascender,
		descender,
		lineGap,
		capHeight,
		advance(cp) {
			let w = cache.get(cp);
			if (w === undefined) {
				w = adv(glyph(cp));
				cache.set(cp, w);
			}
			return w;
		},
	};
}

export function createMeasurer(fonts: Record<CardFont, FontMetrics>): Measurer {
	return {
		width(font, size, text, letterSpacing = 0) {
			const m = fonts[font];
			let units = 0;
			let n = 0;
			for (const ch of text) {
				units += m.advance(ch.codePointAt(0) ?? 32);
				n++;
			}
			return (units / m.unitsPerEm) * size + n * letterSpacing;
		},
		capHeight: (font, size) =>
			(fonts[font].capHeight / fonts[font].unitsPerEm) * size,
		ascent(font, size) {
			const m = fonts[font];
			return ((m.ascender + m.lineGap / 2) / m.unitsPerEm) * size;
		},
		lineHeight(font, size) {
			const m = fonts[font];
			return ((m.ascender - m.descender + m.lineGap) / m.unitsPerEm) * size;
		},
	};
}
