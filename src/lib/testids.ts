/**
 * SHARED `data-testid` values (SPEC §0 rule 16, §18.5; qa/SCENARIOS TI-5).
 * No imports, so e2e specs can import this file by relative path.
 *
 * F-owned. It holds only the ids other packages or the QA scenarios depend
 * on: TI-5, one per public component (§12.5 + the F-ext0 stubs), and the ids
 * of the F-built stubs. A package's OWN ids go in
 * `src/features/<x>/testids.ts` (also import-free, exported as
 * `<X>_TESTID`), which the package owns — so no two packages ever edit the
 * same file (CONTRACTS §1 rule 8). Never rename an id.
 */
export const TESTID = {
	// ---- qa/SCENARIOS TI-5 ------------------------------------------------
	timelineItem: "timeline-item", // WP-Plan
	itemStart: "item-start", // WP-Plan
	itemEnd: "item-end", // WP-Plan
	leg: "leg", // WP-Plan (rows) / WP-Transit (inspector)
	legDuration: "leg-duration", // WP-Plan
	legMode: "leg-mode", // WP-Plan / WP-Transit
	conflictBadge: "conflict-badge", // WP-Plan
	freeTime: "free-time", // WP-Plan
	pin: "pin", // WP-Map
	edge: "edge", // WP-Map
	rollupTodo: "rollup-todo", // WP-Lists
	rollupShopping: "rollup-shopping", // WP-Lists
	galleryItem: "gallery-item", // WP-Media
	presenceAvatar: "presence-avatar", // WP-Shell
	/** ADDENDUM §10: the one inbox bell (replaces the mention bell). */
	inboxBell: "inbox-bell", // WP-Shell
	remoteCursor: "remote-cursor", // WP-Lists
	offlineBanner: "offline-banner", // WP-Home
	scopeBreadcrumb: "scope-breadcrumb", // WP-Shell

	// ---- Shell (WP-Shell) --------------------------------------------------
	workspace: "workspace",
	topBar: "top-bar",
	tripMenu: "trip-menu",
	lensControl: "lens-control",
	connectionPill: "connection-pill",
	shareButton: "share-button",
	commandButton: "command-button",
	centerPanel: "center-panel",
	centerTabs: "center-tabs",
	inspector: "inspector",
	inspectorClose: "inspector-close",
	outlinePopoverButton: "outline-popover-button",
	mobileSheet: "mobile-sheet",
	mobilePills: "mobile-pills",
	fab: "fab",
	dayRangeChip: "day-range-chip",

	// ---- §12.5 public components, one per export ---------------------------
	outline: "outline", // WP-Outline
	outlineRow: "outline-row", // WP-Outline
	ideasBin: "ideas-bin", // WP-Outline
	outlinePopover: "outline-popover", // WP-Outline
	planTab: "plan-tab", // WP-Plan
	itemOverview: "item-overview", // WP-Plan
	dayOverview: "day-overview", // WP-Plan
	dayChips: "day-chips", // WP-Plan
	nowNext: "now-next", // WP-Plan
	tripMap: "trip-map", // WP-Map
	legOverview: "leg-overview", // WP-Transit
	edgeOverview: "edge-overview", // WP-Transit
	addFlightDialog: "add-flight-dialog", // WP-Transit
	addPlaceDialog: "add-place-dialog", // WP-Places
	nodeOverview: "node-overview", // WP-Places
	mediaTab: "media-tab", // WP-Media
	mediaPanel: "media-panel", // WP-Media
	coverStrip: "cover-strip", // WP-Media
	listsTab: "lists-tab", // WP-Lists
	listsPanel: "lists-panel", // WP-Lists
	notesTab: "notes-tab", // WP-Lists
	notesPanel: "notes-panel", // WP-Lists
	mentionInput: "mention-input", // WP-Lists
	shareDialog: "share-dialog", // WP-Home
	/** `/t/<slug>` answered "no access" (the same for a trip that doesn't exist); `data-link-gone` when a guest's link ended. */
	tripNoAccess: "trip-no-access",
	tripNoAccessSignIn: "trip-no-access-sign-in",
	shareLinkRow: "share-link-row", // WP-Home: the trip's one link (data-role, data-enabled)
	shareLinkSwitch: "share-link-switch", // WP-Home (F stub)
	shareLinkUrl: "share-link-url", // WP-Home: the trip's address (its link)
	shareLinkCopy: "share-link-copy", // WP-Home: "Copy link"
	shareLinkReset: "share-link-reset", // WP-Home (F stub)
	shareLinkExpiry: "share-link-expiry", // WP-Home (F stub)
	shareLinkExtend: "share-link-extend", // WP-Home (F stub)
	tripSettingsDialog: "trip-settings-dialog", // WP-Home
	accountMenu: "account-menu", // WP-Home
	guestNudge: "guest-nudge", // WP-Home
	profileDialog: "profile-dialog", // WP-Home
	installButton: "install-button", // WP-Home

	// ---- F-ext0 public components (EXTENSIONS §1.3), one per export -------
	proposalGhost: "proposal-ghost", // F (common)
	suggestModeControl: "suggest-mode-control", // WP-Suggest
	reviewDrawer: "review-drawer", // WP-Suggest
	proposalBar: "proposal-bar", // WP-Suggest
	proposalOverview: "proposal-overview", // WP-Suggest
	noteSuggestions: "note-suggestions", // WP-Suggest
	hoursChip: "hours-chip", // WP-Insights
	dayHoursBadge: "day-hours-badge", // WP-Insights
	daySun: "day-sun", // WP-Insights
	hoursTable: "hours-table", // WP-Insights
	hoursEditorDialog: "hours-editor-dialog", // WP-Insights
	climateCard: "climate-card", // WP-Insights
	shiftTripDialog: "shift-trip-dialog", // WP-Insights
	whatIfChip: "what-if-chip", // WP-Insights
	dateImpactList: "date-impact-list", // WP-Insights
	holidaysEditor: "holidays-editor", // WP-Insights
	moneyTab: "money-tab", // WP-Money
	moneyPanel: "money-panel", // WP-Money
	addExpenseDialog: "add-expense-dialog", // WP-Money
	shareInbox: "share-inbox", // WP-Home

	// ---- Dashboard (WP-Home) -----------------------------------------------
	dashboard: "dashboard",
	tripCard: "trip-card",
	newTripButton: "new-trip-button",
	newTripDialog: "new-trip-dialog",
	newTripName: "new-trip-name",
	newTripSubmit: "new-trip-submit",

	// ---- Common (F1u) ------------------------------------------------------
	emptyState: "empty-state",
	/** The branded error page (`RouteError`, QA ERR-04) and its retry. */
	routeError: "route-error",
	routeErrorRetry: "route-error-retry",
	stubPanel: "stub-panel",
	undoToast: "undo-toast",
	/** `LegSummary`'s route/leg label chip (no line names). */
	legSummaryLabel: "leg-summary-label",
} as const;

export type TestId = (typeof TESTID)[keyof typeof TESTID];
