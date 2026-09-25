/**
 * TanStack Start instance (SPEC §12.3): request and server-function middleware
 * shared by every page and server function.
 *
 * - `securityHeaders`: CSP and friends on every page and server-function
 *   response (dev, `pnpm start` and prod alike;
 *   `src/server/security-headers.server.ts`), HSTS in production, and
 *   `Cache-Control: private, no-store` + `Vary: Cookie` on server functions and
 *   signed-in pages. Static files never reach this middleware: Nitro
 *   `routeRules` (vite.config.ts) and the ingress set their headers.
 * - CSRF: server-function calls must come from this origin (`Sec-Fetch-Site:
 *   same-origin`, else a matching `Origin`/`Referer`). Better Auth's own routes
 *   check their origin themselves.
 * - `tabHeader`: every server-function call carries the tab id (`x-tab-id`), so
 *   the live event a mutation publishes is skipped by the tab that made it
 *   (SPEC §10.5), and `x-yonder-mode: suggest` while the workspace is in
 *   suggest mode (EXTENSIONS §2.3; only the proposal gate reads it).
 */
import {
	createCsrfMiddleware,
	createMiddleware,
	createStart,
} from "@tanstack/react-start";
import { setResponseHeader } from "@tanstack/react-start/server";
import { getTabId, TAB_ID_HEADER } from "@/lib/realtime/tab-id";
import { MODE_HEADER } from "@/lib/schemas/proposals";
import { suggestModeHeader } from "@/lib/workspace/suggest-mode";
import { authEnv } from "@/server/auth/env.server";
import { getEnv } from "@/server/env.server";
import {
	buildSecurityHeaders,
	newCspNonce,
	privateCacheHeaders,
	tripPageHeaders,
} from "@/server/security-headers.server";

const securityHeaders = createMiddleware().server(
	async ({ next, request, handlerType }) => {
		// Pages get a per-request CSP nonce; the router stamps it on its inline
		// scripts (`ssr.nonce` in src/router.tsx, via `cspNonce` below).
		const nonce = handlerType === "router" ? newCspNonce() : undefined;
		const headers = {
			...buildSecurityHeaders(getEnv(), {
				nonce,
				turnstile: !!authEnv().turnstile,
			}),
			...privateCacheHeaders({
				handlerType,
				cookie: request.headers.get("cookie"),
				pathname: new URL(request.url).pathname,
			}),
			...tripPageHeaders(new URL(request.url).pathname),
		};
		for (const [k, v] of Object.entries(headers)) setResponseHeader(k, v);
		return next({ context: { cspNonce: nonce } });
	},
);

const tabHeader = createMiddleware({ type: "function" }).client(({ next }) => {
	const mode = suggestModeHeader();
	return next({
		headers: {
			[TAB_ID_HEADER]: getTabId(),
			...(mode ? { [MODE_HEADER]: mode } : {}),
		},
	});
});

export const startInstance = createStart(() => ({
	requestMiddleware: [
		securityHeaders,
		createCsrfMiddleware({ filter: (ctx) => ctx.handlerType === "serverFn" }),
	],
	functionMiddleware: [tabHeader],
}));
