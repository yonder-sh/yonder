/**
 * Component-test harness (SPEC §4.1, F1u): renders UI inside a working
 * workspace — the demo fixture graph (or yours), a QueryClient, tooltips, and
 * an in-memory URL (`splat` + `search`) that `nav.*` really updates — with no
 * router, server or socket.
 *
 *   const { ws, rerender } = renderWithWorkspace(<PlanTab />, { splat: "japan/tokyo" })
 *   await user.click(screen.getByText("Shibuya Sky"))
 *   expect(ws().sel).toEqual({ kind: "item", id: … })
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { type RenderResult, render } from "@testing-library/react";
import { type ReactElement, type ReactNode, useMemo, useState } from "react";
import { TooltipProvider } from "@/components/ui/tooltip";
import type { TripCounts, TripGraph } from "@/lib/engine/types";
import { demoGraph } from "@/lib/fixtures/demo";
import type { ProposalDto } from "@/lib/schemas/proposals";
import {
	type ConnectionState,
	useWorkspaceOptional,
	type Workspace,
	type WorkspaceMode,
	WorkspaceModelProvider,
	type WorkspaceRouteBinding,
} from "@/lib/workspace/model-context";
import type { NavTarget } from "@/lib/workspace/nav";
import type { WorkspaceSearch } from "@/lib/workspace/search";

export type RenderWorkspaceOptions = {
	graph?: TripGraph;
	counts?: TripCounts;
	/** Scope path, e.g. "japan/tokyo". */
	splat?: string;
	search?: WorkspaceSearch;
	/** "fixture" (default) never calls the server; "live" enables feature queries. */
	mode?: WorkspaceMode;
	connection?: ConnectionState;
	queryClient?: QueryClient;
	/** E7 open proposals (none by default; `scenario.proposals` for ghosts). */
	proposals?: ProposalDto[];
};

export function renderWithWorkspace(
	ui: ReactElement,
	opts: RenderWorkspaceOptions = {},
): RenderResult & {
	/** The latest workspace value (after any navigation). */
	ws: () => Workspace;
	/** Every navigation the UI made, in order. */
	navigations: NavTarget[];
} {
	const queryClient =
		opts.queryClient ??
		new QueryClient({ defaultOptions: { queries: { retry: false } } });
	const navigations: NavTarget[] = [];
	let latest: Workspace | null = null;

	function Capture() {
		latest = useWorkspaceOptional();
		return null;
	}

	function Harness({ children }: { children: ReactNode }) {
		const [loc, setLoc] = useState<NavTarget>({
			splat: opts.splat ?? "",
			search: opts.search ?? {},
		});
		const route = useMemo<WorkspaceRouteBinding>(
			() => ({
				splat: loc.splat,
				search: loc.search,
				go: (t) => {
					navigations.push(t);
					setLoc(t);
				},
				href: (t) =>
					`/t/${(opts.graph ?? demoGraph).trip.slug}/${t.splat}?${new URLSearchParams(
						Object.entries(t.search).map(([k, v]) => [k, String(v)]),
					)}`,
			}),
			[loc],
		);
		return (
			<QueryClientProvider client={queryClient}>
				<TooltipProvider>
					<WorkspaceModelProvider
						graph={opts.graph ?? demoGraph}
						counts={opts.counts}
						mode={opts.mode ?? "fixture"}
						connection={opts.connection ?? "live"}
						route={route}
						proposals={opts.proposals}
					>
						<Capture />
						{children}
					</WorkspaceModelProvider>
				</TooltipProvider>
			</QueryClientProvider>
		);
	}

	const result = render(ui, { wrapper: Harness });
	return {
		...result,
		navigations,
		ws: () => {
			if (!latest) throw new Error("workspace not rendered");
			return latest;
		},
	};
}
