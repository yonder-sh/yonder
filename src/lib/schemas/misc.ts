/**
 * JSONB shapes for `activity_log.meta` (E6 digest) and `user_prefs.prefs`
 * (ADDENDUM §7.2 "view settings synced to the account").
 */
import { z } from "zod";
import { Id } from "./common";

/** Extra facts for digest lines ("moved Itoya from Day 3 to Day 5"). */
export const ActivityMeta = z
	.object({
		name: z.string().max(200),
		fromDayId: Id.nullable(),
		toDayId: Id.nullable(),
		parentId: Id.nullable(),
		count: z.number().int().min(0),
		proposalId: Id,
		/** Money rows (ADDENDUM §7.3): which expense an `expense.*` row is about. */
		expenseId: Id,
		/** `person.*` rows: the member added or merged into. */
		memberId: Id,
		/**
		 * `list.*` rows (WP-Lists): the list item, so "Make private" can drop
		 * the item's earlier lines (ADDENDUM §7.2).
		 */
		listItemId: Id,
		/** The actor was a link guest (set by `logActivity`, SECURITY §2). */
		guest: z.boolean(),
	})
	.partial();
export type ActivityMeta = z.infer<typeof ActivityMeta>;

export const LENS_PREF_VALUES = [
	"country",
	"region",
	"city",
	"area",
	"place",
] as const;

/**
 * Per-user view settings (never per trip, except the tree expand state).
 * Everything is optional; readers apply defaults. `displayCurrency` is
 * view-only (ADDENDUM §7.2): `"local"` = the current country's currency.
 *
 * As a `setUserPrefs` PATCH: keys not sent keep their value, `null` removes a
 * key (back to the default: `defaultLens: null` = "Automatic"), and
 * `treeExpanded` merges per trip (see `mergeUserPrefs`).
 */
export const UserPrefs = z
	.object({
		/** null = "Automatic" (the engine's `defaultLens`). */
		defaultLens: z.enum(LENS_PREF_VALUES).nullable(),
		/** Expanded node ids per trip (≤ 50 trips × 500 ids). */
		treeExpanded: z.record(Id, z.array(Id).max(500)),
		/** Only "satellite" counts: the map is otherwise the app theme's (null clears it). */
		mapStyle: z.enum(["light", "dark", "satellite"]).nullable(),
		compact: z.boolean(),
		clock: z.enum(["12h", "24h"]),
		units: z.enum(["km", "mi"]),
		/** ISO 4217, or "local", or null = the trip's home currency. */
		displayCurrency: z
			.string()
			.regex(/^([A-Z]{3}|local)$/)
			.nullable(),
		/** WP-Lists: done rows start unfolded (QA ROLL-08 "Hide done", per user). */
		listsShowDone: z.boolean(),
		/**
		 * FB-17: hide other people's live cursors (and their cursor chat). Mine
		 * is always shared (owner decision: no "hide my cursor").
		 */
		hideCursors: z.boolean(),
		/**
		 * docs/PLACES.md §1: the Places tab takes the map's space ("wide"),
		 * remembered per person.
		 */
		placesWide: z.boolean(),
		/** docs/PLACES.md §1: the city groups this person split by area (node ids). */
		placesSplit: z.array(Id).max(200),
	})
	.partial()
	.refine((p) => Object.keys(p.treeExpanded ?? {}).length <= 50, {
		message: "too many trips in treeExpanded",
	});
export type UserPrefs = z.infer<typeof UserPrefs>;

/** At most this many trips keep a tree expand state. */
export const MAX_TREE_EXPANDED_TRIPS = 50;

/**
 * The server-side merge of a `setUserPrefs` patch (pure, for tests): shallow
 * for every key, per trip for `treeExpanded` (two devices saving different
 * trips never overwrite each other), `null` deletes a key. When more than
 * `MAX_TREE_EXPANDED_TRIPS` trips are stored, the patch's trips are kept and
 * the oldest-stored others are dropped.
 */
export function mergeUserPrefs(stored: UserPrefs, patch: UserPrefs): UserPrefs {
	const out: Record<string, unknown> = { ...stored };
	for (const [k, v] of Object.entries(patch)) {
		if (v === undefined) continue;
		if (v === null) delete out[k];
		else if (k === "treeExpanded") {
			const sent = v as Record<string, string[]>;
			const kept = Object.entries(stored.treeExpanded ?? {}).filter(
				([trip]) => !(trip in sent),
			);
			const room = Math.max(
				0,
				MAX_TREE_EXPANDED_TRIPS - Object.keys(sent).length,
			);
			out.treeExpanded = {
				...Object.fromEntries(kept.slice(Math.max(0, kept.length - room))),
				...sent,
			};
		} else out[k] = v;
	}
	return out as UserPrefs;
}

/**
 * Reads stored prefs leniently: a key that no longer validates is dropped on
 * its own instead of discarding everything.
 */
export function readUserPrefs(raw: unknown): UserPrefs {
	const whole = UserPrefs.safeParse(raw ?? {});
	if (whole.success) return whole.data;
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
	const out: Record<string, unknown> = {};
	for (const [k, v] of Object.entries(raw)) {
		const one = UserPrefs.safeParse({ [k]: v });
		if (one.success && k in one.data)
			out[k] = (one.data as Record<string, unknown>)[k];
	}
	return out as UserPrefs;
}
