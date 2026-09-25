/**
 * Share card PNGs (docs/OVERVIEW.md §Sharing): the card's SVG
 * (`buildShareCardSvg`) rasterised by resvg with the bundled OFL fonts
 * (Parkinsans 700, Commissioner 400/600/700, Atkinson Hyperlegible Mono 400;
 * licences next to them in `../fonts`).
 *
 * The fonts are inlined into the server bundle (`?inline`), so the built
 * server needs no font files next to it: resvg-js only loads fonts from
 * paths, so on first use they're written once to a content-addressed
 * directory under the OS temp dir. resvg's native binary is a traced
 * external package (Nitro copies `@resvg/resvg-js` and its platform build
 * into `.output/server/node_modules`). System fonts are never loaded: the
 * picture is the same on every host.
 */
import { createHash } from "node:crypto";
import { mkdirSync, renameSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
	buildShareCardSvg,
	CARD_SIZES,
	type CardSize,
	type ShareCardData,
} from "../card/card-svg";
import {
	type CardFont,
	createMeasurer,
	type Measurer,
	readFontMetrics,
} from "../card/metrics";
import mono400 from "../fonts/AtkinsonHyperlegibleMono-400.ttf?inline";
import commissioner400 from "../fonts/Commissioner-400.ttf?inline";
import commissioner600 from "../fonts/Commissioner-600.ttf?inline";
import commissioner700 from "../fonts/Commissioner-700.ttf?inline";
import parkinsans700 from "../fonts/Parkinsans-700.ttf?inline";

const FONT_DATA: Record<CardFont, string> = {
	display: parkinsans700,
	text: commissioner400,
	textSemi: commissioner600,
	textBold: commissioner700,
	mono: mono400,
};

const bytesOf = (dataUrl: string) =>
	Buffer.from(dataUrl.slice(dataUrl.indexOf(",") + 1), "base64");

let fonts: { measurer: Measurer; files: string[] } | null = null;

/** Parsed metrics and on-disk copies of the card's fonts (once per process). */
export function cardFonts(): { measurer: Measurer; files: string[] } {
	if (fonts) return fonts;
	const bytes = Object.fromEntries(
		(Object.keys(FONT_DATA) as CardFont[]).map((k) => [
			k,
			bytesOf(FONT_DATA[k]),
		]),
	) as Record<CardFont, Buffer>;
	const hash = createHash("sha256");
	for (const k of Object.keys(bytes).sort()) hash.update(bytes[k as CardFont]);
	const dir = path.join(
		tmpdir(),
		`yonder-card-fonts-${hash.digest("hex").slice(0, 12)}`,
	);
	mkdirSync(dir, { recursive: true });
	const files = (Object.keys(bytes) as CardFont[]).map((k) => {
		const file = path.join(dir, `${k}.ttf`);
		let ok = false;
		try {
			ok = statSync(file).size === bytes[k].length;
		} catch {}
		if (!ok) {
			const tmp = `${file}.${process.pid}.${Date.now()}`;
			writeFileSync(tmp, bytes[k]);
			renameSync(tmp, file);
		}
		return file;
	});
	const metrics = Object.fromEntries(
		(Object.keys(bytes) as CardFont[]).map((k) => [
			k,
			readFontMetrics(bytes[k]),
		]),
	) as Record<CardFont, ReturnType<typeof readFontMetrics>>;
	fonts = { measurer: createMeasurer(metrics), files };
	return fonts;
}

export function shareCardSvg(data: ShareCardData, size: CardSize): string {
	return buildShareCardSvg(data, size, cardFonts().measurer);
}

export async function renderShareCardPng(
	data: ShareCardData,
	size: CardSize,
): Promise<Buffer> {
	const { files } = cardFonts();
	const svg = shareCardSvg(data, size);
	const { renderAsync } = await import("@resvg/resvg-js");
	const image = await renderAsync(svg, {
		font: {
			loadSystemFonts: false,
			fontFiles: files,
			defaultFontFamily: "Commissioner",
		},
		fitTo: { mode: "width", value: CARD_SIZES[size].width },
		shapeRendering: 2,
		textRendering: 1,
		logLevel: "off",
	});
	return image.asPng();
}
