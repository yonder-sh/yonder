import { betterAuth } from "better-auth";
import { tanstackStartCookies } from "better-auth/tanstack-start";
import { authOptions } from "./auth-options";

/**
 * The app's Better Auth instance (SPEC §11.1). `pnpm auth:generate` reads this
 * file to generate `src/db/schema/auth.ts`.
 *
 * `tanstackStartCookies()` MUST be the last plugin: it forwards Set-Cookie
 * from `auth.api.*` calls made inside server functions onto the Start
 * response. It is kept out of `authOptions` so non-Start processes (the
 * collab server) can use the options without it (spikes/auth gotcha 4).
 */
export const auth = betterAuth({
	...authOptions,
	plugins: [...authOptions.plugins, tanstackStartCookies()],
});

export type Auth = typeof auth;
export type AuthSession = typeof auth.$Infer.Session;
export type AuthUser = AuthSession["user"];
