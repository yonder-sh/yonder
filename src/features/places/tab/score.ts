/**
 * The group score (docs/PLACES.md §1, owner 2026-09-24): the sum of everyone's
 * ratings on the scale Must +3, Really want +2, Want +1, Sure 0, Meh −1,
 * Nah −2. Unrated counts as 0, so the score rewards consensus (Must + Must =
 * +6, Must alone = +3, Must + Nah = +1). A real veto shows as **Split**
 * instead of a bigger negative. Pure.
 */
import type { Priority } from "@/lib/schemas/enums";

export const RATING_WEIGHT = {
	must: 3,
	really_want: 2,
	want: 1,
	sure_why_not: 0,
	meh: -1,
	nah: -2,
} as const satisfies Record<Priority, number>;

type Ratings = Readonly<Record<string, Priority>>;

/** The ratings that count: those of `memberIds` (every rating when omitted). */
function counted(ratings: Ratings, memberIds?: readonly string[]): Priority[] {
	const out: Priority[] = [];
	if (memberIds) {
		for (const m of memberIds) {
			const p = ratings[m];
			if (p) out.push(p);
		}
	} else for (const p of Object.values(ratings)) if (p) out.push(p);
	return out.filter((p) => p in RATING_WEIGHT);
}

/** Sum of the weights (unrated = 0). */
export function groupScore(
	ratings: Ratings,
	memberIds?: readonly string[],
): number {
	let sum = 0;
	for (const p of counted(ratings, memberIds)) sum += RATING_WEIGHT[p];
	return sum;
}

/** The highest single rating's weight, or null when nobody rated. */
export function topRating(
	ratings: Ratings,
	memberIds?: readonly string[],
): number | null {
	let best: number | null = null;
	for (const p of counted(ratings, memberIds)) {
		const w = RATING_WEIGHT[p];
		if (best === null || w > best) best = w;
	}
	return best;
}

/** Someone rated it Must / Really want AND someone Meh / Nah ("Talk about it"). */
export function isSplit(
	ratings: Ratings,
	memberIds?: readonly string[],
): boolean {
	const ps = counted(ratings, memberIds);
	const keen = ps.some((p) => p === "must" || p === "really_want");
	const against = ps.some((p) => p === "meh" || p === "nah");
	return keen && against;
}

/** Everyone who counts rated it Nah (at least one rating): an automatic drop. */
export function allNah(
	ratings: Ratings,
	memberIds: readonly string[],
): boolean {
	if (!memberIds.length) return false;
	return memberIds.every((m) => ratings[m] === "nah");
}

/** The priority tier a score's chip is coloured like (docs/PLACES.md §1c): taxonomy's. */
export { scoreTier } from "@/lib/domain/taxonomy";

/** "+6", "0", "−2" (a real minus sign). */
export function formatScore(score: number): string {
	if (score > 0) return `+${score}`;
	if (score < 0) return `−${Math.abs(score)}`;
	return "0";
}

export type Scored = { name: string; score: number; top: number | null };

/**
 * Priority order: the group score, then the highest single rating (a place
 * nobody rated comes after one rated Sure), then the name.
 */
export function compareByScore(a: Scored, b: Scored): number {
	return (
		b.score - a.score ||
		(b.top ?? -99) - (a.top ?? -99) ||
		a.name.localeCompare(b.name)
	);
}
