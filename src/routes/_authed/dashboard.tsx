import { createFileRoute } from "@tanstack/react-router";
import { Dashboard } from "@/features/home/Dashboard";
import { dashboardToday } from "@/features/home/dashboard.functions";
import { myTripsQuery } from "@/features/home/queries";
import { pageTitle } from "@/lib/brand";
import { todayIn } from "@/lib/format";

/**
 * `/dashboard` — the dashboard (SPEC §12.1; WP-Home owns this route from the
 * feature wave on; `/` is the public landing page). SSR: the trip list is
 * fetched in the loader and dehydrated, with "today" in the viewer's zone so
 * the first paint already splits next / past trips right (DASH-03); in the
 * browser the loader asks the clock.
 */
export const Route = createFileRoute("/_authed/dashboard")({
	loader: async ({ context }) => {
		const [, today] = await Promise.all([
			context.queryClient.ensureQueryData(myTripsQuery()),
			typeof window === "undefined" ? dashboardToday() : todayIn(),
		]);
		return { today };
	},
	head: () => ({ meta: [{ title: pageTitle("Your trips") }] }),
	component: DashboardRoute,
});

function DashboardRoute() {
	const { viewer } = Route.useRouteContext();
	const { today } = Route.useLoaderData();
	return <Dashboard viewer={viewer} today={today} />;
}
