import { createFileRoute } from "@tanstack/react-router";
import { loadSession } from "@/server/authz/session.server";
import { serveAvatar } from "@/server/avatar.server";

/**
 * `GET /api/avatar/$userId?v=<version>&s=64|128|256` (owner FB-16): a
 * profile picture from the private bucket, only for the user themself and
 * people who share a live trip with them (`maySeeAvatar`); 404 otherwise.
 * `user.image` holds this URL (`@/lib/schemas/avatar`).
 */
export const Route = createFileRoute("/api/avatar/$userId")({
	server: {
		handlers: {
			GET: async ({ request, params }) => {
				try {
					const session = await loadSession(request.headers);
					return await serveAvatar(
						request,
						params.userId,
						session?.user.id ?? null,
					);
				} catch (e) {
					console.error("[avatar] serve failed:", (e as Error).message);
					return new Response("Unavailable", {
						status: 503,
						headers: { "Cache-Control": "no-store" },
					});
				}
			},
		},
	},
});
