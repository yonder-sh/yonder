import { createFileRoute } from "@tanstack/react-router";

/** `/dev/fixture/<slug>/…` scopes; the layout route renders the workspace. */
export const Route = createFileRoute("/dev/fixture/$")({
	component: () => null,
});
