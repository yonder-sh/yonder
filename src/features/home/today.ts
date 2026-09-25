/**
 * DASH-03: the dashboard knows "today" on its first paint. The browser keeps
 * its IANA zone in a cookie (`yonder-tz`), so the server can render the next
 * trip / past split for the viewer's own date instead of treating every trip
 * as current until hydration (which flashed an ended trip as "Next trip" on
 * slow phones). Without the cookie (a first visit) the server's date is used;
 * the client corrects it after hydration only if the two dates differ.
 */

export const TZ_COOKIE = "yonder-tz";

/** `tz` if it's a zone this runtime knows, else undefined (the runtime's own). */
export function knownZone(tz: string | null | undefined): string | undefined {
	if (!tz || tz.length > 64) return undefined;
	try {
		new Intl.DateTimeFormat("en-CA", { timeZone: tz });
		return tz;
	} catch {
		return undefined;
	}
}

/**
 * The zone in a `yonder-tz` cookie value, or undefined for anything that
 * isn't a known IANA zone. The value is whatever the browser sent: a
 * hand-edited or truncated cookie ("%E0%A4%A", "Mars/Base", 300 × "A") must
 * fall back to the server's date, never fail the dashboard (the DASH-03
 * render threw on a malformed percent-escape: a 500 for that visitor on
 * every visit, since the cookie lives a year).
 */
export function zoneFromCookie(
	raw: string | null | undefined,
): string | undefined {
	if (!raw || raw.length > 256) return undefined;
	let value = raw;
	try {
		value = decodeURIComponent(raw);
	} catch {
		return undefined;
	}
	return knownZone(value.trim());
}

/** Remembers the browser's zone for the next server render (a year; no-op on the server). */
export function rememberZone(): void {
	if (typeof document === "undefined") return;
	try {
		const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
		if (!knownZone(tz)) return;
		const value = encodeURIComponent(tz);
		if (document.cookie.includes(`${TZ_COOKIE}=${value}`)) return;
		// biome-ignore lint/suspicious/noDocumentCookie: a plain, non-sensitive preference cookie
		document.cookie = `${TZ_COOKIE}=${value}; path=/; max-age=31536000; samesite=lax`;
	} catch {
		// cookies blocked: the server keeps using its own date
	}
}
