import { describe, expect, it } from "vitest";
import {
	buildSecurityHeaders,
	newCspNonce,
	privateCacheHeaders,
	tripPageHeaders,
} from "./security-headers.server";

describe("buildSecurityHeaders", () => {
	it("allows the S3 origin for images and media, and locks framing down", () => {
		const h = buildSecurityHeaders({
			S3_PUBLIC_ENDPOINT: "https://trips.example.com/s3",
			S3_ENDPOINT: "http://s3proxy:80/s3",
			VITE_COLLAB_URL: undefined,
			isProduction: true,
			APP_URL: "https://trips.example.com",
		});
		const csp = h["Content-Security-Policy"] ?? "";
		expect(csp).toContain(
			"img-src 'self' data: blob: https://trips.example.com",
		);
		expect(csp).toContain("frame-ancestors 'none'");
		expect(csp).toContain("object-src 'none'");
		expect(csp).not.toContain("localhost");
		expect(h["X-Content-Type-Options"]).toBe("nosniff");
	});

	it("adds the collab origin and dev sockets outside production", () => {
		const h = buildSecurityHeaders({
			S3_PUBLIC_ENDPOINT: undefined,
			S3_ENDPOINT: "http://localhost:8080",
			VITE_COLLAB_URL: "https://collab.example.com",
			isProduction: false,
			APP_URL: "http://localhost:3000",
		});
		const csp = h["Content-Security-Policy"] ?? "";
		expect(csp).toContain("wss://collab.example.com");
		expect(csp).toContain("ws://localhost:*");
		expect(h["Strict-Transport-Security"]).toBeUndefined();
	});

	it("allows Cloudflare Turnstile's script and frame only when it is on", () => {
		const env = {
			S3_PUBLIC_ENDPOINT: "https://s3.axolotl.cloud",
			S3_ENDPOINT: "http://rgw.ceph.svc:80",
			VITE_COLLAB_URL: undefined,
			isProduction: true,
			APP_URL: "https://yonder.sh",
		};
		const off = buildSecurityHeaders(env, { nonce: "n0nce" })[
			"Content-Security-Policy"
		];
		expect(off).not.toContain("challenges.cloudflare.com");
		const on =
			buildSecurityHeaders(env, { nonce: "n0nce", turnstile: true })[
				"Content-Security-Policy"
			] ?? "";
		expect(on).toContain(
			"script-src 'self' 'nonce-n0nce' https://challenges.cloudflare.com",
		);
		expect(on).toMatch(/frame-src [^;]*https:\/\/challenges\.cloudflare\.com/);
		expect(on).toContain("connect-src 'self' blob: https://s3.axolotl.cloud");
		// Development keeps 'unsafe-inline' and adds the host the same way.
		expect(
			buildSecurityHeaders(
				{ ...env, isProduction: false },
				{ turnstile: true },
			)["Content-Security-Policy"],
		).toContain(
			"script-src 'self' 'unsafe-inline' https://challenges.cloudflare.com",
		);
	});

	it("sends HSTS only for a production https origin (SECURITY §7)", () => {
		const base = {
			S3_PUBLIC_ENDPOINT: undefined,
			S3_ENDPOINT: "http://s3proxy:80",
			VITE_COLLAB_URL: undefined,
		};
		expect(
			buildSecurityHeaders({
				...base,
				isProduction: true,
				APP_URL: "https://trips.example.com",
			})["Strict-Transport-Security"],
		).toBe("max-age=63072000; includeSubDomains");
		expect(
			buildSecurityHeaders({
				...base,
				isProduction: true,
				APP_URL: "http://127.0.0.1:8088",
			})["Strict-Transport-Security"],
		).toBeUndefined();
	});
});

describe("privateCacheHeaders (SECURITY §11)", () => {
	const noStore = { "Cache-Control": "private, no-store", Vary: "Cookie" };

	it("leaves self-caching private routes (avatars, media) their own Cache-Control", () => {
		const cookie = "better-auth.session_token=abc.def";
		for (const pathname of [
			"/api/avatar/u1",
			"/media/x/thumb",
			"/t/asia-2027/share-card.png",
		])
			expect(
				privateCacheHeaders({ handlerType: "router", cookie, pathname }),
			).toEqual({ Vary: "Cookie" });
		expect(
			privateCacheHeaders({
				handlerType: "router",
				cookie,
				pathname: "/t/asia-2027",
			}),
		).toEqual(noStore);
		expect(
			privateCacheHeaders({
				handlerType: "router",
				cookie,
				pathname: "/t/asia-2027/japan/share-card.png",
			}),
		).toEqual(noStore);
		expect(
			privateCacheHeaders({
				handlerType: "serverFn",
				cookie,
				pathname: "/media/x",
			}),
		).toEqual(noStore);
	});

	it("marks every server-function response private", () => {
		expect(
			privateCacheHeaders({ handlerType: "serverFn", cookie: null }),
		).toEqual(noStore);
	});

	it("marks signed-in pages private and leaves public pages alone", () => {
		expect(
			privateCacheHeaders({
				handlerType: "router",
				cookie: "theme=dark; better-auth.session_token=abc.def",
			}),
		).toEqual(noStore);
		expect(
			privateCacheHeaders({
				handlerType: "router",
				cookie: "__Secure-better-auth.session_token=abc",
			}),
		).toEqual(noStore);
		expect(
			privateCacheHeaders({ handlerType: "router", cookie: "theme=dark" }),
		).toEqual({});
		expect(
			privateCacheHeaders({ handlerType: "router", cookie: null }),
		).toEqual({});
	});
});

describe("script-src (SEC-R1-09, SECURITY §7)", () => {
	const env = {
		S3_PUBLIC_ENDPOINT: undefined,
		S3_ENDPOINT: "http://s3proxy:80",
		VITE_COLLAB_URL: undefined,
		APP_URL: "https://trips.example.com",
	};
	it("production pages allow only same-origin files and the request's nonce", () => {
		const nonce = newCspNonce();
		const csp =
			buildSecurityHeaders({ ...env, isProduction: true }, { nonce })[
				"Content-Security-Policy"
			] ?? "";
		expect(csp).toContain(`script-src 'self' 'nonce-${nonce}';`);
		expect(csp).not.toMatch(/script-src[^;]*'unsafe-inline'/);
	});
	it("nonces are fresh and 128-bit", () => {
		const a = newCspNonce();
		expect(a).not.toBe(newCspNonce());
		expect(atob(a)).toHaveLength(16);
	});
	it("development (Vite's inline preamble) keeps 'unsafe-inline'", () => {
		const csp =
			buildSecurityHeaders(
				{ ...env, isProduction: false, APP_URL: "http://localhost:3000" },
				{ nonce: "abc" },
			)["Content-Security-Policy"] ?? "";
		expect(csp).toContain("script-src 'self' 'unsafe-inline'");
	});
});

describe("tripPageHeaders (trip addresses are share links)", () => {
	it("keeps every trip page out of search results", () => {
		for (const path of [
			"/t/asia-2027-k7m2qxw9",
			"/t/asia-2027-k7m2qxw9/japan/tokyo",
			"/t/asia-2027-k7m2qxw9/share-card.png",
		])
			expect(tripPageHeaders(path)).toEqual({
				"X-Robots-Tag": "noindex, nofollow",
			});
		for (const path of ["/", "/login", "/trips", "/terms"])
			expect(tripPageHeaders(path)).toEqual({});
	});
});
