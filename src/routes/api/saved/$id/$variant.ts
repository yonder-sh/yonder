import { createFileRoute } from "@tanstack/react-router";
import { serveSaved } from "@/features/saved/server/serve.server";

/**
 * `GET /api/saved/$id/$variant` (`image` | `favicon`): a saved link's
 * re-hosted picture, for its owner only (`serveSaved`).
 */
export const Route = createFileRoute("/api/saved/$id/$variant")({
	server: {
		handlers: {
			GET: async ({ request, params }) => {
				try {
					return await serveSaved(request, params.id, params.variant);
				} catch (e) {
					console.error("[saved] serve failed:", (e as Error).message);
					return new Response("Unavailable", {
						status: 503,
						headers: { "Cache-Control": "no-store" },
					});
				}
			},
		},
	},
});
