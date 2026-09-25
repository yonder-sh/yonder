/**
 * The Overview's own `data-testid` values (docs/OVERVIEW.md). Import-free, so
 * e2e specs can import this file by relative path. Never rename an id.
 */
export const OVERVIEW_TESTID = {
	page: "overview",
	/** `data-phase`: before · during · after · empty. */
	header: "overview-header",
	title: "overview-title",
	chip: "overview-phase-chip",
	stats: "overview-stats",
	/** `data-stat`: days · cities · places · flights · km · media. */
	stat: "overview-stat",
	planning: "overview-planning",
	today: "overview-today",
	todayItem: "overview-today-item",
	tomorrow: "overview-tomorrow",
	progress: "overview-progress",
	/** `data-drawn`: drawing · done; `data-map`: maplibre · svg · loading. */
	globe: "overview-globe",
	here: "overview-here",
	strip: "overview-strip",
	/** `data-stay`, `data-days` (`from..to`). */
	stay: "overview-stay",
	days: "overview-days",
	/** `data-date`. */
	day: "overview-day",
	daySection: "overview-day-section",
	highlights: "overview-highlights",
	highlight: "overview-highlight",
	favourites: "overview-favourites",
	empty: "overview-empty",
	openPlan: "overview-open-plan",
	seePlaces: "overview-see-places",
	openToday: "overview-open-today",
	/** The inspector's "Open the Overview →" at the trip root. */
	openOverview: "open-overview",
} as const;
