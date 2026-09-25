/**
 * "Where are they" (FB-17a): what to say about a person who is on the trip
 * but not on my screen. Pure, for the chips and tests.
 */
import type { AwarenessView, Peer } from "@/lib/realtime/protocol";

const TAB_WORD = {
	overview: "Overview",
	plan: "Plan",
	places: "Places",
	media: "Media",
	lists: "Lists",
	notes: "Notes",
	money: "Money",
} as const;

export type Where = {
	/** "in Kyoto", "Money tab", "Lists tab · in Kyoto". */
	text: string;
	/** They are somewhere else in the trip (another scope). */
	elsewhere: boolean;
};

/**
 * Null when they are where I am (same scope and tab: their cursor says it),
 * or when they publish no view yet. `canSeeMoney` false (a link guest) never
 * names the Money tab.
 */
export function whereOf(
	view: AwarenessView | undefined,
	me: { scopeId: string | null; tab: keyof typeof TAB_WORD },
	tripName: string,
	canSeeMoney: boolean,
): Where | null {
	if (!view) return null;
	const tab = view.tab === "money" && !canSeeMoney ? "plan" : view.tab;
	const sameScope = (view.scopeId ?? null) === me.scopeId;
	if (sameScope && tab === me.tab) return null;
	const tabText = tab === "plan" ? null : `${TAB_WORD[tab]} tab`;
	if (sameScope) return { text: tabText ?? "Plan", elsewhere: false };
	const place = view.scopeId ? view.scopeName || "another place" : tripName;
	const inText = view.scopeId ? `in ${place}` : `on ${place}`;
	return {
		text: tabText ? `${tabText} · ${inText}` : inText,
		elsewhere: true,
	};
}

/** Peers (one per user) who follow `userId`. */
export function followersOf(
	peers: readonly Peer[],
	userId: string | null,
): Peer[] {
	if (!userId) return [];
	return peers.filter((p) => p.following === userId);
}

/** The peer whose spotlight I should follow (the first one, by name), if any. */
export function spotlightPresenter(
	peers: readonly Peer[],
	dismissed: ReadonlySet<string>,
): Peer | null {
	return (
		peers.find(
			(p) =>
				p.spotlight &&
				typeof p.spotlight.id === "string" &&
				!dismissed.has(p.spotlight.id),
		) ?? null
	);
}
