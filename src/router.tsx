import type { QueryClient } from "@tanstack/react-query";
import { createRouter as createTanStackRouter } from "@tanstack/react-router";
import { setupRouterSsrQueryIntegration } from "@tanstack/react-router-ssr-query";
import {
	createIsomorphicFn,
	getGlobalStartContext,
} from "@tanstack/react-start";
import { RouteError } from "@/components/common/route-error";
import { makeQueryClient } from "@/lib/query/client";
import { routeTree } from "./routeTree.gen";

/** What every route's `beforeLoad` / `loader` receives as `context`. */
export interface RouterContext {
	queryClient: QueryClient;
}

/**
 * One router and one QueryClient per request on the server, one per page in
 * the browser (SPEC §12.2). The SSR-query integration dehydrates what loaders
 * fetched and wraps the app in a QueryClientProvider.
 */
/**
 * The request's CSP nonce (SECURITY §7), set by the security middleware in
 * `src/start.ts`; the router stamps it on every inline script it renders
 * (bootstrap, dehydration, head scripts). None in the browser.
 */
const cspNonce = createIsomorphicFn()
	.server((): string | undefined => {
		try {
			return (getGlobalStartContext() as { cspNonce?: string } | undefined)
				?.cspNonce;
		} catch {
			return undefined; // outside a request (no global middleware ran)
		}
	})
	.client((): string | undefined => undefined);

export function getRouter() {
	const queryClient = makeQueryClient();
	const nonce = cspNonce();
	const router = createTanStackRouter({
		routeTree,
		context: { queryClient } satisfies RouterContext,
		...(nonce ? { ssr: { nonce } } : {}),
		scrollRestoration: true,
		defaultPreload: "intent",
		// Loaders read through TanStack Query, which has its own staleness.
		defaultPreloadStaleTime: 0,
		// QA ERR-04: a branded page with a retry, never the framework's bare
		// "Something went wrong! [Show Error]" (routes may bring their own).
		defaultErrorComponent: RouteError,
	});
	setupRouterSsrQueryIntegration({ router, queryClient });
	return router;
}

declare module "@tanstack/react-router" {
	interface Register {
		router: ReturnType<typeof getRouter>;
	}
}
