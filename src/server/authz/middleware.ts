import { createMiddleware } from "@tanstack/react-start";
import { fnRateLimit } from "@/server/cache.server";
import { assertAccount, assertNamedUser, assertUser } from "./policy";
import { enforce, getSession } from "./session.server";

/**
 * Server-function middleware (SPEC §12.3). Every server function uses one:
 *
 *   createServerFn({ method: "POST" })
 *     .middleware([withNamedUser])
 *     .validator(Input)
 *     .handler(async ({ data, context }) => {
 *       const access = await requireTripRole(data.tripId, "editor", context.user);
 *       …
 *     })
 *
 * - `withSession`: `context.session` / `context.user` may be null (public reads).
 * - `withUser`: signed in, guests included (401 otherwise); also the global
 *   300 calls/min per user limit (SECURITY §10; 429 + Retry-After).
 * - `withNamedUser`: signed in with both names (guests pass) — EVERY mutation.
 * - `withAccount`: a named, non-anonymous account (dashboards, creating trips).
 *
 * This file is NOT `.server.ts` on purpose: route and function modules import
 * it on the client too, where TanStack Start strips the `.server()` bodies
 * (and with them the server-only imports).
 */
export const withSession = createMiddleware({ type: "function" }).server(
	async ({ next }) => {
		const session = await getSession();
		return next({ context: { session, user: session?.user ?? null } });
	},
);

export const withUser = createMiddleware({ type: "function" })
	.middleware([withSession])
	.server(async ({ next, context }) => {
		const user = enforce(() => assertUser(context.user));
		await fnRateLimit(user.id);
		return next({ context: { user } });
	});

export const withNamedUser = createMiddleware({ type: "function" })
	.middleware([withUser])
	.server(({ next, context }) => {
		enforce(() => assertNamedUser(context.user));
		return next();
	});

export const withAccount = createMiddleware({ type: "function" })
	.middleware([withNamedUser])
	.server(({ next, context }) => {
		enforce(() => assertAccount(context.user));
		return next();
	});
