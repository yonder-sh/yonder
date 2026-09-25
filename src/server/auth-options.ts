import { buildAuthOptions } from "./auth/options.server";

/**
 * The Better Auth options shared by the app and the collab process (SPEC
 * §10.3, §11.1), WITHOUT `tanstackStartCookies()`:
 *
 *   // collab/auth.ts
 *   export const collabAuth = betterAuth(authOptions)
 *   const session = await collabAuth.api.getSession({ headers, query: { disableCookieCache: true } })
 *
 * Building them is side-effect free: Postgres (`db`) and Redis (`redis()`) are
 * lazy, so `pnpm auth:generate` can load this without either running.
 * Server-only (never import from client code).
 */
export const authOptions = buildAuthOptions();
export type { AuthOptions } from "./auth/options.server";
