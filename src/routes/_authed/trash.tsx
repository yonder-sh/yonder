import { createFileRoute } from "@tanstack/react-router";
import { TrashPage } from "@/features/trash/TrashPage";
import { pageTitle } from "@/lib/brand";

/** `/trash` — the account's deleted uploads, kept 30 days (`TrashPage`). */
export const Route = createFileRoute("/_authed/trash")({
	ssr: false,
	head: () => ({ meta: [{ title: pageTitle("Trash") }] }),
	component: TrashPage,
});
