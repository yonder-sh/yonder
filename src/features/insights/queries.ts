/**
 * WP-Insights queries. Climate normals are static, so they sit under the
 * trip's prefix (a resync or an access change drops them) but outside every
 * live-invalidation bucket, and never go stale.
 */
import { queryOptions } from "@tanstack/react-query";
import { tripKeys } from "@/lib/query/keys";
import { getClimate } from "./insights.functions";

export const climateQuery = (tripId: string, nodeIds: readonly string[]) =>
	queryOptions({
		queryKey: [
			...tripKeys.trip(tripId),
			"climate",
			...[...nodeIds].sort(),
		] as const,
		queryFn: () => getClimate({ data: { tripId, nodeIds: [...nodeIds] } }),
		staleTime: Number.POSITIVE_INFINITY,
		gcTime: 24 * 3600 * 1000,
		retry: 1,
	});
