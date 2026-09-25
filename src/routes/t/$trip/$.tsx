import { createFileRoute } from "@tanstack/react-router";

/**
 * `/t/$trip/<slug>/<slug>/…` — a scope inside the trip. `_splat` holds the
 * slug path; the layout route resolves it (`resolveSlugPath`) and renders the
 * workspace.
 */
export const Route = createFileRoute("/t/$trip/$")({
	component: () => null,
});
