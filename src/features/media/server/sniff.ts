/**
 * Magic-byte checks for finished uploads (SECURITY §5 "the finalize step
 * verifies … a magic-byte decode"): the stored bytes must be what the
 * declared (and signed) content type says. Pure; tested in `sniff.test.ts`.
 */

const ascii = (b: Uint8Array, at: number, s: string) =>
	s.split("").every((c, i) => b[at + i] === c.charCodeAt(0));

/** The ISO-BMFF brand at offset 8 when bytes 4–7 are `ftyp`. */
function ftypBrand(b: Uint8Array): string | null {
	if (b.length < 12 || !ascii(b, 4, "ftyp")) return null;
	return String.fromCharCode(...b.slice(8, 12));
}

/** True when `head` (the first bytes of the object) matches `mime`. */
export function sniffMatches(mime: string, head: Uint8Array): boolean {
	const b = head;
	switch (mime) {
		case "image/jpeg":
			return b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff;
		case "image/png":
			return (
				b[0] === 0x89 && ascii(b, 1, "PNG") && b[4] === 0x0d && b[5] === 0x0a
			);
		case "image/gif":
			return ascii(b, 0, "GIF87a") || ascii(b, 0, "GIF89a");
		case "image/webp":
			return ascii(b, 0, "RIFF") && ascii(b, 8, "WEBP");
		case "image/avif": {
			const brand = ftypBrand(b);
			return brand === "avif" || brand === "avis" || brand === "mif1";
		}
		case "video/mp4":
		case "video/quicktime": {
			// MP4 and MOV share ISO-BMFF; old QuickTime files may start with a `moov`/`mdat`/`wide` atom.
			if (ftypBrand(b)) return true;
			return (
				b.length >= 8 &&
				(ascii(b, 4, "moov") ||
					ascii(b, 4, "mdat") ||
					ascii(b, 4, "wide") ||
					ascii(b, 4, "free"))
			);
		}
		case "video/webm":
			return b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3;
		case "application/pdf": {
			// `%PDF-` must appear within the first 1 KB; we read 64 bytes, and
			// real-world files put it at 0 (a BOM or junk before it is rare).
			const s = String.fromCharCode(...b.slice(0, Math.min(b.length, 64)));
			return s.includes("%PDF-");
		}
		default:
			return false;
	}
}
