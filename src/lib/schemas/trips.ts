/** JSONB shape of `trips.settings` (SPEC §6.5). Every key is optional; readers apply the defaults. */
import { z } from "zod";
import { HHmm, IsoDate } from "./common";

/** E1: a public holiday (hours day 7) — "Sports Day", 2027-10-11, JP. */
export const Holiday = z.object({
	date: IsoDate,
	name: z.string().trim().min(1).max(60),
	countryCode: z
		.string()
		.regex(/^[A-Z]{2}$/)
		.optional(),
});
export type Holiday = z.infer<typeof Holiday>;

/**
 * The shortlist's per-person level (the group score it needs is this × the
 * people rating): Want, halfway to Really want, or Really want.
 */
export const SHORTLIST_LEVELS = [1, 1.5, 2] as const;
export const ShortlistLevel = z.union([
	z.literal(1),
	z.literal(1.5),
	z.literal(2),
]);
export type ShortlistLevel = z.infer<typeof ShortlistLevel>;

export const TripSettings = z
	.object({
		defaultDayStart: HHmm.default("09:00"),
		/** The trip's HOME currency (ADDENDUM §7.2): the unit of all money math. */
		currency: z
			.string()
			.regex(/^[A-Z]{3}$/)
			.default("USD"),
		walkSpeedKmh: z.number().min(2).max(8).default(4.5),
		compact: z.boolean().optional(),
		/** §10.9: enqueue leg autofill jobs. */
		autofillLegs: z.boolean().default(true),
		/** The sheet's "Capacity/day ~12.5" h. */
		/** The waking day, travel included: 14h = 24h less 8h of sleep and an hour each end. */
		dayCapacityMin: z.number().int().min(60).max(1440).default(840),
		/** E1 (EXTENSIONS §2.2): public holidays that count as hours day 7. */
		holidays: z.array(Holiday).max(100),
		/**
		 * The old fixed shortlist score (default 3). Still read as a fallback
		 * (`shortlistLevel` wins); 0017 turned it into a level.
		 */
		shortlistMinScore: z.number().int().min(-20).max(60).default(3),
		/** The shortlist's per-person level (default 1.5), see `shortlistBar`. */
		shortlistLevel: ShortlistLevel.default(1.5),
	})
	.partial();
export type TripSettings = z.infer<typeof TripSettings>;

/**
 * A `updateTrip({ settings })` PATCH: the same keys with no defaults, so only
 * the keys sent are written (`TripSettings` would fill in "USD", "09:00", …
 * for absent keys and overwrite the trip's real values).
 */
export const TripSettingsPatch = z
	.object({
		defaultDayStart: HHmm,
		currency: z.string().regex(/^[A-Z]{3}$/),
		walkSpeedKmh: z.number().min(2).max(8),
		compact: z.boolean(),
		autofillLegs: z.boolean(),
		dayCapacityMin: z.number().int().min(60).max(1440),
		holidays: z.array(Holiday).max(100),
		shortlistMinScore: z.number().int().min(-20).max(60),
		shortlistLevel: ShortlistLevel,
	})
	.partial();
export type TripSettingsPatch = z.infer<typeof TripSettingsPatch>;
