import { createFileRoute } from "@tanstack/react-router";
import { auth } from "@/server/auth.server";

/**
 * Better Auth's HTTP API (`/api/auth/*`): email OTP, anonymous guests,
 * sessions and sign-out. Better Auth checks `Origin` against `trustedOrigins`
 * on every state-changing request (SECURITY §9). The options, hooks and
 * limits live in `src/server/auth/options.server.ts`.
 */
export const Route = createFileRoute("/api/auth/$")({
	server: {
		handlers: {
			GET: ({ request }) => auth.handler(request),
			POST: ({ request }) => auth.handler(request),
		},
	},
});
