import { createFileRoute, Outlet } from "@tanstack/react-router";
import { requireAccountViewer } from "@/lib/auth/guards";

/**
 * Pathless layout for pages that need a named, non-anonymous account (the
 * dashboard). Signed out or guest → /login?next=…; no names → /welcome.
 * UX only: every server function enforces the same rules (SPEC §11).
 */
export const Route = createFileRoute("/_authed")({
	beforeLoad: ({ location, context }) =>
		requireAccountViewer(location.href, { queryClient: context.queryClient }),
	component: Outlet,
});
