import { createFileRoute } from "@tanstack/react-router";
import { serveSavedFile } from "@/features/saved/server/serve.server";

/**
 * `GET /api/saved-file/$id/$variant` (`thumb` | `display` | `poster` | `original`): a saved
 * photo or video, for its owner only (`serveSavedFile`).
 */
export const Route = createFileRoute("/api/saved-file/$id/$variant")({
	server: {
		handlers: {
			GET: async ({ request, params }) => {
				try {
					return await serveSavedFile(request, params.id, params.variant);
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
