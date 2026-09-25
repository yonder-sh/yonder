import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { ShareInbox } from "@/features/home/ShareInbox";
import { pageTitle } from "@/lib/brand";

/**
 * `/share` — the Web Share Target landing page (EXTENSIONS §10, F route;
 * WP-Home owns `ShareInbox`). The service worker receives the share-target
 * POST, stores it in IndexedDB and redirects here with `?id=`. If the POST
 * ever reaches the server (no service worker yet), the handler answers 303
 * `/share?lost=1` ("Couldn't receive that — share again"); the body is never
 * read or stored. Signed-out users go through /login and come back with the
 * entry intact (it lives on the device).
 */
const ShareSearch = z.object({
	id: z
		.string()
		.regex(/^[A-Za-z0-9_-]{1,64}$/)
		.optional()
		.catch(undefined),
	lost: z.literal(1).optional().catch(undefined),
});

export const Route = createFileRoute("/_authed/share")({
	ssr: false,
	validateSearch: ShareSearch,
	head: () => ({ meta: [{ title: pageTitle("Save to Yonder") }] }),
	server: {
		handlers: {
			POST: async () =>
				new Response(null, {
					status: 303,
					headers: { Location: "/share?lost=1", "Cache-Control": "no-store" },
				}),
		},
	},
	component: ShareRoute,
});

function ShareRoute() {
	const { id, lost } = Route.useSearch();
	return <ShareInbox id={id} lost={lost === 1} />;
}
