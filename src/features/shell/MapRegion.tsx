/**
 * The map pane: WP-Map's lazily loaded `TripMap` (maplibre is big and
 * client-only), with the floating inspector over it on xl/lg and, on the
 * desktop, "Hide the map" in its top-left corner.
 */
import { lazy, Suspense } from "react";
import { FloatingInspector } from "./FloatingInspector";
import { MapHideButton } from "./PanelToggles";

const TripMap = lazy(() => import("@/features/map/TripMap"));

export function MapRegion({
	variant,
	inspector,
	hideable = false,
}: {
	variant: "desktop" | "mobile";
	/** Floating inspector width, or null when the inspector lives elsewhere (md Sheet, mobile drawer). */
	inspector: number | null;
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
			{inspector ? <FloatingInspector width={inspector} /> : null}
		</div>
	);
}
