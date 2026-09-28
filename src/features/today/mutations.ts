/**
 * Today's data hooks (One Yonder phase 5): Done on a stop (shared by the
 * group, optimistic, never a proposal) and a place's address in local script
 * for the driver. The fixes ("Shorten dinner", "Skip Bic Camera") use the
 * Plan's own `updateItem` / `useMoveItem` (to Ideas) with their Undo.
 */
import {
	type QueryClient,
	useQuery,
	useQueryClient,
} from "@tanstack/react-query";
import { useTripMutation } from "@/components/common/use-trip-mutation";
import { getLocalAddress } from "@/features/places/places.functions";
import { setItemDone } from "@/functions/items.functions";
import type { GraphNode, TripGraph } from "@/lib/engine/types";
import { tripKeys } from "@/lib/query/keys";

export type SetItemDoneVars = {
	itemId: string;
	done: boolean;
	/** Who marks it (a user id), for the optimistic write; with `at`, who marked it then. */
	by: string;
	/** A stamp (ISO): the Undo of an Undo, or the `?asOf` time; the server holds it to now off a test stack. */
	at?: string;
};

/** The graph with one item's Done set or cleared (the optimistic write). */
export function patchDone(g: TripGraph, v: SetItemDoneVars): TripGraph {
	return {
		...g,
		items: g.items.map((i) =>
			i.id === v.itemId
				? {
						...i,
						doneAt: v.done ? (v.at ?? new Date().toISOString()) : null,
						doneBy: v.done ? v.by : null,
					}
				: i,
		),
	};
}

/** Done / Undo on a stop, for owners and editors (`can(access, "markDone")`). */
export function useSetItemDone(tripId: string) {
	return useTripMutation(
		({ itemId, done, at, by }: SetItemDoneVars) =>
			setItemDone({
				data: { tripId, itemId, done, ...(at ? { at, by } : {}) },
			}),
		{
			keys: [tripKeys.graph(tripId)],
			direct: true,
			optimistic: (qc, v) =>
				qc.setQueryData(tripKeys.graph(tripId), (g?: TripGraph) =>
					g ? patchDone(g, v) : g,
				),
		},
	);
}

function patchLocalAddress(
	qc: QueryClient,
	tripId: string,
	nodeId: string,
	localAddress: string,
) {
	qc.setQueryData(tripKeys.graph(tripId), (g?: TripGraph) =>
		g
			? {
					...g,
					nodes: g.nodes.map((n) =>
						n.id === nodeId ? { ...n, localAddress } : n,
					),
				}
			: g,
	);
}

/**
 * "Show this to the driver" (P16): the place's address in local script, from
 * the graph when known, else looked up once (Photon) and kept on the place.
 * `localAddress` stays null when unknown or offline; it never errors.
 */
export function useLocalAddress(
	tripId: string,
	node: Pick<GraphNode, "id" | "lat" | "localAddress"> | null | undefined,
	enabled = true,
): { localAddress: string | null; loading: boolean } {
	const qc = useQueryClient();
	const known = node?.localAddress ?? null;
	const nodeId = node?.id ?? "";
	const q = useQuery({
		queryKey: tripKeys.localAddress(tripId, nodeId),
		queryFn: async () => {
			const r = await getLocalAddress({ data: { tripId, nodeId } }).catch(
				() => ({ localAddress: null }),
			);
			if (r.localAddress) patchLocalAddress(qc, tripId, nodeId, r.localAddress);
			return r.localAddress;
		},
		enabled: enabled && !!nodeId && known === null && node?.lat != null,
		staleTime: Number.POSITIVE_INFINITY,
		retry: false,
	});
	return { localAddress: known ?? q.data ?? null, loading: q.isFetching };
}
