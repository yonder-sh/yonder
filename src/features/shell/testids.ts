/**
 * WP-Shell's own `data-testid` values (CONTRACTS §1 rule 8). Import-free, so
 * e2e specs can import this file by relative path. The shared ids (the
 * workspace, top bar, inspector, `inbox-bell`, …) stay in `src/lib/testids.ts`.
 * Never rename an id.
 */
export const SHELL_TESTID = {
	// Inbox (ADDENDUM §10 "one inbox")
	inboxPanel: "inbox-panel",
	inboxRow: "inbox-row",
	inboxDot: "inbox-dot",
	inboxMarkAll: "inbox-mark-all",
	// Digest (EXTENSIONS §9, one line)
	digestBanner: "digest-banner",
	digestGotIt: "digest-got-it",
	activityDialog: "activity-dialog",
	activityFooter: "activity-footer",
	// Trip overview
	tripOverview: "trip-overview",
	stillToPlan: "still-to-plan",
	stillToPlanRow: "still-to-plan-row",
	deadlines: "trip-deadlines",
	deadlineChip: "trip-deadline-chip",
	stillToPlanItem: "still-to-plan-item",
	deadlineRow: "trip-deadline-row",
	recentList: "trip-recent",
	// Inspector
	inspectorTabs: "inspector-tabs",
	// Chrome
	followBar: "follow-bar",
	followResume: "follow-resume",
	followButton: "follow-button",
	shortcutsDialog: "shortcuts-dialog",
	viewSettingsDialog: "view-settings-dialog",
	viewSettingsButton: "view-settings-button",
	tryOtherDates: "try-other-dates",
	fabMenu: "fab-menu",
	fabPlace: "fab-place",
	fabExpense: "fab-expense",
	outlineAside: "outline-aside",
	crumbOverflow: "crumb-overflow",
	suggestRule: "suggest-rule",
	// FB-05: the ways into the Rate screen
	rateButton: "rate-button",
	rateMenuItem: "rate-menu-item",
	// Phone chrome (COLLAB-R3-03, VIS3-09)
	mobileWhatIf: "mobile-what-if",
	mobileEmptyPeek: "mobile-empty-peek",
	// FB-17 live cursors (the overlay's own nodes: remote-cursor, remote-cursor-chat,
	// remote-cursor-edge, remote-reaction, remote-tap)
	cursorLayer: "cursor-layer",
	cursorChatInput: "cursor-chat-input",
	cursorChatSent: "cursor-chat-sent",
	reactionPalette: "reaction-palette",
	elsewhereChips: "elsewhere-chips",
	elsewhereChip: "elsewhere-chip",
	followersBadge: "followers-badge",
	crumbPresence: "crumb-presence",
	spotlightMenuItem: "spotlight-menu-item",
	spotlightBar: "spotlight-bar",
	spotlightEnd: "spotlight-end",
	showCursorsSwitch: "pref-show-cursors",
	// FB-24 form presence (the chips on cards are the layer's `remote-form-chip`;
	// FB-23 drags `remote-drag`, `remote-drop`; FB-25 menus `remote-menu`)
	inspectorFormChip: "inspector-form-chip",
	followFormBanner: "follow-form-banner",
	/** docs/PLACES.md §1: the Places tab's "N to decide" badge. */
	placesToDecide: "places-to-decide",
} as const;

export type ShellTestId = (typeof SHELL_TESTID)[keyof typeof SHELL_TESTID];
