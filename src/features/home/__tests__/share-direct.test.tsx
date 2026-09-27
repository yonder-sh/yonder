/**
 * `/share?url=&text=&title=`: the iOS Shortcut (and ⌘K's "Save this link…")
 * hand a link over in the address, and the share page starts from it.
 */
import { describe, expect, it } from "vitest";
import { directEntry } from "../ShareInbox";

const REEL = "https://www.instagram.com/reel/C9abc123/";

describe("a link handed over in the address", () => {
	it("takes the link, and the caption around it as the text", () => {
		const e = directEntry({ url: REEL, text: `Samoyed Cafe Moffu ${REEL}` });
		expect(e).toMatchObject({
			url: REEL,
			text: "Samoyed Cafe Moffu",
			title: null,
			files: [],
		});
	});

	it("finds the link inside the text when the Shortcut sends only text", () => {
		expect(directEntry({ text: `Watch this ${REEL}` })).toMatchObject({
			url: REEL,
			text: "Watch this",
		});
	});

	it("keeps text with no link, and ignores an empty hand-over", () => {
		expect(directEntry({ text: "Onibus Coffee, Nakameguro" })).toMatchObject({
			url: null,
			text: "Onibus Coffee, Nakameguro",
		});
		expect(directEntry({})).toBeNull();
	});
});
