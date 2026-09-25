/**
 * WP-Places client mutations, all through `useTripMutation` (optimistic graph
 * writes, rollback, self-invalidation, the suggest-mode branch). The server
 * functions are F's (`setNodePriority`, `updateNode`, `createNodePath`,
 * `createItem`); the gate decides apply / propose / forbid.
 */
import type { QueryClient } from "@tanstack/react-query";
import { useTripMutation } from "@/components/common/use-trip-mutation";
import { createItem } from "@/functions/items.functions";
import {
	createNodePath,
	moveNode,
	setNodePriority,
	updateNode,
} from "@/functions/nodes.functions";
import { lifecycleSet } from "@/lib/domain/places-lifecycle";
import type { GraphNode, TripGraph } from "@/lib/engine/types";
import { tripKeys } from "@/lib/query/keys";
import type { IdeaStatus, Priority, ShortlistPin } from "@/lib/schemas/enums";
import type { NodeDetailsPatch } from "@/lib/schemas/nodes";

function patchNode(
	qc: QueryClient,
	tripId: string,
	nodeId: string,
	fn: (n: GraphNode) => GraphNode,
) {
	qc.setQueryData(tripKeys.graph(tripId), (g?: TripGraph) =>
		g ? { ...g, nodes: g.nodes.map((n) => (n.id === nodeId ? fn(n) : n)) } : g,
	);
}

export type SetPriorityVars = {
	nodeId: string;
	memberId: string;
	priority: Priority | null;
	/** Omit to keep the comment; null clears it. */
	comment?: string | null;
};

export function useSetPriority(tripId: string) {
	return useTripMutation((v: SetPriorityVars) => setNodePriority({ data: v }), {
		keys: [tripKeys.graph(tripId)],
		tripId,
		optimistic: (qc, v) =>
			patchNode(qc, tripId, v.nodeId, (n) => {
				const priorities = { ...n.priorities };
				const ratingComments = { ...n.ratingComments };
				if (v.priority === null) {
					delete priorities[v.memberId];
					delete ratingComments[v.memberId];
				} else {
					priorities[v.memberId] = v.priority;
					if (v.comment === null) delete ratingComments[v.memberId];
					else if (typeof v.comment === "string" && v.comment.trim())
						ratingComments[v.memberId] = v.comment.trim();
					else if (typeof v.comment === "string")
						delete ratingComments[v.memberId];
				}
				return { ...n, priorities, ratingComments };
			}),
	});
}

export type UpdateNodeVars = {
	nodeId: string;
	patch: {
		name?: string;
		description?: string;
		category?: GraphNode["category"] & string;
		lat?: number;
		lng?: number;
		address?: string;
		googlePlaceId?: string;
		osmRef?: string;
		countryCode?: string;
		/** A number, or null to go back to the category's default. */
		timeNeededMin?: number | null;
		status?: "active" | "dropped";
		/** docs/PLACES.md §3: the lifecycle decision and the shortlist pin. */
		ideaStatus?: IdeaStatus;
		shortlistPin?: ShortlistPin;
		/** Merged into the stored details; a `null` value deletes that key. */
		details?: NodeDetailsPatch;
		bbox?: [number, number, number, number];
		/** QA TZ-08: an IANA zone override; null = back to the location's zone. */
		tz?: string | null;
	};
};

export function useUpdateNode(tripId: string) {
	return useTripMutation((v: UpdateNodeVars) => updateNode({ data: v }), {
		keys: [tripKeys.graph(tripId)],
		tripId,
		optimistic: (qc, v) =>
			patchNode(qc, tripId, v.nodeId, (n) => {
				const { details, ...rest } = v.patch;
				const next: GraphNode = { ...n };
				if (rest.name !== undefined) next.name = rest.name;
				if (rest.description !== undefined)
					next.description = rest.description.trim() || null;
				if (rest.category !== undefined) next.category = rest.category;
				if (rest.lat !== undefined) next.lat = rest.lat;
				if (rest.lng !== undefined) next.lng = rest.lng;
				if (rest.address !== undefined) next.address = rest.address;
				if (rest.timeNeededMin !== undefined)
					next.timeNeededMin = rest.timeNeededMin;
				Object.assign(next, lifecycleSet(n, rest));
				// null waits for the server (it derives the zone from the coordinates).
				if (typeof rest.tz === "string") next.tz = rest.tz;
				if (details) {
					const merged: Record<string, unknown> = { ...n.details, ...details };
					for (const [k, val] of Object.entries(details))
						if (val === null) delete merged[k];
					next.details = merged as GraphNode["details"];
				}
				return next;
			}),
	});
}

type ChainSegment = Parameters<
	typeof createNodePath
>[0]["data"]["chain"][number];

export function useCreateNodePath(tripId: string) {
	return useTripMutation(
		(v: { chain: ChainSegment[]; ids: string[] }) =>
			createNodePath({ data: { tripId, chain: v.chain, ids: v.ids } }),
		{ keys: [tripKeys.graph(tripId), tripKeys.counts(tripId)], tripId },
	);
}

export type CreateItemVars = {
	id: string;
	dayId: string | null;
	nodeId: string;
	afterItemId?: string;
	beforeItemId?: string;
};

export function useCreateItem(tripId: string) {
	return useTripMutation(
		(v: CreateItemVars) => createItem({ data: { tripId, ...v } }),
		{ keys: [tripKeys.graph(tripId), tripKeys.counts(tripId)], tripId },
	);
}

export function useMoveNode(tripId: string) {
	return useTripMutation(
		(v: { nodeId: string; parentId: string | null }) => moveNode({ data: v }),
		{
			keys: [tripKeys.graph(tripId)],
			tripId,
			optimistic: (qc, v) =>
				patchNode(qc, tripId, v.nodeId, (n) => ({
					...n,
					parentId: v.parentId,
				})),
		},
	);
}
