/**
 * List-item JSON shapes (ADDENDUM §10 "booking windows that move"). A due
 * date may be RELATIVE to an item's day, so it follows the item when the item
 * or the whole trip moves: "355 days before this flight's day at 09:00
 * Asia/Tokyo", "1 month before at 10:00", "the 10th of the month, 2 months
 * before". WP-Lists' `effectiveDue` resolves it (`src/lib/engine/due.ts`).
 */
import { z } from "zod";
import { HHmm, Id, Tz } from "./common";

export const DueRule = z.discriminatedUnion("kind", [
	z
		.object({
			kind: z.literal("days"),
			/** The item whose day anchors the rule. */
			itemId: Id,
			/** Days before the item's day (0 = that day). */
			days: z.number().int().min(0).max(400),
			time: HHmm,
			tz: Tz,
		})
		.strict(),
	z
		.object({
			kind: z.literal("months"),
			itemId: Id,
			/** Calendar months before the item's day (same day of month unless `dayOfMonth`). */
			months: z.number().int().min(0).max(24),
			dayOfMonth: z.number().int().min(1).max(31).optional(),
			time: HHmm,
			tz: Tz,
		})
		.strict(),
]);
export type DueRule = z.infer<typeof DueRule>;
