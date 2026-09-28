/**
 * e2e (`pnpm e2e:fast`): E2E_OUTBOUND_STUB sends the server's fetches of
 * user-supplied URLs (link previews, `peekLink`, Maps short links) to a local
 * fixture server (e2e/stubs/link-stub.mjs) instead of the internet: each
 * request goes to `<stub>?u=<the original URL>`, and the stub answers as that
 * host would. Honoured only where the test switches are (`testRoutesEnabled`:
 * ENABLE_TEST_ROUTES on a localhost APP_URL, never in production), and only
 * for a loopback stub.
 */
import { testRoutesEnabled } from "./env.server";

let warned = false;

/** The stub's base URL, or null (the real hosts). */
export function outboundStubUrl(
	raw = process.env.E2E_OUTBOUND_STUB,
): URL | null {
	const v = raw?.trim();
	if (!v) return null;
	if (!testRoutesEnabled()) {
		if (!warned)
			console.warn(
				"[outbound] E2E_OUTBOUND_STUB ignored: test switches are off",
			);
		warned = true;
		return null;
	}
	const u = new URL(v);
	if (!/^(localhost|127\.0\.0\.1|\[::1\])$/.test(u.hostname))
		throw new Error(`E2E_OUTBOUND_STUB must be a loopback URL, got ${v}`);
	return u;
}

/** The stub's URL for a request to `original`. */
export function viaStub(stub: URL, original: string): URL {
	const u = new URL(stub);
	u.searchParams.set("u", original);
	return u;
}

/** `fetch`, or with the stub on, a fetch that asks the stub instead of each host. */
export function outboundFetch(): typeof fetch {
	const stub = outboundStubUrl();
	if (!stub) return fetch;
	return (input, init) =>
		fetch(
			viaStub(
				stub,
				input instanceof Request ? input.url : new URL(String(input)).href,
			),
			init,
		);
}
