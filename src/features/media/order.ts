/**
 * Media order: the tiles on the same thing (a place, a visit, a day…) in the
 * order everyone sees them, and the Rate feed shows a place's photos in. A
 * tile's menu moves it to the front, one earlier or one later; the server
 * keys the move from its neighbour (`beforeId` / `afterId`).
 */
import type { MediaDto } from "./media.functions";
import { sameTarget } from "./queries";

export type Reorder = { id: string; afterId?: string; beforeId?: string };

/** The media on the same thing as `item`, in order (suggestions and failed uploads aside). */
export function siblingsOf(
	all: readonly MediaDto[],
	item: MediaDto,
): MediaDto[] {
	return all.filter(
		(m) =>
			!m.proposed && m.status !== "failed" && sameTarget(m.target, item.target),
	);
}

/** The moves `id` can make among `sibs` (null where it can't). */
export function reorderMoves(
	sibs: readonly MediaDto[],
	id: string,
): {
	front: Reorder | null;
	earlier: Reorder | null;
	later: Reorder | null;
} {
	const i = sibs.findIndex((m) => m.id === id);
	const first = sibs[0];
	const prev = sibs[i - 1];
	const next = sibs[i + 1];
	return {
		front: i > 0 && first ? { id, beforeId: first.id } : null,
		earlier: i > 0 && prev ? { id, beforeId: prev.id } : null,
		later: i >= 0 && next ? { id, afterId: next.id } : null,
	};
}

/** The list with the move applied (shown at once; the server's order follows). */
export function applyReorder(xs: readonly MediaDto[], v: Reorder): MediaDto[] {
	const moving = xs.find((m) => m.id === v.id);
	const anchor = v.beforeId ?? v.afterId;
	const rest = xs.filter((m) => m.id !== v.id);
	const at = rest.findIndex((m) => m.id === anchor);
	if (!moving || at < 0) return [...xs];
	rest.splice(v.beforeId ? at : at + 1, 0, moving);
	return rest;
}
