/**
 * WP-Suggest's component-test helpers on top of F's `renderWithWorkspace`
 * (`src/test/render-workspace.tsx`): the demo graph as any role (`graphAs`)
 * and `renderSuggest` (the fixture proposals by default).
 */
import { QueryClient } from "@tanstack/react-query";
import type { ReactElement } from "react";
import type { TripRole } from "@/lib/auth/roles";
import type { TripGraph } from "@/lib/engine/types";
import { demoGraph, scenario } from "@/lib/fixtures/demo";
import {
	type RenderWorkspaceOptions,
	renderWithWorkspace,
} from "@/test/render-workspace";

export const MAYA_USER = "user-maya";

/** The demo graph as someone else: Maya the suggester, a viewer, a guest… */
export function graphAs(
	role: TripRole,
	opts: { userId?: string; isGuest?: boolean; name?: string } = {},
): TripGraph {
	const userId = opts.userId ?? (role === "owner" ? "user-dennis" : MAYA_USER);
	const mayaMember = "00000000-0000-7000-8000-000000000053";
	return {
		...demoGraph,
		me: {
			userId,
			memberId: opts.isGuest
				? null
				: role === "owner"
					? demoGraph.me.memberId
					: mayaMember,
			role,
			isGuest: opts.isGuest ?? false,
			name: opts.name ?? (role === "owner" ? "Dennis" : "Maya"),
			color: 2,
		},
		members: [
			...demoGraph.members,
			{
				id: mayaMember,
				userId: MAYA_USER,
				status: "active",
				role: role === "owner" ? "suggester" : role,
				name: "Maya Chen",
				firstName: "Maya",
				color: 2,
			},
		],
	};
}

/**
 * F's `renderWithWorkspace` with WP-Suggest's defaults: the fixture's
 * proposals, and a QueryClient that never retries (mutations included, so a
 * mocked failure settles at once).
 */
export function renderSuggest(
	ui: ReactElement,
	opts: RenderWorkspaceOptions = {},
) {
	const queryClient =
		opts.queryClient ??
		new QueryClient({
			defaultOptions: {
				queries: { retry: false },
				mutations: { retry: false },
			},
		});
	return {
		...renderWithWorkspace(ui, {
			...opts,
			queryClient,
			proposals: opts.proposals ?? scenario.proposals,
		}),
		queryClient,
	};
}
