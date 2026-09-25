/**
 * The places lifecycle as the Places tab shows it (docs/PLACES.md §3):
 * Idea → Shortlist → Scheduled, or Dropped. Scheduled is derived (the place
 * is on a day); the shortlist is **suggested** at a group score of
 * `shortlistMinScore` (a trip setting, default +3) or more, and anyone with
 * edit rights can pin a place on (it stays whatever the ratings) or unpin a
 * suggested one (it stays off until the ratings change). Dropped is explicit,
 * or everyone rated it Nah. Pure.
 */
import type { LifecycleFields } from "@/lib/domain/places-lifecycle";
import type { ShortlistPin, TripSettings } from "@/lib/engine/types";

export type PlaceStatus = "idea" | "shortlist" | "scheduled" | "dropped";

export const STATUS_LABEL: Record<PlaceStatus, string> = {
	idea: "Idea",
	shortlist: "Shortlist",
	scheduled: "Scheduled",
	dropped: "Dropped",
};

export const DEFAULT_SHORTLIST_MIN = 3;

export function shortlistThreshold(
	settings: Pick<TripSettings, "shortlistMinScore"> | undefined,
): number {
	const v = settings?.shortlistMinScore;
	return typeof v === "number" && Number.isFinite(v)
		? v
		: DEFAULT_SHORTLIST_MIN;
}

export type StatusInfo = {
	status: PlaceStatus;
	/** On the shortlist because of its score (not pinned). */
	suggested: boolean;
	/** Pinned on by hand. */
	pinned: boolean;
	/** Taken off by hand although its score would suggest it. */
	unpinned: boolean;
	/** Dropped because everyone rated it Nah (not by hand). */
	autoDropped: boolean;
};

export function placeStatus(p: {
	/** Dropped by hand (`status` / `ideaStatus`, or an ancestor dropped). */
	dropped: boolean;
	/** On a day. */
	scheduled: boolean;
	pin: ShortlistPin;
	score: number;
	threshold: number;
	/** Everyone who rates rated it Nah. */
	allNah: boolean;
}): StatusInfo {
	const base = {
		suggested: false,
		pinned: false,
		unpinned: false,
		autoDropped: false,
	};
	if (p.dropped) return { ...base, status: "dropped" };
	if (p.scheduled) return { ...base, status: "scheduled" };
	if (p.allNah && p.pin !== "pinned")
		return { ...base, status: "dropped", autoDropped: true };
	if (p.pin === "pinned") return { ...base, status: "shortlist", pinned: true };
	const above = p.score >= p.threshold;
	if (p.pin === "unpinned") return { ...base, status: "idea", unpinned: above };
	return above
		? { ...base, status: "shortlist", suggested: true }
		: { ...base, status: "idea" };
}

/** Still to decide: an idea or a shortlist pick (the tab's count badge). */
export function toDecide(s: PlaceStatus): boolean {
	return s === "idea" || s === "shortlist";
}

export type ShortlistToggle = { shortlistPin: ShortlistPin };

/**
 * S (pin / unpin), preferring to hand the decision back to the ratings: a
 * pinned place whose score would not suggest it goes back to `auto`; one
 * the score suggests is unpinned. Off the list: an unpinned place the score
 * suggests goes back to `auto` (on again), anything else is pinned.
 */
export function toggleShortlist(s: {
	status: PlaceStatus;
	pinned: boolean;
	suggested: boolean;
	unpinned: boolean;
	score: number;
	threshold: number;
}): ShortlistToggle {
	const above = s.score >= s.threshold;
	if (s.status === "shortlist")
		return { shortlistPin: s.pinned && !above ? "auto" : "unpinned" };
	if (s.unpinned && above) return { shortlistPin: "auto" };
	return { shortlistPin: "pinned" };
}

/** D: drop, or bring a dropped place back. */
export function toggleDrop(droppedByHand: boolean): LifecycleFields {
	return droppedByHand
		? { status: "active" }
		: { status: "dropped", ideaStatus: "dropped" };
}
