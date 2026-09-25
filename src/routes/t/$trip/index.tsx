import { createFileRoute } from "@tanstack/react-router";

/** `/t/$trip` — the trip root scope. The layout route renders the workspace. */
export const Route = createFileRoute("/t/$trip/")({
	component: () => null,
});
