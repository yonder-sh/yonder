import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { EXAMPLES, exampleGraph } from "../card/__fixtures__/examples";
import { shareCardData } from "../card/card-data";
import { CARD_SIZES, type CardSize } from "../card/card-svg";
import { renderShareCardPng, shareCardSvg } from "./render.server";

/** Width and height from a PNG's IHDR chunk. */
function pngSize(png: Buffer): { width: number; height: number } {
	expect(png.subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");
	expect(png.subarray(12, 16).toString("ascii")).toBe("IHDR");
	return { width: png.readUInt32BE(16), height: png.readUInt32BE(20) };
}

describe("renderShareCardPng", () => {
	const data = shareCardData(exampleGraph(EXAMPLES["asia-2027"]));
	for (const size of ["story", "square"] as CardSize[])
		it(`renders a ${size} PNG at ${CARD_SIZES[size].width}×${CARD_SIZES[size].height}`, async () => {
			const png = await renderShareCardPng(data, size);
			expect(pngSize(png)).toEqual(CARD_SIZES[size]);
			// A real picture, not an empty canvas.
			expect(png.length).toBeGreaterThan(60_000);
		}, 20_000);
});

// SHARE_SHOTS=1 writes every example card to .data/share-shots/ to look at.
describe.runIf(process.env.SHARE_SHOTS)("share shots", () => {
	it("writes the example cards", async () => {
		const out = path.resolve(".data/share-shots");
		mkdirSync(out, { recursive: true });
		for (const [name, trip] of Object.entries(EXAMPLES)) {
			const data = shareCardData(exampleGraph(trip));
			for (const size of ["story", "square"] as CardSize[]) {
				writeFileSync(
					path.join(out, `${name}-${size}.png`),
					await renderShareCardPng(data, size),
				);
				writeFileSync(
					path.join(out, `${name}-${size}.svg`),
					shareCardSvg(data, size),
				);
			}
		}
	}, 120_000);
});
