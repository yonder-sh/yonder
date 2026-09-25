import { JOIN_PATH } from "./constants";

/**
 * Share-link URLs (SECURITY §2). The token rides in the URL **fragment**
 * (`/join#t=<token>`), which browsers never send to the server, so it stays
 * out of access logs, proxies and `Referer`. `/join` posts it to
 * `redeemShareLink` and then scrubs it from the address bar.
 *
 * Tokens are 32 random bytes in base64url (43 characters); the looser length
 * bound only exists so a malformed token gets the same "no longer works"
 * answer as an unknown one.
 */
export const SHARE_TOKEN_RE = /^[A-Za-z0-9_-]{22,128}$/;

export function isShareToken(v: unknown): v is string {
	return typeof v === "string" && SHARE_TOKEN_RE.test(v);
}

/** The path (plus fragment) to put in a share URL: `/join#t=<token>`. */
export function shareLinkPath(token: string): string {
	return `${JOIN_PATH}#t=${encodeURIComponent(token)}`;
}

/** The absolute share URL for `appUrl` (e.g. `APP_URL`, or `location.origin`). */
export function shareLinkUrl(appUrl: string, token: string): string {
	return new URL(shareLinkPath(token), appUrl).toString();
}

/**
 * Reads the token from a location hash: `#t=<token>` (canonical) or a bare
 * `#<token>`. Returns null when there is no well-formed token.
 */
export function parseShareFragment(
	hash: string | null | undefined,
): string | null {
	if (!hash) return null;
	const raw = hash.startsWith("#") ? hash.slice(1) : hash;
	if (!raw) return null;
	const fromParam = new URLSearchParams(raw).get("t");
	const candidate = fromParam ?? (raw.includes("=") ? null : raw);
	if (!candidate) return null;
	let token: string;
	try {
		token = decodeURIComponent(candidate);
	} catch {
		return null;
	}
	return isShareToken(token) ? token : null;
}
