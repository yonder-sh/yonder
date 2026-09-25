import type { AppEnv } from "./env.server";

/**
 * Response security headers (SPEC §12.3, SECURITY §9), set by the app itself so
 * `vite dev`, `pnpm start` and prod behind the ingress behave the same. Applied by the
 * request middleware in `src/start.ts` to pages and server functions.
 *
 * Scripts (SECURITY §7): in production, pages allow only same-origin files
 * and inline scripts carrying the request's nonce (`'nonce-…'`: TanStack
 * Start's bootstrap and dehydration scripts and the theme script get it via
 * the router's `ssr.nonce`), so injected inline script never runs. Without a
 * nonce (development: Vite's inline preamble and HMR; server-function and
 * API responses, which are not HTML) `'unsafe-inline'` stays. In development
 * the Vite HMR socket (other localhost ports) is allowed in `connect-src`.
 * With Cloudflare Turnstile on (`opts.turnstile`), its script and challenge
 * frame (https://challenges.cloudflare.com) are allowed too; never otherwise.
 */
export function buildSecurityHeaders(
	env: Pick<
		AppEnv,
		| "S3_PUBLIC_ENDPOINT"
		| "S3_ENDPOINT"
		| "VITE_COLLAB_URL"
		| "isProduction"
		| "APP_URL"
	>,
	opts: { nonce?: string; turnstile?: boolean } = {},
): Record<string, string> {
	const origin = (url: string | undefined): string | null => {
		if (!url) return null;
		try {
			return new URL(url).origin;
		} catch {
			return null;
		}
	};
	const s3 = origin(env.S3_PUBLIC_ENDPOINT ?? env.S3_ENDPOINT);
	const collab = origin(env.VITE_COLLAB_URL)?.replace(/^http/, "ws") ?? null;
	const dev = env.isProduction
		? []
		: ["ws://localhost:*", "http://localhost:*", "ws://127.0.0.1:*"];
	const list = (...xs: (string | null | undefined)[]) =>
		xs.filter((x): x is string => !!x).join(" ");
	// The map's Satellite basemap (WP-Map FB-04): keyless Esri World Imagery
	// tiles, fetched by MapLibre (`src/features/map/styles/yonder-satellite.json`).
	const imagery = "https://server.arcgisonline.com";
	const turnstile = opts.turnstile ? "https://challenges.cloudflare.com" : null;

	const csp = [
		"default-src 'self'",
		opts.nonce && env.isProduction
			? `script-src ${list("'self'", `'nonce-${opts.nonce}'`, turnstile)}`
			: `script-src ${list("'self'", "'unsafe-inline'", turnstile)}`,
		"style-src 'self' 'unsafe-inline'",
		`img-src ${list("'self'", "data:", "blob:", s3, "https://*.googleusercontent.com", imagery)}`,
		`media-src ${list("'self'", "blob:", s3)}`,
		"font-src 'self' data:",
		// `blob:`: Chrome checks a <video>'s reads of a local object URL (the
		// upload preview and poster capture) against connect-src.
		`connect-src ${list("'self'", "blob:", s3, collab, "https://tiles.openfreemap.org", imagery, ...dev)}`,
		"worker-src 'self' blob:",
		"manifest-src 'self'",
		`frame-src ${list("https://www.tiktok.com", "https://www.instagram.com", "https://www.youtube-nocookie.com", "https://www.youtube.com", turnstile)}`,
		"frame-ancestors 'none'",
		"base-uri 'self'",
		"form-action 'self'",
		"object-src 'none'",
	].join("; ");

	return {
		"Content-Security-Policy": csp,
		"X-Content-Type-Options": "nosniff",
		"Referrer-Policy": "strict-origin-when-cross-origin",
		"Permissions-Policy": "camera=(), microphone=(), geolocation=(self)",
		// SECURITY §7: two years, subdomains included; only for a production
		// https origin (never on localhost, where it would pin the dev host).
		...(env.isProduction && env.APP_URL.startsWith("https://")
			? { "Strict-Transport-Security": "max-age=63072000; includeSubDomains" }
			: {}),
	};
}

/** A fresh CSP nonce (128 random bits, base64). */
export function newCspNonce(): string {
	const bytes = new Uint8Array(16);
	crypto.getRandomValues(bytes);
	return btoa(String.fromCharCode(...bytes));
}

/**
 * SECURITY §2/§12: pages that carry a share or claim token (the fragment on
 * `/join`, the legacy `/s/<token>` path) never send a `Referer` anywhere and
 * are never cached. Applied after the global headers, so they win.
 */
export function tokenPageHeaders(pathname: string): Record<string, string> {
	if (
		pathname === "/join" ||
		pathname.startsWith("/join/") ||
		pathname.startsWith("/s/")
	)
		return {
			"Referrer-Policy": "no-referrer",
			"Cache-Control": "private, no-store",
		};
	return {};
}

/** Better Auth's session cookie (`better-auth.session_token`, `__Secure-` in prod). */
const SESSION_COOKIE_RE = /(?:^|;\s*)(?:__Secure-)?[\w.-]*session_token=/;

/**
 * Routes that check access per request and set their own `Cache-Control:
 * private, max-age=…` (a versioned avatar, a media thumb, a short-lived
 * redirect): the blanket `no-store` below would make every render refetch.
 */
const SELF_CACHING = ["/api/avatar/", "/media/"];
/** The trip's share card (docs/OVERVIEW.md §Sharing): `private, max-age=60` + ETag. */
const SHARE_CARD_RE = /^\/t\/[a-z0-9-]+\/share-card\.png$/;

/**
 * SECURITY §11: private responses are never stored by shared or browser
 * caches. Server-function responses always (they carry share-link URLs,
 * emails, booking refs, costs); SSR pages when the request is signed in.
 * Public, signed-out pages and hashed static assets keep their caching;
 * `SELF_CACHING` routes keep their own (always `private`).
 */
export function privateCacheHeaders(input: {
	handlerType: "serverFn" | "router";
	cookie: string | null;
	pathname?: string;
}): Record<string, string> {
	const signedIn = SESSION_COOKIE_RE.test(input.cookie ?? "");
	if (
		input.handlerType === "router" &&
		(SELF_CACHING.some((p) => input.pathname?.startsWith(p)) ||
			SHARE_CARD_RE.test(input.pathname ?? ""))
	)
		return { Vary: "Cookie" };
	if (input.handlerType === "serverFn" || signedIn)
		return { "Cache-Control": "private, no-store", Vary: "Cookie" };
	return {};
}
