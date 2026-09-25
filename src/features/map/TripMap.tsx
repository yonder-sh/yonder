/**
 * The map (SPEC §12.5 `TripMap({ variant })`, default export, lazy-loaded by
 * WP-Shell's `MapRegion`).
 *
 * With WebGL2 it renders the MapLibre map (`MapCanvas`, its own chunk). Without
 * it (old browsers, some headless and test environments) it falls back to a
 * light SVG sketch of the same model — pins as buttons, edges by mode — so the
 * workspace stays usable and nothing looks broken (SPEC §18.3 "a WebGL2
 * fallback").
 *
 * Either way the region carries its text alternative: the ordered "Stops"
 * list (`StopsList`, QA A11Y-03), hidden until it takes keyboard focus.
 */
import { lazy, Suspense, useEffect, useState } from "react";
import { TESTID } from "@/lib/testids";
import { useWorkspace } from "@/lib/workspace/use-workspace";
import { FallbackMap } from "./FallbackMap";
import { StopsList } from "./StopsList";

const MapCanvas = lazy(() => import("./MapCanvas"));

/** `true`/`false` once checked on the client; `null` before. */
export function useWebGL2(): boolean | null {
	const [ok, setOk] = useState<boolean | null>(null);
	useEffect(() => {
		let result = false;
		try {
			const c = document.createElement("canvas");
			result = !!c.getContext("webgl2");
		} catch {
			result = false;
		}
		setOk(result);
	}, []);
	return ok;
}

export default function TripMap({
	variant,
}: {
	variant: "desktop" | "mobile";
}) {
	const { scope, graph } = useWorkspace();
	const webgl = useWebGL2();
	return (
		<div
			data-testid={TESTID.tripMap}
			// FB-17: a cursor over the map travels as lng/lat (the map's projector).
			data-cursor-map=""
			className="relative size-full overflow-hidden bg-basemap-land"
		>
			{/* The landmark sits inside the test id's element, so a query scoped
			    to the map (QA A11Y-03) finds it; the canvas, the fallback and
			    the stops list are all inside it. */}
			<section
				aria-label={`Map of ${scope?.name ?? graph.trip.name}`}
				className="relative size-full"
			>
				{webgl === null ? (
					<div
						className="size-full animate-pulse bg-basemap-land"
						aria-hidden
					/>
				) : webgl ? (
					<Suspense
						fallback={
							<div
								className="size-full animate-pulse bg-basemap-land"
								aria-hidden
							/>
						}
					>
						<MapCanvas variant={variant} />
					</Suspense>
				) : (
					<FallbackMap variant={variant} />
				)}
				<StopsList variant={variant} />
			</section>
		</div>
	);
}
