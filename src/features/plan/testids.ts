/**
 * WP-Plan's own `data-testid` values (CONTRACTS §1 rule 8). Import-free, so
 * e2e specs can import this file by relative path. The shared ids
 * (`timeline-item`, `item-start`, `leg`, `free-time`, …) stay in
 * `src/lib/testids.ts`. Never rename an id.
 */
export const PLAN_TESTID = {
	/** "Ideas in Kyoto" under the days (One Yonder: the Outline's Ideas bin moved here). */
	ideas: "plan-ideas",
	daySection: "plan-day",
	dayHeader: "plan-day-header",
	/** One Yonder D02: a day in the trip-level list. */
	dayRow: "plan-day-row",
	/** One Yonder D04: Fill a day (the day's ideas in the map's place). */
	fillDay: "plan-fill-day",
	fillIdea: "plan-fill-idea",
	fillAdd: "plan-fill-add",
	fillBar: "plan-fill-bar",
	dockStop: "plan-dock-stop",
	dockStopAdd: "plan-dock-stop-add",
	/** "35 days · Sat 2 Oct – Fri 5 Nov · 7 days planned" (D02). */
	planMeta: "plan-meta",
	dayMenu: "plan-day-menu",
	dayMenuFilter: "plan-day-menu-filter",
	dayFilter: "plan-day-filter",
	dayStart: "plan-day-start",
	dayTitle: "plan-day-title",
	dayNoCity: "plan-day-no-city",
	daySummary: "plan-day-summary",
	dayIssues: "plan-day-issues",
	dayStay: "plan-day-stay",
	dayHidden: "plan-day-hidden",
	dayDeleteConfirm: "plan-day-delete-confirm",
	itemMenu: "plan-item-menu",
	itemMoveUp: "plan-item-move-up",
	itemMoveDown: "plan-item-move-down",
	itemDuration: "plan-item-duration",
	itemResize: "plan-item-resize",
	itemWarning: "plan-item-warning",
	itemBooked: "plan-item-booked",
	itemWallet: "plan-item-wallet",
	itemNote: "plan-item-note",
	addBetween: "plan-add-between",
	legAccept: "plan-leg-accept",
	legFix: "plan-leg-fix",
	legStale: "plan-leg-stale",
	legBundles: "plan-leg-bundles",
	/** A leg row's details, shown on hover, focus or selection. */
	legMore: "plan-leg-more",
	timedDuration: "plan-timed-duration",
	stayLeg: "plan-stay-leg",
	overnight: "plan-overnight",
	flightStub: "plan-flight-stub",
	flightContinued: "plan-flight-continued",
	/** FB-18: "· times TBD" on a flight stub without times. */
	flightTbd: "plan-flight-tbd",
	layover: "plan-layover",
	unlinked: "plan-unlinked",
	fold: "plan-fold",
	ghost: "plan-ghost",
	originRow: "plan-origin-row",
	proposalBanner: "plan-proposal-banner",
	areaBlock: "plan-area-block",
	band: "plan-band",
	bandLink: "plan-band-link",
	nowLine: "plan-now-line",
	whoFilter: "plan-who-filter",
	rangeBar: "plan-range-bar",
	dropIndicator: "plan-drop-indicator",
	// Overviews
	overviewTitle: "plan-overview-title",
	overviewPin: "plan-overview-pin",
	overviewDay: "plan-overview-day",
	overviewAssignees: "plan-overview-assignees",
	overviewBooked: "plan-overview-booked",
	overviewUnschedule: "plan-overview-unschedule",
	overviewDelete: "plan-overview-delete",
	overviewNote: "plan-overview-note",
	overviewAbout: "plan-overview-about",
	overviewChips: "plan-overview-chips",
	overviewDeleted: "plan-overview-deleted",
	dayOverviewStay: "plan-day-overview-stay",
	dayOverviewCapacity: "plan-day-overview-capacity",
} as const;

export type PlanTestId = (typeof PLAN_TESTID)[keyof typeof PLAN_TESTID];
