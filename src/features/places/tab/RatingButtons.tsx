/**
 * The Places tab's rating buttons: the kit's `RatingButtons` with this tab's
 * test ids (the feed's filled set and the drawer's outline set).
 */
import { Link, useLocation } from "@tanstack/react-router";
import type { ComponentProps } from "react";
import { RatingButtons as KitRatingButtons } from "@/components/kit";
import { Button } from "@/components/ui/button";
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
			reasonTestId={PLACES_TAB_TESTID.rateReason}
			{...props}
		/>
	);
}

/** "Sign in" for a "Can rate" link guest, back to this same place. */
export function RateSignIn() {
	const location = useLocation();
	const next = `${location.pathname}${location.searchStr ?? ""}`;
	return (
		<Button size="sm" asChild>
			<Link
				to="/login"
				search={{ next } as never}
				data-testid={PLACES_TAB_TESTID.feedSignIn}
			>
				Sign in
			</Link>
		</Button>
	);
}
