/**
 * WP-Map's own test ids (CONTRACTS §1 rule 8). Import-free. The shared ones
 * (`pin`, `edge`, `trip-map`) stay in `src/lib/testids.ts`. Never rename one.
 */
export const MAP_TESTID = {
	/** The MapLibre canvas container (absent in the no-WebGL fallback). */
	canvas: "map-canvas",
	/** The SVG preview drawn when WebGL2 is missing. */
	fallback: "map-fallback",
	cluster: "map-cluster",
	revisit: "map-revisit",
	edgeChip: "map-edge-chip",
	controls: "map-controls",
	fit: "map-fit",
	zoomIn: "map-zoom-in",
	zoomOut: "map-zoom-out",
	layersButton: "map-layers-button",
	layerMenu: "map-layer-menu",
	legend: "map-legend",
	showIdeas: "map-show-ideas",
	showDropped: "map-show-dropped",
	showStays: "map-show-stays",
	dayMode: "map-day-mode",
	/** The Satellite toggle in the map's controls (light / dark follow the app theme). */
	satellite: "map-satellite",
	filterButton: "map-filter-button",
	filterMenu: "map-filter-menu",
	filterChip: "map-filter-chip",
	filterClear: "map-filter-clear",
	finerChip: "map-finer-chip",
	/** FB-22: "Back to Dennis's view" (map-following paused). */
	followChip: "map-follow-chip",
	empty: "map-empty",
	scopeHint: "map-scope-hint",
	edgeTip: "map-edge-tip",
	/** QA ERR-06: basemap tiles failed to load. */
	tilesError: "map-tiles-error",
	/** QA A11Y-03: the ordered "Stops" list (the map's text alternative). */
	stops: "map-stops",
} as const;
