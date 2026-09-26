/**
 * The map pane: WP-Map's lazily loaded `TripMap` (maplibre is big and
 * client-only), with, on the desktop, "Hide the map" in its top-left corner.
 * The details are beside it, never over it (`DetailsPane`).
 */
import { lazy, Suspense } from "react";
import { MapHideButton } from "./PanelToggles";

const TripMap = lazy(() => import("@/features/map/TripMap"));

export function MapRegion({
	variant,
	hideable = false,
}: {
	variant: "desktop" | "mobile";
	/** The desktop map can be hidden (`useShell().toggleMap`). */
	hideable?: boolean;
}) {
	return (
		<div className="relative h-full min-h-0 w-full overflow-hidden bg-basemap-land">
			<Suspense
				fallback={
					<div
						className="size-full animate-pulse bg-basemap-land"
						aria-hidden="true"
					/>
				}
			>
				<TripMap variant={variant} />
			</Suspense>
			{hideable ? <MapHideButton /> : null}
		</div>
	);
}
