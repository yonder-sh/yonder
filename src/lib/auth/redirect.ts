/**
 * `?next=` handling for /login and /welcome (SPEC §11.2 flow 1, QA AUTH-05).
 * Only same-origin relative paths are followed: they must start with "/" and
 * not "//" or "/\" (both are protocol-relative in browsers), and contain no
 * control characters or backslashes that a browser might normalize into a
 * different origin. Anything else falls back to the dashboard.
 */
export function safeNext(next: unknown, fallback = "/"): string {
	if (typeof next !== "string" || next.length === 0 || next.length > 2048)
		return fallback;
	if (!next.startsWith("/") || next.startsWith("//")) return fallback;
	// Backslashes and control characters (incl. tab/newline, which browsers strip).
	if (/[\\\p{Cc}]/u.test(next)) return fallback;
	try {
		// Resolve against a dummy origin: anything that escapes it is external.
		const base = "https://yonder.invalid";
		const url = new URL(next, base);
		if (url.origin !== base) return fallback;
		return `${url.pathname}${url.search}${url.hash}`;
	} catch {
		return fallback;
	}
}

/** Paths that must never be a post-sign-in destination (they would loop). */
const AUTH_PAGES = ["/login", "/welcome"];

/** `safeNext`, also refusing the auth pages themselves. */
export function postAuthDestination(next: unknown, fallback = "/"): string {
	const dest = safeNext(next, fallback);
	const path = dest.split(/[?#]/, 1)[0] ?? "";
	return AUTH_PAGES.includes(path) ? fallback : dest;
}
