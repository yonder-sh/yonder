/**
 * TanStack Query key factory: the shared contract between queries, mutations and
 * live invalidation (SPEC §12.2, §10.5).
 *
 * Every trip-scoped query key starts with `['trip', tripId, <TripKey>]`, so a live
 * `invalidate` event naming a TripKey (or a full resync of `['trip', tripId]`)
 * reaches every query built on these helpers. Feature packages build their own
 * `queryOptions` on top of `tripKeys` and must not invent parallel key shapes.
 */

/**
 * The invalidation vocabulary of the realtime protocol. A server mutation names
 * the keys it changed; clients invalidate `['trip', tripId, key]` for each.
 */
export const TRIP_KEYS = [
	"graph",
	"counts",
	"lists",
	"media",
	"notes",
	"sharing",
	"activity",
	// F-ext0 (EXTENSIONS §2.3)
	"proposals",
	"money",
] as const;
export type TripKey = (typeof TRIP_KEYS)[number];

export function isTripKey(v: unknown): v is TripKey {
	return typeof v === "string" && (TRIP_KEYS as readonly string[]).includes(v);
}

export const tripKeys = {
	/** Every trip query of every trip. */
	all: ["trip"] as const,
	/** Every query of one trip: the resync / reconnect / access-change target. */
	trip: (tripId: string) => ["trip", tripId] as const,
	/** One invalidation bucket of a trip (prefix of the concrete queries below). */
	byKey: (tripId: string, key: TripKey) => ["trip", tripId, key] as const,
	/** `getTripGraph` (F): nodes, days, items, legs, members; carries `trip.version`. */
	graph: (tripId: string) => ["trip", tripId, "graph"] as const,
	/** `getTripCounts` (F). */
	counts: (tripId: string) => ["trip", tripId, "counts"] as const,
	/** `listTripListItems` (WP-Lists). */
	lists: (tripId: string) => ["trip", tripId, "lists"] as const,
	/** `listTripMedia` (WP-Media). */
	media: (tripId: string) => ["trip", tripId, "media"] as const,
	/** `listTripNotes` (WP-Lists): derived note JSON/plain text, not the Y.Docs. */
	notes: (tripId: string) => ["trip", tripId, "notes"] as const,
	/** `getSharing` (WP-Home). */
	sharing: (tripId: string) => ["trip", tripId, "sharing"] as const,
	/** `listActivity` (F); `target` narrows it to one node/item/leg/day (any stable string). */
	activity: (tripId: string, target?: string) =>
		target === undefined
			? (["trip", tripId, "activity"] as const)
			: (["trip", tripId, "activity", target] as const),
	/** `listProposals` (F, E7): open + recent proposals. `[]` for viewers and guest viewers. */
	proposals: (tripId: string) => ["trip", tripId, "proposals"] as const,
	/** `listMoney` (WP-Money, E5): expenses, payments, settlements, budgets. Members only. */
	money: (tripId: string) => ["trip", tripId, "money"] as const,
	/**
	 * `getDigest` (F, E6): snapshotted once per trip open (`staleTime: Infinity`)
	 * and deliberately NOT under a TripKey, so live events never grow the banner.
	 */
	digest: (tripId: string) => ["tripDigest", tripId] as const,
	/** `getLeg` (F): one leg with alternatives. Invalidated together with `graph`. */
	leg: (tripId: string, legKey: string) =>
		["trip", tripId, "leg", legKey] as const,
	/** Prefix of every `leg` query of a trip. */
	legs: (tripId: string) => ["trip", tripId, "leg"] as const,
} as const;

/** Per-user (not per-trip) queries. */
export const meKeys = {
	all: ["me"] as const,
	/** `listMyTrips` (WP-Home). */
	trips: ["me", "trips"] as const,
	/** `listMyDeadlines` (WP-Home): invalidated by the `lists` TripKey. */
	deadlines: ["me", "deadlines"] as const,
	/** `listMyMentions` (WP-Lists): invalidated by `mention` events. */
	mentions: ["me", "mentions"] as const,
	/** `getUserPrefs` (F, ADDENDUM §7.2): view settings synced to the account. */
	prefs: ["me", "prefs"] as const,
	/**
	 * `listInbox` (F, ADDENDUM §10 one inbox): invalidated by mention events and
	 * by the `lists`, `proposals` and `money` TripKeys (due todos, reviews,
	 * results, balance and budget notices).
	 */
	inbox: ["me", "inbox"] as const,
	/** `getStorageUsage` (ADDENDUM §12): the account's storage used and quota. */
	storage: ["me", "storage"] as const,
} as const;

/** `getPublicConfig`: runtime settings the browser needs (Turnstile site key). */
export const publicConfigKey = ["publicConfig"] as const;

/** `getSessionFn` (F). */
export const sessionKey = ["session"] as const;
/** `getCapabilities` (F). */
export const capabilitiesKey = ["capabilities"] as const;
/** `resolveTripSlug` (F): slug → `{ tripId }`, `staleTime: Infinity`. */
export const tripSlugKey = (slug: string) => ["tripSlug", slug] as const;

/**
 * The query-key prefixes one TripKey invalidates. Most map 1:1; a few also touch
 * queries outside `['trip', id, key]` (SPEC §12.2 "Invalidated by").
 */
export function keysToInvalidate(
	tripId: string,
	key: TripKey,
): readonly (readonly unknown[])[] {
	switch (key) {
		case "graph":
			// `getLeg` is derived from the same rows as the graph.
			return [tripKeys.graph(tripId), tripKeys.legs(tripId)];
		case "lists":
			// The dashboard's deadline list reads list items of every trip.
			return [tripKeys.lists(tripId), meKeys.deadlines, meKeys.inbox];
		case "proposals":
		case "money":
			// The inbox derives review, result, balance and budget items from them.
			return [tripKeys.byKey(tripId, key), meKeys.inbox];
		default:
			return [tripKeys.byKey(tripId, key)];
	}
}
