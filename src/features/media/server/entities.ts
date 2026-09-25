/**
 * HTML character references in fetched preview text (VIS-16). The scraper
 * already decodes an attribute once, but many sites (WordPress/Yoast among
 * them) encode their meta tags twice, so `We&amp;#039;ve` arrives as
 * `We&#039;ve`. One more pass, and only one, turns that into `We've`.
 * Numeric references and the common named ones (HTML 4 plus a few HTML 5
 * typography names) are decoded; anything unknown is left as written. Pure.
 */

/** HTML 4's Latin-1 names for U+00A0…U+00FF, in code-point order. */
const LATIN1 =
	"nbsp iexcl cent pound curren yen brvbar sect uml copy ordf laquo not shy reg macr deg plusmn sup2 sup3 acute micro para middot cedil sup1 ordm raquo frac14 frac12 frac34 iquest Agrave Aacute Acirc Atilde Auml Aring AElig Ccedil Egrave Eacute Ecirc Euml Igrave Iacute Icirc Iuml ETH Ntilde Ograve Oacute Ocirc Otilde Ouml times Oslash Ugrave Uacute Ucirc Uuml Yacute THORN szlig agrave aacute acirc atilde auml aring aelig ccedil egrave eacute ecirc euml igrave iacute icirc iuml eth ntilde ograve oacute ocirc otilde ouml divide oslash ugrave uacute ucirc uuml yacute thorn yuml".split(
		" ",
	);

const NAMED_LIST: Record<string, number> = {
	amp: 38,
	lt: 60,
	gt: 62,
	quot: 34,
	apos: 39,
	OElig: 338,
	oelig: 339,
	Scaron: 352,
	scaron: 353,
	Yuml: 376,
	fnof: 402,
	circ: 710,
	tilde: 732,
	ensp: 8194,
	emsp: 8195,
	thinsp: 8201,
	ndash: 8211,
	mdash: 8212,
	horbar: 8213,
	lsquo: 8216,
	rsquo: 8217,
	sbquo: 8218,
	ldquo: 8220,
	rdquo: 8221,
	bdquo: 8222,
	dagger: 8224,
	Dagger: 8225,
	bull: 8226,
	hellip: 8230,
	permil: 8240,
	prime: 8242,
	Prime: 8243,
	lsaquo: 8249,
	rsaquo: 8250,
	oline: 8254,
	euro: 8364,
	trade: 8482,
	larr: 8592,
	uarr: 8593,
	rarr: 8594,
	darr: 8595,
	harr: 8596,
	minus: 8722,
	star: 9734,
	starf: 9733,
	hearts: 9829,
	check: 10003,
};
/** Own names only (a lookup must never reach `Object.prototype`). */
const NAMED = new Map<string, number>([
	...Object.entries(NAMED_LIST),
	...LATIN1.map((name, i) => [name, 0xa0 + i] as [string, number]),
]);

const REF =
	/&(?:#(\d{1,7})|#[xX]([0-9a-fA-F]{1,6})|([A-Za-z][A-Za-z0-9]{1,31}));/g;

function fromCodePoint(cp: number, raw: string): string {
	// Control characters, surrogates and out-of-range values stay as written.
	if (
		cp < 0x20 ||
		(cp >= 0x7f && cp <= 0x9f) ||
		(cp >= 0xd800 && cp <= 0xdfff) ||
		cp > 0x10ffff
	)
		return raw;
	return String.fromCodePoint(cp);
}

/** Decodes character references once (`&#039;` → `'`, `&mdash;` → `—`). */
export function decodeEntities(s: string): string;
export function decodeEntities(s: string | null): string | null;
export function decodeEntities(s: string | null): string | null {
	if (!s?.includes("&")) return s;
	return s.replace(REF, (raw, dec?: string, hex?: string, name?: string) => {
		if (dec) return fromCodePoint(Number.parseInt(dec, 10), raw);
		if (hex) return fromCodePoint(Number.parseInt(hex, 16), raw);
		const cp = name ? NAMED.get(name) : undefined;
		return cp ? String.fromCodePoint(cp) : raw;
	});
}
