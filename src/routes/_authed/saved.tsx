import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { SavedPage } from "@/features/saved/SavedPage";
import { pageTitle } from "@/lib/brand";

/**
 * `/saved` — links shared into Yonder, waiting for a trip (`SavedPage`).
 * `?open=<id>` opens the feed at one; `&from=share` came from a share (the
 * card offers Later). Client-rendered: the feed is a full-screen layer.
 */
const SavedSearch = z.object({
	open: z
		.string()
		.regex(/^[0-9a-f-]{36}$/i)
		.optional()
		.catch(undefined),
	from: z.literal("share").optional().catch(undefined),
});

export const Route = createFileRoute("/_authed/saved")({
	ssr: false,
	validateSearch: SavedSearch,
	head: () => ({ meta: [{ title: pageTitle("Saved") }] }),
	component: SavedRoute,
});

function SavedRoute() {
	const { open, from } = Route.useSearch();
	return <SavedPage open={open} from={from} />;
}
