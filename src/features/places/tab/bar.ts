/**
 * How high the shortlist bar is (owner, 2026-09-25): a place is suggested
 * for the shortlist when its group score reaches a per-person level × the
 * people rating, rounded up. People rating: those whose ratings count and
 * who rated at least half the trip's places (at least 1). The score stays
 * the plain sum, so someone who just joined adds to scores before they
 * raise the bar, and joining never knocks a place off. Pure.
 */
import {
	SHORTLIST_LEVELS,
	type ShortlistLevel,
	type TripSettings,
} from "@/lib/schemas/trips";
import type { StatusInfo } from "./lifecycle";
import { formatScore } from "./score";

export type { ShortlistLevel };
export { SHORTLIST_LEVELS };

/** Halfway between Want (+1) and Really want (+2): two people need +3. */
export const DEFAULT_SHORTLIST_LEVEL: ShortlistLevel = 1.5;

/** The setting's choices, as the group reads them. */
export const LEVEL_LABEL: Record<`${ShortlistLevel}`, string> = {
	"1": "Want",
	"1.5": "Between Want and Really want",
	"2": "Really want",
};

export function isShortlistLevel(v: unknown): v is ShortlistLevel {
	return (SHORTLIST_LEVELS as readonly unknown[]).includes(v);
}

/** The old fixed score, read for a group of two: +2 Want, +3 halfway, +4 Really want. */
export function levelFromMinScore(score: number): ShortlistLevel {
	if (score <= 2) return 1;
	if (score >= 4) return 2;
	return 1.5;
}

/** The trip's level: `shortlistLevel`, else the old `shortlistMinScore`, else 1.5. */
export function shortlistLevel(
	settings:
		| Pick<TripSettings, "shortlistLevel" | "shortlistMinScore">
		| undefined,
): ShortlistLevel {
	const v = settings?.shortlistLevel;
	if (isShortlistLevel(v)) return v;
	const old = settings?.shortlistMinScore;
	if (typeof old === "number" && Number.isFinite(old))
		return levelFromMinScore(old);
	return DEFAULT_SHORTLIST_LEVEL;
}

type Rated = { priorities: Readonly<Record<string, unknown>> };

/** Of `raterIds`, how many rated at least half of `places`. */
export function peopleRating(
	places: readonly Rated[],
	raterIds: readonly string[],
): number {
	if (!places.length) return 0;
	let n = 0;
	for (const m of raterIds) {
		let rated = 0;
		for (const p of places) if (p.priorities[m] != null) rated++;
		if (rated * 2 >= places.length) n++;
	}
	return n;
}

export type ShortlistBar = {
	/** The group score a place needs. */
	bar: number;
	/** People rating (at least 1). */
	people: number;
	level: ShortlistLevel;
};

/**
 * The bar for the trip: `places` are its places to rate (not dropped),
 * `raterIds` the people whose ratings count.
 */
export function shortlistBar(
	level: ShortlistLevel,
	places: readonly Rated[],
	raterIds: readonly string[],
): ShortlistBar {
	const people = Math.max(1, peopleRating(places, raterIds));
	return { level, people, bar: Math.ceil(level * people) };
}

const peopleText = (n: number) => `${n} ${n === 1 ? "person" : "people"}`;

/** "it needs +6 with 4 people rating". */
function needs(bar: ShortlistBar): string {
	return `it needs ${formatScore(bar.bar)} with ${peopleText(bar.people)} rating`;
}

/**
 * Why a place is (or isn't) on the shortlist, for its details and the
 * status chip's tooltip. Null where the shortlist isn't the question
 * (on a day, dropped).
 */
export function shortlistReason(p: {
	info: StatusInfo;
	score: number;
	/** Anyone rated it (whose ratings count). */
	rated: boolean;
	bar: ShortlistBar;
	/** Who pinned it, when known. */
	pinnedBy?: string | null;
}): string | null {
	const { info, score, bar } = p;
	if (info.status === "scheduled" || info.status === "dropped") return null;
	if (info.pinned)
		return p.pinnedBy
			? `Pinned to the shortlist by ${p.pinnedBy}.`
			: "Pinned to the shortlist.";
	const gave = `the group gave it ${formatScore(score)}`;
	if (info.status === "shortlist")
		return `On the shortlist: ${gave}, and ${needs(bar)}.`;
	if (info.unpinned)
		return `Taken off the shortlist by hand: ${gave}, and ${needs(bar)}.`;
	if (!p.rated)
		return `Not on the shortlist yet: nobody has rated it, and ${needs(bar)}.`;
	return `Not on the shortlist yet: ${gave}, and ${needs(bar)}.`;
}

/** A row's reason (`rated`: anyone whose ratings count rated it). */
export function rowReason(
	row: { info: StatusInfo; score: number; top: number | null },
	bar: ShortlistBar,
	pinnedBy?: string | null,
): string | null {
	return shortlistReason({
		info: row.info,
		score: row.score,
		rated: row.top !== null,
		bar,
		pinnedBy,
	});
}
