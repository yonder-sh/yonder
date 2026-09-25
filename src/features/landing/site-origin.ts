import { createIsomorphicFn } from "@tanstack/react-start";
import { getEnv } from "@/server/env.server";

/**
 * This deployment's public origin, for the landing page's canonical link and
 * Open Graph URLs (they must be absolute). On the server (the HTML crawlers
 * and link previews read) it's APP_URL, read at runtime like the rest of the
 * config; in the browser, the page's own origin. No server function: nothing
 * new to call from outside.
 */
export const siteOrigin = createIsomorphicFn()
	.server((): string => getEnv().appOrigin)
	.client((): string => window.location.origin);
