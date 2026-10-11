import { createFileRoute } from "@tanstack/react-router";
import { serveTrashThumb } from "@/features/trash/server/trash.server";

/** `GET /api/trash/$id/thumb`: a trip file's thumbnail in Trash, for its uploader only. */
export const Route = createFileRoute("/api/trash/$id/thumb")({
	server: {
		handlers: {
			GET: async ({ request, params }) => {
				try {
					return await serveTrashThumb(request, params.id);
				} catch (e) {
					console.error("[trash] serve failed:", (e as Error).message);
					return new Response("Unavailable", {
						status: 503,
						headers: { "Cache-Control": "no-store" },
					});
				}
			},
		},
	},
});
