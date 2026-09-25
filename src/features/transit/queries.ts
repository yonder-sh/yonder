/**
 * WP-Transit's client queries. The leg row with its `alternatives` comes from
 * F's `legQuery` (`getLeg`, invalidated with the graph); the rail info
 * (attribution, "data as of") is static per build.
 */
import { queryOptions, useQuery } from "@tanstack/react-query";
import { tripKeys } from "@/lib/query/keys";
import { legQuery } from "@/lib/query/trip-queries";
import type { LegTarget } from "@/lib/schemas/targets";
import { useWorkspace } from "@/lib/workspace/use-workspace";
import { getRailInfo } from "./transit.functions";

export const railInfoQuery = () =>
	queryOptions({
		queryKey: ["transit", "rail-info"] as const,
		queryFn: () => getRailInfo(),
		staleTime: Number.POSITIVE_INFINITY,
		gcTime: Number.POSITIVE_INFINITY,
	});

/** The leg row (with alternatives) in live mode; null in fixture mode. */
export function useLegRow(target: LegTarget) {
	const ws = useWorkspace();
	return useQuery({
		...legQuery(ws.graph.trip.id, target),
		enabled: ws.mode === "live",
	});
}

/** Every key a leg write changes in this tab (the live event skips it). */
export const legKeys = (tripId: string) => [
	tripKeys.graph(tripId),
	tripKeys.legs(tripId),
	tripKeys.counts(tripId),
];
