/**
 * The rate screen's pure logic (ADDENDUM §10): which nodes can be rated, the
 * shared `f` filter applied to them, the owner's ranking rule (max of the
 * members' ratings, then their sum), and per-member progress ("Audrey 47/125").
 */

import {
	PLACE_CATEGORIES,
	PRIORITIES,
	PRIORITY_ORDER,
	priorityRank,
} from "@/lib/domain/taxonomy";
import type { GraphIndex } from "@/lib/engine/graph-index";
import type { GraphMember, GraphNode } from "@/lib/engine/types";
import { mentionsAsText } from "@/lib/notes/mentions";
import type { Priority } from "@/lib/schemas/enums";
import { RATING_COMMENT_MAX } from "@/lib/schemas/nodes";
import type { WorkspaceFilter } from "@/lib/workspace/filter";

/**
 * What members rate: places to go and neighbourhoods (the sheet's 125 Places
 * rows, "Neighborhood" ones imported as areas: ADDENDUM's "Audrey 47/125").
 * Airports, stations and ports (transit) and lodging (stays) are logistics,
 * not something to rate.
 *
 * An area counts only when it is a destination in itself: it has its own
 * description or time needed, came from the sheet as a Neighborhood, or
 * someone already rated or commented on it. Wards and districts that only
 * hold places (the importer's and the filing's structure: Fujinomiya,
 * Haneda, Setagaya…) are not cards to rate.
 */
export function isRateable(
	n: Pick<GraphNode, "type" | "category"> &
		Partial<
			Pick<
				GraphNode,
				| "description"
				| "timeNeededMin"
				| "details"
				| "priorities"
				| "ratingComments"
			>
		>,
): boolean {
	if (n.type === "place") {
		const group = PLACE_CATEGORIES[n.category ?? "other"]?.group;
		return group !== "transit" && group !== "stay";
	}
	if (n.type !== "area") return false;
	return (
		!!n.description?.trim() ||
		n.timeNeededMin != null ||
		!!n.details?.sheetCategory ||
		Object.keys(n.priorities ?? {}).length > 0 ||
		Object.keys(n.ratingComments ?? {}).length > 0
	);
}

/**
 * The rateable nodes inside `scopeId` (the scope itself excluded unless it is
 * rateable), in outline order. Dropped nodes are left out unless asked for.
 * `liveIds` (the server graph's node ids) leaves out proposal ghosts: an
 * unaccepted suggestion can't be rated until it is reviewed.
 */
export function rateableNodes(
	ix: GraphIndex,
	scopeId: string | null,
	opts: { includeDropped?: boolean; liveIds?: ReadonlySet<string> } = {},
): GraphNode[] {
	return ix.outline.filter(
		(n) =>
			isRateable(n) &&
			(!opts.liveIds || opts.liveIds.has(n.id)) &&
			ix.isWithin(n.id, scopeId) &&
			(opts.includeDropped || !ix.isDropped(n.id)),
	);
}

/** Members who rate: everyone assignable except viewers who never rated anything. */
export function raters(
	members: readonly GraphMember[],
	nodes: readonly GraphNode[],
): GraphMember[] {
	const rated = new Set<string>();
	for (const n of nodes)
		for (const m of Object.keys(n.priorities)) rated.add(m);
	return members.filter(
		(m) =>
			m.status !== "removed" &&
			!m.mergedIntoId &&
			(m.role !== "viewer" || rated.has(m.id)),
	);
}

/**
 * The shared filter itself is F's (`@/lib/workspace/filter-match`): the Rate
 * screen applies exactly the matcher the Outline, Ideas and the map use.
 */
export {
	filterContextOf,
	matchesFilter,
} from "@/lib/workspace/filter-match";

/**
 * A filter from a link, as the rate screen reads it (FB-05 deep links):
 * "unrated by <my own member id>" is "unrated by me", so the control shows
 * it and the URL stays the same one the Still to plan panel builds.
 */
export function ownFilter(
	f: WorkspaceFilter,
	me: string | null,
): WorkspaceFilter {
	return me && f.unratedBy === me ? { ...f, unratedBy: "me" } : f;
}

/** Ranking key: `[max, sum]` over the members' ratings (the owner's rule). */
export function rankKey(
	n: Pick<GraphNode, "priorities">,
	memberIds?: readonly string[],
): [number, number] {
	const ratings = memberIds
		? memberIds.map((m) => n.priorities[m])
		: Object.values(n.priorities);
	return priorityRank(ratings);
}

/** Highest max first, then highest sum, then name (unrated last). */
export function compareRank(
	a: Pick<GraphNode, "priorities" | "name">,
	b: Pick<GraphNode, "priorities" | "name">,
	memberIds?: readonly string[],
): number {
	const [amax, asum] = rankKey(a, memberIds);
	const [bmax, bsum] = rankKey(b, memberIds);
	return bmax - amax || bsum - asum || a.name.localeCompare(b.name);
}

/** Tier label for a ranking row: its max rating ("Must"), or "Not rated". */
export function tierOf(
	n: Pick<GraphNode, "priorities">,
	memberIds?: readonly string[],
): Priority | null {
	const [max] = rankKey(n, memberIds);
	if (max < 0) return null;
	return PRIORITY_ORDER.find((p) => PRIORITIES[p].score === max) ?? null;
}

export type MemberProgress = { memberId: string; rated: number; total: number };

export function progressOf(
	nodes: readonly GraphNode[],
	members: readonly Pick<GraphMember, "id">[],
): MemberProgress[] {
	return members.map((m) => ({
		memberId: m.id,
		rated: nodes.filter((n) => n.priorities[m.id] !== undefined).length,
		total: nodes.length,
	}));
}

/** Keyboard shortcut → priority: 1 Must … 6 Nah (PRIORITY_ORDER). */
export function priorityForKey(key: string): Priority | null {
	const i = Number.parseInt(key, 10);
	if (!Number.isInteger(i) || i < 1 || i > PRIORITY_ORDER.length) return null;
	return PRIORITY_ORDER[i - 1] ?? null;
}

/**
 * A rating comment's limit, in the characters you see (ADDENDUM §10). It is
 * the one the server enforces too (`RatingComment`, PLAN-R3-03): a mention
 * counts as its "@Name", however many mentions a comment has. The stored
 * text keeps the tokens (`[@Audrey Tester](mention:<uuid>)`, about 50
 * characters more each), and `node_priorities_comment_ck` leaves room for a
 * comment of nothing but mentions.
 */
export const COMMENT_MAX = RATING_COMMENT_MAX;

/** A comment as it reads: every mention token as its "@Name". */
export const commentVisibleText = mentionsAsText;

/**
 * The comment counter (PLAN-R2-07): `shown` counts what you see, so
 * "ask @Audrey Tester" is 18, not the 67 of its stored form; `over` says by
 * how many characters a draft is over the 280 you see.
 */
export function commentLength(draft: string): {
	shown: number;
	over: null | { by: number };
} {
	const shown = commentVisibleText(draft.trim()).length;
	return {
		shown,
		over: shown > COMMENT_MAX ? { by: shown - COMMENT_MAX } : null,
	};
}

/**
 * Where ← goes on the rate screen: back along the trail of cards you came
 * from (the card you just rated, even when rating jumped ahead or the
 * filter dropped it), skipping the one in view and any no longer rateable
 * here. Returns the card and its trail position (the trail is cut there),
 * or null when the trail is spent (← then takes the previous card).
 */
export function backTarget(
	trail: readonly string[],
	current: string | undefined,
	rateable: ReadonlySet<string>,
): { id: string; at: number } | null {
	for (let at = trail.length - 1; at >= 0; at--) {
		const id = trail[at] as string;
		if (id !== current && rateable.has(id)) return { id, at };
	}
	return null;
}

/**
 * The next card after rating: the next node in `order` that `me` hasn't
 * rated yet, wrapping around; else simply the next one; null at the end.
 */
export function nextCard(
	order: readonly GraphNode[],
	currentId: string | null,
	me: string | null,
): string | null {
	if (!order.length) return null;
	const at = currentId ? order.findIndex((n) => n.id === currentId) : -1;
	for (let k = 1; k <= order.length; k++) {
		const n = order[(at + k) % order.length] as GraphNode;
		if (n.id === currentId) break;
		if (!me || n.priorities[me] === undefined) return n.id;
	}
	const next = order[at + 1];
	return next ? next.id : null;
}
