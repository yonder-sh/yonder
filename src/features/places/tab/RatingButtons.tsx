/**
 * The Places tab's rating buttons: the kit's `RatingButtons` with this tab's
 * test ids (the feed's filled set and the drawer's outline set).
 */
import type { ComponentProps } from "react";
import { RatingButtons as KitRatingButtons } from "@/components/kit";
import { PLACES_TAB_TESTID } from "./testids";

export function RatingButtons({
	variant = "outline",
	...props
}: ComponentProps<typeof KitRatingButtons>) {
	return (
		<KitRatingButtons
			variant={variant}
			buttonTestId={PLACES_TAB_TESTID.feedButton}
			revealTestId={PLACES_TAB_TESTID.feedReveal}
			{...props}
		/>
	);
}
