/**
 * WP-Suggest's own `data-testid` values (CONTRACTS §1 rule 8). Import-free,
 * so e2e specs can import this file by relative path. The public ids
 * (`suggest-mode-control`, `review-drawer`, `proposal-bar`,
 * `proposal-overview`, `note-suggestions`) stay in `src/lib/testids.ts`.
 */
export const SUGGEST_TESTID = {
	// SuggestModeControl
	modeMenu: "suggest-mode-menu",
	modeEditing: "suggest-mode-editing",
	modeSuggesting: "suggest-mode-suggesting",
	showSwitch: "suggest-show-switch",
	reviewOpen: "suggest-review-open",
	suggesterPill: "suggest-suggester-pill",
	firstHint: "suggest-first-hint",
	/** `SuggestModeMenuItem` in WP-Shell's trip menu (M6). */
	modeMenuItem: "suggest-mode-menu-item",
	// ReviewDrawer
	filter: "suggest-filter",
	group: "suggest-group",
	groupAcceptAll: "suggest-group-accept-all",
	groupRejectAll: "suggest-group-reject-all",
	row: "suggest-row",
	rowSummary: "suggest-row-summary",
	accept: "suggest-accept",
	acceptAnyway: "suggest-accept-anyway",
	reject: "suggest-reject",
	rejectNote: "suggest-reject-note",
	rejectConfirm: "suggest-reject-confirm",
	withdraw: "suggest-withdraw",
	show: "suggest-show",
	conflict: "suggest-conflict",
	status: "suggest-status",
	// ProposalBar
	barAlternative: "suggest-bar-alternative",
	/** The lead line: "Suggested by Maya · Change to 1h 30m" (never truncated). */
	barText: "suggest-bar-text",
	// ProposalOverview
	fieldRow: "suggest-field-row",
	// GhostActions
	ghostAccept: "suggest-ghost-accept",
	ghostReject: "suggest-ghost-reject",
	// NoteSuggestions
	noteSuggestButton: "suggest-note-button",
	noteTextarea: "suggest-note-textarea",
	noteSend: "suggest-note-send",
	noteBlock: "suggest-note-block",
	noteInsert: "suggest-note-insert",
} as const;
