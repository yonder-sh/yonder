import {
	createFileRoute,
	notFound,
	Outlet,
	useNavigate,
	useParams,
	useRouter,
} from "@tanstack/react-router";
import { useCallback, useMemo } from "react";
import { Workspace } from "@/features/shell/Workspace";
import { demoGraph, scenario } from "@/lib/fixtures/demo";
import {
	WorkspaceModelProvider,
	type WorkspaceRouteBinding,
} from "@/lib/workspace/model-context";
import type { NavTarget } from "@/lib/workspace/nav";
import { WorkspaceSearch } from "@/lib/workspace/search";

/**
 * `/dev/fixture/…` (SPEC §12.1): the whole Workspace on the F0 demo fixture,
 * with no backend — for building and screenshotting UI without a database,
 * collab server or sign-in. Dev builds only (404 otherwise). Mutations call
 * the real server functions and fail; that's expected here.
 */
export const Route = createFileRoute("/dev/fixture")({
	ssr: false,
	validateSearch: WorkspaceSearch,
	beforeLoad: () => {
		if (!import.meta.env.DEV) throw notFound();
	},
	head: () => ({ meta: [{ title: "Fixture · Yonder" }] }),
	component: FixtureRoute,
});

function FixtureRoute() {
	const search = Route.useSearch();
	const splat = useParams({ strict: false })._splat ?? "";
	const navigate = useNavigate();
	const router = useRouter();
	const go = useCallback(
		(t: NavTarget, opts?: { replace?: boolean }) => {
			const replace = opts?.replace ?? false;
			if (t.splat)
				void navigate({
					to: "/dev/fixture/$",
					params: { _splat: t.splat },
					search: t.search,
					replace,
				});
			else void navigate({ to: "/dev/fixture", search: t.search, replace });
		},
		[navigate],
	);
	const href = useCallback(
		(t: NavTarget) =>
			t.splat
				? router.buildLocation({
						to: "/dev/fixture/$",
						params: { _splat: t.splat },
						search: t.search,
					}).href
				: router.buildLocation({ to: "/dev/fixture", search: t.search }).href,
		[router],
	);
	const route = useMemo<WorkspaceRouteBinding>(
		() => ({ splat, search, go, href }),
		[splat, search, go, href],
	);
	return (
		<>
			<WorkspaceModelProvider
				graph={demoGraph}
				mode="fixture"
				connection="live"
				route={route}
				proposals={scenario.proposals}
			>
				<Workspace />
			</WorkspaceModelProvider>
			<Outlet />
		</>
	);
}
