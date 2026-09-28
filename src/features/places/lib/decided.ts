/**
 * "Mark decided" (owner, 2026-09-28): an editor marks the Where picker's
 * scope decided (a country, a city, the whole trip). The mark reaches down:
 * a place is decided when it, an ancestor or the trip is marked AND it was
 * added before that mark, so places found later still ask. Decided places
 * stop counting as "to rate" and "to talk through"; they stay in All places
 * and on the map. Pure.
 */
import type { GraphIndex } from "@/lib/engine/graph-index";
import type { GraphNode } from "@/lib/engine/types";

type Ix = Pick<GraphIndex, "trip" | "node" | "path" | "graph">;

export type DecidedMark = {
	/** The scope marked: a node, or null for the whole trip. */
	scopeId: string | null;
	/** "Kyoto", or "the trip". */
	name: string;
	/** ISO. */
	at: string;
	/** Who marked it (a user id). */
	by: string | null;
};

/** "Kyoto", or "the trip" at the root. */
export function whereName(scope: { name: string } | null): string {
	return scope ? scope.name : "the trip";
}

/** A scope's own mark (null: the whole trip); null when it isn't marked. */
export function ownMark(ix: Ix, scopeId: string | null): DecidedMark | null {
	if (scopeId === null)
		return ix.trip.decidedAt
			? {
					scopeId: null,
					name: whereName(null),
					at: ix.trip.decidedAt,
					by: ix.trip.decidedBy ?? null,
				}
			: null;
	const n = ix.node(scopeId);
	return n?.decidedAt
		? { scopeId: n.id, name: n.name, at: n.decidedAt, by: n.decidedBy ?? null }
		: null;
}

/** The marks over a scope, nearest first: its own, each ancestor's, the trip's. */
export function marksOver(ix: Ix, scopeId: string | null): DecidedMark[] {
	const ids: (string | null)[] = scopeId
		? ix
				.path(scopeId)
				.map((n) => n.id)
				.reverse()
		: [];
	ids.push(null);
	return ids.flatMap((id) => ownMark(ix, id) ?? []);
}

/** Added before the mark (a place with no known creation time counts as older). */
export function coveredBy(
	mark: Pick<DecidedMark, "at">,
	createdAt: string | null | undefined,
): boolean {
	if (!createdAt) return true;
	return Date.parse(createdAt) < Date.parse(mark.at);
}

/** Anything marked decided in the trip (the walk is skipped when not). */
export function hasMarks(ix: Ix): boolean {
	return !!ix.trip.decidedAt || ix.graph.nodes.some((n) => n.decidedAt);
}

/** The mark that settles a place, nearest first; null: it still asks. */
export function decidedMarkOf(
	ix: Ix,
	node: Pick<GraphNode, "id" | "createdAt">,
): DecidedMark | null {
	for (const m of marksOver(ix, node.id))
		if (coveredBy(m, node.createdAt)) return m;
	return null;
}

export function isDecided(
	ix: Ix,
	node: Pick<GraphNode, "id" | "createdAt">,
): boolean {
	return decidedMarkOf(ix, node) !== null;
}

/** The decided places among `nodes`, by id. */
export function decidedIds(
	ix: Ix,
	nodes: readonly Pick<GraphNode, "id" | "createdAt">[],
): ReadonlySet<string> {
	if (!hasMarks(ix)) return new Set();
	return new Set(nodes.filter((n) => isDecided(ix, n)).map((n) => n.id));
}

/**
 * Decide's header for a scope: "Mark Kyoto decided" (open), "Decided ·
 * Undo" (marked here), or "Decided with Japan" (marked above; its undo
 * lives there, never a second mark). `remark` moves that one mark to now
 * for the places added since: "Mark them decided" here, "Mark Japan's new
 * places decided" inside Japan.
 */
export type ScopeDecision =
	| { kind: "open"; label: string }
	| { kind: "decided"; mark: DecidedMark; remark: string }
	| { kind: "inherited"; mark: DecidedMark; label: string; remark: string };

export function scopeDecision(
	ix: Ix,
	scope: { id: string; name: string } | null,
): ScopeDecision {
	const [first] = marksOver(ix, scope?.id ?? null);
	if (!first)
		return { kind: "open", label: `Mark ${whereName(scope)} decided` };
	if (first.scopeId === (scope?.id ?? null))
		return { kind: "decided", mark: first, remark: "Mark them decided" };
	return {
		kind: "inherited",
		mark: first,
		label: `Decided with ${first.name}`,
		remark: `Mark ${first.name}'s new places decided`,
	};
}

/** The places a decided scope still asks about: added since its mark (dropped ones aside). */
export function addedSince(
	rows: readonly { status: string; decided: boolean }[],
): number {
	return rows.filter((r) => r.status !== "dropped" && !r.decided).length;
}
