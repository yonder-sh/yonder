/**
 * The trip as the server has it, indexed. `ws.ix` is built from the E7
 * overlay while suggestions are shown (EXTENSIONS §3.6), so an open "move
 * Itoya to Day 1" already has Itoya on Day 1 there. Describing a suggestion,
 * its before → after, its crumb and its conflict must read the trip WITHOUT
 * the suggestions applied: that is `ws.graph`.
 *
 * One index per graph object (a WeakMap), so every row and bar shares it.
 */
import { useMemo } from "react";
import { type GraphIndex, indexGraph } from "@/lib/engine/graph-index";
import type { TripGraph } from "@/lib/engine/types";
import { useWorkspace } from "@/lib/workspace/use-workspace";

const cache = new WeakMap<TripGraph, GraphIndex>();

/** The index of `graph` (reusing `ix` when it was built from the same graph). */
export function baseIndexOf(graph: TripGraph, ix?: GraphIndex): GraphIndex {
	if (ix && ix.graph === graph) return ix;
	let hit = cache.get(graph);
	if (!hit) {
		hit = indexGraph(graph);
		cache.set(graph, hit);
	}
	return hit;
}

/** The server graph's index (no suggestions applied). */
export function useBaseIndex(): GraphIndex {
	const { graph, ix } = useWorkspace();
	return useMemo(() => baseIndexOf(graph, ix), [graph, ix]);
}
