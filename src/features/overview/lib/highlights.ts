/**
 * docs/OVERVIEW.md §6 "Highlights mosaic": the group's top-rated places that
 * have a photo, up to six. After the trip the most-photographed places come
 * first (then the group's favourites). Pure.
 */
import { compareByScore } from "@/features/places/tab/score";

export interface HighlightCandidate {
	id: string;
	name: string;
	/** Group score (`groupScore`). */
	score: number;
	/** The highest single rating's weight (`topRating`). */
	top: number | null;
	/** Its cover photo's attachment id, if it has one. */
	coverId: string | null;
	/** Photos and videos attached to it. */
	photos: number;
}

export function pickHighlights(
	cands: readonly HighlightCandidate[],
	opts: { after: boolean; limit?: number },
): HighlightCandidate[] {
	const withPhoto = cands.filter((c) => c.coverId);
	const sorted = [...withPhoto].sort((a, b) =>
		opts.after
			? b.photos - a.photos || compareByScore(a, b)
			: compareByScore(a, b),
	);
	return sorted.slice(0, opts.limit ?? 6);
}

/** The group's favourites: the best scores above zero. */
export function favourites(
	cands: readonly HighlightCandidate[],
	limit = 3,
): HighlightCandidate[] {
	return cands
		.filter((c) => c.score > 0)
		.sort(compareByScore)
		.slice(0, limit);
}
