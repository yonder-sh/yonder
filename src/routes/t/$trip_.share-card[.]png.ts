import { createFileRoute } from "@tanstack/react-router";

/**
 * `GET /t/$trip/share-card.png?size=story|square` (docs/OVERVIEW.md §Sharing):
 * the trip's share card for anyone who can see the trip, drawn from the graph
 * they can read; 404 otherwise. The logic is `serveShareCard`
 * (`features/overview/share/server/serve.server.ts`), loaded on first use so
 * the fonts and resvg stay out of the server's startup.
 */
export const Route = createFileRoute("/t/$trip_/share-card.png")({
	server: {
		handlers: {
			GET: async ({ request, params }) => {
				try {
					const { serveShareCard } = await import(
						"@/features/overview/share/server/serve.server"
					);
					return await serveShareCard(request, params.trip);
				} catch (e) {
					console.error("[share-card] render failed:", (e as Error).message);
					return new Response("Unavailable", {
						status: 503,
						headers: { "Cache-Control": "no-store" },
					});
				}
			},
		},
	},
});
