/**
 * Text helpers for the sheet import: cell text + its links → Markdown,
 * name normalisation for matching, link labels. Pure.
 */

/** The same name typed twice matches: NFC, case-folded, spaces collapsed. */
export function normName(s: string): string {
	return s.normalize("NFC").toLocaleLowerCase("en").replace(/\s+/g, " ").trim();
}

/**
 * Escapes the inline Markdown characters a sheet note uses literally
 * ("~¥30k" is not strikethrough, "*" is not emphasis). Line-leading list
 * markers are kept: "1. …" and "• …" in the sheet ARE lists.
 */
export function escapeInline(s: string): string {
	return s.replace(/([\\`*_~[\]<>|])/g, "\\$1");
}

/** A sheet bullet ("• ") becomes a Markdown list item. */
function lineMarkers(s: string): string {
	return s
		.split("\n")
		.map((line) => line.replace(/^\s*•\s+/, "- "))
		.join("\n");
}

/** `https://www.japan-guide.com/e/e3020.html` → `japan-guide.com`; null for a bad URL. */
export function hostOf(url: string): string | null {
	try {
		return new URL(url).hostname.replace(/^www\./, "");
	} catch {
		return null;
	}
}

export function isHttpUrl(url: string | null | undefined): url is string {
	if (!url) return false;
	try {
		const u = new URL(url);
		return u.protocol === "http:" || u.protocol === "https:";
	} catch {
		return false;
	}
}

/** "Guide ↗" → "Guide". */
export function stripArrow(s: string): string {
	return s.replace(/\s*↗\s*$/u, "").trim();
}

/** Anchor texts that say nothing about the page ("Guide ↗", "Link ↗", "Book ↗", a bare domain). */
export function isGenericAnchor(text: string, url: string): boolean {
	const t = normName(stripArrow(text));
	if (["guide", "link", "book", "website", "site", "map", ""].includes(t))
		return true;
	const host = hostOf(url);
	return host !== null && (t === host || t === `www.${host}`);
}

/**
 * A link attachment's title: the anchor text when it says something
 * ("Tokyo Weekender: vintage watches"), else "<site>: <what it's about>"
 * ("japan-guide.com: Kappabashi Street", QA SEED-07).
 */
export function linkTitle(anchor: string, url: string, about: string): string {
	if (!isGenericAnchor(anchor, url)) return stripArrow(anchor).slice(0, 200);
	const host = hostOf(url);
	return (host ? `${host}: ${about}` : about).slice(0, 200);
}

export type CellLink = { text: string; url: string };

/**
 * A sheet cell as Markdown: every linked anchor run becomes `[text](url)`
 * (in order, each at its next occurrence), everything else is escaped.
 * `fallbackUrls` supplies URLs for anchors the sheet styled as links but
 * stored no URL for (the Places J29 quirk).
 */
export function cellMarkdown(
	text: string | null | undefined,
	links: readonly CellLink[] = [],
	extra: readonly CellLink[] = [],
): string {
	if (!text) return "";
	const all = [...links, ...extra].filter(
		(l) => l.text.trim() && isHttpUrl(l.url),
	);
	let out = "";
	let rest = text;
	for (const l of all) {
		const i = rest.indexOf(l.text);
		if (i < 0) continue;
		out += escapeInline(rest.slice(0, i));
		out += `[${escapeInline(l.text)}](${linkTarget(l.url)})`;
		rest = rest.slice(i + l.text.length);
	}
	out += escapeInline(rest);
	return lineMarkers(out).trim();
}

/** A URL safe inside `[…](…)`: parentheses and spaces percent-encoded. */
export function linkTarget(url: string): string {
	return url.replace(/[()\s]/g, (c) =>
		c === "(" ? "%28" : c === ")" ? "%29" : encodeURIComponent(c),
	);
}

/** Joins non-empty Markdown blocks with a blank line. */
export function blocks(
	...parts: (string | null | undefined | false)[]
): string {
	return parts
		.filter((p): p is string => typeof p === "string" && p.trim() !== "")
		.map((p) => p.trim())
		.join("\n\n");
}

/** Sheet hours (0.5, 1.25, 9.75) → whole minutes. */
export function hrsToMin(hrs: number | null | undefined): number | null {
	if (hrs == null || !Number.isFinite(hrs) || hrs < 0) return null;
	return Math.round(hrs * 60);
}

/**
 * "~¥30,000", "from ~¥6,600" → 30000 / 6600 (JPY); null when the text names
 * no yen amount. The text itself is always kept as `priceText`.
 */
export function yenAmount(text: string | null | undefined): number | null {
	if (!text) return null;
	const m = /¥\s*([\d,]+(?:\.\d+)?)/u.exec(text);
	if (!m?.[1]) return null;
	const n = Number(m[1].replace(/,/g, ""));
	return Number.isFinite(n) ? n : null;
}

/**
 * EXTENSIONS §5 E2 "Booked for this date": the sheet text says the thing is
 * booked. "reserve"/"reservation" means it still NEEDS booking (D4), so it
 * never counts.
 */
export function saysBooked(...texts: (string | null | undefined)[]): boolean {
	const t = texts.filter(Boolean).join(" ");
	return /(?<!\bnot\s(?:yet\s)?)\b(booked|confirmed|ticketed)\b|\bticket\s*#|\bref:|\bconf\s*#/iu.test(
		t,
	);
}
