import { createFileRoute, notFound, redirect } from "@tanstack/react-router";
import { z } from "zod";
import { placesFromRate } from "@/features/places/tab/entry";
import { requireTripViewer } from "@/lib/auth/guards";
import { indexGraph } from "@/lib/engine/graph-index";
import { slugPath } from "@/lib/engine/tree";
import { errorCode } from "@/lib/errors";
import { tripGraphQuery, tripSlugQuery } from "@/lib/query/trip-queries";
import { FILTER_PARAM_RE } from "@/lib/workspace/filter";

/**
 * `/t/<trip>/rate` (ADDENDUM §10) is folded into the Places tab
 * (docs/PLACES.md §1b): old links, bookmarks and the dashboard's "Rate
 * places" land on the tab's Rate view at the same scope with the same
 * filter (`view=table|compare` open the table; `n` opens on that place;
 * `set=ideas` is the Ideas pill). `rate` stays a reserved top-level slug
 * (ROOT_RESERVED_SLUGS).
 */
export const RateSearch = z.object({
	view: z.enum(["cards", "table", "compare"]).optional().catch(undefined),
	f: z.string().regex(FILTER_PARAM_RE).optional().catch(undefined),
	n: z.uuid().optional().catch(undefined),
	in: z.uuid().optional().catch(undefined),
	set: z.enum(["ideas"]).optional().catch(undefined),
});

export const Route = createFileRoute("/t/$trip_/rate")({
	ssr: false,
	validateSearch: RateSearch,
	beforeLoad: ({ params, location, context }) =>
		requireTripViewer(params.trip, location.href, {
			queryClient: context.queryClient,
		}),
	loaderDeps: ({ search }) => search,
	loader: async ({ context, params, deps }) => {
		let target: { splat: string; search: Record<string, unknown> };
		try {
			const { tripId } = await context.queryClient.ensureQueryData(
				tripSlugQuery(params.trip),
			);
			const graph = await context.queryClient.ensureQueryData(
				tripGraphQuery(tripId),
			);
			const ix = indexGraph(graph);
			const { scopeId, search } = placesFromRate(deps, (id) => ix.node(id));
			target = {
				splat: scopeId ? slugPath(ix, scopeId).join("/") : "",
				search,
			};
		} catch (e) {
			const code = errorCode(e);
			if (code === "NOT_FOUND" || code === "FORBIDDEN") throw notFound();
			throw e;
		}
		if (target.splat)
			throw redirect({
				to: "/t/$trip/$",
				params: { trip: params.trip, _splat: target.splat },
				search: target.search,
				replace: true,
			});
		throw redirect({
			to: "/t/$trip",
			params: { trip: params.trip },
			search: target.search,
			replace: true,
		});
	},
	component: () => null,
});
