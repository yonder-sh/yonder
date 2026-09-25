import { createFileRoute } from "@tanstack/react-router";
import { serveMedia } from "@/features/media/server/serve.server";

/**
 * `GET /media/$id/$variant` (SPEC §13.4, §15.5; ADDENDUM §9): session +
 * trip access + the attachment read rules, then `thumb`/`image`/`favicon`/
 * `page-<n>` stream from S3 and `display`/`original`/`poster` redirect to a
 * presigned GET. The logic is `serveMedia` (`features/media/server/serve.server.ts`).
 */
export const Route = createFileRoute("/media/$id/$variant")({
	server: {
		handlers: {
			GET: async ({ request, params }) => {
				try {
					return await serveMedia(request, params.id, params.variant);
				} catch (e) {
					console.error("[media] serve failed:", (e as Error).message);
					return new Response("Unavailable", {
						status: 503,
						headers: { "Cache-Control": "no-store" },
					});
				}
			},
		},
	},
});
