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
		dayCapacityMin: z.number().int().min(60).max(1440).default(750),
		/** E1 (EXTENSIONS §2.2): public holidays that count as hours day 7. */
		holidays: z.array(Holiday).max(100),
		/**
		 * docs/PLACES.md §3: a place is a suggested shortlist pick at this group
		 * score or more (default 3: one Must, or Really want + Want).
		 */
		shortlistMinScore: z.number().int().min(-20).max(60).default(3),
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
	})
	.partial();
export type TripSettingsPatch = z.infer<typeof TripSettingsPatch>;
