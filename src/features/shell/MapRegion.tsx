/**
 * The map pane: WP-Map's lazily loaded `TripMap` (maplibre is big and
 * client-only), with the floating inspector over it on xl/lg.
 */
import { lazy, Suspense } from "react";
import { FloatingInspector } from "./FloatingInspector";

const TripMap = lazy(() => import("@/features/map/TripMap"));

export function MapRegion({
	variant,
	inspector,
}: {
	variant: "desktop" | "mobile";
	/** Floating inspector width, or null when the inspector lives elsewhere (md Sheet, mobile drawer). */
	inspector: number | null;
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
			{inspector ? <FloatingInspector width={inspector} /> : null}
		</div>
	);
}
