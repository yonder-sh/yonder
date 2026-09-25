/**
 * E1 opening hours (EXTENSIONS §4.1), stored in `nodes.details.openingHours`
 * with `source: 'google' | 'manual'`. Hours parsed from the sheet's
 * `openHoursText` are derived (`effectiveHours`, WP-Insights), never stored.
 */
import { z } from "zod";
import { HHmm, IsoDate } from "./common";

export const HoursPeriod = z.object({
	/** 0 Sun … 6 Sat, 7 = public holiday (`settings.holidays`). */
	day: z.number().int().min(0).max(7),
	open: HHmm,
	/** close ≤ open → closes the next day (18:00–03:00). */
	close: HHmm.or(z.literal("24:00")),
	lastEntry: HHmm.optional(),
});
export type HoursPeriod = z.infer<typeof HoursPeriod>;

export const HoursException = z.object({
	date: IsoDate,
	closed: z.boolean(),
	periods: z
		.array(HoursPeriod.omit({ day: true }))
		.max(4)
		.optional(),
	label: z.string().max(60).optional(),
});
export type HoursException = z.infer<typeof HoursException>;

export const OpeningHours = z.object({
	source: z.enum(["google", "manual"]),
	alwaysOpen: z.boolean().optional(),
	periods: z.array(HoursPeriod).max(40),
	/** Closures known without hours. */
	closedDays: z.array(z.number().int().min(0).max(6)).max(7).optional(),
	closedNth: z
		.array(
			z.object({
				day: z.number().int().min(0).max(6),
				nth: z.union([z.literal(-1), z.number().int().min(1).max(5)]),
			}),
		)
		.max(4)
		.optional(),
	lastEntryBeforeCloseMin: z.number().int().min(0).max(240).optional(),
	exceptions: z.array(HoursException).max(60).optional(),
	note: z.string().max(200).optional(),
	updatedAt: z.iso.datetime(),
});
export type OpeningHours = z.infer<typeof OpeningHours>;
